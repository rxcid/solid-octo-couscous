/**
 * Catalog reads behind the v1 API. Each mirrors a SampleDatabase query in
 * Sinc's Models.swift, so the online app answers as the offline one does:
 *
 *   resolveTracks   -> the identity_root/matched_root CTEs
 *   songRoot        -> the root CTE
 *   relationships   -> musicDNARelationships
 *   siblings        -> siblings
 *   search          -> search
 *
 * A song is every recording with the same normalized title, artist, and
 * kind, plus every recording sharing an ISRC with one of them. The app roots
 * a scan the same way; Sinc's cluster_id (shared work, artist, and title)
 * only ever groups recordings that already share a name, so it adds nothing.
 *
 * Only `published` relationships are ever read.
 */
import { type SQL, sql } from "drizzle-orm";
import type {
  Relationship,
  Relationships,
  Resolution,
  Segment,
  SiblingGroup,
  TrackDetail,
  TrackSummary,
} from "../api/schemas.js";
import type { Db } from "../db/client.js";
import { type TrackKind, normalize, normalizeIdentifier } from "./identity.js";

/** An int[] parameter, usable as `= ANY(...)` or with unnest(). */
const intArray = (values: number[]) => sql`${sql.param(values)}::int[]`;

async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

// --- identity ---------------------------------------------------------------

/**
 * The recordings a recognition result names. An ISRC match wins outright;
 * otherwise every recording with the same normalized title, artist, and kind
 * matches, since pressings of one song often share them.
 */
export async function resolveTracks(
  db: Db,
  input: { isrc?: string; title?: string; artist?: string; kind: TrackKind },
): Promise<{ matchedBy: Resolution["matchedBy"]; trackIds: number[] }> {
  const isrc = input.isrc ? normalizeIdentifier(input.isrc) : "";
  if (isrc) {
    const byIsrc = await rows<{ id: number }>(db, sql`
      SELECT DISTINCT track_id AS id FROM track_identifiers
      WHERE namespace = 'isrc' AND identifier = ${isrc}
      ORDER BY id`);
    if (byIsrc.length) return { matchedBy: "isrc", trackIds: byIsrc.map((r) => r.id) };
  }
  const title = normalize(input.title ?? "");
  const artist = normalize(input.artist ?? "");
  if (title && artist) {
    const byText = await rows<{ id: number }>(db, sql`
      SELECT id FROM tracks
      WHERE norm_title = ${title} AND norm_artist = ${artist} AND kind = ${input.kind}
      ORDER BY id`);
    if (byText.length) return { matchedBy: "title_artist", trackIds: byText.map((r) => r.id) };
  }
  return { matchedBy: null, trackIds: [] };
}

export async function findTrackId(db: Db, canonicalId: string): Promise<number | null> {
  const [row] = await rows<{ id: number }>(db, sql`SELECT id FROM tracks WHERE canonical_id = ${canonicalId}`);
  return row?.id ?? null;
}

/** Every recording of the songs these tracks belong to, the tracks included. */
export async function songRoot(db: Db, trackIds: number[]): Promise<number[]> {
  const found = await rows<{ id: number }>(db, sql`
    WITH given AS (SELECT unnest(${intArray(trackIds)}) AS id),
    same_isrc AS (
      SELECT other.track_id AS id
      FROM track_identifiers mine
      JOIN track_identifiers other
        ON other.namespace = 'isrc' AND other.identifier = mine.identifier
      WHERE mine.namespace = 'isrc' AND mine.track_id IN (SELECT id FROM given)
    ),
    matched AS (SELECT id FROM given UNION SELECT id FROM same_isrc)
    SELECT DISTINCT t.id
    FROM tracks m
    JOIN tracks t
      ON t.norm_title = m.norm_title AND t.norm_artist = m.norm_artist AND t.kind = m.kind
    WHERE m.id IN (SELECT id FROM matched)
    ORDER BY t.id`);
  return found.map((r) => r.id);
}

// --- tracks -----------------------------------------------------------------

type SummaryRow = {
  id: number;
  canonical_id: string;
  kind: TrackKind;
  title: string;
  artist_credit: string;
  release_year: number | null;
  isrc: string | null;
  mbid: string | null;
};

const toSummary = (r: SummaryRow): TrackSummary => ({
  id: r.canonical_id,
  kind: r.kind,
  title: r.title,
  artistCredit: r.artist_credit,
  releaseYear: r.release_year,
  isrc: r.isrc,
  musicbrainzRecordingId: r.mbid,
});

/** Summaries keyed by internal id, with the first ISRC and MusicBrainz id. */
export async function trackSummaries(db: Db, trackIds: number[]): Promise<Map<number, TrackSummary>> {
  if (!trackIds.length) return new Map();
  const found = await rows<SummaryRow>(db, sql`
    SELECT t.id, t.canonical_id, t.kind, t.title, t.artist_credit, t.release_year,
      (SELECT i.identifier FROM track_identifiers i
        WHERE i.track_id = t.id AND i.namespace = 'isrc'
        ORDER BY i.identifier LIMIT 1) AS isrc,
      (SELECT i.identifier FROM track_identifiers i
        WHERE i.track_id = t.id AND i.namespace = 'musicbrainz_recording'
        ORDER BY i.identifier LIMIT 1) AS mbid
    FROM tracks t
    WHERE t.id = ANY(${intArray([...new Set(trackIds)])})`);
  return new Map(found.map((r) => [r.id, toSummary(r)]));
}

/** Summaries in the order of the ids given. */
async function orderedSummaries(db: Db, trackIds: number[]): Promise<TrackSummary[]> {
  const byId = await trackSummaries(db, trackIds);
  return trackIds.map((id) => byId.get(id)!);
}

export async function trackDetail(db: Db, trackId: number): Promise<TrackDetail> {
  const [summaries, [track], identifiers, artists, contributors, works, [disclosure], versionIds] =
    await Promise.all([
      trackSummaries(db, [trackId]),
      rows<{ duration_ms: number | null; disambiguation: string | null }>(db, sql`
        SELECT duration_ms, disambiguation FROM tracks WHERE id = ${trackId}`),
      rows<TrackDetail["identifiers"][number]>(db, sql`
        SELECT namespace, identifier FROM track_identifiers
        WHERE track_id = ${trackId} ORDER BY namespace, identifier`),
      rows<TrackDetail["artists"][number]>(db, sql`
        SELECT a.canonical_id AS id, a.name, ta.credited_name AS "creditedName", ta.join_phrase AS "joinPhrase"
        FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
        WHERE ta.track_id = ${trackId} ORDER BY ta.position`),
      rows<TrackDetail["contributors"][number]>(db, sql`
        SELECT tc.contributor_name AS name, tc.role, a.canonical_id AS "artistId", tc.credited_name AS "creditedName"
        FROM track_contributors tc LEFT JOIN artists a ON a.id = tc.artist_id
        WHERE tc.track_id = ${trackId} ORDER BY tc.position, tc.role, tc.contributor_name`),
      rows<TrackDetail["works"][number]>(db, sql`
        SELECT w.canonical_id AS id, w.title,
          ARRAY(SELECT wi.identifier FROM work_identifiers wi
                WHERE wi.work_id = w.id AND wi.namespace = 'iswc' ORDER BY 1) AS iswcs
        FROM track_works tw JOIN works w ON w.id = tw.work_id
        WHERE tw.track_id = ${trackId} ORDER BY w.title, w.id`),
      rows<NonNullable<TrackDetail["lineageDisclosure"]>>(db, sql`
        SELECT classification, source, source_url AS "sourceUrl", evidence_text AS "evidenceText", confidence
        FROM track_lineage_disclosures WHERE track_id = ${trackId}`),
      songRoot(db, [trackId]),
    ]);
  return {
    ...summaries.get(trackId)!,
    durationMs: track!.duration_ms,
    disambiguation: track!.disambiguation,
    identifiers,
    artists,
    contributors,
    works,
    lineageDisclosure: disclosure ?? null,
    versions: await orderedSummaries(db, versionIds.filter((id) => id !== trackId)),
  };
}

// --- relationships -----------------------------------------------------------

type EdgeRow = {
  direction: "sources" | "derivatives";
  total: number;
  id: number;
  canonical_id: string;
  parent_track_id: number;
  child_track_id: number;
  relationship_type: Relationship["type"];
  notes: string | null;
  source_names: string[];
  source_kinds: string[];
  assertion_count: number;
  is_verified: boolean;
  is_inference: boolean;
  confidence: number | null;
  evidence_excerpt: string | null;
  evidence_url: string | null;
};

type SegmentRow = {
  sample_id: number;
  element: string | null;
  timestamp_parent: number | null;
  timestamp_child: number | null;
  duration_ms: number | null;
  sample_type: Segment["sampleType"];
  pitch_shift_semitones: number | null;
  tempo_ratio: number | null;
  is_reversed: boolean | null;
  is_looped: boolean | null;
};

/**
 * Everything the song takes from and everything that takes from it.
 *
 * The root covers every version of the song, so one related song can arrive
 * over several edges (a source sampled by the album cut and the radio edit).
 * Like the app, keep one per direction, relationship type, and related song,
 * preferring the edge that says what was borrowed, then the one with notes.
 * Edges between two versions of the song are the song related to itself.
 */
export async function relationships(db: Db, rootIds: number[], limit: number): Promise<Relationships> {
  const edges = await rows<EdgeRow>(db, sql`
    WITH root AS (SELECT unnest(${intArray(rootIds)}) AS id),
    adjacent AS (
      SELECT s.id, 'derivatives' AS direction, s.child_track_id AS other_id
      FROM samples s
      WHERE s.status = 'published'
        AND s.parent_track_id IN (SELECT id FROM root)
        AND s.child_track_id NOT IN (SELECT id FROM root)
      UNION ALL
      SELECT s.id, 'sources', s.parent_track_id
      FROM samples s
      WHERE s.status = 'published'
        AND s.child_track_id IN (SELECT id FROM root)
        AND s.parent_track_id NOT IN (SELECT id FROM root)
    ),
    ranked AS (
      SELECT a.id, a.direction, a.other_id,
        row_number() OVER (
          PARTITION BY a.direction, s.relationship_type, other.norm_title, other.norm_artist, other.kind
          ORDER BY
            NOT EXISTS (SELECT 1 FROM sample_segments g WHERE g.sample_id = s.id AND g.element IS NOT NULL),
            s.notes IS NULL,
            s.id
        ) AS rank
      FROM adjacent a
      JOIN samples s ON s.id = a.id
      JOIN tracks other ON other.id = a.other_id
    ),
    chosen AS (
      SELECT r.id, r.direction,
        count(*) OVER (PARTITION BY r.direction)::int AS total,
        row_number() OVER (PARTITION BY r.direction ORDER BY lower(other.title), other.id) AS position
      FROM ranked r JOIN tracks other ON other.id = r.other_id
      WHERE r.rank = 1
    )
    SELECT c.direction, c.total, s.id, s.canonical_id, s.parent_track_id, s.child_track_id,
      s.relationship_type, s.notes, p.*
    FROM chosen c
    JOIN samples s ON s.id = c.id
    CROSS JOIN LATERAL (
      SELECT
        coalesce(array_agg(DISTINCT a.source_name ORDER BY a.source_name), '{}') AS source_names,
        coalesce(array_agg(DISTINCT a.source_kind ORDER BY a.source_kind), '{}') AS source_kinds,
        count(*)::int AS assertion_count,
        coalesce(bool_or(a.verification_status = 'verified'), false) AS is_verified,
        coalesce(bool_or(a.source_kind = 'writer_credit_inference'), false) AS is_inference,
        max(a.confidence) AS confidence,
        (array_agg(a.evidence_text ORDER BY a.verification_status = 'verified' DESC, a.id)
          FILTER (WHERE trim(a.evidence_text) <> ''))[1] AS evidence_excerpt,
        (array_agg(a.source_url ORDER BY a.verification_status = 'verified' DESC, a.id)
          FILTER (WHERE trim(a.source_url) <> ''))[1] AS evidence_url
      FROM sample_assertions a WHERE a.sample_id = s.id
    ) p
    WHERE c.position <= ${limit}
    ORDER BY c.direction, c.position`);

  const edgeIds = edges.map((e) => e.id);
  const [summaries, segmentRows] = await Promise.all([
    trackSummaries(db, edges.flatMap((e) => [e.parent_track_id, e.child_track_id])),
    edgeIds.length
      ? rows<SegmentRow>(db, sql`
          SELECT sample_id, element, timestamp_parent, timestamp_child, duration_ms, sample_type,
            pitch_shift_semitones, tempo_ratio, is_reversed, is_looped
          FROM sample_segments WHERE sample_id = ANY(${intArray(edgeIds)})
          ORDER BY sample_id, timestamp_child NULLS LAST, id`)
      : Promise.resolve([]),
  ]);
  const segments = Map.groupBy(segmentRows, (g) => g.sample_id);

  const result: Relationships = {
    sources: { total: 0, items: [] },
    derivatives: { total: 0, items: [] },
  };
  for (const e of edges) {
    const page = result[e.direction];
    page.total = e.total;
    page.items.push({
      id: e.canonical_id,
      type: e.relationship_type,
      source: summaries.get(e.parent_track_id)!,
      destination: summaries.get(e.child_track_id)!,
      notes: e.notes,
      segments: (segments.get(e.id) ?? []).map((g) => ({
        element: g.element,
        atInSourceMs: g.timestamp_parent,
        atInDestinationMs: g.timestamp_child,
        durationMs: g.duration_ms,
        sampleType: g.sample_type,
        pitchShiftSemitones: g.pitch_shift_semitones,
        tempoRatio: g.tempo_ratio,
        isReversed: g.is_reversed,
        isLooped: g.is_looped,
      })),
      provenance: {
        sources: e.source_names,
        sourceKinds: e.source_kinds,
        assertionCount: e.assertion_count,
        isVerified: e.is_verified,
        isInference: e.is_inference,
        confidence: e.confidence,
        evidenceExcerpt: e.evidence_excerpt,
        evidenceUrl: e.evidence_url,
      },
    });
  }
  return result;
}

/**
 * Other songs built from the sources this song uses, grouped by source and
 * busiest source first. `total` is the true crowd size; `tracks` is trimmed
 * after ranking, so a trimmed number is never passed off as the real one.
 */
export async function siblings(
  db: Db,
  rootIds: number[],
  options: { perSource: number; sources: number },
): Promise<SiblingGroup[]> {
  const found = await rows<{ source_id: number; track_id: number; total: number }>(db, sql`
    WITH root AS (SELECT unnest(${intArray(rootIds)}) AS id),
    shared AS (
      SELECT DISTINCT parent_track_id AS source_id FROM samples
      WHERE status = 'published'
        AND child_track_id IN (SELECT id FROM root)
        AND parent_track_id NOT IN (SELECT id FROM root)
    ),
    crowd AS (
      -- One recording per song.
      SELECT DISTINCT ON (s.parent_track_id, t.norm_title, t.norm_artist, t.kind)
        s.parent_track_id AS source_id, s.child_track_id AS track_id
      FROM samples s JOIN tracks t ON t.id = s.child_track_id
      WHERE s.status = 'published'
        AND s.parent_track_id IN (SELECT source_id FROM shared)
        AND s.child_track_id NOT IN (SELECT id FROM root)
      ORDER BY s.parent_track_id, t.norm_title, t.norm_artist, t.kind, s.child_track_id
    ),
    counted AS (
      SELECT c.source_id, c.track_id,
        count(*) OVER (PARTITION BY c.source_id)::int AS total,
        row_number() OVER (PARTITION BY c.source_id ORDER BY lower(t.title), t.id) AS position
      FROM crowd c JOIN tracks t ON t.id = c.track_id
    ),
    busiest AS (
      SELECT source_id, dense_rank() OVER (ORDER BY total DESC, source_id) AS rank
      FROM counted GROUP BY source_id, total
    )
    SELECT c.source_id, c.track_id, c.total
    FROM counted c JOIN busiest b ON b.source_id = c.source_id
    WHERE c.position <= ${options.perSource} AND b.rank <= ${options.sources}
    ORDER BY b.rank, c.position`);

  const summaries = await trackSummaries(db, found.flatMap((r) => [r.source_id, r.track_id]));
  const groups = new Map<number, SiblingGroup>();
  for (const r of found) {
    let group = groups.get(r.source_id);
    if (!group) {
      group = { source: summaries.get(r.source_id)!, total: r.total, tracks: [] };
      groups.set(r.source_id, group);
    }
    group.tracks.push(summaries.get(r.track_id)!);
  }
  return [...groups.values()];
}

// --- search -------------------------------------------------------------------

/**
 * Songs whose normalized title or artist contains every query token, one
 * recording per song: exact title first, then title prefix, exact artist,
 * newest.
 */
export async function search(db: Db, query: string, limit: number): Promise<TrackSummary[]> {
  const full = normalize(query);
  const tokens = full.split(" ").filter(Boolean).slice(0, 8);
  if (!tokens.length) return [];
  const matchesEveryToken = sql.join(
    tokens.map((token) => sql`(strpos(t.norm_title, ${token}) > 0 OR strpos(t.norm_artist, ${token}) > 0)`),
    sql` AND `,
  );
  const found = await rows<{ id: number }>(db, sql`
    WITH matches AS (
      SELECT t.id, t.title, t.artist_credit, t.release_year, t.norm_title, t.norm_artist,
        (t.norm_title = ${full}) AS exact_title,
        (strpos(t.norm_title, ${full}) = 1) AS title_prefix,
        (t.norm_artist = ${full}) AS exact_artist
      FROM tracks t
      WHERE t.kind = 'song' AND ${matchesEveryToken}
    ),
    best AS (
      -- One recording per song, the plainest title first.
      SELECT m.*, row_number() OVER (
        PARTITION BY norm_title, norm_artist ORDER BY length(title), id
      ) AS n
      FROM matches m
    )
    SELECT id FROM best WHERE n = 1
    ORDER BY exact_title DESC, title_prefix DESC, exact_artist DESC,
      release_year DESC NULLS LAST, lower(title), lower(artist_credit), id
    LIMIT ${limit}`);
  return orderedSummaries(db, found.map((r) => r.id));
}
