import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import * as catalog from "../catalog/repository.js";
import { generations, generationsOfTracks } from "../catalog/generations.js";
import type { Db } from "../db/client.js";
import {
  Direction,
  GenerationsFamily,
  ErrorBody,
  Lineage,
  Relationships,
  Resolution,
  ResolveQuery,
  SiblingGroup,
  TrackDetail,
  TrackParams,
  TrackSummary,
} from "./schemas.js";

const errors = { 400: ErrorBody, 404: ErrorBody };

const notFound = (id: string) => ({
  error: { code: "track_not_found", message: `No track with id ${id}` },
});

const missingSelector = {
  error: { code: "invalid_request", message: "Pass canonicalId, isrc, mbid, or both title and artist." },
};
const hasSelector = (q: { canonicalId?: string; isrc?: string; mbid?: string; title?: string; artist?: string }) =>
  Boolean(q.canonicalId || q.isrc || q.mbid || (q.title && q.artist));

// operationId names each operation in generated clients, so keep them stable.
export const v1: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  app.get("/tracks/resolve", {
    schema: {
      operationId: "resolveTrack",
      tags: ["tracks"],
      summary: "Find the catalog recordings for a recognized song",
      description:
        "Pass a catalog id, ISRC, MusicBrainz recording id, or title and artist. The first stages are " +
        "Sinc's bundled lookup: canonical id, then the union of ISRC and MusicBrainz matches, then " +
        "normalized title and artist. Known title and artist aliases are a last exact stage that only " +
        "the online catalog has.",
      querystring: ResolveQuery,
      response: { 200: Resolution, ...errors },
    },
  }, async (request, reply) => {
    const { canonicalId, isrc, mbid, title, artist, kind = "song" } = request.query;
    if (!hasSelector(request.query)) return reply.code(400).send(missingSelector);
    const { matchedBy, trackIds } = await catalog.resolveTracks(db, { canonicalId, isrc, mbid, title, artist, kind });
    const summaries = await catalog.trackSummaries(db, trackIds);
    return { matchedBy, tracks: trackIds.map((id) => summaries.get(id)!) };
  });

  app.get("/tracks/:id", {
    schema: {
      operationId: "getTrack",
      tags: ["tracks"],
      summary: "A track, its credits, and its other versions",
      params: TrackParams,
      response: { 200: TrackDetail, ...errors },
    },
  }, async (request, reply) => {
    const trackId = await catalog.findTrackId(db, request.params.id);
    if (trackId === null) return reply.code(404).send(notFound(request.params.id));
    return catalog.trackDetail(db, trackId);
  });

  app.get("/tracks/:id/relationships", {
    schema: {
      operationId: "getRelationships",
      tags: ["tracks"],
      summary: "What the song takes from, and what takes from it",
      description:
        "Covers every version of the song. One relationship per related song, direction, and type, " +
        "preferring the one that says what was borrowed. Only published relationships.",
      params: TrackParams,
      querystring: Type.Object({
        limit: Type.Integer({ minimum: 1, maximum: 200, default: 50, description: "Per direction." }),
      }),
      response: { 200: Relationships, ...errors },
    },
  }, async (request, reply) => {
    const trackId = await catalog.findTrackId(db, request.params.id);
    if (trackId === null) return reply.code(404).send(notFound(request.params.id));
    const root = await catalog.songRoot(db, [trackId]);
    return catalog.relationships(db, root, request.query.limit);
  });

  app.get("/tracks/:id/lineage", {
    schema: {
      operationId: "getLineage",
      tags: ["tracks"],
      summary: "The song's lineage, generation by generation",
      description:
        "A tree of relationships from the song outward, as Sinc's lineage view builds it: sources by " +
        "default (what it samples, what those sample, and so on), or derivatives. Nodes come depth-first " +
        "with parentId set, so a client can rebuild the tree in one pass.",
      params: TrackParams,
      querystring: Type.Object({
        direction: Type.Optional(Direction),
        depth: Type.Integer({ minimum: 1, maximum: 5, default: 3, description: "Generations below the root." }),
        rootLimit: Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Children shown under the root." }),
        childLimit: Type.Integer({ minimum: 1, maximum: 20, default: 4, description: "Children shown under any other node." }),
      }),
      response: { 200: Lineage, ...errors },
    },
  }, async (request, reply) => {
    const trackId = await catalog.findTrackId(db, request.params.id);
    if (trackId === null) return reply.code(404).send(notFound(request.params.id));
    const { direction = "sources", depth, rootLimit, childLimit } = request.query;
    return catalog.lineage(db, trackId, { direction, maxDepth: depth, rootLimit, childLimit, maxNodes: 500 });
  });

  app.get("/tracks/:id/generations", {
    schema: {
      operationId: "getGenerations",
      tags: ["tracks"],
      summary: "The song's sound family, following sampled, interpolated and remixed handoffs",
      description: "Matches Sinc's GenerationsBuilder over published catalog edges and version clusters. " +
        "One handoff is one generation; covers do not count.",
      params: TrackParams,
      response: { 200: GenerationsFamily, ...errors },
    },
  }, async (request, reply) => {
    const family = await generations(db, request.params.id);
    if (!family) return reply.code(404).send(notFound(request.params.id));
    return family;
  });

  app.get("/generations", {
    schema: {
      operationId: "resolveGenerations",
      tags: ["tracks"],
      summary: "The sound family of a recognized song",
      description: "Resolves the song as /tracks/resolve does and builds one family from every recording " +
        "that matched, as Sinc's bundled catalog does for a scan: duplicate copies in separate version " +
        "clusters are all the song. 404 when nothing matches.",
      querystring: ResolveQuery,
      response: { 200: GenerationsFamily, ...errors },
    },
  }, async (request, reply) => {
    const { canonicalId, isrc, mbid, title, artist, kind = "song" } = request.query;
    if (!hasSelector(request.query)) return reply.code(400).send(missingSelector);
    const { trackIds } = await catalog.resolveTracks(db, { canonicalId, isrc, mbid, title, artist, kind });
    const family = await generationsOfTracks(db, trackIds);
    if (!family) {
      return reply.code(404).send({ error: { code: "track_not_found", message: "No catalog recording matches" } });
    }
    return family;
  });

  app.get("/tracks/:id/siblings", {
    schema: {
      operationId: "getSiblings",
      tags: ["tracks"],
      summary: "Other songs built from the same sources",
      description: "Grouped by shared source, busiest first. `total` counts every song before trimming.",
      params: TrackParams,
      querystring: Type.Object({
        perSource: Type.Integer({ minimum: 1, maximum: 100, default: 12 }),
        sources: Type.Integer({ minimum: 1, maximum: 20, default: 4 }),
      }),
      response: {
        200: Type.Object({ groups: Type.Array(SiblingGroup) }, { title: "Siblings" }),
        ...errors,
      },
    },
  }, async (request, reply) => {
    const trackId = await catalog.findTrackId(db, request.params.id);
    if (trackId === null) return reply.code(404).send(notFound(request.params.id));
    const root = await catalog.songRoot(db, [trackId]);
    return { groups: await catalog.siblings(db, root, request.query) };
  });

  app.get("/search", {
    schema: {
      operationId: "searchTracks",
      tags: ["search"],
      summary: "Search songs by title and artist",
      description: 'Every word must appear in the title or artist, so "juicy notorious" works. One recording per song.',
      querystring: Type.Object({
        q: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Integer({ minimum: 1, maximum: 100, default: 24 }),
      }),
      response: {
        200: Type.Object({ tracks: Type.Array(TrackSummary) }, { title: "SearchResults" }),
        ...errors,
      },
    },
  }, async (request) => ({
    tracks: await catalog.search(db, request.query.q, request.query.limit),
  }));
};
