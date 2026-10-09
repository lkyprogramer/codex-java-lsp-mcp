// input:  ab-summary.mjs。
// output: 实验汇总的分母规则与凭据剔除回归锁。
import assert from "node:assert/strict";
import test from "node:test";
import { redactBackend, summarizeArm } from "./ab-summary.mjs";

test("summarizeArm: success rate is over every scheduled attempt", () => {
  const runs = [
    { arm: "a2", kind: "qa", taskSuccess: true },
    { arm: "a2", kind: "qa", taskSuccess: false },
    { arm: "a2", kind: "repair", taskSuccess: null },
    { arm: "a2", kind: "repair", taskSuccess: null },
    { arm: "a3", kind: "qa", taskSuccess: true }
  ];
  const a2 = summarizeArm(runs, "a2");
  assert.equal(a2.scheduled, 4);
  assert.equal(a2.successRate, 1 / 4, "blocked/unmeasured attempts stay in the denominator");
  assert.equal(a2.conditionalAccuracy, 1 / 2);
  assert.equal(a2.unmeasured, 2);
  assert.equal(a2.repair.successRate, 0);
  assert.equal(a2.repair.conditionalAccuracy, null);
  assert.equal(summarizeArm([], "a2").successRate, null);
});

test("redactBackend: no API key ever reaches the pack", () => {
  const out = redactBackend({ baseUrl: "https://gw.example:8443/v1", apiKey: "sk-secret", model: "m" });
  assert.deepEqual(out, { baseUrlHost: "gw.example:8443", model: "m", reasoningEffort: null });
  assert.ok(!JSON.stringify(out).includes("sk-secret"));
});
