import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import type { Db } from "../db/client.js";
import { env } from "../env.js";
import { setupTestDb } from "../test/database.js";
import {
  type GenerationsFamily, type GenerationsRecord, type HandoffIndex,
  chronological, generations, generationsOfTracks, loadHandoffIndex, scalarOrder,
} from "./generations.js";
import type { TrackKind } from "./identity.js";
import { resolveTracks } from "./repository.js";

const sincDir = process.env.SINC_DIR ?? resolve(import.meta.dirname, "../../../../Sincapp");
const skipCatalogParity = process.env.SKIP_SINC_CATALOG_PARITY === "1";
type Request = { canonicalId: string | null; isrc: string | null; title: string; artist: string; kind: TrackKind };
type Case = { name: string; request: Request; maxClusters: number; family: unknown };
type Fixture = {
  catalogSha256: string; cases: Case[];
  sweep: { byId: Record<string, string>; byTitle: Record<string, string> };
};

function compareFields(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((value, index) => compareFields(actual[index], value, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path} must be an object`);
    const wanted = Object.keys(expected).sort();
    assert.deepEqual(Object.keys(actual).sort(), wanted, `${path} fields`);
    for (const key of wanted) compareFields((actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

/** GenerationsParityFixtureTests.digest: the same plain encoding, hashed the same way. */
function canonical(value: unknown): string {
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") {
    assert.ok(Number.isInteger(value), `non-integer ${value}`);
    return `i${value};`;
  }
  if (typeof value === "string") return `s${Buffer.byteLength(value, "utf8")}:${value}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join("")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => canonical(key) + canonical(object[key])).join("")}}`;
}
const digest = (family: GenerationsFamily | null) =>
  createHash("sha256").update(canonical(family), "utf8").digest("hex").slice(0, 16);

/**
 * Sinc's generationsRoots for a request, then the family. Sinc has no alias
 * stage, so an alias-only match is no match here.
 */
async function sincFamily(db: Db, request: Request, maxClusters: number, index?: HandoffIndex) {
  const { matchedBy, trackIds } = await resolveTracks(db, {
    canonicalId: request.canonicalId ?? undefined, isrc: request.isrc ?? undefined,
    title: request.title, artist: request.artist, kind: request.kind,
  });
  return generationsOfTracks(db, matchedBy === "alias" ? [] : trackIds, maxClusters, index);
}

/**
 * One catalog's parity: the fixture Sinc's real Swift builder exported from
 * that exact catalog, imported into its own _test database.
 */
function parity(label: string, options: { fixture: string; catalog: string | undefined; database: string }) {
  const fixturePath = join(import.meta.dirname, "__fixtures__", options.fixture);
  const sourcePath = join(sincDir, "tools", "data", options.fixture);
  const skip = skipCatalogParity ? "SKIP_SINC_CATALOG_PARITY is set"
    : !options.catalog ? `no ${label} catalog given` : false;

  describe(`GenerationsBuilder parity on the ${label} catalog`, { skip }, () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    let db: Db;
    let closeDb: () => Promise<void>;
    let app: Awaited<ReturnType<typeof buildApp>>;
    let index: HandoffIndex;

    before(async () => {
      const catalog = options.catalog!;
      if (!existsSync(catalog)) throw new Error(`${label} catalog missing: ${catalog}`);
      const hash = createHash("sha256").update(readFileSync(catalog)).digest("hex");
      assert.equal(hash, fixture.catalogSha256,
        `${options.fixture} was exported from another catalog; re-export it from Sinc for this one`);
      const parityUrl = new URL(env.DATABASE_URL);
      parityUrl.pathname = `/${options.database}`;
      process.env.TEST_DATABASE_URL = parityUrl.toString();
      const test = await setupTestDb();
      db = test.db;
      closeDb = () => test.pool.end();
      // A dedicated _test database protects both development data and the other
      // API tests. Replace it with the same bytes Swift used.
      const imported = spawnSync(process.execPath,
        ["--import", "tsx", resolve(import.meta.dirname, "../scripts/import-sinc.ts"),
          "--replace", "--catalog", catalog],
        { cwd: resolve(import.meta.dirname, "../.."),
          env: { ...process.env, DATABASE_URL: parityUrl.toString() }, encoding: "utf8", maxBuffer: 1024 * 1024 });
      assert.equal(imported.status, 0, imported.stderr || imported.stdout);
      app = await buildApp({ db, corsOrigin: "*", logger: false });
      index = await loadHandoffIndex(db);
    });

    after(async () => { await app?.close(); await closeDb?.(); });

    it("uses the exact fixture exported by Sinc's real Swift builder", {
      skip: !existsSync(sourcePath) && `no Sinc checkout at ${sincDir}`,
    }, () => assert.deepEqual(fixture, JSON.parse(readFileSync(sourcePath, "utf8"))));

    for (const vector of fixture.cases) {
      it(`matches every Swift field for ${vector.name}`, async () => {
        compareFields(await sincFamily(db, vector.request, vector.maxClusters), vector.family, vector.name);
        if (vector.maxClusters !== 1500) return;
        if (vector.request.canonicalId) {
          const response = await app.inject({ method: "GET", url: `/v1/tracks/${vector.request.canonicalId}/generations` });
          assert.equal(response.statusCode, 200, response.body);
          compareFields(response.json(), vector.family, `${vector.name}.endpoint`);
        }
        // What the app asks for a scan: the same request, resolved on the server.
        const query = new URLSearchParams(Object.entries(vector.request)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
        const scan = await app.inject({ method: "GET", url: `/v1/generations?${query}` });
        if (vector.family === null) {
          assert.equal(scan.statusCode, 404, scan.body);
        } else {
          assert.equal(scan.statusCode, 200, scan.body);
          compareFields(scan.json(), vector.family, `${vector.name}.resolved`);
        }
      });
    }

    it("matches Swift's family digest for every swept catalog id", async () => {
      const differing: string[] = [];
      for (const [id, expected] of Object.entries(fixture.sweep.byId)) {
        if (digest(await generations(db, id, 1500, index)) !== expected) differing.push(id);
      }
      assert.deepEqual(differing, [], `${differing.length} of ${Object.keys(fixture.sweep.byId).length} differ`);
    });

    it("matches Swift's family digest for every song spanning several clusters", async () => {
      const differing: string[] = [];
      for (const [id, expected] of Object.entries(fixture.sweep.byTitle)) {
        const [first] = (await db.execute<{ title: string; artist: string; kind: TrackKind }>(
          sql`SELECT title, artist_credit AS artist, kind FROM tracks WHERE canonical_id = ${id}`)).rows;
        assert.ok(first, `${id} is missing`);
        const family = await sincFamily(db, { canonicalId: null, isrc: null, ...first }, 1500, index);
        if (digest(family) !== expected) differing.push(id);
      }
      assert.deepEqual(differing, [], `${differing.length} of ${Object.keys(fixture.sweep.byTitle).length} differ`);
    });

    it("returns 404 for a missing catalog track", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/tracks/node_unknown/generations" });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, "track_not_found");
    });
  });
}

// The catalog Sinc bundles today, and the next release when its path is given.
parity("bundled", {
  fixture: "generations_vectors.json",
  catalog: join(sincDir, "Sinc", "Resources", "samples.sqlite"),
  database: "music_sample_graph_parity_test",
});
parity("candidate", {
  fixture: "generations_vectors_candidate.json",
  catalog: process.env.SINC_CANDIDATE_CATALOG,
  database: "music_sample_graph_parity_candidate_test",
});

describe("Generations record order", () => {
  const record = (id: string, title: string, earliestYear: number | null): GenerationsRecord => ({
    id, earliestYear, handoffTypes: [], connectedTitles: [], alsoFromTitles: [],
    track: { title, artist: "", year: earliestYear, kind: "song", isrc: null, musicBrainzRecordingID: null,
      catalogRecordingID: id },
  });
  const order = (records: GenerationsRecord[]) => [...records].sort(chronological).map((r) => r.id);

  it("puts records of one year in title order, as Swift does", () => {
    // v17 dates most records, so equal years are common: Juicy's family had
    // "Let It Go (remix)" ahead of "Let It Go" before this was fixed.
    const remix = record("2|let it go remix", "Let It Go (remix)", 2007);
    const original = record("1|let it go", "Let It Go", 2007);
    assert.deepEqual(order([remix, original]), ["1|let it go", "2|let it go remix"]);
    assert.deepEqual(order([original, remix]), ["1|let it go", "2|let it go remix"]);
  });

  it("puts dated records first, oldest first, and undated ones by title", () => {
    const records = [record("a", "Zed", null), record("b", "Alpha", null), record("c", "Mid", 1990),
      record("d", "Early", 1971), record("e", "Also 1990", 1990)];
    assert.deepEqual(order(records), ["d", "e", "c", "b", "a"]);
  });

  it("breaks a title tie by comparing ids as Swift strings", () => {
    // A locale collation would put "15|x" first; Swift's String < compares scalars.
    assert.deepEqual(order([record("15|x", "Intro", null), record("155|x", "Intro", null)]), ["155|x", "15|x"]);
    assert.ok(scalarOrder("-7|x", "12|x") < 0);
  });
});
