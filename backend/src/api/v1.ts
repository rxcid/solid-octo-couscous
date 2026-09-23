import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import * as catalog from "../catalog/repository.js";
import type { Db } from "../db/client.js";
import {
  ErrorBody,
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

export const v1: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  app.get("/tracks/resolve", {
    schema: {
      tags: ["tracks"],
      summary: "Find the catalog recordings for a recognized song",
      description:
        "Pass what recognition returned. An ISRC match wins; otherwise every recording with the same " +
        "normalized title, artist, and kind matches. Needs an ISRC, or a title and an artist.",
      querystring: ResolveQuery,
      response: { 200: Resolution, ...errors },
    },
  }, async (request, reply) => {
    const { isrc, title, artist, kind = "song" } = request.query;
    if (!isrc && !(title && artist)) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Pass isrc, or both title and artist." },
      });
    }
    const { matchedBy, trackIds } = await catalog.resolveTracks(db, { isrc, title, artist, kind });
    const summaries = await catalog.trackSummaries(db, trackIds);
    return { matchedBy, tracks: trackIds.map((id) => summaries.get(id)!) };
  });

  app.get("/tracks/:id", {
    schema: {
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

  app.get("/tracks/:id/siblings", {
    schema: {
      tags: ["tracks"],
      summary: "Other songs built from the same sources",
      description: "Grouped by shared source, busiest first. `total` counts every song before trimming.",
      params: TrackParams,
      querystring: Type.Object({
        perSource: Type.Integer({ minimum: 1, maximum: 100, default: 12 }),
        sources: Type.Integer({ minimum: 1, maximum: 20, default: 4 }),
      }),
      response: { 200: Type.Object({ groups: Type.Array(SiblingGroup) }), ...errors },
    },
  }, async (request, reply) => {
    const trackId = await catalog.findTrackId(db, request.params.id);
    if (trackId === null) return reply.code(404).send(notFound(request.params.id));
    const root = await catalog.songRoot(db, [trackId]);
    return { groups: await catalog.siblings(db, root, request.query) };
  });

  app.get("/search", {
    schema: {
      tags: ["search"],
      summary: "Search songs by title and artist",
      description: 'Every word must appear in the title or artist, so "juicy notorious" works. One recording per song.',
      querystring: Type.Object({
        q: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Integer({ minimum: 1, maximum: 100, default: 24 }),
      }),
      response: { 200: Type.Object({ tracks: Type.Array(TrackSummary) }), ...errors },
    },
  }, async (request) => ({
    tracks: await catalog.search(db, request.query.q, request.query.limit),
  }));
};
