import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const SINC_DIR = process.env.SINC_DIR ?? resolve(ROOT, "..", "Sincapp");
const SCRIPT = join(ROOT, "tools", "sync-swift-client.mjs");

describe("vendored Swift client", () => {
  it("does not use the OpenAPI build plugin", () => {
    const manifest = readFileSync(join(ROOT, "clients", "swift", "Package.swift"), "utf8");
    assert.doesNotMatch(manifest, /swift-openapi-generator|OpenAPIGenerator|plugins:/);
  });

  it("matches the Sinc checkout", { skip: !existsSync(SINC_DIR) && `no Sinc checkout at ${SINC_DIR}` }, () => {
    const output = execFileSync(process.execPath, [SCRIPT, "--check"], {
      env: { ...process.env, SINC_DIR },
      encoding: "utf8",
    });
    assert.match(output, /Vendored Swift client matches/);
    const project = readFileSync(join(SINC_DIR, "project.yml"), "utf8");
    assert.match(project, /path: Packages\/MusicSampleGraphClient/);
  });
});
