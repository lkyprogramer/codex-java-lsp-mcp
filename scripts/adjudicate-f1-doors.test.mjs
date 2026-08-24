import assert from "node:assert/strict";
import test from "node:test";
import {
  adjudicateF1Project,
  adjudicateMemory,
  adjudicateTools,
  f1NonWorse,
  f1P95Pass,
  f1TokenDrop
} from "./adjudicate-f1-doors.mjs";

test("F1 quality door allows -0.005 and no more", () => {
  assert.equal(f1NonWorse(0.8, 0.795), true);
  assert.equal(f1NonWorse(0.8, 0.794), false);
  assert.equal(f1NonWorse(null, 1), null);
});

test("F1 token door is 20% relative P50 drop", () => {
  assert.equal(f1TokenDrop(1000, 800).pass, true);
  assert.equal(f1TokenDrop(1000, 801).pass, false);
});

test("F1 p95 door is 1.10", () => {
  assert.equal(f1P95Pass(1.1), true);
  assert.equal(f1P95Pass(1.11), false);
});

test("project adjudication uses F1 doors not verifier minReadMust", () => {
  const row = adjudicateF1Project({
    project: "lishuedu",
    old: {
      recall: 0.8,
      pRead: 0.7,
      rReadMust: 0.9,
      estimatedTokensP50: 4000,
      p95: 100,
      splits: { holdout: { recall: 0.8, pRead: 0.7, rReadMust: 0.9 } },
      rangeEvidence: { line: { mean: 1 } }
    },
    new: {
      recall: 0.8,
      pRead: 0.7,
      rReadMust: 0.9,
      estimatedTokensP50: 2800,
      p95: 105,
      splits: { holdout: { recall: 0.8, pRead: 0.7, rReadMust: 0.9 } },
      rangeEvidence: { line: { mean: 1 } }
    },
    delta: { p95Ratio: 1.05 }
  });
  assert.equal(row.pass, true);
  assert.equal(row.token.drop > 0.2, true);
});

test("memory door keeps G1 anchor +10% and S1/S2 caps", () => {
  const pass = adjudicateMemory({
    g1: { lishuedu: 173, cipherlink: 29, "exam-parent-v3": 46 },
    s1: 900,
    s2: 1200
  });
  assert.equal(pass.pass, true);
  assert.equal(adjudicateMemory({
    g1: { lishuedu: 191, cipherlink: 29, "exam-parent-v3": 46 },
    s1: 900,
    s2: 1200
  }).pass, false);
});

test("tool door is exactly five public tools without java_context", () => {
  const names = ["java_status", "java_impact", "java_symbol", "java_diagnostics", "java_runtime"];
  assert.equal(adjudicateTools({ names, tokens: 500, mainTokens: 600 }).pass, true);
  assert.equal(adjudicateTools({
    names: [...names, "java_context"],
    tokens: 500,
    mainTokens: 600
  }).pass, false);
});
