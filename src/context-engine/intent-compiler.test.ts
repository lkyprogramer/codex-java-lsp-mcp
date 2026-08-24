import assert from "node:assert/strict";
import test from "node:test";
import { compileIntent, allIntents } from "./intent-compiler.js";
import { obligationsFor } from "./obligations.js";
import { INTENTS } from "./intent-types.js";

test("nine frozen intents each expand at least one generic obligation", () => {
  assert.deepEqual(allIntents(), [...INTENTS]);
  for (const intent of INTENTS) {
    const obligations = obligationsFor(intent);
    assert.ok(obligations.length >= 1, intent);
    assert.equal(compileIntent(intent).resolvedIntent, intent);
  }
});

test("auto fallback infers persistence and upstream without scene ids", () => {
  assert.equal(compileIntent("auto", { taskText: "mapper xml entity" }).resolvedIntent, "PERSISTENCE_FLOW");
  assert.equal(compileIntent("auto", { taskText: "who calls this service", profile: "service" }).resolvedIntent, "UPSTREAM_IMPACT");
  assert.equal(compileIntent("IMPLEMENTATION_CHANGE", { taskText: "mapper xml" }).resolvedIntent, "IMPLEMENTATION_CHANGE");
});
