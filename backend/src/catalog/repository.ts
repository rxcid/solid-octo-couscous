/**
 * Catalog reads behind the v1 API. Each mirrors a SampleDatabase query in
 * Sinc's Models.swift, so the online app answers as the offline one does:
 *
 *   resolveTracks   -> generationsRoots, plus known title/artist aliases
 *   songRoot        -> the root CTE
 *   relationships   -> musicDNARelationships
 *   lineage         -> lineage (LineageBuilder in Lineage.swift)
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
  Lineage,
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
 * Resolve like Sinc's generationsRoots: canonical id first, then the union of
 * ISRC and MusicBrainz recording matches, then normalized title and artist.
 * An identifier match is independent of kind, as it is in Sinc. The alias
 * stage is the online catalog's own addition: the app never reads
 * node_aliases, so a spelling the catalog knows only as an alias finds a song
 * online that the bundled catalog cannot.
 */
export async function resolveTracks(
  db: Db,
  input: { canonicalId?: string; isrc?: string; mbid?: string; title?: string; artist?: string; kind: TrackKind },
): Promise<{ matchedBy: Resolution["matchedBy"]; trackIds: number[] }> {
  if (input.canonicalId) {
    const id = await findTrackId(db, input.canonicalId);
    if (id !== null) return { matchedBy: "canonical_id", trackIds: [id] };
  }

  const isrc = input.isrc ? normalizeIdentifier(input.isrc) : "";
  const mbid = input.mbid?.toLowerCase() ?? "";
  if (isrc || mbid) {
    const byIdentifier = await rows<{ id: number; has_isrc: boolean }>(db, sql`
      SELECT track_id AS id, bool_or(namespace = 'isrc') AS has_isrc
      FROM track_identifiers
      WHERE (namespace = 'isrc' AND identifier = ${isrc} AND ${isrc} <> '')
         OR (namespace = 'musicbrainz_recording' AND identifier = ${mbid} AND ${mbid} <> '')
      GROUP BY track_id ORDER BY track_id`);
    if (byIdentifier.length) return {
      matchedBy: byIdentifier.some((r) => r.has_isrc) ? "isrc" : "mbid",
      trackIds: byIdentifier.map((r) => r.id),
    };
  }

  const title = normalize(input.title ?? "");
  const artist = normalize(input.artist ?? "");
  if (title && artist) {
    const byText = await rows<{ id: number }>(db, sql`
      SELECT id FROM tracks
      WHERE norm_title = ${title} AND norm_artist = ${artist} AND kind = ${input.kind}
      ORDER BY id`);
    if (byText.length) return { matchedBy: "title_artist", trackIds: byText.map((r) => r.id) };

    const byAlias = await rows<{ id: number }>(db, sql`
      SELECT DISTINCT t.id FROM track_aliases a
      JOIN tracks t ON t.id = a.track_id
      WHERE a.norm_title = ${title} AND a.norm_artist = ${artist} AND t.kind = ${input.kind}
      ORDER BY t.id`);
    if (byAlias.length) return { matchedBy: "alias", trackIds: byAlias.map((r) => r.id) };
  }
  return { matchedBy: null, trackIds: [] };
}

export async function findTrackId(db: Db, canonicalId: string): Promise<number | null> {
  const [row] = await rows<{ id: number }>(db, sql`SELECT id FROM tracks WHERE canonical_id = ${canonicalId}`);
  return row?.id ?? null;
}

/**
 * Song roots for several groups at once: for each key, every recording of the
 * songs its tracks belong to, the tracks included.
 */
export async function songRoots(db: Db, groups: Map<number, number[]>): Promise<Map<number, number[]>> {
  if (!groups.size) return new Map();
  const keys = [...groups].flatMap(([key, ids]) => ids.map(() => key));
  const ids = [...groups.values()].flat();
  const found = await rows<{ key: number; id: number }>(db, sql`
    WITH given AS (
      SELECT * FROM unnest(${intArray(keys)}, ${intArray(ids)}) AS g(key, id)
    ),
    same_isrc AS (
      SELECT g.key, other.track_id AS id
      FROM given g
      JOIN track_identifiers mine ON mine.track_id = g.id AND mine.namespace = 'isrc'
      JOIN track_identifiers other
        ON other.namespace = 'isrc' AND other.identifier = mine.identifier
    ),
    matched AS (SELECT key, id FROM given UNION SELECT key, id FROM same_isrc)
    SELECT DISTINCT m.key, t.id
    FROM matched m
    JOIN tracks mt ON mt.id = m.id
    JOIN tracks t
      ON t.norm_title = mt.norm_title AND t.norm_artist = mt.norm_artist AND t.kind = mt.kind
    ORDER BY m.key, t.id`);
  const roots = new Map<number, number[]>([...groups.keys()].map((key) => [key, []]));
  for (const r of found) roots.get(r.key)!.push(r.id);
  return roots;
}

/** Every recording of the songs these tracks belong to, the tracks included. */
export async function songRoot(db: Db, trackIds: number[]): Promise<number[]> {
  return (await songRoots(db, new Map([[0, trackIds]]))).get(0)!;
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

export type Direction = "sources" | "derivatives";

type ChosenRow = {
  key: number;
  direction: Direction;
  total: number;
  edge_id: number;
  other_id: number;
  position: number;
};

/**
 * For each keyed song root, the relationships to show in each direction.
 *
 * A root covers every recording of the song, so one related song can arrive
 * over several edges (a source sampled by the album cut and the radio edit).
 * Like the app, keep one per direction, relationship type, and related song,
 * preferring the edge that says what was borrowed, then the one with notes.
 * Edges between two recordings of the same song are the song related to
 * itself and never shown. `total` counts related songs before the limit.
 */
async function chooseRelated(
  db: Db,
  roots: Map<number, number[]>,
  directions: Direction[],
  limit: number,
): Promise<ChosenRow[]> {
  const keys = [...roots].flatMap(([key, ids]) => ids.map(() => key));
  const ids = [...roots.values()].flat();
  if (!ids.length) return [];
  return rows<ChosenRow>(db, sql`
    WITH root AS (
      SELECT * FROM unnest(${intArray(keys)}, ${intArray(ids)}) AS r(key, id)
    ),
    adjacent AS (
      SELECT r.key, s.id, 'derivatives' AS direction, s.child_track_id AS other_id
      FROM root r JOIN samples s ON s.parent_track_id = r.id
      WHERE ${directions.includes("derivatives")} AND s.status = 'published'
        AND NOT EXISTS (SELECT 1 FROM root r2 WHERE r2.key = r.key AND r2.id = s.child_track_id)
      UNION ALL
      SELECT r.key, s.id, 'sources', s.parent_track_id
      FROM root r JOIN samples s ON s.child_track_id = r.id
      WHERE ${directions.includes("sources")} AND s.status = 'published'
        AND NOT EXISTS (SELECT 1 FROM root r2 WHERE r2.key = r.key AND r2.id = s.parent_track_id)
    ),
    ranked AS (
      SELECT a.key, a.id, a.direction, a.other_id,
        row_number() OVER (
          PARTITION BY a.key, a.direction, s.relationship_type,
            other.norm_title, other.norm_artist, other.kind
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
      SELECT r.key, r.direction, r.id AS edge_id, r.other_id,
        count(*) OVER (PARTITION BY r.key, r.direction)::int AS total,
        row_number() OVER (
          PARTITION BY r.key, r.direction ORDER BY lower(other.title), other.id
        )::int AS position
      FROM ranked r JOIN tracks other ON other.id = r.other_id
      WHERE r.rank = 1
    )
    SELECT * FROM chosen WHERE position <= ${limit}
    ORDER BY key, direction, position`);
}

type ProvenanceRow = {
  id: number;
  canonical_id: string;
  parent_track_id: number;
  child_track_id: number;
  relationship_type: Relationship["relationshipType"];
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

/** Relationships by internal id, with both recordings, segments, and provenance. */
async function loadRelationships(db: Db, edgeIds: number[]): Promise<Map<number, Relationship>> {
  if (!edgeIds.length) return new Map();
  const edges = await rows<ProvenanceRow>(db, sql`
    SELECT s.id, s.canonical_id, s.parent_track_id, s.child_track_id, s.relationship_type, s.notes, p.*
    FROM samples s
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
    WHERE s.id = ANY(${intArray(edgeIds)})`);
  const [summaries, segmentRows] = await Promise.all([
    trackSummaries(db, edges.flatMap((e) => [e.parent_track_id, e.child_track_id])),
    rows<SegmentRow>(db, sql`
      SELECT sample_id, element, timestamp_parent, timestamp_child, duration_ms, sample_type,
        pitch_shift_semitones, tempo_ratio, is_reversed, is_looped
      FROM sample_segments WHERE sample_id = ANY(${intArray(edgeIds)})
      ORDER BY sample_id, timestamp_child NULLS LAST, id`),
  ]);
  const segments = Map.groupBy(segmentRows, (g) => g.sample_id);
  return new Map(
    edges.map((e) => [
      e.id,
      {
        id: e.canonical_id,
        relationshipType: e.relationship_type,
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
      },
    ]),
  );
}

/** Everything the song takes from and everything that takes from it. */
export async function relationships(db: Db, rootIds: number[], limit: number): Promise<Relationships> {
  const chosen = await chooseRelated(db, new Map([[0, rootIds]]), ["sources", "derivatives"], limit);
  const loaded = await loadRelationships(db, chosen.map((c) => c.edge_id));
  const result: Relationships = { sources: { total: 0, items: [] }, derivatives: { total: 0, items: [] } };
  for (const c of chosen) {
    result[c.direction].total = c.total;
    result[c.direction].items.push(loaded.get(c.edge_id)!);
  }
  return result;
}

// --- lineage ------------------------------------------------------------------

type PendingNode = {
  id: string;
  parentId: string | null;
  depth: number;
  trackId: number;
  edgeId: number | null;
  /** Track ids of this node's song and of every ancestor's. */
  path: Set<number>;
  children: PendingNode[];
  hiddenChildCount: number;
  isCycle: boolean;
};

export type LineageOptions = {
  direction: Direction;
  maxDepth: number;
  rootLimit: number;
  childLimit: number;
  maxNodes: number;
};

/**
 * The song's lineage as a tree, built a generation at a time. Mirrors Sinc's
 * LineageBuilder: the root shows up to rootLimit relationships and every
 * other node up to childLimit, with the rest counted in hiddenChildCount;
 * a song already on the path back to the root becomes a leaf marked isCycle;
 * film, TV, comedy, and speech sources are leaves. maxNodes bounds the whole
 * tree, and `truncated` says whether it cut anything.
 */
export async function lineage(db: Db, trackId: number, options: LineageOptions): Promise<Lineage> {
  const root: PendingNode = {
    id: "0",
    parentId: null,
    depth: 0,
    trackId,
    edgeId: null,
    path: new Set(),
    children: [],
    hiddenChildCount: 0,
    isCycle: false,
  };
  const kinds = new Map<number, TrackKind>();
  const kindOf = async (ids: number[]) => {
    const unknown = ids.filter((id) => !kinds.has(id));
    if (!unknown.length) return;
    for (const r of await rows<{ id: number; kind: TrackKind }>(db, sql`
      SELECT id, kind FROM tracks WHERE id = ANY(${intArray(unknown)})`)) {
      kinds.set(r.id, r.kind);
    }
  };

  let nodeCount = 1;
  let truncated = false;
  let generation = [root];
  await kindOf([trackId]);
  for (let depth = 0; depth <= options.maxDepth && generation.length; depth++) {
    const expanding = generation.filter((n) => !n.isCycle && kinds.get(n.trackId) === "song");
    const roots = await songRoots(db, new Map(expanding.map((n, i) => [i, [n.trackId]])));
    expanding.forEach((n, i) => {
      for (const id of roots.get(i)!) n.path.add(id);
    });
    const limit = depth === 0 ? options.rootLimit : options.childLimit;
    // At the last generation only the counts matter, but a row is needed to carry one.
    const chosen = await chooseRelated(db, roots, [options.direction], Math.max(limit, 1));
    const byNode = Map.groupBy(chosen, (c) => c.key);
    await kindOf(chosen.map((c) => c.other_id));

    const next: PendingNode[] = [];
    expanding.forEach((node, i) => {
      const related = byNode.get(i) ?? [];
      const total = related[0]?.total ?? 0;
      if (depth === options.maxDepth) {
        node.hiddenChildCount = total;
        return;
      }
      const room = Math.max(0, options.maxNodes - nodeCount);
      const shown = related.slice(0, Math.min(limit, room));
      if (shown.length < Math.min(total, limit)) truncated = true;
      node.hiddenChildCount = total - shown.length;
      for (const [index, c] of shown.entries()) {
        const child: PendingNode = {
          id: `${node.id}.${index}`,
          parentId: node.id,
          depth: depth + 1,
          trackId: c.other_id,
          edgeId: c.edge_id,
          path: new Set(node.path),
          children: [],
          hiddenChildCount: 0,
          isCycle: node.path.has(c.other_id),
        };
        node.children.push(child);
        next.push(child);
      }
      nodeCount += shown.length;
    });
    generation = next;
  }

  const ordered: PendingNode[] = [];
  const visit = (n: PendingNode) => {
    ordered.push(n);
    n.children.forEach(visit);
  };
  visit(root);
  const [summaries, loaded] = await Promise.all([
    trackSummaries(db, ordered.map((n) => n.trackId)),
    loadRelationships(db, ordered.flatMap((n) => (n.edgeId === null ? [] : [n.edgeId]))),
  ]);
  return {
    direction: options.direction,
    truncated,
    nodes: ordered.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      depth: n.depth,
      track: summaries.get(n.trackId)!,
      relationship: n.edgeId === null ? null : loaded.get(n.edgeId)!,
      hiddenChildCount: n.hiddenChildCount,
      isCycle: n.isCycle,
    })),
  };
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
