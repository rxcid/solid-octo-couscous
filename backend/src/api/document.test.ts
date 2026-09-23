import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { SWIFT_CLIENT_SPEC, openApiDocument } from "./document.js";

it("the Swift client is generated from the current API", async () => {
  assert.equal(
    readFileSync(SWIFT_CLIENT_SPEC, "utf8"),
    await openApiDocument(),
    "clients/swift/.../openapi.json is stale. Run `npm run openapi` and rebuild the Swift client.",
  );
});
