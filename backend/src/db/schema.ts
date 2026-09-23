/**
 * Canonical Music DNA store, shaped after Sinc's catalog
 * (Sincapp/tools/build_db.py) and data contract (Sincapp/docs/DATA_PLATFORM.md).
 *
 * Sinc catalog table        -> this schema
 *   graph_nodes + recording_metadata -> tracks
 *   node_identifiers                 -> track_identifiers
 *   node_aliases                     -> track_aliases
 *   recording_aliases                -> track_name_aliases
 *   recording_artists                -> track_artists
 *   recording_contributors           -> track_contributors
 *   recording_lineage_disclosures    -> track_lineage_disclosures
 *   artists / works / work_identifiers / recording_works -> same, track_works
 *   graph_edges                      -> samples (source -> parent, destination -> child)
 *   relationship_details             -> samples.notes + sample_segments
 *   relationship_assertions          -> sample_assertions
 *
 * Internal integer ids are for joins only. `canonical_id` is the stable,
 * public identifier and uses the same format as Sinc's catalog, so ids in the
 * app's bundled catalog stay valid against this database.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums (closed vocabularies that code branches on)
// ---------------------------------------------------------------------------

/** What a node is. Mirrors the kinds Sinc's views render (Models.swift). */
export const trackKind = pgEnum("track_kind", [
  "song",
  "film",
  "tv",
  "comedy",
  "speech",
]);

/** Mirrors MusicDNARelationshipType in Sinc's MusicDNAGraph.swift. */
export const relationshipType = pgEnum("relationship_type", [
  "sampled",
  "interpolated",
  "covered",
  "remixed",
]);

/** How the borrowed audio was treated (Sinc's `sampleType`). */
export const sampleType = pgEnum("sample_type", [
  "direct",
  "looped",
  "chopped",
  "pitch_shifted",
  "time_stretched",
  "filtered",
  "layered",
]);

/**
 * Where a relationship is in the publication pipeline. Candidates must not
 * silently become facts; only `published` edges should be served to users.
 */
export const sampleStatus = pgEnum("sample_status", [
  "observed",
  "candidate",
  "reviewed",
  "verified",
  "published",
  "rejected",
  "disputed",
]);

/** The standing of one source's claim about a relationship. */
export const assertionStatus = pgEnum("assertion_status", [
  "imported",
  "inferred",
  "community_submitted",
  "reviewed",
  "corroborated",
  "verified",
  "disputed",
]);

export const identifierNamespace = pgEnum("identifier_namespace", [
  "musicbrainz_recording",
  "isrc",
  "iswc",
  "apple_music",
  "spotify",
  "acrcloud",
  "audd",
  "acoustid",
]);

export const lineageClassification = pgEnum("lineage_classification", [
  "human",
  "ai_assisted",
  "ai_generated",
  "unknown",
]);

// ---------------------------------------------------------------------------
// Shared columns and checks
// ---------------------------------------------------------------------------

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

const timestamps = {
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Confidence scores are probabilities. */
const confidenceCheck = (name: string, column: unknown) =>
  check(name, sql`${column} BETWEEN 0 AND 1`);

// ---------------------------------------------------------------------------
// Catalog entities
// ---------------------------------------------------------------------------

export const artists = pgTable("artists", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  canonicalId: text("canonical_id").notNull().unique(),
  musicbrainzArtistId: text("musicbrainz_artist_id").unique(),
  name: text("name").notNull(),
  sortName: text("sort_name"),
  ...timestamps,
});

/** Compositions. Interpolations and covers relate at this level. */
export const works = pgTable("works", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  canonicalId: text("canonical_id").notNull().unique(),
  musicbrainzWorkId: text("musicbrainz_work_id").unique(),
  title: text("title").notNull(),
  workType: text("work_type"),
  disambiguation: text("disambiguation"),
  ...timestamps,
});

/**
 * Any recording that can sample or be sampled: songs, and also film, TV,
 * comedy, and speech sources. Titles and artist credits are display data and
 * fallback search keys, not identity.
 */
export const tracks = pgTable(
  "tracks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    canonicalId: text("canonical_id").notNull().unique(),
    /** Dedup key: `mb:recording:<mbid>`, or `text:<kind>:<norm_title>:<norm_artist>`. */
    identityKey: text("identity_key").notNull().unique(),
    kind: trackKind("kind").notNull().default("song"),
    title: text("title").notNull(),
    /** The artist as credited on this recording, e.g. "Jay-Z feat. Beyoncé". */
    artistCredit: text("artist_credit").notNull(),
    /** Normalized with Sinc's normalize() (Models.swift / build_db.py). */
    normTitle: text("norm_title").notNull(),
    normArtist: text("norm_artist").notNull(),
    releaseYear: smallint("release_year"),
    durationMs: integer("duration_ms"),
    disambiguation: text("disambiguation"),
    isVideo: boolean("is_video"),
    ...timestamps,
  },
  (t) => [
    index("tracks_norm_idx").on(t.normTitle, t.normArtist, t.kind),
    check("tracks_duration_ms_positive", sql`${t.durationMs} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Track metadata
// ---------------------------------------------------------------------------

export const trackIdentifiers = pgTable(
  "track_identifiers",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    namespace: identifierNamespace("namespace").notNull(),
    identifier: text("identifier").notNull(),
    /** The data source that supplied this identifier. */
    source: text("source").notNull(),
  },
  (t) => [
    unique("track_identifiers_unique").on(t.trackId, t.namespace, t.identifier),
    index("track_identifiers_lookup_idx").on(t.namespace, t.identifier),
    // A MusicBrainz recording is exactly one track. ISRCs are not unique in
    // practice, so they are only indexed.
    uniqueIndex("track_identifiers_musicbrainz_unique")
      .on(t.namespace, t.identifier)
      .where(sql`${t.namespace} = 'musicbrainz_recording'`),
  ],
);

/** Title/artist pairs a track is known by, used to match recognition results. */
export const trackAliases = pgTable(
  "track_aliases",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    artistCredit: text("artist_credit").notNull(),
    normTitle: text("norm_title").notNull(),
    normArtist: text("norm_artist").notNull(),
    source: text("source").notNull(),
  },
  (t) => [
    unique("track_aliases_unique").on(t.trackId, t.normTitle, t.normArtist),
    index("track_aliases_norm_idx").on(t.normTitle, t.normArtist),
  ],
);

/** MusicBrainz recording aliases: localized names and search hints. */
export const trackNameAliases = pgTable(
  "track_name_aliases",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    locale: text("locale"),
    aliasType: text("alias_type"),
    isPrimary: boolean("is_primary"),
    source: text("source").notNull(),
  },
  (t) => [
    unique("track_name_aliases_unique").on(
      t.trackId,
      t.name,
      t.locale,
      t.aliasType,
    ),
    index("track_name_aliases_name_idx").on(t.name),
  ],
);

/** The ordered artist credit, MusicBrainz style ("A" + " feat. " + "B"). */
export const trackArtists = pgTable(
  "track_artists",
  {
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    creditedName: text("credited_name"),
    joinPhrase: text("join_phrase"),
  },
  (t) => [
    primaryKey({ columns: [t.trackId, t.artistId, t.position] }),
    index("track_artists_artist_id_idx").on(t.artistId),
  ],
);

/** People credited on a recording in any role: performer, producer, writer. */
export const trackContributors = pgTable(
  "track_contributors",
  {
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    contributorName: text("contributor_name").notNull(),
    artistId: integer("artist_id").references(() => artists.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
    creditedName: text("credited_name"),
    position: integer("position").notNull().default(0),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    confidence: real("confidence"),
  },
  (t) => [
    primaryKey({
      columns: [t.trackId, t.contributorName, t.role, t.position],
    }),
    index("track_contributors_artist_id_idx").on(t.artistId),
    confidenceCheck("track_contributors_confidence_range", t.confidence),
  ],
);

export const trackWorks = pgTable(
  "track_works",
  {
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    workId: integer("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").notNull().default("performance"),
    source: text("source").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.trackId, t.workId, t.relationshipType] }),
    // Serves "other recordings of this composition".
    index("track_works_work_id_idx").on(t.workId),
  ],
);

export const workIdentifiers = pgTable(
  "work_identifiers",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    workId: integer("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    namespace: identifierNamespace("namespace").notNull(),
    identifier: text("identifier").notNull(),
    source: text("source").notNull(),
  },
  (t) => [
    unique("work_identifiers_unique").on(t.workId, t.namespace, t.identifier),
    index("work_identifiers_lookup_idx").on(t.namespace, t.identifier),
  ],
);

/** Whether a recording was made by people, with AI assistance, or by AI. */
export const trackLineageDisclosures = pgTable(
  "track_lineage_disclosures",
  {
    trackId: integer("track_id")
      .primaryKey()
      .references(() => tracks.id, { onDelete: "cascade" }),
    classification: lineageClassification("classification").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    evidenceText: text("evidence_text"),
    confidence: real("confidence"),
  },
  (t) => [
    confidenceCheck("track_lineage_disclosures_confidence_range", t.confidence),
  ],
);

// ---------------------------------------------------------------------------
// The sample graph
// ---------------------------------------------------------------------------

/**
 * Directed relationships: child_track_id samples (or interpolates, covers,
 * remixes) parent_track_id. In Sinc's terms the parent is the edge's source
 * and the child its destination.
 *
 * One edge per (parent, child, relationship type). Where and how the material
 * was used lives in sample_segments; who says so lives in sample_assertions.
 */
export const samples = pgTable(
  "samples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    canonicalId: text("canonical_id").notNull().unique(),
    parentTrackId: integer("parent_track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    childTrackId: integer("child_track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    relationshipType: relationshipType("relationship_type")
      .notNull()
      .default("sampled"),
    status: sampleStatus("status").notNull().default("candidate"),
    /** Computed from the assertions; not a source's own claim. */
    confidence: real("confidence"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    // Leads with parent_track_id, so it also serves "who sampled this track?".
    unique("samples_edge_unique").on(
      t.parentTrackId,
      t.childTrackId,
      t.relationshipType,
    ),
    // Serves "what does this track sample?".
    index("samples_child_idx").on(t.childTrackId, t.relationshipType),
    index("samples_status_idx").on(t.status),
    check(
      "samples_no_self_reference",
      sql`${t.parentTrackId} <> ${t.childTrackId}`,
    ),
    confidenceCheck("samples_confidence_range", t.confidence),
  ],
);

/**
 * One borrowed element of a relationship: what was taken, where it sits in
 * each recording, and how it was transformed. Timing is optional; many
 * relationships are known to use "the drums" long before anyone times them.
 */
export const sampleSegments = pgTable(
  "sample_segments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sampleId: integer("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    /** e.g. "drums (drum set)", "lead vocals", "hook". */
    element: text("element"),
    /** Where the material occurs in the parent, in ms from the start. */
    timestampParent: integer("timestamp_parent"),
    /** Where it appears in the child, in ms from the start. */
    timestampChild: integer("timestamp_child"),
    durationMs: integer("duration_ms"),
    sampleType: sampleType("sample_type"),
    pitchShiftSemitones: real("pitch_shift_semitones"),
    tempoRatio: real("tempo_ratio"),
    isReversed: boolean("is_reversed"),
    isLooped: boolean("is_looped"),
    createdAt,
  },
  (t) => [
    unique("sample_segments_unique")
      .on(t.sampleId, t.element, t.timestampParent, t.timestampChild)
      .nullsNotDistinct(),
    check(
      "sample_segments_timestamps_non_negative",
      sql`${t.timestampParent} >= 0 AND ${t.timestampChild} >= 0`,
    ),
    check("sample_segments_duration_positive", sql`${t.durationMs} > 0`),
    check("sample_segments_tempo_ratio_positive", sql`${t.tempoRatio} > 0`),
  ],
);

/**
 * One source's claim that a relationship exists. Sources never overwrite
 * each other: every independent claim is its own row on the same edge.
 */
export const sampleAssertions = pgTable(
  "sample_assertions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sampleId: integer("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    /** e.g. "musicbrainz", "wikipedia", "curated". */
    sourceName: text("source_name").notNull(),
    /** e.g. "community_database", "wikipedia_prose", "human_curated". */
    sourceKind: text("source_kind").notNull(),
    sourceRecordId: text("source_record_id").notNull().default(""),
    sourceUrl: text("source_url"),
    evidenceText: text("evidence_text"),
    verificationStatus: assertionStatus("verification_status")
      .notNull()
      .default("imported"),
    confidence: real("confidence"),
    createdAt,
  },
  (t) => [
    unique("sample_assertions_unique").on(
      t.sampleId,
      t.sourceName,
      t.sourceRecordId,
    ),
    confidenceCheck("sample_assertions_confidence_range", t.confidence),
  ],
);

// ---------------------------------------------------------------------------
// Relations (for the db.query API)
// ---------------------------------------------------------------------------

export const artistsRelations = relations(artists, ({ many }) => ({
  credits: many(trackArtists),
  contributions: many(trackContributors),
}));

export const worksRelations = relations(works, ({ many }) => ({
  recordings: many(trackWorks),
  identifiers: many(workIdentifiers),
}));

export const tracksRelations = relations(tracks, ({ one, many }) => ({
  identifiers: many(trackIdentifiers),
  aliases: many(trackAliases),
  nameAliases: many(trackNameAliases),
  artists: many(trackArtists),
  contributors: many(trackContributors),
  works: many(trackWorks),
  lineageDisclosure: one(trackLineageDisclosures),
  /** Edges where this track is the child: the tracks it samples. */
  samples: many(samples, { relationName: "child" }),
  /** Edges where this track is the parent: the tracks that sample it. */
  sampledBy: many(samples, { relationName: "parent" }),
}));

export const trackIdentifiersRelations = relations(
  trackIdentifiers,
  ({ one }) => ({
    track: one(tracks, {
      fields: [trackIdentifiers.trackId],
      references: [tracks.id],
    }),
  }),
);

export const trackAliasesRelations = relations(trackAliases, ({ one }) => ({
  track: one(tracks, {
    fields: [trackAliases.trackId],
    references: [tracks.id],
  }),
}));

export const trackNameAliasesRelations = relations(
  trackNameAliases,
  ({ one }) => ({
    track: one(tracks, {
      fields: [trackNameAliases.trackId],
      references: [tracks.id],
    }),
  }),
);

export const trackArtistsRelations = relations(trackArtists, ({ one }) => ({
  track: one(tracks, {
    fields: [trackArtists.trackId],
    references: [tracks.id],
  }),
  artist: one(artists, {
    fields: [trackArtists.artistId],
    references: [artists.id],
  }),
}));

export const trackContributorsRelations = relations(
  trackContributors,
  ({ one }) => ({
    track: one(tracks, {
      fields: [trackContributors.trackId],
      references: [tracks.id],
    }),
    artist: one(artists, {
      fields: [trackContributors.artistId],
      references: [artists.id],
    }),
  }),
);

export const trackWorksRelations = relations(trackWorks, ({ one }) => ({
  track: one(tracks, {
    fields: [trackWorks.trackId],
    references: [tracks.id],
  }),
  work: one(works, {
    fields: [trackWorks.workId],
    references: [works.id],
  }),
}));

export const workIdentifiersRelations = relations(
  workIdentifiers,
  ({ one }) => ({
    work: one(works, {
      fields: [workIdentifiers.workId],
      references: [works.id],
    }),
  }),
);

export const trackLineageDisclosuresRelations = relations(
  trackLineageDisclosures,
  ({ one }) => ({
    track: one(tracks, {
      fields: [trackLineageDisclosures.trackId],
      references: [tracks.id],
    }),
  }),
);

export const samplesRelations = relations(samples, ({ one, many }) => ({
  parent: one(tracks, {
    fields: [samples.parentTrackId],
    references: [tracks.id],
    relationName: "parent",
  }),
  child: one(tracks, {
    fields: [samples.childTrackId],
    references: [tracks.id],
    relationName: "child",
  }),
  segments: many(sampleSegments),
  assertions: many(sampleAssertions),
}));

export const sampleSegmentsRelations = relations(sampleSegments, ({ one }) => ({
  sample: one(samples, {
    fields: [sampleSegments.sampleId],
    references: [samples.id],
  }),
}));

export const sampleAssertionsRelations = relations(
  sampleAssertions,
  ({ one }) => ({
    sample: one(samples, {
      fields: [sampleAssertions.sampleId],
      references: [samples.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Artist = typeof artists.$inferSelect;
export type NewArtist = typeof artists.$inferInsert;
export type Work = typeof works.$inferSelect;
export type NewWork = typeof works.$inferInsert;
export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Sample = typeof samples.$inferSelect;
export type NewSample = typeof samples.$inferInsert;
export type SampleSegment = typeof sampleSegments.$inferSelect;
export type NewSampleSegment = typeof sampleSegments.$inferInsert;
export type SampleAssertion = typeof sampleAssertions.$inferSelect;
export type NewSampleAssertion = typeof sampleAssertions.$inferInsert;
