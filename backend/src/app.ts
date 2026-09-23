import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { db, pool } from "./db/client.js";
import { env } from "./env.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: env.CORS_ORIGIN });

  app.get("/health", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok", database: "up" };
    } catch (err) {
      app.log.error(err, "database health check failed");
      return reply.code(503).send({ status: "degraded", database: "down" });
    }
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return app;
}
