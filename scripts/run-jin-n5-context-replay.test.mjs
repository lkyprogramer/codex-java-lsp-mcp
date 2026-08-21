import assert from "node:assert/strict";
import test from "node:test";
import {
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
