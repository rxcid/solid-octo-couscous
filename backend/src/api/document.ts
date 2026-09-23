import { resolve } from "node:path";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";
import { forSwiftGenerator, publicDocument } from "./openapi.js";

/** The copy of the OpenAPI document the Swift client is generated from. */
export const SWIFT_CLIENT_SPEC = resolve(
  import.meta.dirname,
  "../../../clients/swift/Sources/MusicSampleGraphClient/openapi.json",
);

/**
 * The OpenAPI document as the server serves it, adapted for the Swift
 * generator (see forSwiftGenerator) and serialized for committing.
 */
export async function openApiDocument(): Promise<string> {
  // Routes never query while registering, so the pool is never connected.
  const { db, pool } = createDb("postgres://openapi@127.0.0.1:1/unused");
  const app = await buildApp({ db, corsOrigin: "*", logger: false });
  try {
    await app.ready();
    return `${JSON.stringify(forSwiftGenerator(publicDocument(app.swagger())), null, 2)}\n`;
  } finally {
    await app.close();
    await pool.end();
  }
}
