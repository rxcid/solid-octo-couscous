import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyServerOptions } from "fastify";
import { publicDocument } from "./api/openapi.js";
import { v1 } from "./api/v1.js";
import type { Db } from "./db/client.js";

export type AppOptions = {
  db: Db;
  corsOrigin: string;
  logger?: FastifyServerOptions["logger"];
};

export async function buildApp({ db, corsOrigin, logger = true }: AppOptions) {
  const app = Fastify({ logger }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, { origin: corsOrigin });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Music Sample Graph API",
        version: "1.0.0",
        description:
          "Sinc's Music DNA graph: what a song samples, what samples it, and who else " +
          "built on the same sources. Ids are Sinc's catalog canonical ids.",
      },
      tags: [
        { name: "tracks", description: "Recordings and their relationships" },
        { name: "search", description: "Finding songs" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    transformSpecification: (spec) => publicDocument(spec),
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => publicDocument(app.swagger()));

  // Every error leaves in one shape: { error: { code, message } }.
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: { code: "invalid_request", message: error.message } });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
    }
    return reply.code(status).send({ error: { code: "request_failed", message: error.message } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: `No route for ${request.method} ${request.url}` } }),
  );

  app.get("/health", { schema: { hide: true } }, async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok", database: "up" };
    } catch (err) {
      app.log.error(err, "database health check failed");
      return reply.code(503).send({ status: "degraded", database: "down" });
    }
  });

  await app.register(v1, { prefix: "/v1", db });

  return app;
}
