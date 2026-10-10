// eval-pilot-compare: the R02 denominator rule, token medians and the pilot
// row filter used by the native-vs-A2 primary control.
import assert from "node:assert/strict";
import test from "node:test";
import { medianPromptTokens, pilotReport, summarizeArm } from "./eval-pilot-compare.mjs";

test("summarizeArm: success rate is over every scheduled attempt", () => {
  const runs = [
    { arm: "product", kind: "qa", taskSuccess: true },
    { arm: "product", kind: "qa", taskSuccess: false },
    { arm: "product", kind: "repair", taskSuccess: null },
    { arm: "product", kind: "repair", taskSuccess: null },
    { arm: "control", kind: "qa", taskSuccess: true }
  ];
  const product = summarizeArm(runs, "product");
  assert.equal(product.scheduled, 4);
  assert.equal(product.successRate, 1 / 4, "blocked/unmeasured attempts stay in the denominator");
  assert.equal(product.conditionalAccuracy, 1 / 2);
  assert.equal(product.unmeasured, 2);
  assert.equal(product.repair.successRate, 0);
  assert.equal(product.repair.conditionalAccuracy, null);
  assert.equal(summarizeArm([], "product").successRate, null);
});

test("medianPromptTokens: exact median; missing usage is not a median", () => {
  assert.equal(medianPromptTokens([{ usage: { promptTokens: 10 } }, { usage: { inputTokens: 30 } }, { usage: { promptTokens: 20 } }, { usage: { promptTokens: 40 } }]), 25);
  assert.equal(medianPromptTokens([{ usage: { promptTokens: 10 } }, { usage: null }]), null);
});

test("pilotReport keeps only pilot rows and drops the whole-split summary", () => {
  const report = { schema: "r", summary: { overall: {} }, rows: [{ task_id: "a" }, { task_id: "b" }, { task_id: "a", repeat: 1 }] };
  assert.deepEqual(pilotReport(report, ["a"]), { schema: "r", rows: [{ task_id: "a" }, { task_id: "a", repeat: 1 }] });
});
