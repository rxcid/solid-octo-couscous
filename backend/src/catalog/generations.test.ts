import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import type { Db } from "../db/client.js";
import { env } from "../env.js";
import { setupTestDb } from "../test/database.js";
import { type GenerationsRecord, chronological, generations, scalarOrder } from "./generations.js";

const fixturePath = join(import.meta.dirname, "__fixtures__", "generations_vectors.json");
const sincDir = process.env.SINC_DIR ?? resolve(import.meta.dirname, "../../../../Sincapp");
const sourcePath = join(sincDir, "tools", "data", "generations_vectors.json");
const catalogPath = join(sincDir, "Sinc", "Resources", "samples.sqlite");
const skipCatalogParity = process.env.SKIP_SINC_CATALOG_PARITY === "1";
type Case = { name: string; request: { canonicalId: string | null }; maxClusters: number; family: unknown };
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { catalogSha256: string; cases: Case[] };
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

function compareFields(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((value, index) => compareFields(actual[index], value, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path} must be an object`);
    const wanted = Object.keys(expected).sort();
    assert.deepEqual(Object.keys(actual).sort(), wanted, `${path} fields`);
    for (const key of wanted) compareFields((actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

describe("GenerationsBuilder parity", {
  skip: skipCatalogParity && "Standalone CI has no bundled Sinc v16 catalog",
}, () => {
  before(async () => {
    if (!existsSync(catalogPath)) throw new Error(`Sinc bundled catalog missing: ${catalogPath}`);
    const hash = createHash("sha256").update(readFileSync(catalogPath)).digest("hex");
    assert.equal(hash, fixture.catalogSha256, "Only bundled v16 may produce the parity comparison");
    const parityUrl = new URL(env.DATABASE_URL);
    parityUrl.pathname = "/music_sample_graph_parity_test";
    process.env.TEST_DATABASE_URL = parityUrl.toString();
    const test = await setupTestDb();
    db = test.db;
    closeDb = () => test.pool.end();
    // A dedicated _test database protects both development data and the other
    // API tests. Replace it with the same bundled bytes Swift used.
    const imported = spawnSync(process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../scripts/import-sinc.ts"),
        "--replace", "--catalog", catalogPath],
      { cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, DATABASE_URL: parityUrl.toString() }, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    app = await buildApp({ db, corsOrigin: "*", logger: false });
  });

  after(async () => { await app?.close(); await closeDb?.(); });

  it("uses the exact fixture exported by Sinc's real Swift builder", {
    skip: !existsSync(sourcePath) && `no Sinc checkout at ${sincDir}`,
  }, () => assert.deepEqual(fixture, JSON.parse(readFileSync(sourcePath, "utf8"))));

  for (const vector of fixture.cases) {
    it(`matches every Swift field for ${vector.name}`, async () => {
      const actual = await generations(db, vector.request.canonicalId ?? "node_unknown", vector.maxClusters);
      compareFields(actual, vector.family, vector.name);
      if (vector.request.canonicalId && vector.maxClusters === 1500) {
        const response = await app.inject({ method: "GET", url: `/v1/tracks/${vector.request.canonicalId}/generations` });
        assert.equal(response.statusCode, 200, response.body);
        compareFields(response.json(), vector.family, `${vector.name}.endpoint`);
      }
    });
  }

  it("returns 404 for a missing catalog track", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tracks/node_unknown/generations" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "track_not_found");
  });
});

describe("Generations record order", () => {
  const record = (id: string, title: string, earliestYear: number | null): GenerationsRecord => ({
    id, earliestYear, handoffTypes: [], connectedTitles: [], alsoFromTitles: [],
    track: { title, artist: "", year: earliestYear, kind: "song", isrc: null, musicBrainzRecordingID: null,
      catalogRecordingID: id },
  });
  const order = (records: GenerationsRecord[]) => [...records].sort(chronological).map((r) => r.id);

  it("puts records of one year in title order, as Swift does", () => {
    // v17 dates most records, so equal years are common: Juicy's family had
    // "Let It Go (remix)" ahead of "Let It Go" before this was fixed.
    const remix = record("2|let it go remix", "Let It Go (remix)", 2007);
    const original = record("1|let it go", "Let It Go", 2007);
    assert.deepEqual(order([remix, original]), ["1|let it go", "2|let it go remix"]);
    assert.deepEqual(order([original, remix]), ["1|let it go", "2|let it go remix"]);
  });

  it("puts dated records first, oldest first, and undated ones by title", () => {
    const records = [record("a", "Zed", null), record("b", "Alpha", null), record("c", "Mid", 1990),
      record("d", "Early", 1971), record("e", "Also 1990", 1990)];
    assert.deepEqual(order(records), ["d", "e", "c", "b", "a"]);
  });

  it("breaks a title tie by comparing ids as Swift strings", () => {
    // A locale collation would put "15|x" first; Swift's String < compares scalars.
    assert.deepEqual(order([record("15|x", "Intro", null), record("155|x", "Intro", null)]), ["155|x", "15|x"]);
    assert.ok(scalarOrder("-7|x", "12|x") < 0);
  });
});
