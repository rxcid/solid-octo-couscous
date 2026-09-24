/**
 * Records real API responses, from the test fixture catalog, for the Swift
 * client's tests. Each file keeps the URL it was recorded from; the Swift
 * tests replay the body and check the client asked for that same URL. Run
 * after changing a response shape (needs Postgres: npm run db:up):
 *
 *   npm run openapi:fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildApp } from "../app.js";
import { truncateCatalog } from "../db/maintenance.js";
import { setupTestDb } from "../test/database.js";
import { seedCatalog } from "../test/fixtures.js";

const DIR = resolve(import.meta.dirname, "../../../clients/swift/Tests/MusicSampleGraphClientTests/Fixtures");

const { db, pool } = await setupTestDb();
await truncateCatalog(db);
const ids = await seedCatalog(db);
const app = await buildApp({ db, corsOrigin: "*", logger: false });

// URLs as the Swift client builds them: declared parameter order, unset ones left out.
const recordings: Record<string, string> = {
  resolve: "/v1/tracks/resolve?isrc=USAAA6900001&kind=song",
  "resolve-mbid": "/v1/tracks/resolve?mbid=00000000-0000-4000-8000-00000000000c&kind=song",
  "resolve-invalid": "/v1/tracks/resolve?title=Night%20Drive&kind=song",
  track: `/v1/tracks/${ids.funkyBreak}`,
  "track-not-found": "/v1/tracks/node_unknown",
  relationships: `/v1/tracks/${ids.funkyBreak}/relationships`,
  lineage: `/v1/tracks/${ids.lateEcho}/lineage`,
  generations: `/v1/tracks/${ids.funkyBreak}/generations`,
  "generations-resolved": "/v1/generations?isrc=USAAA6900001&kind=song",
  "generations-no-match": "/v1/generations?title=Nothing&artist=Nobody&kind=song",
  "lineage-derivatives": `/v1/tracks/${ids.funkyBreak}/lineage?direction=derivatives&depth=2`,
  siblings: `/v1/tracks/${ids.nightDrive}/siblings`,
  search: "/v1/search?q=funky",
};

try {
  mkdirSync(DIR, { recursive: true });
  for (const [name, url] of Object.entries(recordings)) {
    const response = await app.inject({ method: "GET", url });
    const recording = { url, status: response.statusCode, body: response.json() };
    writeFileSync(resolve(DIR, `${name}.json`), `${JSON.stringify(recording, null, 2)}\n`);
  }
  console.log(`Recorded ${Object.keys(recordings).length} responses in ${relative(process.cwd(), DIR)}`);
} finally {
  await app.close();
  await pool.end();
}
