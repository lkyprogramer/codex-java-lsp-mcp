import assert from "node:assert/strict";
import test from "node:test";
import {
  MISS_IN_POOL_EVICTED,
  MISS_NOT_IN_POOL,
  MISS_RANGE_MISS,
  classifyMustHitFile,
  diagnoseBenchmarkPayload,
  diagnoseScene,
  impactFromBenchmarkAttempt,
  summarizeDiagnosis
} from "./diagnose-impact-misses.mjs";
import { loadTuningScenes } from "./audit-golden-quality.mjs";

test("NOT_IN_POOL / IN_POOL_EVICTED / RANGE_MISS labels", () => {
  assert.equal(classifyMustHitFile("src/A.java", {
    pool: [],
    selected: [],
    selectedRanges: {},
    mustReadRanges: {}
  }), MISS_NOT_IN_POOL);
  assert.equal(classifyMustHitFile("src/B.java", {
    pool: ["src/B.java", "src/C.java"],
    selected: ["src/C.java"],
    selectedRanges: { "src/C.java": [{ startLine: 1, endLine: 4 }] }
  }), MISS_IN_POOL_EVICTED);
  assert.equal(classifyMustHitFile("src/C.java", {
    pool: ["src/C.java"],
    selected: ["src/C.java"],
    selectedRanges: { "src/C.java": [{ startLine: 10, endLine: 12 }] },
    mustReadRanges: { "src/C.java": [{ startLine: 1, endLine: 4 }] }
  }), MISS_RANGE_MISS);
  assert.equal(classifyMustHitFile("src/C.java", {
    pool: ["src/C.java"],
    selected: ["src/C.java"],
    selectedRanges: { "src/C.java": [{ startLine: 1, endLine: 8 }] },
    mustReadRanges: { "src/C.java": [{ startLine: 1, endLine: 4 }] }
  }), null);
});

test("holdout rows in a mixed jsonl are not diagnosed", () => {
  const jsonl = [
    JSON.stringify({
      id: "tune-1",
      evaluationSplit: "tuning",
      golden: { mustHit: ["src/A.java"] }
    }),
    JSON.stringify({
      id: "hold-secret",
      evaluationSplit: "holdout",
      golden: { mustHit: ["HOLD_OUT_SECRET.java"] }
    })
  ].join("\n");
  const loaded = loadTuningScenes(jsonl);
  const payload = {
    rows: [
      {
        id: "tune-1",
        attempts: [{ determinism: { candidatePaths: [], readPlan: [] } }]
      },
      {
        id: "hold-secret",
        attempts: [{ determinism: { candidatePaths: ["HOLD_OUT_SECRET.java"], readPlan: [] } }]
      }
    ]
  };
  const rows = diagnoseBenchmarkPayload(payload, loaded.tuning);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenarioId, "tune-1");
  assert.equal(JSON.stringify(rows).includes("HOLD_OUT_SECRET"), false);
});

test("selection-layer majority routes to B1; discovery majority to B3", () => {
  const selection = summarizeDiagnosis([
    { misses: [{ file: "a", label: MISS_IN_POOL_EVICTED }, { file: "b", label: MISS_RANGE_MISS }, { file: "c", label: MISS_IN_POOL_EVICTED }] }
  ]);
  assert.equal(selection.next, "B1");
  assert.ok(selection.shares.selectionLayer >= 0.6);
  const discovery = summarizeDiagnosis([
    { misses: [{ file: "a", label: MISS_NOT_IN_POOL }, { file: "b", label: MISS_NOT_IN_POOL }, { file: "c", label: MISS_IN_POOL_EVICTED }] }
  ]);
  assert.equal(discovery.next, "B3");
  assert.ok(discovery.shares.NOT_IN_POOL > 0.4);
  const impact = impactFromBenchmarkAttempt({
    determinism: {
      candidatePaths: ["src/A.java", "src/B.java"],
      readPlan: [{ path: "src/A.java", ranges: [{ startLine: 1, endLine: 2 }] }]
    }
  });
  const scene = diagnoseScene(
    { id: "s", golden: { mustHit: ["src/A.java", "src/B.java", "src/C.java"] } },
    impact
  );
  assert.deepEqual(scene.misses.map(row => row.label).sort(), [MISS_IN_POOL_EVICTED, MISS_NOT_IN_POOL]);
});
