import assert from "node:assert/strict";
import test from "node:test";
import { emptyMethodSummary } from "./method-summary.js";

test("N1 method summary skeleton is empty of call and flow facts", () => {
  const summary = emptyMethodSummary("src/A.java#A#m#abc");
  assert.equal(summary.directCalls.length, 0);
  assert.equal(summary.virtualCalls.length, 0);
  assert.equal(summary.lexicalFingerprint.length, 0);
  assert.equal(summary.methodId, "src/A.java#A#m#abc");
});
