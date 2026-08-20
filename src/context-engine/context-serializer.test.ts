import assert from "node:assert/strict";
import test from "node:test";
import { closeSearchResult } from "./context-closure.js";
import { planEvidenceBundles } from "./context-planner.js";
import { serializeContext, sourceParity } from "./context-serializer.js";
import { ContextSessionStore, StaleSessionError, PLANNER_VERSION } from "./context-contract.js";
import type { GraphSearchResult } from "./graph-search.js";

function search(): GraphSearchResult {
  return {
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    coverage: "PARTIAL",
    bundles: [
      { path: "src/A.java", hops: 0, estimatedTokens: 40, provingPath: [], closedObligations: ["O1"] },
      {
        path: "src/B.java",
        hops: 1,
        estimatedTokens: 40,
        provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#A#run#1", toId: "src/B.java#B#save#1" }],
        closedObligations: ["O1", "O2"]
      }
    ],
    unresolved: [{ id: "O3", role: "entity" }],
    metrics: { expansions: 2, hops: 1, estimatedTokens: 80 }
  };
}

function facts() {
  return {
    methods: [{ name: "run", startLine: 4, endLine: 20, bodyStartLine: 4, callSites: [{ line: 8, name: "save" }] }]
  };
}

test("serializer emits one schema, omits scores, and keeps includeSource parity", () => {
  const closed = closeSearchResult({ search: search(), factsForPath: () => facts(), includeSource: true });
  const plan = planEvidenceBundles({ bundles: closed, tokenBudget: 400 });
  const withSource = serializeContext({
    plan,
    search: search(),
    includeSource: true,
    generation: 3,
    serviceMs: 12
  });
  const without = serializeContext({
    plan,
    search: search(),
    includeSource: false,
    generation: 3,
    serviceMs: 12
  });
  assert.equal(withSource.version, 1);
  assert.equal(withSource.resolvedIntent, "IMPLEMENTATION_CHANGE");
  assert.ok(Array.isArray(withSource.resolvedAnchors));
  assert.ok(Array.isArray(withSource.unresolved));
  assert.ok(Array.isArray(withSource.next));
  assert.equal(JSON.stringify(withSource).includes("confidence"), false);
  assert.equal(JSON.stringify(withSource).includes("score"), false);
  assert.equal(sourceParity(withSource, without), true);
  assert.equal(without.contexts.some(item => item.spans.some(span => span.text !== undefined)), false);
});

test("stale session is fail-closed", () => {
  const store = new ContextSessionStore();
  const closed = closeSearchResult({ search: search(), factsForPath: () => facts() });
  const plan = planEvidenceBundles({ bundles: closed, tokenBudget: 400 });
  const contract = serializeContext({ plan, search: search(), includeSource: false, generation: 1, serviceMs: 1 });
  contract.coverage = "COMPLETE";
  const key = { sessionId: "s1", generation: 1, repoHash: "abc", plannerVersion: PLANNER_VERSION };
  store.save(key, contract);
  assert.equal(store.consume(key).generation, 1);
  assert.throws(() => store.consume({ ...key, generation: 2 }), error => error instanceof StaleSessionError && error.code === "STALE_SESSION");
  assert.throws(() => store.consume({ ...key, sessionId: "missing" }), StaleSessionError);
});
