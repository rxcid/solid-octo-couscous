import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("ignores Finder files but not a stray package file", () => {
    // A copy of this package stands in for Sinc, so the real checkout is never touched.
    const sinc = mkdtempSync(join(tmpdir(), "sinc-vendor-"));
    try {
      const vendored = join(sinc, "Packages", "MusicSampleGraphClient");
      const source = join(ROOT, "clients", "swift");
      mkdirSync(vendored, { recursive: true });
      copyFileSync(join(source, "Package.swift"), join(vendored, "Package.swift"));
      cpSync(join(source, "Sources"), join(vendored, "Sources"), { recursive: true });
      cpSync(join(source, "Tests"), join(vendored, "Tests"), { recursive: true });
      const check = () => execFileSync(process.execPath, [SCRIPT, "--check"],
        { env: { ...process.env, SINC_DIR: sinc }, encoding: "utf8", stdio: "pipe" });

      writeFileSync(join(vendored, "Sources", ".DS_Store"), "");
      writeFileSync(join(vendored, "Tests", ".DS_Store"), "");
      assert.match(check(), /Vendored Swift client matches/);

      writeFileSync(join(vendored, "Sources", "Stray.swift"), "");
      assert.throws(check, /file list differs/);
    } finally {
      rmSync(sinc, { recursive: true, force: true });
    }
  });
});
