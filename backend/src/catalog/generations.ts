/** Sinc/Generations.swift port. A cluster is one catalog version group; a
 * node without cluster_id stands for itself as -catalog_node_id. */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { songIdentity } from "./song-identity.js";
import type { TrackKind } from "./identity.js";

type HandoffType = "sampled" | "interpolated" | "remixed";
type Recording = {
  nodeID: number; clusterID: number; canonicalID: string; title: string; artist: string;
  year: number | null; kind: TrackKind; isrc: string | null; musicBrainzRecordingID: string | null;
};
type Handoff = {
  sourceNodeID: number; destinationNodeID: number; sourceClusterID: number;
  destinationClusterID: number; type: HandoffType;
};
type Track = {
  title: string; artist: string; year: number | null; kind: TrackKind; isrc: string | null;
  musicBrainzRecordingID: string | null; catalogRecordingID: string;
};
export type GenerationsRecord = {
  id: string; track: Track; earliestYear: number | null; handoffTypes: HandoffType[];
  connectedTitles: string[]; alsoFromTitles: string[];
};
type Gap = { years: { lower: number; upper: number } | null; hasDateConflict: boolean };
type Generation = { role: "before" | "thisSong" | "sameGeneration" | "after";
  offset: number; records: GenerationsRecord[]; gapFromPrevious: Gap | null };
export type GenerationsFamily = {
  root: GenerationsRecord; generations: Generation[]; hasMoreBefore: boolean; hasMoreAfter: boolean;
};

const clusterSQL = (alias: string) => sql.raw(`COALESCE(${alias}.cluster_id, -COALESCE(${alias}.catalog_node_id, ${alias}.id))`);
const nodeSQL = (alias: string) => sql.raw(`COALESCE(${alias}.catalog_node_id, ${alias}.id)`);
const intArray = (values: number[]) => sql`${sql.param(values)}::int[]`;

async function loadHandoffs(db: Db): Promise<{ into: Map<number, Handoff[]>; outOf: Map<number, Handoff[]> }> {
  const result = await db.execute(sql`
    SELECT ${nodeSQL("parent")} AS "sourceNodeID", ${nodeSQL("child")} AS "destinationNodeID",
      ${clusterSQL("parent")} AS "sourceClusterID", ${clusterSQL("child")} AS "destinationClusterID",
      s.relationship_type AS type
    FROM samples s
    JOIN tracks parent ON parent.id = s.parent_track_id
    JOIN tracks child ON child.id = s.child_track_id
    WHERE s.status = 'published' AND s.relationship_type IN ('sampled', 'interpolated', 'remixed')
      AND ${clusterSQL("parent")} <> ${clusterSQL("child")}
    -- Sinc's v16 SQLite query scans its unique (source_node_id,
    -- destination_node_id, relationship_type) index. With a cluster cap,
    -- traversal order decides which descendants fit, so preserve it.
    ORDER BY ${nodeSQL("parent")}, ${nodeSQL("child")}, s.relationship_type`);
  const into = new Map<number, Handoff[]>();
  const outOf = new Map<number, Handoff[]>();
  for (const row of result.rows as Handoff[]) {
    const edge = { sourceNodeID: Number(row.sourceNodeID), destinationNodeID: Number(row.destinationNodeID),
      sourceClusterID: Number(row.sourceClusterID), destinationClusterID: Number(row.destinationClusterID),
      type: row.type };
    if (!into.has(edge.destinationClusterID)) into.set(edge.destinationClusterID, []);
    if (!outOf.has(edge.sourceClusterID)) outOf.set(edge.sourceClusterID, []);
    into.get(edge.destinationClusterID)!.push(edge);
    outOf.get(edge.sourceClusterID)!.push(edge);
  }
  return { into, outOf };
}

async function loadRecordings(db: Db, where: ReturnType<typeof sql>): Promise<Recording[]> {
  const result = await db.execute(sql`
    SELECT ${nodeSQL("t")} AS "nodeID", ${clusterSQL("t")} AS "clusterID",
      t.canonical_id AS "canonicalID", t.title, t.artist_credit AS artist,
      t.release_year AS year, t.kind,
      (SELECT i.identifier FROM track_identifiers i WHERE i.track_id = t.id AND i.namespace = 'isrc'
        ORDER BY i.identifier LIMIT 1) AS isrc,
      (SELECT i.identifier FROM track_identifiers i WHERE i.track_id = t.id AND i.namespace = 'musicbrainz_recording'
        ORDER BY i.identifier LIMIT 1) AS "musicBrainzRecordingID"
    FROM tracks t WHERE ${where} ORDER BY ${nodeSQL("t")}`);
  return (result.rows as Recording[]).map((r) => ({ ...r, nodeID: Number(r.nodeID),
    clusterID: Number(r.clusterID), year: r.year === null ? null : Number(r.year) }));
}

// Swift's localizedCaseInsensitiveCompare in an English locale. Across every
// catalog title the two orders differ only around "ß", which Foundation
// compares inconsistently ("Außer" equals "Ausser" yet sorts after "Aust"),
// so there is no single Swift order to copy there. Other device locales sort
// differently offline (sv_SE moves Å, Ä and Æ); the server keeps English.
const titleCollator = new Intl.Collator("en", { sensitivity: "accent" });
const titleOrder = (a: string, b: string) => titleCollator.compare(a, b);
/** Swift's String `<`: Unicode scalars of the NFC form, not a locale collation. */
export const scalarOrder = (a: string, b: string) => {
  const left = [...a.normalize("NFC")].map((c) => c.codePointAt(0)!);
  const right = [...b.normalize("NFC")].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
};
/** Oldest first, undated last, then by title and id, as Generations.swift's chronological. */
export const chronological = (a: GenerationsRecord, b: GenerationsRecord) => {
  if (a.earliestYear !== null && b.earliestYear !== null && a.earliestYear !== b.earliestYear)
    return a.earliestYear - b.earliestYear;
  if (a.earliestYear !== null && b.earliestYear === null) return -1;
  if (a.earliestYear === null && b.earliestYear !== null) return 1;
  return titleOrder(a.track.title, b.track.title) || scalarOrder(a.id, b.id);
};
const track = (r: Recording): Track => ({ title: r.title, artist: r.artist, year: r.year,
  kind: r.kind, isrc: r.isrc, musicBrainzRecordingID: r.musicBrainzRecordingID,
  catalogRecordingID: r.canonicalID });

type Walk = { levels: Set<number>[]; handoffs: Handoff[][]; hasMore: boolean };

/** Returns null only when the canonical id is absent. Published handoffs only. */
export async function generations(db: Db, canonicalID: string, maxClusters = 1500): Promise<GenerationsFamily | null> {
  const roots = await loadRecordings(db, sql`t.canonical_id = ${canonicalID}`);
  if (!roots.length) return null;
  const primary = roots[0]!;
  const rootClusters = new Set(roots.map((r) => r.clusterID));
  const edges = await loadHandoffs(db);
  const offset = new Map([...rootClusters].map((id) => [id, 0]));
  let isFull = false;
  const place = (id: number, generation: number) => {
    if (offset.size >= maxClusters) { isFull = true; return false; }
    offset.set(id, generation); return true;
  };
  const neighbours = (id: number, sign: number) =>
    (sign < 0 ? edges.into : edges.outOf).get(id) ?? [];
  const walk = (sign: number): Walk => {
    const levels: Set<number>[] = [];
    const linking: Handoff[][] = [];
    let frontier = rootClusters;
    for (let step = 1; step <= 3; step++) {
      const next = new Set<number>();
      const links: Handoff[] = [];
      for (const cluster of frontier) for (const edge of neighbours(cluster, sign)) {
        const other = sign < 0 ? edge.sourceClusterID : edge.destinationClusterID;
        if (!offset.has(other) && place(other, sign * step)) next.add(other);
        if (next.has(other)) links.push(edge);
      }
      if (!next.size) return { levels, handoffs: linking, hasMore: isFull };
      levels.push(next); linking.push(links); frontier = next;
    }
    const hasMore = isFull || [...frontier].some((cluster) =>
      neighbours(cluster, sign).some((edge) => !offset.has(sign < 0 ? edge.sourceClusterID : edge.destinationClusterID)));
    return { levels, handoffs: linking, hasMore };
  };
  const before = walk(-1);
  const after = walk(1);
  const siblingClusters = new Set<number>();
  const siblingHandoffs: Handoff[] = [];
  for (const cluster of before.levels[0] ?? []) for (const edge of edges.outOf.get(cluster) ?? []) {
    const destination = edge.destinationClusterID;
    if (!offset.has(destination) && place(destination, 0)) siblingClusters.add(destination);
    if (siblingClusters.has(destination)) siblingHandoffs.push(edge);
  }
  const clusterIds = [...offset.keys()];
  const members = new Map<number, Recording[]>();
  for (const r of await loadRecordings(db, sql`${clusterSQL("t")} = ANY(${intArray(clusterIds)})`)) {
    if (!members.has(r.clusterID)) members.set(r.clusterID, []);
    members.get(r.clusterID)!.push(r);
  }
  const recording = (node: number, cluster: number) => members.get(cluster)?.find((r) => r.nodeID === node);
  const earliestYear = (clusters: Iterable<number>, identity: string) => {
    const years = [...clusters].flatMap((id) => members.get(id) ?? [])
      .filter((r) => songIdentity(r.title) === identity).map((r) => r.year)
      .filter((y): y is number => y !== null);
    return years.length ? Math.min(...years) : null;
  };
  const recordID = (node: number, cluster: number) => rootClusters.has(cluster) ? "root" :
    (recording(node, cluster) ? `${cluster}|${songIdentity(recording(node, cluster)!.title)}` : null);
  const root: GenerationsRecord = { id: "root", track: track(primary),
    earliestYear: earliestYear(rootClusters, songIdentity(primary.title)) ?? primary.year,
    handoffTypes: [], connectedTitles: [], alsoFromTitles: [] };
  const records = (handoffs: Handoff[], side: "source" | "destination", clusters: Set<number>): GenerationsRecord[] => {
    const reached = new Map<string, { cluster: number; identity: string; recordings: Recording[];
      types: Set<HandoffType>; connected: Set<string> }>();
    for (const edge of handoffs) {
      const cluster = side === "source" ? edge.sourceClusterID : edge.destinationClusterID;
      const node = side === "source" ? edge.sourceNodeID : edge.destinationNodeID;
      const otherCluster = side === "source" ? edge.destinationClusterID : edge.sourceClusterID;
      const otherNode = side === "source" ? edge.destinationNodeID : edge.sourceNodeID;
      const r = recording(node, cluster);
      if (!clusters.has(cluster) || !r) continue;
      const identity = songIdentity(r.title);
      const id = `${cluster}|${identity}`;
      if (!reached.has(id)) reached.set(id, { cluster, identity, recordings: [], types: new Set(), connected: new Set() });
      const entry = reached.get(id)!;
      if (!entry.recordings.some((existing) => existing.nodeID === node)) entry.recordings.push(r);
      entry.types.add(edge.type);
      const other = recording(otherNode, otherCluster);
      if (other) entry.connected.add(other.title);
    }
    return [...reached].map(([id, entry]): GenerationsRecord => {
      const shown = [...entry.recordings].sort((a, b) =>
        a.year === null ? (b.year === null ? a.nodeID - b.nodeID : 1) :
          (b.year === null ? -1 : a.year - b.year || a.nodeID - b.nodeID))[0]!;
      return { id, track: track(shown), earliestYear: earliestYear([entry.cluster], entry.identity),
        handoffTypes: [...entry.types].sort(), connectedTitles: [...entry.connected].sort(titleOrder), alsoFromTitles: [] };
    }).sort(chronological);
  };
  const gap = (older: GenerationsRecord[], younger: GenerationsRecord[], handoffs: Handoff[]): Gap | null => {
    const olderYears = new Map(older.map((r) => [r.id, r.earliestYear]));
    const youngerYears = new Map(younger.map((r) => [r.id, r.earliestYear]));
    const differences: number[] = [];
    for (const edge of handoffs) {
      const source = recordID(edge.sourceNodeID, edge.sourceClusterID);
      const destination = recordID(edge.destinationNodeID, edge.destinationClusterID);
      const sourceYear = source ? olderYears.get(source) : null;
      const destinationYear = destination ? youngerYears.get(destination) : null;
      if (sourceYear != null && destinationYear != null) differences.push(destinationYear - sourceYear);
    }
    if (!differences.length) return null;
    const forward = differences.filter((n) => n >= 0);
    return { years: forward.length ? { lower: Math.min(...forward), upper: Math.max(...forward) } : null,
      hasDateConflict: forward.length < differences.length };
  };
  const result: Generation[] = [];
  let chainPrevious: GenerationsRecord[] | null = null;
  for (let index = before.levels.length - 1; index >= 0; index--) {
    const rs = records(before.handoffs[index]!, "source", before.levels[index]!);
    result.push({ role: "before", offset: -(index + 1), records: rs,
      gapFromPrevious: chainPrevious ? gap(chainPrevious, rs, before.handoffs[index + 1]!) : null });
    chainPrevious = rs;
  }
  result.push({ role: "thisSong", offset: 0, records: [root],
    gapFromPrevious: chainPrevious ? gap(chainPrevious, [root], before.handoffs[0] ?? []) : null });
  if (siblingClusters.size) result.push({ role: "sameGeneration", offset: 0,
    records: records(siblingHandoffs, "destination", siblingClusters), gapFromPrevious: null });
  chainPrevious = [root];
  for (let index = 0; index < after.levels.length; index++) {
    const clusters = after.levels[index]!;
    const arriving = [...clusters].flatMap((id) => edges.into.get(id) ?? []);
    const offsetValue = index + 1;
    const rs = records(after.handoffs[index]!, "destination", clusters).map((r) => {
      const titles = arriving.flatMap((edge) => {
        if (recordID(edge.destinationNodeID, edge.destinationClusterID) !== r.id ||
          siblingClusters.has(edge.sourceClusterID) ||
          (offset.get(edge.sourceClusterID) ?? Infinity) >= offsetValue - 1) return [];
        const source = recording(edge.sourceNodeID, edge.sourceClusterID);
        return source ? [source.title] : [];
      });
      return titles.length ? { ...r, alsoFromTitles: [...new Set(titles)].sort(titleOrder) } : r;
    });
    result.push({ role: "after", offset: offsetValue, records: rs,
      gapFromPrevious: chainPrevious ? gap(chainPrevious, rs, after.handoffs[index]!) : null });
    chainPrevious = rs;
  }
  return { root, generations: result, hasMoreBefore: before.hasMore, hasMoreAfter: after.hasMore };
}
