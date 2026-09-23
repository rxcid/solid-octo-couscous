/**
 * Writes the OpenAPI document into the Swift client package, which generates
 * its types and client from it at build time. Run after changing the API:
 *
 *   npm run openapi
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { SWIFT_CLIENT_SPEC, openApiDocument } from "../api/document.js";

mkdirSync(dirname(SWIFT_CLIENT_SPEC), { recursive: true });
writeFileSync(SWIFT_CLIENT_SPEC, await openApiDocument());
console.log(`Wrote ${relative(process.cwd(), SWIFT_CLIENT_SPEC)}`);
