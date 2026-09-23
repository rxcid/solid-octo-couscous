/**
 * The v1 API contract. These schemas validate requests, serialize responses,
 * and generate the OpenAPI document (GET /openapi.json).
 *
 * Ids are Sinc's canonical ids (`node_…`, `edge_…`, `artist_mb_…`), so an id
 * from the app's bundled catalog names the same thing here. Times are
 * milliseconds; Sinc's catalog stores seconds.
 */
import { Type, type Static, type TSchema, type TSchemaOptions } from "typebox";
import * as db from "../db/schema.js";

const Nullable = <T extends TSchema>(schema: T, options?: TSchemaOptions) =>
  Type.Union([schema, Type.Null()], options);

export const TrackId = Type.String({
  pattern: "^node_[A-Za-z0-9_-]{1,100}$",
  description: "A track's canonical id, as in Sinc's catalog.",
  examples: ["node_3577dce5b98f6d4f398357f9f7a7658188daf2b213cf526a118f82af1bfe81ba"],
});

export const TrackKind = Type.Enum(db.trackKind.enumValues);
export const RelationshipType = Type.Enum(db.relationshipType.enumValues);

export const TrackSummary = Type.Object({
  id: TrackId,
  kind: TrackKind,
  title: Type.String(),
  artistCredit: Type.String({ description: "The artist as credited on this recording." }),
  releaseYear: Nullable(Type.Integer()),
  isrc: Nullable(Type.String()),
  musicbrainzRecordingId: Nullable(Type.String()),
});

export const TrackDetail = Type.Object({
  ...TrackSummary.properties,
  durationMs: Nullable(Type.Integer()),
  disambiguation: Nullable(Type.String()),
  identifiers: Type.Array(
    Type.Object({ namespace: Type.Enum(db.identifierNamespace.enumValues), identifier: Type.String() }),
  ),
  artists: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      creditedName: Nullable(Type.String()),
      joinPhrase: Nullable(Type.String()),
    }),
    { description: "The ordered artist credit. Joining creditedName (or name) and joinPhrase rebuilds artistCredit." },
  ),
  contributors: Type.Array(
    Type.Object({
      name: Type.String(),
      role: Type.String(),
      artistId: Nullable(Type.String()),
      creditedName: Nullable(Type.String()),
    }),
  ),
  works: Type.Array(
    Type.Object({ id: Type.String(), title: Type.String(), iswcs: Type.Array(Type.String()) }),
    { description: "Compositions this recording performs." },
  ),
  lineageDisclosure: Nullable(
    Type.Object({
      classification: Type.Enum(db.lineageClassification.enumValues),
      source: Type.String(),
      sourceUrl: Nullable(Type.String()),
      evidenceText: Nullable(Type.String()),
      confidence: Nullable(Type.Number()),
    }),
    { description: "Whether the recording is human-made or AI-generated. Null means not recorded, not human-made." },
  ),
  versions: Type.Array(TrackSummary, {
    description:
      "Other recordings of the same song: the same normalized title, artist, and kind, or a shared ISRC. " +
      "Relationships and siblings cover all of them.",
  }),
});

export const Segment = Type.Object({
  element: Nullable(Type.String({ description: 'What was borrowed, e.g. "drums (drum set)".' })),
  atInSourceMs: Nullable(Type.Integer()),
  atInDestinationMs: Nullable(Type.Integer()),
  durationMs: Nullable(Type.Integer()),
  sampleType: Nullable(Type.Enum(db.sampleType.enumValues)),
  pitchShiftSemitones: Nullable(Type.Number()),
  tempoRatio: Nullable(Type.Number()),
  isReversed: Nullable(Type.Boolean()),
  isLooped: Nullable(Type.Boolean()),
});

export const Provenance = Type.Object({
  sources: Type.Array(Type.String(), { description: 'Who asserts this, e.g. "musicbrainz", "wikipedia".' }),
  sourceKinds: Type.Array(Type.String()),
  assertionCount: Type.Integer(),
  isVerified: Type.Boolean({ description: "At least one assertion has been verified." }),
  isInference: Type.Boolean({ description: "Inferred from shared writer credits rather than stated." }),
  confidence: Nullable(Type.Number({ description: "The highest confidence any source reports." })),
  evidenceExcerpt: Nullable(Type.String()),
  evidenceUrl: Nullable(Type.String()),
});

export const Relationship = Type.Object({
  id: Type.String({ description: "The relationship's canonical id (edge_…)." }),
  type: RelationshipType,
  source: TrackSummary,
  destination: TrackSummary,
  notes: Nullable(Type.String()),
  segments: Type.Array(Segment),
  provenance: Provenance,
});

const RelationshipPage = Type.Object({
  total: Type.Integer({ description: "Related songs in all, before the limit." }),
  items: Type.Array(Relationship),
});

export const Relationships = Type.Object({
  sources: Type.Object(RelationshipPage.properties, {
    description: "What this song takes from: relationships where it is the destination.",
  }),
  derivatives: Type.Object(RelationshipPage.properties, {
    description: "What takes from this song: relationships where it is the source.",
  }),
});

export const SiblingGroup = Type.Object({
  source: TrackSummary,
  total: Type.Integer({ description: "Every other song built from this source." }),
  tracks: Type.Array(TrackSummary),
});

export const ResolveQuery = Type.Object({
  isrc: Type.Optional(Type.String({ maxLength: 64 })),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  artist: Type.Optional(Type.String({ maxLength: 500 })),
  kind: Type.Optional(TrackKind),
});

export const Resolution = Type.Object({
  matchedBy: Nullable(Type.Enum(["isrc", "title_artist"])),
  tracks: Type.Array(TrackSummary, { description: "Every recording that matched. Empty when the catalog has none." }),
});

export const TrackParams = Type.Object({ id: TrackId });

export const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});

export type TrackSummary = Static<typeof TrackSummary>;
export type TrackDetail = Static<typeof TrackDetail>;
export type Segment = Static<typeof Segment>;
export type Relationship = Static<typeof Relationship>;
export type Relationships = Static<typeof Relationships>;
export type SiblingGroup = Static<typeof SiblingGroup>;
export type Resolution = Static<typeof Resolution>;
