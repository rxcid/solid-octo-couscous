#!/usr/bin/env node
// Regenerate the checked-in Swift client, then mirror its package into Sinc.
// `--check` compares both copies without requiring the generator binary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "clients", "swift");
const target = join(process.env.SINC_DIR ?? resolve(root, "..", "Sincapp"), "Packages", "MusicSampleGraphClient");
const generated = join(source, "Sources", "MusicSampleGraphClient", "Generated");
const sourceSpec = join(source, "Sources", "MusicSampleGraphClient");
const expectedGenerated = [
  "Client.swift", "Types.swift", "Types+Components.swift", "Types+Operations.swift",
  "Types+Components+Schemas.swift", "Types+Components+Parameters.swift",
  "Types+Components+RequestBodies.swift", "Types+Components+Responses.swift",
  "Types+Components+Headers.swift",
];

function files(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  // Finder (.DS_Store) and editors leave hidden files beside the package;
  // no package file is hidden, so they are never part of the comparison.
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).flatMap((entry) => {
    const name = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(dir, entry.name), name) : [name];
  }).sort();
}

function same(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

function assertMirror() {
  const expected = ["Package.swift", ...files(join(source, "Sources"), "Sources"), ...files(join(source, "Tests"), "Tests")].sort();
  const actual = ["Package.swift", ...files(join(target, "Sources"), "Sources"), ...files(join(target, "Tests"), "Tests")].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Vendored Swift client file list differs. Expected ${expected.length} files, found ${actual.length}. Run npm run swift:client:sync.`);
  }
  for (const name of expected) {
    if (!same(join(source, name), join(target, name))) {
      throw new Error(`Vendored Swift client differs at ${name}. Run npm run swift:client:sync.`);
    }
  }
  console.log(`Vendored Swift client matches ${expected.length} package files.`);
}

function assertSafeToSync() {
  if (!existsSync(target)) return;
  const currentFiles = ["Package.swift", ...files(join(source, "Sources"), "Sources"), ...files(join(source, "Tests"), "Tests")];
  const vendoredFiles = ["Package.swift", ...files(join(target, "Sources"), "Sources"), ...files(join(target, "Tests"), "Tests")];
  for (const name of vendoredFiles) {
    const vendored = join(target, name);
    if (same(join(source, name), vendored)) continue;
    let previous;
    try {
      previous = execFileSync("git", ["show", `HEAD:clients/swift/${name}`], { cwd: root, stdio: "pipe" });
    } catch {
      throw new Error(`Vendored ${name} differs from the source, and no committed baseline exists. Inspect it before syncing or pass --force.`);
    }
    if (!readFileSync(vendored).equals(previous)) {
      throw new Error(`Vendored ${name} has independent changes. Inspect them before syncing or pass --force.`);
    }
  }
  const unexpected = vendoredFiles.filter((name) => !currentFiles.includes(name));
  if (unexpected.length) {
    throw new Error(`Unexpected files in vendored package: ${unexpected.join(", ")}. Remove them explicitly before syncing.`);
  }
}

function generatorPath() {
  const configured = process.env.SWIFT_OPENAPI_GENERATOR;
  if (configured) return configured;
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  const candidates = [
    join(source, ".build", `${architecture}-apple-macosx`, "debug", "swift-openapi-generator-tool"),
    join(source, ".build", "debug", "swift-openapi-generator-tool"),
  ];
  for (const cached of candidates) if (existsSync(cached)) return cached;
  throw new Error("Set SWIFT_OPENAPI_GENERATOR to a locally installed swift-openapi-generator-tool 1.13.1. The sync script never downloads tools.");
}

function generate() {
  const temporary = mkdtempSync(join(tmpdir(), "music-sample-graph-swift-"));
  try {
    execFileSync(generatorPath(), [
      "generate", join(sourceSpec, "openapi.json"),
      "--config", join(sourceSpec, "openapi-generator-config.yaml"),
      "--output-directory", temporary,
    ], { stdio: "pipe" });
    const actual = files(temporary);
    if (JSON.stringify(actual) !== JSON.stringify(expectedGenerated.slice().sort())) {
      throw new Error(`Generator produced unexpected files: ${actual.join(", ")}`);
    }
    return { temporary, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function assertGenerated(temporary) {
  for (const name of expectedGenerated) {
    if (!same(join(temporary, name), join(generated, name))) {
      throw new Error(`Checked-in Swift source differs from the OpenAPI generator at ${name}. Run npm run swift:client:sync.`);
    }
  }
  console.log(`Checked-in Swift source matches ${expectedGenerated.length} generated files.`);
}

function copyTree(from, to) {
  for (const name of files(from)) {
    const output = join(to, name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(from, name), output);
  }
}

const mode = process.argv[2];
if (mode && !["--check", "--check-generated", "--force"].includes(mode)) {
  throw new Error(`Unknown option ${mode}`);
}
if (mode === "--check") {
  assertMirror();
} else {
  // A normal sync accepts an old committed copy, but protects independent vendor edits.
  if (!mode) assertSafeToSync();
  const result = generate();
  try {
    if (mode === "--check-generated") {
      assertGenerated(result.temporary);
      assertMirror();
    } else {
      const existingGenerated = files(generated);
      const unexpectedGenerated = existingGenerated.filter((name) => !expectedGenerated.includes(name));
      if (unexpectedGenerated.length) {
        throw new Error(`Unexpected files in Generated: ${unexpectedGenerated.join(", ")}. Remove them explicitly before syncing.`);
      }
      mkdirSync(generated, { recursive: true });
      copyTree(result.temporary, generated);
      const expectedVendor = ["Package.swift", ...files(join(source, "Sources"), "Sources"), ...files(join(source, "Tests"), "Tests")];
      const existingVendor = ["Package.swift", ...files(join(target, "Sources"), "Sources"), ...files(join(target, "Tests"), "Tests")];
      const unexpectedVendor = existingVendor.filter((name) => !expectedVendor.includes(name));
      if (unexpectedVendor.length) {
        throw new Error(`Unexpected files in vendored package: ${unexpectedVendor.join(", ")}. Remove them explicitly before syncing.`);
      }
      mkdirSync(target, { recursive: true });
      copyFileSync(join(source, "Package.swift"), join(target, "Package.swift"));
      copyTree(join(source, "Sources"), join(target, "Sources"));
      copyTree(join(source, "Tests"), join(target, "Tests"));
      assertMirror();
    }
  } finally {
    result.cleanup();
  }
}
