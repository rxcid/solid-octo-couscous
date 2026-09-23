/**
 * A small catalog that exercises every rule the API applies:
 *
 *   Funky Break ──sampled──▶ City Anthem            (drums, verified, 2 sources)
 *   Funky Break ──sampled──▶ City Anthem (Radio Edit)  another pressing of the same song
 *   Funky Break ──sampled──▶ Night Drive
 *   Funky Break ──sampled──▶ Unreviewed Claim       still a candidate: never served
 *   Funky Break Pt. 1 ─sampled─▶ Late Echo          shares Funky Break's ISRC
 *   City Anthem (Radio Edit) ─interpolated─▶ Late Echo   inferred from writer credits
 *   City Anthem ──remixed──▶ City Anthem (Radio Edit)    inside one song: never served
 *   Famous Speech ──sampled──▶ Night Drive          a speech source
 */
import type { TrackKind } from "../catalog/identity.js";
import { normalize, textIdentity } from "../catalog/identity.js";
import type { Db } from "../db/client.js";
import * as s from "../db/schema.js";

type TrackSpec = {
  title: string;
  artist: string;
  year: number;
  kind?: TrackKind;
  isrc?: string;
  mbid?: string;
};

async function track(db: Db, spec: TrackSpec) {
  const kind = spec.kind ?? "song";
  const identity = spec.mbid
    ? { identityKey: `mb:recording:${spec.mbid}`, canonicalId: `node_mb_${spec.mbid}` }
    : textIdentity(kind, spec.title, spec.artist);
  const [row] = await db
    .insert(s.tracks)
    .values({
      ...identity,
      kind,
      title: spec.title,
      artistCredit: spec.artist,
      normTitle: normalize(spec.title),
      normArtist: normalize(spec.artist),
      releaseYear: spec.year,
    })
    .returning();
  const identifiers = [
    spec.isrc && { namespace: "isrc" as const, identifier: spec.isrc },
    spec.mbid && { namespace: "musicbrainz_recording" as const, identifier: spec.mbid },
  ].filter((i) => !!i);
  if (identifiers.length) {
    await db.insert(s.trackIdentifiers).values(identifiers.map((i) => ({ ...i, trackId: row!.id, source: "fixture" })));
  }
  return row!;
}

type Claim = Omit<s.NewSampleAssertion, "sampleId">;

async function edge(
  db: Db,
  parent: s.Track,
  child: s.Track,
  options: {
    type?: s.NewSample["relationshipType"];
    status?: s.NewSample["status"];
    claims: Claim[];
    segments?: Omit<s.NewSampleSegment, "sampleId">[];
  },
) {
  const type = options.type ?? "sampled";
  const [row] = await db
    .insert(s.samples)
    .values({
      canonicalId: `edge_${parent.id}_${child.id}_${type}`,
      parentTrackId: parent.id,
      childTrackId: child.id,
      relationshipType: type,
      status: options.status ?? "published",
    })
    .returning();
  await db.insert(s.sampleAssertions).values(options.claims.map((c) => ({ ...c, sampleId: row!.id })));
  if (options.segments?.length) {
    await db.insert(s.sampleSegments).values(options.segments.map((g) => ({ ...g, sampleId: row!.id })));
  }
  return row!;
}

const musicbrainz: Claim = { sourceName: "musicbrainz", sourceKind: "community_database" };

export async function seedCatalog(db: Db) {
  const funkyBreak = await track(db, {
    title: "Funky Break",
    artist: "The Originals",
    year: 1969,
    isrc: "USAAA6900001",
    mbid: "00000000-0000-4000-8000-00000000000a",
  });
  const funkyBreakPart1 = await track(db, {
    title: "Funky Break Pt. 1",
    artist: "The Originals",
    year: 1969,
    isrc: "USAAA6900001",
  });
  const cityAnthem = await track(db, {
    title: "City Anthem",
    artist: "MC Example",
    year: 1988,
    isrc: "USBBB8800001",
    mbid: "00000000-0000-4000-8000-00000000000b",
  });
  const cityAnthemEdit = await track(db, {
    title: "City Anthem (Radio Edit)",
    artist: "MC Example",
    year: 1988,
    mbid: "00000000-0000-4000-8000-00000000000c",
  });
  const nightDrive = await track(db, { title: "Night Drive", artist: "DJ Sample", year: 1990 });
  const lateEcho = await track(db, { title: "Late Echo", artist: "The Revival", year: 2005 });
  const unreviewed = await track(db, { title: "Unreviewed Claim", artist: "Somebody", year: 2020 });
  const speech = await track(db, { title: "Famous Speech", artist: "A Speaker", year: 1963, kind: "speech" });

  const [originals] = await db
    .insert(s.artists)
    .values({ canonicalId: "artist_fixture_originals", name: "The Originals" })
    .returning();
  await db.insert(s.trackArtists).values({ trackId: funkyBreak.id, artistId: originals!.id, position: 0 });
  await db.insert(s.trackContributors).values({
    trackId: funkyBreak.id,
    contributorName: "Pat Producer",
    role: "producer",
    source: "fixture",
  });
  const [work] = await db
    .insert(s.works)
    .values({ canonicalId: "work_fixture_funky_break", title: "Funky Break" })
    .returning();
  await db.insert(s.trackWorks).values({ trackId: funkyBreak.id, workId: work!.id, source: "fixture" });
  await db.insert(s.workIdentifiers).values({
    workId: work!.id,
    namespace: "iswc",
    identifier: "T-000.000.001-0",
    source: "fixture",
  });
  await db.insert(s.trackLineageDisclosures).values({
    trackId: funkyBreak.id,
    classification: "human",
    source: "fixture",
  });

  await edge(db, funkyBreak, cityAnthem, {
    claims: [
      {
        sourceName: "curated",
        sourceKind: "human_curated",
        verificationStatus: "verified",
        evidenceText: "Liner notes credit the break.",
        sourceUrl: "https://example.org/liner-notes",
      },
      musicbrainz,
    ],
    segments: [
      {
        element: "drums (drum set)",
        timestampParent: 85_000,
        timestampChild: 0,
        durationMs: 4_000,
        sampleType: "looped",
        isLooped: true,
      },
    ],
  });
  await edge(db, funkyBreak, cityAnthemEdit, { claims: [musicbrainz] });
  await edge(db, funkyBreak, nightDrive, {
    claims: [{ sourceName: "wikipedia", sourceKind: "wikipedia_prose", evidenceText: "Wikipedia says so." }],
  });
  await edge(db, funkyBreak, unreviewed, { status: "candidate", claims: [musicbrainz] });
  await edge(db, funkyBreakPart1, lateEcho, { claims: [musicbrainz] });
  await edge(db, cityAnthemEdit, lateEcho, {
    type: "interpolated",
    claims: [{ sourceName: "writer_credits", sourceKind: "writer_credit_inference", verificationStatus: "inferred" }],
  });
  await edge(db, cityAnthem, cityAnthemEdit, { type: "remixed", claims: [musicbrainz] });
  await edge(db, speech, nightDrive, {
    claims: [{ sourceName: "curated", sourceKind: "human_curated", verificationStatus: "verified" }],
  });

  const id = (t: s.Track) => t.canonicalId;
  return {
    funkyBreak: id(funkyBreak),
    funkyBreakPart1: id(funkyBreakPart1),
    cityAnthem: id(cityAnthem),
    cityAnthemEdit: id(cityAnthemEdit),
    nightDrive: id(nightDrive),
    lateEcho: id(lateEcho),
    unreviewed: id(unreviewed),
    speech: id(speech),
  };
}
