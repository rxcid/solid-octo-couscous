import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { isRemix, songIdentity } from "./song-identity.js";

const fixturePath = join(import.meta.dirname, "__fixtures__", "song_identity_vectors.json");
const sincDir = process.env.SINC_DIR ?? resolve(import.meta.dirname, "../../../../Sincapp");
const sourcePath = join(sincDir, "tools", "data", "song_identity_vectors.json");
const vectors = JSON.parse(readFileSync(fixturePath, "utf8")) as { title: string; identity: string }[];

describe("SongIdentity", () => {
  it("matches Sinc's full shared vector set", () => {
    assert.ok(vectors.length >= 400);
    for (const { title, identity } of vectors) {
      assert.equal(songIdentity(title), identity, title);
      assert.equal(isRemix(title), identity.includes("|"), title);
    }
  });

  it("uses the same vectors as the Sinc checkout", { skip: !existsSync(sourcePath) && `no Sinc checkout at ${sincDir}` }, () => {
    assert.deepEqual(vectors, JSON.parse(readFileSync(sourcePath, "utf8")));
  });
});
