/**
 * Load Sinc's catalog (samples.sqlite) into Postgres.
 *
 *   npm run import:sinc                       first load, into an empty database
 *   npm run import:sinc -- --replace          discard the catalog tables and reload
 *   npm run import:sinc -- --catalog <path>   read a specific samples.sqlite
 *
 * The catalog defaults to SINC_CATALOG, then to the Sinc checkout next to this
 * repository. The whole load is one transaction, and it is checked against the
 * catalog's own row counts before it commits.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { count, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { NORMALIZATION_VERSION, normalize } from "../catalog/identity.js";
import { db, pool } from "../db/client.js";
import * as s from "../db/schema.js";

const SUPPORTED_SCHEMA_VERSION = 6;
const CHUNK = 2000;

class ImportError extends Error {}

type Value = string | number | null;
type Row = Record<string, Value>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const { values: args } = parseArgs({
  options: {
    catalog: { type: "string" },
    replace: { type: "boolean", default: false },
  },
});
const catalogPath = resolve(
  args.catalog ??
    process.env.SINC_CATALOG ??
    resolve(import.meta.dirname, "../../../../Sincapp/Sinc/Resources/samples.sqlite"),
);

// --- reading the catalog ---------------------------------------------------

const str = (value: Value) => String(value);
const text = (value: Value) => (value === null ? null : String(value));
const num = (value: Value) => (value === null ? null : Number(value));
const bool = (value: Value) => (value === null ? null : value === 1);
/** Sinc stores times as seconds; this schema stores milliseconds. */
const ms = (seconds: Value) => (seconds === null ? null : Math.round(Number(seconds) * 1000));

/** A value from one of the schema's enums, or a clear error naming the column. */
function member<T extends string>(values: readonly T[], value: Value, column: string): T {
  if (values.includes(value as T)) return value as T;
  throw new ImportError(`${column}: unexpected value ${JSON.stringify(value)}; the schema allows ${values.join(", ")}`);
}

/** Catalog row ids to Postgres ids, failing loudly on a dangling reference. */
class IdMap {
  private readonly ids = new Map<number, number>();
  constructor(private readonly label: string) {}
  set(from: Value, to: number) {
    this.ids.set(Number(from), to);
  }
  has(from: Value) {
    return this.ids.has(Number(from));
  }
  get(from: Value): number {
    const to = this.ids.get(Number(from));
    if (to === undefined) throw new ImportError(`${this.label} ${from} is referenced but was not imported`);
    return to;
  }
}

function openCatalog(path: string) {
  if (!existsSync(path)) {
    throw new ImportError(`no catalog at ${path}. Pass --catalog <path> or set SINC_CATALOG.`);
  }
  const lite = new DatabaseSync(path, { readOnly: true });
  const rows = (query: string) => lite.prepare(query).all() as Row[];

  const schemaVersion = Number(Object.values(rows("PRAGMA user_version")[0]!)[0]);
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new ImportError(`catalog schema v${schemaVersion} is not supported (expected v${SUPPORTED_SCHEMA_VERSION}).`);
  }
  const metadata = Object.fromEntries(
    rows("SELECT key, value FROM catalog_metadata").map((r) => [str(r.key), str(r.value)]),
  );
  if (metadata.normalization_version !== NORMALIZATION_VERSION) {
    throw new ImportError(
      `catalog uses normalization v${metadata.normalization_version}, but src/catalog/identity.ts ` +
        `implements v${NORMALIZATION_VERSION}. Port Sinc's change to normalize() first.`,
    );
  }
  return { lite, rows, metadata, schemaVersion };
}

// --- writing Postgres ------------------------------------------------------

const report: [table: string, rows: number][] = [];

/** Inserts rows in chunks, recording catalog id -> Postgres id when given a map. */
async function copy<TTable extends PgTable>(
  tx: Tx,
  table: TTable,
  name: string,
  source: Row[],
  toRow: (row: Row) => TTable["$inferInsert"],
  ids?: IdMap,
) {
  for (let i = 0; i < source.length; i += CHUNK) {
    const chunk = source.slice(i, i + CHUNK);
    const insert = tx.insert(table).values(chunk.map(toRow));
    if (!ids) {
      await insert;
      continue;
    }
    // Postgres returns inserted rows in VALUES order, so they line up with the chunk.
    const inserted = (await insert.returning({ id: sql<number>`id` })) as { id: number }[];
    inserted.forEach((row, index) => ids.set(chunk[index]!.id!, row.id));
  }
  report.push([name, source.length]);
}

async function importCatalog(rows: (query: string) => Row[]) {
  // Every edge must join two different recordings. Catalog v16 has two remixes
  // merged into their originals; Sinc's build_db.py now keeps them apart.
  const edges = rows(`
    SELECT e.id, e.canonical_id, e.source_node_id, e.destination_node_id,
           e.relationship_type, d.notes, source.title AS source_title
    FROM graph_edges e
    JOIN graph_nodes source ON source.id = e.source_node_id
    LEFT JOIN relationship_details d ON d.edge_id = e.id`);
  const selfReferences = edges.filter((e) => e.source_node_id === e.destination_node_id);

  await db.transaction(async (tx) => {
    const [{ existing }] = (await tx.select({ existing: count() }).from(s.tracks)) as [{ existing: number }];
    if (existing > 0 && !args.replace) {
      throw new ImportError(`the database already holds ${existing} tracks. Rerun with --replace to reload.`);
    }
    if (args.replace) {
      await tx.execute(sql`
        TRUNCATE sample_assertions, sample_segments, samples,
          track_lineage_disclosures, track_works, work_identifiers,
          track_contributors, track_artists, track_name_aliases, track_aliases,
          track_identifiers, tracks, works, artists
        RESTART IDENTITY`);
    }

    const artistIds = new IdMap("artist");
    await copy(tx, s.artists, "artists", rows("SELECT * FROM artists"), (r) => ({
      canonicalId: str(r.canonical_id),
      musicbrainzArtistId: text(r.musicbrainz_artist_id),
      name: str(r.name),
      sortName: text(r.sort_name),
    }), artistIds);

    const workIds = new IdMap("work");
    await copy(tx, s.works, "works", rows("SELECT * FROM works"), (r) => ({
      canonicalId: str(r.canonical_id),
      musicbrainzWorkId: text(r.musicbrainz_work_id),
      title: str(r.title),
      workType: text(r.work_type),
      disambiguation: text(r.disambiguation),
    }), workIds);

    const trackIds = new IdMap("track");
    const nodes = rows(`
      SELECT n.*, m.duration_ms, m.disambiguation, m.is_video
      FROM graph_nodes n LEFT JOIN recording_metadata m ON m.node_id = n.id`);
    await copy(tx, s.tracks, "tracks", nodes, (r) => ({
      canonicalId: str(r.canonical_id),
      identityKey: str(r.identity_key),
      kind: member(s.trackKind.enumValues, r.kind, "graph_nodes.kind"),
      title: str(r.title),
      artistCredit: str(r.artist),
      normTitle: str(r.norm_title),
      normArtist: str(r.norm_artist),
      releaseYear: num(r.year),
      durationMs: num(r.duration_ms),
      disambiguation: text(r.disambiguation),
      isVideo: bool(r.is_video),
    }), trackIds);

    await copy(tx, s.trackIdentifiers, "track_identifiers", rows("SELECT * FROM node_identifiers"), (r) => ({
      trackId: trackIds.get(r.node_id),
      namespace: member(s.identifierNamespace.enumValues, r.namespace, "node_identifiers.namespace"),
      identifier: str(r.identifier),
      source: str(r.source),
    }));

    await copy(tx, s.trackAliases, "track_aliases", rows("SELECT * FROM node_aliases"), (r) => ({
      trackId: trackIds.get(r.node_id),
      title: str(r.title),
      artistCredit: str(r.artist),
      normTitle: str(r.norm_title),
      normArtist: str(r.norm_artist),
      source: str(r.source),
    }));

    await copy(tx, s.trackNameAliases, "track_name_aliases", rows("SELECT * FROM recording_aliases"), (r) => ({
      trackId: trackIds.get(r.node_id),
      name: str(r.name),
      locale: text(r.locale),
      aliasType: text(r.alias_type),
      isPrimary: bool(r.is_primary),
      source: str(r.source),
    }));

    await copy(tx, s.trackArtists, "track_artists", rows("SELECT * FROM recording_artists"), (r) => ({
      trackId: trackIds.get(r.node_id),
      artistId: artistIds.get(r.artist_id),
      position: Number(r.position),
      creditedName: text(r.credited_name),
      joinPhrase: text(r.join_phrase),
    }));

    await copy(tx, s.trackContributors, "track_contributors", rows("SELECT * FROM recording_contributors"), (r) => ({
      trackId: trackIds.get(r.node_id),
      contributorName: str(r.contributor_name),
      artistId: r.artist_id === null ? null : artistIds.get(r.artist_id),
      role: str(r.role),
      creditedName: text(r.credited_name),
      position: Number(r.position),
      source: str(r.source),
      sourceUrl: text(r.source_url),
      confidence: num(r.confidence),
    }));

    await copy(tx, s.trackWorks, "track_works", rows("SELECT * FROM recording_works"), (r) => ({
      trackId: trackIds.get(r.node_id),
      workId: workIds.get(r.work_id),
      relationshipType: str(r.relationship_type),
      source: str(r.source),
    }));

    await copy(tx, s.workIdentifiers, "work_identifiers", rows("SELECT * FROM work_identifiers"), (r) => ({
      workId: workIds.get(r.work_id),
      namespace: member(s.identifierNamespace.enumValues, r.namespace, "work_identifiers.namespace"),
      identifier: str(r.identifier),
      source: str(r.source),
    }));

    await copy(tx, s.trackLineageDisclosures, "track_lineage_disclosures", rows("SELECT * FROM recording_lineage_disclosures"), (r) => ({
      trackId: trackIds.get(r.node_id),
      classification: member(s.lineageClassification.enumValues, r.classification, "recording_lineage_disclosures.classification"),
      source: str(r.source),
      sourceUrl: text(r.source_url),
      evidenceText: text(r.evidence_text),
      confidence: num(r.confidence),
    }));

    // Everything in a shipped catalog is already in front of users.
    const sampleIds = new IdMap("edge");
    const importable = edges.filter((e) => e.source_node_id !== e.destination_node_id);
    await copy(tx, s.samples, "samples", importable, (r) => ({
      canonicalId: str(r.canonical_id),
      parentTrackId: trackIds.get(r.source_node_id),
      childTrackId: trackIds.get(r.destination_node_id),
      relationshipType: member(s.relationshipType.enumValues, r.relationship_type, "graph_edges.relationship_type"),
      status: "published" as const,
      notes: text(r.notes),
    }), sampleIds);

    // Sinc keeps one details row per edge; anything in it besides notes is a segment.
    const details = rows(`
      SELECT * FROM relationship_details
      WHERE COALESCE(element, at_in_source, at_in_destination, duration, sample_type,
                     pitch_shift_semitones, tempo_ratio, is_reversed, is_looped) IS NOT NULL`);
    await copy(tx, s.sampleSegments, "sample_segments", details.filter((r) => sampleIds.has(r.edge_id)), (r) => ({
      sampleId: sampleIds.get(r.edge_id),
      element: text(r.element),
      timestampParent: ms(r.at_in_source),
      timestampChild: ms(r.at_in_destination),
      durationMs: ms(r.duration),
      sampleType: r.sample_type === null ? null : member(s.sampleType.enumValues, r.sample_type, "relationship_details.sample_type"),
      pitchShiftSemitones: num(r.pitch_shift_semitones),
      tempoRatio: num(r.tempo_ratio),
      isReversed: bool(r.is_reversed),
      isLooped: bool(r.is_looped),
    }));

    const assertions = rows("SELECT * FROM relationship_assertions");
    await copy(tx, s.sampleAssertions, "sample_assertions", assertions.filter((r) => sampleIds.has(r.edge_id)), (r) => ({
      sampleId: sampleIds.get(r.edge_id),
      sourceName: str(r.source_name),
      sourceKind: str(r.source_kind),
      sourceRecordId: str(r.source_record_id),
      sourceUrl: text(r.source_url),
      evidenceText: text(r.evidence_text),
      verificationStatus: member(s.assertionStatus.enumValues, r.verification_status, "relationship_assertions.verification_status"),
      confidence: num(r.confidence),
    }));

    // Nothing commits unless Postgres holds exactly what was read.
    for (const [table, expected] of report) {
      const result = await tx.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      const actual = result.rows[0]!.n;
      if (actual !== expected) throw new ImportError(`${table}: expected ${expected} rows, found ${actual}`);
    }
  });

  return selfReferences;
}

/** Aliases store both the raw and normalized text, so they check the port. */
function normalizationDrift(rows: (query: string) => Row[]) {
  const aliases = rows("SELECT title, artist, norm_title, norm_artist FROM node_aliases");
  const drifted = aliases.filter(
    (a) => normalize(str(a.title)) !== a.norm_title || normalize(str(a.artist)) !== a.norm_artist,
  );
  return { checked: aliases.length, drifted };
}

// --- main ------------------------------------------------------------------

try {
  const started = performance.now();
  const { lite, rows, metadata, schemaVersion } = openCatalog(catalogPath);
  console.log(`Importing ${catalogPath}`);
  console.log(`  ${metadata.catalog_revision_id}`);
  console.log(`  schema v${schemaVersion}, built ${metadata.catalog_revision_created_at}`);

  const selfReferences = await importCatalog(rows);
  const { checked, drifted } = normalizationDrift(rows);
  lite.close();

  for (const [table, n] of report) console.log(`  ${table.padEnd(26)} ${n.toLocaleString("en-US").padStart(7)}`);
  console.log(`Imported in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
  if (selfReferences.length) {
    console.warn(
      `Skipped ${selfReferences.length} edge(s) from a recording to itself; a catalog built with ` +
        `Sinc's fixed build_db.py has none:\n` +
        selfReferences.map((e) => `  ${e.canonical_id}  ${e.relationship_type}  "${e.source_title}"`).join("\n"),
    );
  }
  if (drifted.length) {
    console.warn(
      `Normalization drift: ${drifted.length} of ${checked} aliases normalize differently here than ` +
        `in the catalog, so title lookups will miss them. First: ${JSON.stringify(drifted[0])}`,
    );
  } else {
    console.log(`Normalization matches the catalog on all ${checked.toLocaleString("en-US")} aliases.`);
  }
} catch (err) {
  console.error(`import:sinc failed: ${err instanceof ImportError ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
