import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import * as catalog from "../catalog/repository.js";
import type { Db } from "../db/client.js";
import { truncateCatalog } from "../db/maintenance.js";
import { setupTestDb } from "../test/database.js";
import { seedCatalog } from "../test/fixtures.js";
import type { Lineage, Relationships, Resolution, SiblingGroup, TrackDetail, TrackSummary } from "./schemas.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let closeDb: () => Promise<void>;
let ids: Awaited<ReturnType<typeof seedCatalog>>;

before(async () => {
  const test = await setupTestDb();
  db = test.db;
  closeDb = () => test.pool.end();
  await truncateCatalog(db);
  ids = await seedCatalog(db);
  app = await buildApp({ db, corsOrigin: "http://localhost:3000", logger: false });
});

after(async () => {
  await app?.close();
  await closeDb?.();
});

async function get<T>(url: string, status = 200): Promise<T> {
  const response = await app.inject({ method: "GET", url });
  assert.equal(response.statusCode, status, `GET ${url}: ${response.body}`);
  return response.json() as T;
}

const titles = (tracks: TrackSummary[]) => tracks.map((t) => t.title);
type ErrorResponse = { error: { code: string; message: string } };

describe("GET /v1/tracks/resolve", () => {
  it("matches an ISRC however it is formatted, with every recording sharing it", async () => {
    const body = await get<Resolution>("/v1/tracks/resolve?isrc=us-aaa-69-00001");
    assert.equal(body.matchedBy, "isrc");
    assert.deepEqual(titles(body.tracks), ["Funky Break", "Funky Break Pt. 1"]);
  });

  it("matches every pressing by normalized title and artist", async () => {
    const body = await get<Resolution>(
      `/v1/tracks/resolve?title=${encodeURIComponent("CITY ANTHEM (feat. Somebody)")}&artist=mc%20example`,
    );
    assert.equal(body.matchedBy, "title_artist");
    assert.deepEqual(titles(body.tracks), ["City Anthem", "City Anthem (Radio Edit)"]);
  });

  it("falls back to title and artist when the ISRC is unknown", async () => {
    const body = await get<Resolution>("/v1/tracks/resolve?isrc=ZZ0000000000&title=Night%20Drive&artist=DJ%20Sample");
    assert.equal(body.matchedBy, "title_artist");
    assert.deepEqual(titles(body.tracks), ["Night Drive"]);
  });

  it("respects kind", async () => {
    const song = await get<Resolution>("/v1/tracks/resolve?title=Famous%20Speech&artist=A%20Speaker");
    assert.deepEqual(song.tracks, []);
    const speech = await get<Resolution>("/v1/tracks/resolve?title=Famous%20Speech&artist=A%20Speaker&kind=speech");
    assert.deepEqual(titles(speech.tracks), ["Famous Speech"]);
  });

  it("answers an unknown song with an empty match, not an error", async () => {
    assert.deepEqual(await get("/v1/tracks/resolve?title=Nothing&artist=Nobody"), { matchedBy: null, tracks: [] });
  });

  it("needs an ISRC or both title and artist", async () => {
    const body = await get<ErrorResponse>("/v1/tracks/resolve?title=Night%20Drive", 400);
    assert.equal(body.error.code, "invalid_request");
  });
});

describe("GET /v1/tracks/:id", () => {
  it("returns credits, identifiers, works, disclosure, and other recordings of the song", async () => {
    const track = await get<TrackDetail>(`/v1/tracks/${ids.funkyBreak}`);
    assert.equal(track.id, ids.funkyBreak);
    assert.equal(track.isrc, "USAAA6900001");
    assert.deepEqual(track.identifiers, [
      { namespace: "musicbrainz_recording", identifier: "00000000-0000-4000-8000-00000000000a" },
      { namespace: "isrc", identifier: "USAAA6900001" },
    ]);
    assert.deepEqual(track.artists, [
      { id: "artist_fixture_originals", name: "The Originals", creditedName: null, joinPhrase: null },
    ]);
    assert.deepEqual(track.contributors, [
      { name: "Pat Producer", role: "producer", artistId: null, creditedName: null },
    ]);
    assert.deepEqual(track.works, [
      { id: "work_fixture_funky_break", title: "Funky Break", iswcs: ["T-000.000.001-0"] },
    ]);
    assert.equal(track.lineageDisclosure?.classification, "human");
    // Shares the ISRC, so it is the same song.
    assert.deepEqual(titles(track.versions), ["Funky Break Pt. 1"]);
  });

  it("groups pressings with the same normalized title and artist", async () => {
    const track = await get<TrackDetail>(`/v1/tracks/${ids.cityAnthem}`);
    assert.deepEqual(titles(track.versions), ["City Anthem (Radio Edit)"]);
    assert.equal(track.lineageDisclosure, null);
  });

  it("404s an unknown id and 400s a malformed one", async () => {
    assert.equal((await get<ErrorResponse>("/v1/tracks/node_unknown", 404)).error.code, "track_not_found");
    assert.equal((await get<ErrorResponse>("/v1/tracks/not-an-id", 400)).error.code, "invalid_request");
  });
});

describe("GET /v1/tracks/:id/generations", () => {
  it("uses each unclustered node as its own cluster and skips unpublished edges", async () => {
    const family = await get<{ root: { track: { title: string } }; generations: {
      role: string; offset: number; records: { track: { title: string } }[] }[] }>(
      `/v1/tracks/${ids.funkyBreak}/generations`,
    );
    assert.equal(family.root.track.title, "Funky Break");
    assert.deepEqual(family.generations.map((g) => [g.role, g.offset]),
      [["thisSong", 0], ["after", 1], ["after", 2]]);
    assert.deepEqual(family.generations[1]!.records.map((r) => r.track.title),
      ["City Anthem (Radio Edit)", "City Anthem", "Night Drive"]);
    const candidate = await get<{ generations: { role: string }[] }>(`/v1/tracks/${ids.unreviewed}/generations`);
    assert.deepEqual(candidate.generations.map((g) => g.role), ["thisSong"]);
  });

  it("404s when the canonical id is absent", async () => {
    assert.equal((await get<ErrorResponse>("/v1/tracks/node_unknown/generations", 404)).error.code,
      "track_not_found");
  });
});

describe("GET /v1/tracks/:id/relationships", () => {
  it("covers the whole song, one relationship per related song, never candidates", async () => {
    const body = await get<Relationships>(`/v1/tracks/${ids.funkyBreak}/relationships`);
    assert.deepEqual(body.sources, { total: 0, items: [] });
    assert.equal(body.derivatives.total, 3);
    assert.deepEqual(
      body.derivatives.items.map((r) => [r.source.title, r.relationshipType, r.destination.title]),
      [
        // Both pressings of City Anthem sample the break; the one that says what it took wins.
        ["Funky Break", "sampled", "City Anthem"],
        // Reached through Funky Break Pt. 1, which shares the ISRC.
        ["Funky Break Pt. 1", "sampled", "Late Echo"],
        ["Funky Break", "sampled", "Night Drive"],
      ],
    );
  });

  it("carries segments and provenance", async () => {
    const body = await get<Relationships>(`/v1/tracks/${ids.funkyBreak}/relationships`);
    const [anthem] = body.derivatives.items;
    assert.deepEqual(anthem!.segments, [
      {
        element: "drums (drum set)",
        atInSourceMs: 85_000,
        atInDestinationMs: 0,
        durationMs: 4_000,
        sampleType: "looped",
        pitchShiftSemitones: null,
        tempoRatio: null,
        isReversed: null,
        isLooped: true,
      },
    ]);
    assert.deepEqual(anthem!.provenance, {
      sources: ["curated", "musicbrainz"],
      sourceKinds: ["community_database", "human_curated"],
      assertionCount: 2,
      isVerified: true,
      isInference: false,
      confidence: null,
      evidenceExcerpt: "Liner notes credit the break.",
      evidenceUrl: "https://example.org/liner-notes",
    });
  });

  it("hides relationships between recordings of the same song", async () => {
    const body = await get<Relationships>(`/v1/tracks/${ids.cityAnthem}/relationships`);
    assert.deepEqual(titles(body.sources.items.map((r) => r.source)), ["Funky Break"]);
    const [echo] = body.derivatives.items;
    assert.equal(body.derivatives.total, 1);
    assert.equal(echo!.relationshipType, "interpolated");
    assert.equal(echo!.destination.title, "Late Echo");
    assert.equal(echo!.provenance.isInference, true);
  });

  it("keeps different relationship types apart and includes non-song sources", async () => {
    const echo = await get<Relationships>(`/v1/tracks/${ids.lateEcho}/relationships`);
    assert.deepEqual(
      echo.sources.items.map((r) => [r.relationshipType, r.source.title]),
      [["interpolated", "City Anthem (Radio Edit)"], ["sampled", "Funky Break Pt. 1"]],
    );
    const drive = await get<Relationships>(`/v1/tracks/${ids.nightDrive}/relationships`);
    assert.deepEqual(
      drive.sources.items.map((r) => [r.source.kind, r.source.title]),
      [["speech", "Famous Speech"], ["song", "Funky Break"]],
    );
  });

  it("limits each direction but reports the full total", async () => {
    const body = await get<Relationships>(`/v1/tracks/${ids.funkyBreak}/relationships?limit=1`);
    assert.equal(body.derivatives.total, 3);
    assert.equal(body.derivatives.items.length, 1);
  });

  it("never serves a candidate, even from its own side", async () => {
    const body = await get<Relationships>(`/v1/tracks/${ids.unreviewed}/relationships`);
    assert.deepEqual(body, { sources: { total: 0, items: [] }, derivatives: { total: 0, items: [] } });
  });
});

/** The tree as indented lines: title, <relationship to parent>, +hidden, cycle. */
const outline = (lineage: Lineage) =>
  lineage.nodes.map(
    (n) =>
      "  ".repeat(n.depth) +
      n.track.title +
      (n.relationship ? ` <${n.relationship.relationshipType}>` : "") +
      (n.hiddenChildCount ? ` +${n.hiddenChildCount}` : "") +
      (n.isCycle ? " cycle" : ""),
  );

describe("GET /v1/tracks/:id/lineage", () => {
  it("walks sources generation by generation, across every recording of each song", async () => {
    const lineage = await get<Lineage>(`/v1/tracks/${ids.lateEcho}/lineage`);
    assert.equal(lineage.direction, "sources");
    assert.deepEqual(outline(lineage), [
      "Late Echo",
      "  City Anthem (Radio Edit) <interpolated>",
      // The radio edit's lineage includes the album cut's sample.
      "    Funky Break <sampled>",
      "  Funky Break Pt. 1 <sampled>",
    ]);
    assert.deepEqual(
      lineage.nodes.map((n) => [n.id, n.parentId]),
      [["0", null], ["0.0", "0"], ["0.0.0", "0.0"], ["0.1", "0"]],
    );
    const [, radioEdit] = lineage.nodes;
    assert.equal(radioEdit!.relationship!.source.title, "City Anthem (Radio Edit)");
    assert.equal(radioEdit!.relationship!.destination.title, "Late Echo");
  });

  it("walks derivatives when asked", async () => {
    const lineage = await get<Lineage>(`/v1/tracks/${ids.funkyBreak}/lineage?direction=derivatives`);
    assert.deepEqual(outline(lineage), [
      "Funky Break",
      "  City Anthem <sampled>",
      "    Late Echo <interpolated>",
      "  Late Echo <sampled>",
      "  Night Drive <sampled>",
    ]);
  });

  it("counts what the limits and the depth leave out", async () => {
    const narrow = await get<Lineage>(`/v1/tracks/${ids.funkyBreak}/lineage?direction=derivatives&rootLimit=1`);
    assert.deepEqual(outline(narrow), ["Funky Break +2", "  City Anthem <sampled>", "    Late Echo <interpolated>"]);
    const shallow = await get<Lineage>(`/v1/tracks/${ids.funkyBreak}/lineage?direction=derivatives&depth=1`);
    assert.deepEqual(outline(shallow), [
      "Funky Break",
      "  City Anthem <sampled> +1",
      "  Late Echo <sampled>",
      "  Night Drive <sampled>",
    ]);
  });

  it("stops at non-song sources and at songs already on the path", async () => {
    assert.deepEqual(outline(await get<Lineage>(`/v1/tracks/${ids.nightDrive}/lineage`)), [
      "Night Drive",
      "  Famous Speech <sampled>",
      "  Funky Break <sampled>",
    ]);
    assert.deepEqual(outline(await get<Lineage>(`/v1/tracks/${ids.loopOne}/lineage`)), [
      "Loop One",
      "  Loop Two <sampled>",
      "    Loop One <sampled> cycle",
    ]);
  });

  it("stays within the node budget and says when it cut", async () => {
    const trackId = (await catalog.findTrackId(db, ids.funkyBreak))!;
    const options = { direction: "derivatives" as const, maxDepth: 3, rootLimit: 10, childLimit: 4 };
    const cut = await catalog.lineage(db, trackId, { ...options, maxNodes: 2 });
    assert.equal(cut.truncated, true);
    // What the budget cut still counts as hidden, so nothing silently disappears.
    assert.deepEqual(outline(cut), ["Funky Break +2", "  City Anthem <sampled> +1"]);
    assert.equal((await catalog.lineage(db, trackId, { ...options, maxNodes: 500 })).truncated, false);
  });

  it("404s an unknown track", async () => {
    assert.equal((await get<ErrorResponse>("/v1/tracks/node_unknown/lineage", 404)).error.code, "track_not_found");
  });
});

describe("GET /v1/tracks/:id/siblings", () => {
  it("finds the crowd around a shared source, one recording per song", async () => {
    const { groups } = await get<{ groups: SiblingGroup[] }>(`/v1/tracks/${ids.nightDrive}/siblings`);
    assert.deepEqual(
      groups.map((g) => [g.source.title, g.total, titles(g.tracks)]),
      [["Funky Break", 1, ["City Anthem"]]],
    );
  });

  it("leaves out the song's own pressings", async () => {
    const { groups } = await get<{ groups: SiblingGroup[] }>(`/v1/tracks/${ids.cityAnthem}/siblings`);
    assert.deepEqual(
      groups.map((g) => [g.source.title, g.total, titles(g.tracks)]),
      [["Funky Break", 1, ["Night Drive"]]],
    );
  });
});

describe("GET /v1/search", () => {
  it("needs every word in the title or artist, one recording per song", async () => {
    assert.deepEqual(titles((await get<{ tracks: TrackSummary[] }>("/v1/search?q=anthem%20mc")).tracks), ["City Anthem"]);
    assert.deepEqual(titles((await get<{ tracks: TrackSummary[] }>("/v1/search?q=funky")).tracks), [
      "Funky Break",
      "Funky Break Pt. 1",
    ]);
  });

  it("searches songs only", async () => {
    assert.deepEqual((await get<{ tracks: TrackSummary[] }>("/v1/search?q=famous")).tracks, []);
  });
});

describe("the service", () => {
  it("publishes an OpenAPI document with named schemas and operations", async () => {
    type Operation = { operationId: string };
    const spec = await get<{
      openapi: string;
      paths: Record<string, { get: Operation }>;
      components: { schemas: Record<string, unknown> };
    }>("/openapi.json");
    assert.equal(spec.openapi, "3.1.0");
    assert.deepEqual(
      Object.entries(spec.paths).map(([path, { get }]) => [path, get.operationId]).sort(),
      [
        ["/v1/search", "searchTracks"],
        ["/v1/tracks/resolve", "resolveTrack"],
        ["/v1/tracks/{id}", "getTrack"],
        ["/v1/tracks/{id}/generations", "getGenerations"],
        ["/v1/tracks/{id}/lineage", "getLineage"],
        ["/v1/tracks/{id}/relationships", "getRelationships"],
        ["/v1/tracks/{id}/siblings", "getSiblings"],
      ],
    );
    for (const name of ["TrackSummary", "TrackDetail", "Relationship", "Lineage", "LineageNode", "GenerationsFamily", "Generation", "Error"]) {
      assert.ok(spec.components.schemas[name], `components.schemas.${name}`);
    }
    // Named schemas appear once, then by reference.
    assert.equal(JSON.stringify(spec.paths).includes('"title":"TrackSummary"'), false);
  });

  it("answers unknown routes in the error shape", async () => {
    assert.equal((await get<ErrorResponse>("/v1/nope", 404)).error.code, "not_found");
  });
});
