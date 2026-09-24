/**
 * The v1 API contract. These schemas validate requests, serialize responses,
 * and generate the OpenAPI document (GET /openapi.json).
 *
 * Ids are Sinc's canonical ids (`node_…`, `edge_…`, `artist_mb_…`), so an id
 * from the app's bundled catalog names the same thing here. Times are
 * milliseconds; Sinc's catalog stores seconds.
 *
 * A schema's `title` names it: the OpenAPI document lists it once under
 * components and refers to it everywhere else (see openapi.ts), so generated
 * clients get a type with that name.
 */
import { Type, type Static, type TSchema, type TSchemaOptions } from "typebox";
import * as db from "../db/schema.js";

const Nullable = <T extends TSchema>(schema: T, options?: TSchemaOptions) =>
  Type.Union([schema, Type.Null()], options);

/** An enum of strings that says so, which code generators need to emit a real enum. */
const StringEnum = <const V extends string[]>(values: readonly [...V], options?: TSchemaOptions) =>
  Type.Enum(values, { ...options, type: "string" });

export const TrackId = Type.String({
  pattern: "^node_[A-Za-z0-9_-]{1,100}$",
  description: "A track's canonical id, as in Sinc's catalog, e.g. node_3577dce5b98f….",
});

export const TrackKind = StringEnum(db.trackKind.enumValues, { title: "TrackKind" });
export const RelationshipType = StringEnum(db.relationshipType.enumValues, { title: "RelationshipType" });
export const Direction = StringEnum(["sources", "derivatives"], { title: "Direction" });

export const TrackSummary = Type.Object(
  {
    id: TrackId,
    kind: TrackKind,
    title: Type.String(),
    artistCredit: Type.String({ description: "The artist as credited on this recording." }),
    releaseYear: Nullable(Type.Integer()),
    isrc: Nullable(Type.String()),
    musicbrainzRecordingId: Nullable(Type.String()),
  },
  { title: "TrackSummary" },
);

export const TrackDetail = Type.Object(
  {
    ...TrackSummary.properties,
    durationMs: Nullable(Type.Integer()),
    disambiguation: Nullable(Type.String()),
    identifiers: Type.Array(
      Type.Object(
        { namespace: StringEnum(db.identifierNamespace.enumValues, { title: "IdentifierNamespace" }), identifier: Type.String() },
        { title: "Identifier" },
      ),
    ),
    artists: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          creditedName: Nullable(Type.String()),
          joinPhrase: Nullable(Type.String()),
        },
        { title: "ArtistCredit" },
      ),
      { description: "The ordered artist credit. Joining creditedName (or name) and joinPhrase rebuilds artistCredit." },
    ),
    contributors: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          role: Type.String(),
          artistId: Nullable(Type.String()),
          creditedName: Nullable(Type.String()),
        },
        { title: "Contributor" },
      ),
    ),
    works: Type.Array(
      Type.Object({ id: Type.String(), title: Type.String(), iswcs: Type.Array(Type.String()) }, { title: "Work" }),
      { description: "Compositions this recording performs." },
    ),
    lineageDisclosure: Nullable(
      Type.Object(
        {
          classification: StringEnum(db.lineageClassification.enumValues, { title: "LineageClassification" }),
          source: Type.String(),
          sourceUrl: Nullable(Type.String()),
          evidenceText: Nullable(Type.String()),
          confidence: Nullable(Type.Number()),
        },
        { title: "LineageDisclosure" },
      ),
      { description: "Whether the recording is human-made or AI-generated. Null means not recorded, not human-made." },
    ),
    versions: Type.Array(TrackSummary, {
      description:
        "Other recordings of the same song: the same normalized title, artist, and kind, or a shared ISRC. " +
        "Relationships and siblings cover all of them.",
    }),
  },
  { title: "TrackDetail" },
);

export const Segment = Type.Object(
  {
    element: Nullable(Type.String({ description: 'What was borrowed, e.g. "drums (drum set)".' })),
    atInSourceMs: Nullable(Type.Integer()),
    atInDestinationMs: Nullable(Type.Integer()),
    durationMs: Nullable(Type.Integer()),
    sampleType: Nullable(StringEnum(db.sampleType.enumValues, { title: "SampleType" })),
    pitchShiftSemitones: Nullable(Type.Number()),
    tempoRatio: Nullable(Type.Number()),
    isReversed: Nullable(Type.Boolean()),
    isLooped: Nullable(Type.Boolean()),
  },
  { title: "Segment" },
);

export const Provenance = Type.Object(
  {
    sources: Type.Array(Type.String(), { description: 'Who asserts this, e.g. "musicbrainz", "wikipedia".' }),
    sourceKinds: Type.Array(Type.String()),
    assertionCount: Type.Integer(),
    isVerified: Type.Boolean({ description: "At least one assertion has been verified." }),
    isInference: Type.Boolean({ description: "Inferred from shared writer credits rather than stated." }),
    confidence: Nullable(Type.Number({ description: "The highest confidence any source reports." })),
    evidenceExcerpt: Nullable(Type.String()),
    evidenceUrl: Nullable(Type.String()),
  },
  { title: "Provenance" },
);

export const Relationship = Type.Object(
  {
    id: Type.String({ description: "The relationship's canonical id (edge_…)." }),
    relationshipType: RelationshipType,
    source: TrackSummary,
    destination: TrackSummary,
    notes: Nullable(Type.String()),
    segments: Type.Array(Segment),
    provenance: Provenance,
  },
  { title: "Relationship" },
);

const RelationshipPage = Type.Object(
  {
    total: Type.Integer({ description: "Related songs in all, before the limit." }),
    items: Type.Array(Relationship),
  },
  { title: "RelationshipPage" },
);

export const Relationships = Type.Object(
  {
    sources: RelationshipPage,
    derivatives: RelationshipPage,
  },
  {
    title: "Relationships",
    description:
      "sources: what this song takes from (it is the destination). " +
      "derivatives: what takes from this song (it is the source).",
  },
);

export const SiblingGroup = Type.Object(
  {
    source: TrackSummary,
    total: Type.Integer({ description: "Every other song built from this source." }),
    tracks: Type.Array(TrackSummary),
  },
  { title: "SiblingGroup" },
);

export const LineageNode = Type.Object(
  {
    id: Type.String({ description: 'Unique in this response: "0" is the root, "0.2" its third child.' }),
    parentId: Nullable(Type.String()),
    depth: Type.Integer({ description: "Generations from the root, which is 0." }),
    track: TrackSummary,
    relationship: Nullable(Relationship, { description: "The relationship joining this node to its parent." }),
    hiddenChildCount: Type.Integer({ description: "Relationships this node has that the tree does not show." }),
    isCycle: Type.Boolean({ description: "This song is already on the path to the root, so it is not expanded." }),
  },
  { title: "LineageNode" },
);

export const Lineage = Type.Object(
  {
    direction: Direction,
    truncated: Type.Boolean({ description: "The node budget cut the tree short." }),
    nodes: Type.Array(LineageNode, { description: "Depth-first: every node comes after its parent." }),
  },
  { title: "Lineage" },
);

export const GenerationsTrack = Type.Object({
  title: Type.String(), artist: Type.String(), year: Nullable(Type.Integer()),
  kind: TrackKind, isrc: Nullable(Type.String()),
  musicBrainzRecordingID: Nullable(Type.String()), catalogRecordingID: TrackId,
}, { title: "GenerationsTrack" });

export const GenerationsRecord = Type.Object({
  id: Type.String(), track: GenerationsTrack, earliestYear: Nullable(Type.Integer()),
  handoffTypes: Type.Array(StringEnum(["sampled", "interpolated", "remixed"], { title: "HandoffType" })),
  connectedTitles: Type.Array(Type.String()), alsoFromTitles: Type.Array(Type.String()),
}, { title: "GenerationsRecord" });

export const GenerationsGap = Type.Object({
  years: Nullable(Type.Object({ lower: Type.Integer(), upper: Type.Integer() }, { title: "GenerationsYearRange" })),
  hasDateConflict: Type.Boolean(),
}, { title: "GenerationsGap" });

export const Generation = Type.Object({
  role: StringEnum(["before", "thisSong", "sameGeneration", "after"], { title: "GenerationRole" }),
  offset: Type.Integer(), records: Type.Array(GenerationsRecord),
  gapFromPrevious: Nullable(GenerationsGap),
}, { title: "Generation" });

export const GenerationsFamily = Type.Object({
  root: GenerationsRecord, generations: Type.Array(Generation),
  hasMoreBefore: Type.Boolean(), hasMoreAfter: Type.Boolean(),
}, { title: "GenerationsFamily" });

export const ResolveQuery = Type.Object({
  isrc: Type.Optional(Type.String({ maxLength: 64 })),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  artist: Type.Optional(Type.String({ maxLength: 500 })),
  kind: Type.Optional(TrackKind),
});

export const Resolution = Type.Object(
  {
    matchedBy: Nullable(StringEnum(["isrc", "title_artist"], { title: "MatchMethod" })),
    tracks: Type.Array(TrackSummary, { description: "Every recording that matched. Empty when the catalog has none." }),
  },
  { title: "Resolution" },
);

export const TrackParams = Type.Object({ id: TrackId });

export const ErrorBody = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String() }, { title: "ErrorDetail" }) },
  { title: "Error" },
);

export type TrackSummary = Static<typeof TrackSummary>;
export type TrackDetail = Static<typeof TrackDetail>;
export type Segment = Static<typeof Segment>;
export type Relationship = Static<typeof Relationship>;
export type Relationships = Static<typeof Relationships>;
export type SiblingGroup = Static<typeof SiblingGroup>;
export type Lineage = Static<typeof Lineage>;
export type Resolution = Static<typeof Resolution>;
export type GenerationsFamily = Static<typeof GenerationsFamily>;
