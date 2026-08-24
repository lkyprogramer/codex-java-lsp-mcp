import assert from "node:assert/strict";
import test from "node:test";
import { withConvergedCostV6 } from "../output-v6.js";
import { projectImpactResultV6 } from "../format.js";
import type { ImpactResultV6 } from "../../agent-types.js";
import {
  accumulateCostSteps,
  lambdaCalibration,
  reconstructEstimatedTokens,
  refuseSyntheticScalar,
  retrievalCostFromV6
} from "./cost-model.js";
import { compareCostVectors, tailCvar } from "./cost-scorecard.js";
import { repairReadBytes } from "./repair-policy.js";
import { defaultPolicyCoverage, oraclePolicyCoverage } from "./retrieval-policy.js";
import { requiredGroupsFromScenario } from "../../benchmark/golden-required-groups.js";
import type { Scenario } from "../../benchmark/golden-scenario.js";

function samplePayload(): ImpactResultV6 {
  return {
    version: 6,
    target: {
      file: "src/main/java/demo/DemoService.java",
      symbol: "DemoService#process",
      profile: "service",
      range: { start: { line: 10, column: 3 }, end: { line: 10, column: 3 } }
    },
    freshness: {
      requestGeneration: 1,
      indexedGeneration: 1,
      coverage: "COMPLETE",
      changedDuringRequest: false
    },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [],
    readPlan: [{
      priority: "P0",
      fileId: "F1",
      ranges: [{ startLine: 1, endLine: 10, estimatedBytes: 400 }],
      reason: "anchor",
      expectedEvidence: ["target"],
      estimatedBytes: 400
    }],
    evidenceGaps: [],
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 },
    metrics: { routingVersion: 6, elapsedMs: 12 }
  };
}

test("shipped withConvergedCostV6 estimatedTokens rebuilds from the cost vector bytes", () => {
  const result = withConvergedCostV6(samplePayload(), 400, 0);
  const vector = retrievalCostFromV6(result.cost, { toolCalls: 1, serviceMs: 12 });
  assert.equal(vector.wireBytes, result.cost.resultBytes);
  assert.equal(vector.plannedSourceBytes, result.cost.readBytes);
  assert.equal(reconstructEstimatedTokens(vector.wireBytes, vector.plannedSourceBytes), result.cost.estimatedTokens);
  assert.equal(vector.tokenEstimator, "BYTE_DIV_4");
  assert.equal("taskSuccess" in vector, false, "TaskSuccess stays absent rather than a fake 0");
});

test("cost vector proxies do not double-count into estimatedTokens", () => {
  const result = withConvergedCostV6(samplePayload(), 1, 0);
  const vector = retrievalCostFromV6(result.cost);
  assert.equal(result.cost.estimatedTokens, reconstructEstimatedTokens(vector.wireBytes, vector.plannedSourceBytes));
  const doubled = (vector.wireTokensProxy ?? 0) + (vector.plannedSourceTokensProxy ?? 0);
  assert.ok(doubled >= result.cost.estimatedTokens);
});

test("standard and diagnostic projections rebuild the same estimatedTokens from the shipped cost vector", () => {
  const canonical = withConvergedCostV6(samplePayload(), 400, 0);
  canonical.metrics = { routingVersion: 6, elapsedMs: 12 };
  const diagnostic = projectImpactResultV6(canonical, "diagnostic");
  const standard = projectImpactResultV6(canonical, "standard");
  for (const payload of [standard, diagnostic]) {
    const vector = retrievalCostFromV6(payload.cost, { toolCalls: 1, serviceMs: payload.metrics?.elapsedMs ?? 0 });
    assert.equal(reconstructEstimatedTokens(vector.wireBytes, vector.plannedSourceBytes), payload.cost.estimatedTokens);
    assert.equal(vector.plannedSourceBytes, payload.cost.readBytes);
    assert.equal("expectedGain" in payload.cost, false);
  }
  assert.equal(standard.metrics?.retrievalCost, undefined);
});

test("first and second call steps accumulate bytes and calls without summing token proxies", () => {
  const first = retrievalCostFromV6(withConvergedCostV6(samplePayload(), 400, 0).cost, { toolCalls: 1, serviceMs: 10 });
  const second = retrievalCostFromV6(withConvergedCostV6(samplePayload(), 200, 0).cost, {
    toolCalls: 1,
    additionalSourceBytes: 200,
    serviceMs: 8
  });
  const cumulative = accumulateCostSteps([first, second]);
  assert.equal(cumulative.toolCalls, 2);
  assert.equal(cumulative.wireBytes, first.wireBytes + second.wireBytes);
  assert.equal(cumulative.cumulativeServiceMs, 18);
  assert.equal(cumulative.serviceMs, 8);
  assert.equal(
    reconstructEstimatedTokens(cumulative.wireBytes, cumulative.plannedSourceBytes),
    reconstructEstimatedTokens(first.wireBytes + second.wireBytes, first.plannedSourceBytes + second.plannedSourceBytes)
  );
});

test("λ calibration is CALIBRATED_OFFLINE and refuses a synthetic scalar", () => {
  const calibration = lambdaCalibration({});
  assert.equal(calibration.status, "CALIBRATED_OFFLINE");
  assert.equal(calibration.scalarAllowed, false);
  assert.equal(calibration.taskSuccess, "UNMEASURED");
  assert.throws(() => refuseSyntheticScalar(), /uncalibrated/);
});

test("repair policies keep oracle ≤ member ≤ whole-file and continuation adds missed members only", () => {
  const plan = {
    selected: [{ file: "A.java", estimatedBytes: 40 }],
    missedRequired: [{ file: "B.java", estimatedBytes: 25 }]
  };
  const files = [
    { file: "A.java", memberBytes: 80, wholeFileBytes: 400 },
    { file: "B.java", memberBytes: 60, wholeFileBytes: 300 }
  ];
  const oracle = repairReadBytes("EXACT_RANGE_ORACLE", plan, files);
  const member = repairReadBytes("MEMBER_READ", plan, files);
  const whole = repairReadBytes("WHOLE_FILE_UPPER_BOUND", plan, files);
  const continuation = repairReadBytes("CONTINUATION_DEFAULT", plan, files);
  assert.equal(oracle, 65);
  assert.equal(member, 140);
  assert.equal(whole, 700);
  assert.equal(continuation, 40 + 60);
  assert.ok(oracle <= member && member <= whole);
});

test("default vs oracle coverage of required groups stays split by selected files", () => {
  const groups = [
    { id: "a", weight: 1, anyOf: [{ file: "A.java" }] },
    { id: "b", weight: 1, anyOf: [{ file: "B.java" }, { file: "C.java" }] }
  ];
  assert.equal(defaultPolicyCoverage(groups, ["A.java"]), 0.5);
  const oracle = oraclePolicyCoverage(groups, ["A.java", "C.java"]);
  assert.equal(oracle.coverage, 1);
  assert.deepEqual(oracle.selected.sort(), ["A.java", "C.java"]);
});

test("legacy mustHit goldens become required groups; explicit groups win", () => {
  const legacy: Scenario = {
    id: "s1",
    name: "n",
    anchor: { file: "src/A.java", line: 1, column: 1, profile: "service" },
    golden: { mustHit: ["src/A.java", "src/B.java"] }
  };
  const groups = requiredGroupsFromScenario(legacy);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.anyOf, [{ file: "src/A.java" }]);
  const explicit: Scenario = {
    ...legacy,
    golden: {
      mustHit: ["src/A.java"],
      requiredGroups: [{ id: "persistence-contract", weight: 1, anyOf: [{ file: "src/A.java" }, { file: "src/B.xml" }] }]
    }
  };
  assert.deepEqual(requiredGroupsFromScenario(explicit).map(group => group.id), ["persistence-contract"]);
});

test("paired scorecard compares tuning and holdout per field and never emits a scalar J", () => {
  const oldVector = retrievalCostFromV6({
    resultBytes: 1000,
    readBytes: 400,
    estimatedTokens: reconstructEstimatedTokens(1000, 400),
    suppressedRawBytes: 0
  });
  const newVector = retrievalCostFromV6({
    resultBytes: 1100,
    readBytes: 350,
    estimatedTokens: reconstructEstimatedTokens(1100, 350),
    suppressedRawBytes: 0
  });
  const tuning = compareCostVectors(oldVector, newVector, "tuning");
  const holdout = compareCostVectors(oldVector, oldVector, "holdout");
  assert.equal(tuning.split, "tuning");
  assert.equal(holdout.split, "holdout");
  assert.equal(tuning.fields.find(field => field.field === "plannedSourceBytes")?.nonWorse, true);
  assert.equal(tuning.fields.find(field => field.field === "wireBytes")?.nonWorse, false);
  assert.equal(holdout.fields.every(field => field.nonWorse), true);
  assert.equal(JSON.stringify(tuning).includes("lambda"), false);
  assert.equal(tailCvar([10, 20, 30, 40, 100], 0.2), 100);
});
