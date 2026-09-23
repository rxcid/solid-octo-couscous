/**
 * A migrated Postgres database for tests: TEST_DATABASE_URL, or DATABASE_URL
 * with `_test` appended to the database name. Created on first use.
 */
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDb } from "../db/client.js";
import { env } from "../env.js";

export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

async function ensureDatabase(url: URL) {
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Can't reach Postgres for tests at ${admin.host}. Start it with \`npm run db:up\`.`, {
      cause: err,
    });
  }
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

export async function setupTestDb() {
  const url = new URL(testDatabaseUrl());
  // Tests truncate tables, so never let them near a real database.
  if (!/^\/[a-z0-9_]+_test$/.test(url.pathname)) {
    throw new Error(`Refusing to run tests against ${url.pathname.slice(1)}: its name must end in _test.`);
  }
  await ensureDatabase(url);
  const { db, pool } = createDb(url.toString());
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  return { db, pool };
}
