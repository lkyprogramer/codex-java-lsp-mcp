import assert from "node:assert/strict";
import test from "node:test";
import { jsonBytesForImpactTokens } from "./identity-token-json.js";

test("token accounting does not move when compact elapsedMs crosses a digit boundary", () => {
  const base = {
    version: 1,
    target: { file: "A.java", symbol: "a" },
    contexts: [],
    unresolved: [],
    cost: { estimatedTokens: 1, readBytes: 4, resultBytes: 4, suppressedRawBytes: 0 },
    metrics: { routingVersion: 6, elapsedMs: 222 }
  };
  const fourDigits = {
    ...base,
    metrics: { ...base.metrics, elapsedMs: 1000 }
  };
  assert.notEqual(
    Buffer.byteLength(JSON.stringify(base), "utf8"),
    Buffer.byteLength(JSON.stringify(fourDigits), "utf8"),
    "public compact JSON still encodes the real elapsedMs width"
  );
  assert.equal(jsonBytesForImpactTokens(base), jsonBytesForImpactTokens(fourDigits));
});
