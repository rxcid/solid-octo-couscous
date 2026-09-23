import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { canonicalId, normalize, textIdentity, versionKey } from "./identity.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "normalization_vectors.json");
const SINC_DIR = process.env.SINC_DIR ?? resolve(import.meta.dirname, "../../../../Sincapp");
const SINC_VECTORS = join(SINC_DIR, "tools", "data", "normalization_vectors.json");

type Vector = { input: string; normalized: string };
const vectors = JSON.parse(readFileSync(FIXTURE, "utf8")) as Vector[];

describe("normalize", () => {
  it("matches every shared parity vector", () => {
    assert.ok(vectors.length >= 10);
    for (const { input, normalized } of vectors) {
      assert.equal(normalize(input), normalized, `normalize(${JSON.stringify(input)})`);
    }
  });

  it("uses the same vectors as the Sinc checkout", { skip: !existsSync(SINC_VECTORS) && `no Sinc checkout at ${SINC_DIR}` }, () => {
    // A vector added on the Sinc side must be copied here too.
    assert.deepEqual(vectors, JSON.parse(readFileSync(SINC_VECTORS, "utf8")));
  });
});

describe("identity", () => {
  // Values below were written by Sinc's Python pipeline.
  it("reproduces text node ids from Sinc's catalog", () => {
    assert.equal(
      textIdentity("song", "Amen, Brother", "The Winstons").canonicalId,
      "node_3577dce5b98f6d4f398357f9f7a7658188daf2b213cf526a118f82af1bfe81ba",
    );
    assert.deepEqual(textIdentity("song", "Survivalism", "Nine Inch Nails"), {
      identityKey: "text:song:survivalism:nine inch nails",
      canonicalId: "node_c1d9717d099ecf1ab56d90a1648f075d36088737d9fb7dbfb6a0f6e346566e62",
    });
  });

  it("reproduces a versioned derivative's identity", () => {
    const title = "Survivalism (deadmau5 remix)";
    assert.equal(versionKey(title), "survivalism deadmau5 remix");
    assert.deepEqual(textIdentity("song", title, "Nine Inch Nails", versionKey(title)), {
      identityKey: "text:song:survivalism:nine inch nails:version:survivalism deadmau5 remix",
      canonicalId: "node_60b81ab7c3f2a23800f5b7f4d375d332b04927704ef0e3a0786d3d95eeaf3143",
    });
  });

  it("reproduces edge ids from Sinc's catalog", () => {
    assert.equal(
      canonicalId(
        "edge",
        "node_3577dce5b98f6d4f398357f9f7a7658188daf2b213cf526a118f82af1bfe81ba",
        "node_dc284f8a8902540171078f279645b1066eb38e4d26432e5ea8837548826e256a",
        "sampled",
      ),
      "edge_750631f34021a397172d61f875aabf30b8064563500cbdf041d22587195810d5",
    );
  });
});
