import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateC1HoldoutCoverage,
  evaluateN5ContextGates,
  holdoutTaskText,
  N5_CONTEXT_GATES
} from "./run-jin-n5-context-replay.mjs";

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
