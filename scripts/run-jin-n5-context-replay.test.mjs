import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMissingPath,
  evaluateC1HoldoutCoverage,
  evaluateC2FirstCallBytes,
  evaluateN5ContextGates,
  holdoutTaskText,
  impactProfileOf,
  MISS_DISCOVERY_GAP,
  MISS_IN_POOL_NOT_PACKED,
  N5_CONTEXT_GATES,
  searchPoolPaths
} from "./run-jin-n5-context-replay.mjs";

test("impactProfileOf falls back to auto for unknown golden profiles", () => {
  assert.equal(impactProfileOf("controller"), "controller");
  assert.equal(impactProfileOf("ddd-controller"), "auto");
  assert.equal(impactProfileOf(undefined), "auto");
});

test("holdout task text uses the scene name and keywords, never the scene id", () => {
  const text = holdoutTaskText({
    id: "paper-task-claim-iam-holdout",
    name: "PaperTaskCommandAppService#claimTask IAM identity",
    anchor: { taskKeywords: ["paper", "task", "claim"] }
  });
  assert.match(text, /PaperTaskCommandAppService/);
  assert.match(text, /claim/);
  assert.equal(text.includes("paper-task-claim-iam-holdout"), false);
});

test("N5 context gates pass when auto or persistence selected sets contain the target", () => {
  const mapper = N5_CONTEXT_GATES[1].target;
  const account = N5_CONTEXT_GATES[2].target;
  const me = N5_CONTEXT_GATES[0].target;
  const gates = evaluateN5ContextGates([
    {
      project: "lishuedu",
      scenarioId: "paper-task-claim-iam-holdout",
      intent: "auto",
      selected: [me]
    },
    {
      project: "cipherlink",
      scenarioId: "client-release-storage-presign-holdout",
      intent: "auto",
      selected: []
    },
    {
      project: "cipherlink",
      scenarioId: "client-release-storage-presign-holdout",
      intent: "PERSISTENCE_FLOW",
      selected: [mapper]
    },
    {
      project: "exam-parent-v3",
      scenarioId: "candidate-pay-order-cross-module-admission",
      intent: "PERSISTENCE_FLOW",
      selected: [account]
    }
  ]);
  assert.equal(gates.every(item => item.hit), true);
});

test("N5 context gates fail when the persistence proving file is only discovered, not selected", () => {
  const mapper = N5_CONTEXT_GATES[1].target;
  const gates = evaluateN5ContextGates([
    {
      project: "lishuedu",
      scenarioId: "paper-task-claim-iam-holdout",
      intent: "auto",
      selected: [N5_CONTEXT_GATES[0].target]
    },
    {
      project: "cipherlink",
      scenarioId: "client-release-storage-presign-holdout",
      intent: "auto",
      selected: []
    },
    {
      project: "cipherlink",
      scenarioId: "client-release-storage-presign-holdout",
      intent: "PERSISTENCE_FLOW",
      discovered: [mapper],
      selected: []
    },
    {
      project: "exam-parent-v3",
      scenarioId: "candidate-pay-order-cross-module-admission",
      intent: "PERSISTENCE_FLOW",
      selected: [N5_CONTEXT_GATES[2].target]
    }
  ]);
  assert.equal(gates.find(item => item.scenarioId.includes("presign"))?.hit, false);
});

test("C1 coverage counts required files in candidates union evidence", () => {
  const rows = [
    { project: "lishuedu", scenarioId: "a", intent: "auto", requiredFiles: ["src/A.java", "src/B.java"], evidence: ["src/A.java"], candidates: ["src/B.java"] },
    { project: "lishuedu", scenarioId: "b", intent: "auto", requiredFiles: ["src/A.java"], evidence: ["src/A.java"], candidates: [] },
    { project: "cipherlink", scenarioId: "c", intent: "auto", requiredFiles: ["src/A.java", "src/C.java", "src/D.java", "src/E.java"], evidence: ["src/A.java"], candidates: ["src/A.java"] },
    { project: "cipherlink", scenarioId: "d", intent: "auto", requiredFiles: ["src/A.java"], evidence: ["src/A.java"], candidates: [] },
    { project: "exam-parent-v3", scenarioId: "e", intent: "auto", requiredFiles: ["src/A.java"], evidence: ["src/A.java"], candidates: [] },
    { project: "exam-parent-v3", scenarioId: "f", intent: "auto", requiredFiles: ["src/A.java"], evidence: ["src/A.java"], candidates: [] }
  ];
  const coverage = evaluateC1HoldoutCoverage(rows);
  assert.equal(coverage.n, 6);
  assert.equal(coverage.rows[0].rate, 1);
  assert.equal(coverage.rows[2].rate, 0.25);
  assert.equal(coverage.passed, false);
  rows[2].candidates = ["src/C.java", "src/D.java", "src/E.java"];
  assert.equal(evaluateC1HoldoutCoverage(rows).passed, true);
});

test("searchPoolPaths ranks unique paths by hop then path", () => {
  const pool = searchPoolPaths([
    { path: "src/B.java", hops: 1 },
    { path: "src/A.java", hops: 2 },
    { path: "src/B.java", hops: 0 },
    { path: "src/C.java", hops: 1 }
  ]);
  assert.deepEqual(pool, ["src/B.java", "src/C.java", "src/A.java"]);
});

test("classifyMissingPath labels in-pool misses separately from discovery gaps", () => {
  const pool = ["src/A.java", "src/B.java", "src/C.java"];
  const inPool = classifyMissingPath("src/C.java", {
    poolPaths: pool,
    wireCandidates: ["src/A.java", "src/B.java"],
    evidence: ["src/A.java"]
  });
  assert.equal(inPool.label, MISS_IN_POOL_NOT_PACKED);
  assert.equal(inPool.poolRank, 3);
  const gap = classifyMissingPath("src/Z.java", {
    poolPaths: pool,
    wireCandidates: pool,
    evidence: []
  });
  assert.equal(gap.label, MISS_DISCOVERY_GAP);
  assert.equal(gap.poolRank, null);
});

test("C1 coverage is not floor-eligible while an in-pool miss remains", () => {
  const rows = [
    {
      project: "lishuedu",
      scenarioId: "a",
      intent: "auto",
      requiredFiles: ["src/A.java", "src/InPool.java", "src/Gap.java"],
      evidence: ["src/A.java"],
      candidates: ["src/A.java"],
      poolPaths: ["src/A.java", "src/InPool.java"]
    },
    {
      project: "lishuedu",
      scenarioId: "b",
      intent: "auto",
      requiredFiles: ["src/A.java"],
      evidence: ["src/A.java"],
      candidates: [],
      poolPaths: ["src/A.java"]
    },
    {
      project: "cipherlink",
      scenarioId: "c",
      intent: "auto",
      requiredFiles: ["src/A.java"],
      evidence: ["src/A.java"],
      candidates: [],
      poolPaths: ["src/A.java"]
    },
    {
      project: "cipherlink",
      scenarioId: "d",
      intent: "auto",
      requiredFiles: ["src/A.java"],
      evidence: ["src/A.java"],
      candidates: [],
      poolPaths: ["src/A.java"]
    },
    {
      project: "exam-parent-v3",
      scenarioId: "e",
      intent: "auto",
      requiredFiles: ["src/A.java"],
      evidence: ["src/A.java"],
      candidates: [],
      poolPaths: ["src/A.java"]
    },
    {
      project: "exam-parent-v3",
      scenarioId: "f",
      intent: "auto",
      requiredFiles: ["src/A.java"],
      evidence: ["src/A.java"],
      candidates: [],
      poolPaths: ["src/A.java"]
    }
  ];
  const coverage = evaluateC1HoldoutCoverage(rows);
  assert.equal(coverage.passed, false);
  assert.equal(coverage.inPoolNotPacked, 1);
  assert.equal(coverage.floorEligible, false);
  assert.equal(coverage.rows[0].missLabels[0].label, MISS_IN_POOL_NOT_PACKED);
});

test("C2 first-call byte P50 uses six auto holdouts and the 1.2 gate", () => {
  const rows = [
    { intent: "auto", project: "a", scenarioId: "1", contextBytes: 1000, impactBytes: 1000 },
    { intent: "auto", project: "a", scenarioId: "2", contextBytes: 1100, impactBytes: 1000 },
    { intent: "auto", project: "b", scenarioId: "3", contextBytes: 1050, impactBytes: 1000 },
    { intent: "auto", project: "b", scenarioId: "4", contextBytes: 1200, impactBytes: 1000 },
    { intent: "auto", project: "c", scenarioId: "5", contextBytes: 900, impactBytes: 1000 },
    { intent: "auto", project: "c", scenarioId: "6", contextBytes: 1010, impactBytes: 1000 },
    { intent: "PERSISTENCE_FLOW", project: "a", scenarioId: "1", contextBytes: 9000, impactBytes: 1000 }
  ];
  const bytes = evaluateC2FirstCallBytes(rows);
  assert.equal(bytes.n, 6);
  assert.equal(bytes.passed, true);
  assert.ok(bytes.p50 <= 1.2);
  for (const row of rows.slice(0, 4)) row.contextBytes = 1300;
  assert.equal(evaluateC2FirstCallBytes(rows).p50 > 1.2, true);
  assert.equal(evaluateC2FirstCallBytes(rows).passed, false);
});
