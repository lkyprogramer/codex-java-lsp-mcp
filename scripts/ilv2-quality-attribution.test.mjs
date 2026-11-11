import test from "node:test";
import assert from "node:assert/strict";
import { buildLedger, classifyFailure } from "./ilv2-quality-attribution.mjs";

const stage = overrides => ({ discovered: true, declarationCorrect: true, relationAvailable: true, selected: true,
  rangeCovered: true, serialized: true, deliveryConfirmed: true, taskPassed: true, ...overrides });

test("the earliest provable break wins; a null frontier is UNMEASURED, never a guessed cause", () => {
  assert.equal(classifyFailure(stage({ rangeCovered: false, serialized: null, deliveryConfirmed: null, taskPassed: null })), "RANGE_MISS");
  assert.equal(classifyFailure({ discovered: null, declarationCorrect: null, relationAvailable: null, selected: null,
    rangeCovered: null, serialized: null, deliveryConfirmed: null, taskPassed: null }), "UNMEASURED");
  // A later false behind an unmeasured stage is not attributed.
  assert.equal(classifyFailure(stage({ selected: null, taskPassed: false })), "UNMEASURED");
  assert.equal(classifyFailure(stage({ discovered: false, declarationCorrect: false })), "NOT_DISCOVERED");
  assert.equal(classifyFailure(stage({ taskPassed: false })), "TASK_REASONING_OR_EDIT_FAILURE");
  assert.equal(classifyFailure(stage({})), "PASSED");
  assert.throws(() => classifyFailure(stage({ serialized: "yes" })), /must be true, false or null/);
  // Values after the first break are still validated.
  assert.throws(() => classifyFailure(stage({ discovered: false, taskPassed: "no" })), /taskPassed must be/);
});

test("the ledger keeps a planner that issued no query apart from a search miss and refuses holdout rows", () => {
  const ledger = buildLedger([
    { taskId: "t1", taskGroup: "g1", split: "dev", stage: stage({ discovered: false }), plannerQueries: 0 },
    { taskId: "t2", taskGroup: "g2", split: "dev", stage: stage({ discovered: false }), plannerQueries: 3 }
  ]);
  assert.deepEqual(ledger.byLabel, { NOT_PLANNED: ["t1"], NOT_DISCOVERED: ["t2"] });
  assert.throws(() => buildLedger([{ taskId: "h1", taskGroup: "g1", split: "holdout", stage: stage({}) }]), /only dev or exposed regression/);
});

test("a card triggers on two distinct task groups or one recorded critical defect, else NOT_TRIGGERED", () => {
  const ledger = buildLedger([
    { taskId: "a", taskGroup: "g1", split: "dev", stage: stage({ rangeCovered: false }) },
    { taskId: "b", taskGroup: "g1", split: "dev", stage: stage({ selected: false }) },
    { taskId: "c", taskGroup: "g2", split: "regression", stage: stage({ relationAvailable: false }), criticalDefect: "callers lost for overloaded target" },
    { taskId: "d", taskGroup: "g3", split: "dev", stage: stage({ discovered: false }) }
  ]);
  // Two rows of one group are one group: Q07 is not triggered by them.
  assert.equal(ledger.cards.Q07.status, "NOT_TRIGGERED");
  assert.deepEqual(ledger.cards.Q07.taskGroups, ["g1"]);
  assert.equal(ledger.cards.Q05.status, "TRIGGERED");
  assert.equal(ledger.cards.Q06.status, "NOT_TRIGGERED");
  assert.equal(ledger.cards.Q08.status, "NOT_TRIGGERED");
});
