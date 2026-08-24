import assert from "node:assert/strict";
import test from "node:test";
import {
  adjudicateRuoyiObservation,
  F1_TOKEN_DROP_GATE,
  metricsFromBenchmark,
  qualityIdentity,
  tokenDrop,
  writeTuningScenarioJsonl
} from "./run-f1-ruoyi-observation.mjs";

test("F1 ruoyi observation drops holdout rows unread", () => {
  const jsonl = [
    JSON.stringify({ id: "tune-1", evaluationSplit: "tuning", golden: { mustHit: ["a.java"] } }),
    JSON.stringify({ id: "hold-secret", evaluationSplit: "holdout", golden: { mustHit: ["secret.java"] } }),
    JSON.stringify({ id: "tune-2", evaluationSplit: "tuning", golden: { mustHit: ["b.java"] } })
  ].join("\n");
  const filtered = writeTuningScenarioJsonl(jsonl);
  assert.equal(filtered.tuningCount, 2);
  assert.equal(filtered.holdoutSkipped, 1);
  assert.equal(filtered.jsonl.includes("hold-secret"), false);
  assert.equal(filtered.jsonl.includes("secret.java"), false);
});

test("quality identity is bit-identical and treats missing old RangeLineRecall as unmeasured", () => {
  const oldMetrics = { recall: 0.5, pRead: 0.4, rReadMust: 0.6, RangeLineRecall: null };
  const newMetrics = { recall: 0.5, pRead: 0.4, rReadMust: 0.6, RangeLineRecall: 0.9 };
  const identity = qualityIdentity(oldMetrics, newMetrics);
  assert.equal(identity.identical, true);
  assert.deepEqual(identity.unmeasured, ["RangeLineRecall"]);
  assert.equal(qualityIdentity({ ...oldMetrics, recall: 0.51 }, newMetrics).identical, false);
});

test("token drop gate is 20% relative", () => {
  assert.equal(F1_TOKEN_DROP_GATE, 0.2);
  assert.equal(tokenDrop(1000, 800).pass, true);
  assert.equal(tokenDrop(1000, 801).pass, false);
  assert.equal(tokenDrop(0, 0).pass, false);
});

test("adjudication prefers the identity sentinel over token", () => {
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: false, diffs: [{ metric: "recall", old: 1, new: 0.9 }] },
    token: { pass: true }
  }), "QUALITY_IDENTITY_FAIL");
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: true, diffs: [] },
    token: { pass: false }
  }), "TOKEN_FAIL");
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: true, diffs: [] },
    token: { pass: true }
  }), "GO");
});

test("metricsFromBenchmark reads totals and does not invent TaskSuccess", () => {
  const metrics = metricsFromBenchmark({
    totals: { recall: 0.7, pRead: 0.5, rReadMust: 0.8, RangeLineRecall: 0.9, estimatedTokensP50: 1200 },
    rows: [{ id: "a" }, { id: "b" }]
  });
  assert.equal(metrics.scenarios, 2);
  assert.equal(metrics.estimatedTokensP50, 1200);
  assert.equal(metrics.recall, 0.7);
});
