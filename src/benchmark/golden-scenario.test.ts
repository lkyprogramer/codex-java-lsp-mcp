import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  firstTaskBlockingRank,
  goldenEntries,
  loadScenarios,
  ndcgReadAt6,
  readPlanCoordinateRecall,
  readPlanRangeRecall,
  taskBlockingFiles,
  type Scenario
} from "./golden-scenario.js";

function scenario(golden: Scenario["golden"]): Scenario {
  return {
    id: "s1",
    name: "Scenario",
    anchor: { file: "src/main/java/demo/Anchor.java", line: 1, column: 1, profile: "service" },
    golden
  };
}

test("taskBlockingFiles unions mustHit and taskBlocking, excludes should/support", () => {
  const s = scenario({
    mustHit: ["A.java"],
    taskBlocking: ["B.java"],
    shouldHit: ["C.java"],
    support: ["D.java"]
  });
  assert.deepEqual([...taskBlockingFiles(s)].sort(), ["A.java", "B.java"]);
});

test("goldenEntries de-duplicates cross-version compatibility aliases by strongest kind", () => {
  const s = scenario({
    mustHit: ["A.java"],
    taskBlocking: ["B.java"],
    shouldHit: ["B.java", "C.java"],
    support: ["D.java"]
  });

  assert.deepEqual(goldenEntries(s), [
    { file: "A.java", kind: "must" },
    { file: "B.java", kind: "taskBlocking" },
    { file: "C.java", kind: "should" },
    { file: "D.java", kind: "support" }
  ]);
});

test("ndcgReadAt6 scores 1.0 when the read plan places golden files in ideal relevance order", () => {
  const s = scenario({ mustHit: ["A.java"], taskBlocking: ["B.java"], shouldHit: ["C.java"], support: [] });
  // must/taskBlocking (relevance 3) both outrank should (relevance 2); this order is already ideal.
  assert.equal(ndcgReadAt6(s, ["A.java", "B.java", "C.java"]), 1);
});

test("ndcgReadAt6 penalizes placing a should-hit file ahead of a must-hit file", () => {
  const s = scenario({ mustHit: ["A.java"], taskBlocking: [], shouldHit: ["C.java"], support: [] });
  const ideal = ndcgReadAt6(s, ["A.java", "C.java"]);
  const inverted = ndcgReadAt6(s, ["C.java", "A.java"]);
  assert.equal(ideal, 1);
  assert.ok(inverted < ideal, "placing the lower-relevance file first must score below the ideal ordering");
});

test("ndcgReadAt6 is 0 when no golden file appears in the read plan's first 6 items", () => {
  const s = scenario({ mustHit: ["A.java"], taskBlocking: [], shouldHit: [], support: [] });
  assert.equal(ndcgReadAt6(s, ["Z1.java", "Z2.java"]), 0);
});

test("firstTaskBlockingRank returns the 1-indexed position, undefined when never a candidate", () => {
  const s = scenario({ mustHit: ["A.java"], taskBlocking: ["B.java"], shouldHit: [], support: [] });
  assert.equal(firstTaskBlockingRank(s, ["Z.java", "B.java", "A.java"]), 2);
  assert.equal(firstTaskBlockingRank(s, ["Z.java", "Y.java"]), undefined);
});

test("readPlanRangeRecall is undefined (not 0) when the scenario carries no mustReadRanges", () => {
  const s = scenario({ mustHit: ["A.java"], taskBlocking: [], shouldHit: [], support: [] });
  assert.equal(readPlanRangeRecall(s, new Map()), undefined);
});

test("readPlanRangeRecall measures fractional line-range coverage once mustReadRanges is populated", () => {
  const s = scenario({
    mustHit: ["A.java"],
    taskBlocking: [],
    shouldHit: [],
    support: [],
    mustReadRanges: {
      "A.java": [{ startLine: 10, endLine: 20 }, { startLine: 40, endLine: 50 }]
    }
  });
  const selected = new Map([["A.java", [{ startLine: 5, endLine: 25 }]]]);
  assert.equal(readPlanRangeRecall(s, selected), 0.5, "only the first of two required ranges is covered by the selected window");
});

test("readPlanCoordinateRecall is undefined for legacy line-only scenarios", () => {
  const s = scenario({ mustReadRanges: { "A.java": [{ startLine: 1, endLine: 2 }] } });
  assert.equal(readPlanCoordinateRecall(s, new Map()), undefined);
});

test("readPlanCoordinateRecall accepts an adjacent union and rejects a first-token gap", () => {
  const s = scenario({
    mustReadCoordinateRangesV2: [{ file: "A.java", start: { line: 10, column: 5 }, end: { line: 12, column: 9 } }]
  });
  const covered = new Map([["A.java", [
    { start: { line: 10, column: 1 }, end: { line: 11, column: 1 } },
    { start: { line: 11, column: 1 }, end: { line: 13, column: 1 } }
  ]] as const]);
  const clipped = new Map([["A.java", [
    { start: { line: 10, column: 6 }, end: { line: 13, column: 1 } }
  ]] as const]);
  assert.equal(readPlanCoordinateRecall(s, covered), 1);
  assert.equal(readPlanCoordinateRecall(s, clipped), 0);
});

test("readPlanCoordinateRecall treats an emoji as two UTF-16 code units", () => {
  const s = scenario({
    mustReadCoordinateRangesV2: [{ file: "Emoji.java", start: { line: 1, column: 2 }, end: { line: 1, column: 4 } }]
  });
  assert.equal(readPlanCoordinateRecall(s, new Map([["Emoji.java", [
    { start: { line: 1, column: 2 }, end: { line: 1, column: 4 } }
  ]]])), 1);
  assert.equal(readPlanCoordinateRecall(s, new Map([["Emoji.java", [
    { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } }
  ]]])), 0, "the last UTF-16 code unit must not be treated as covered");
});

test("loadScenarios validates split provenance and exact coordinate ranges", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "golden-scenario-"));
  const file = path.join(directory, "scenario.jsonl");
  try {
    writeFileSync(file, `${JSON.stringify({
      id: "s1",
      name: "scenario",
      repoCommit: "a".repeat(40),
      evaluationSplit: "holdout",
      anchor: { file: "src/A.java", line: 1, column: 1, profile: "service" },
      golden: {
        mustReadCoordinateRangesV2: [{ file: "src/A.java", start: { line: 1, column: 1 }, end: { line: 1, column: 3 } }]
      }
    })}\n`, "utf8");
    assert.equal(loadScenarios(file)[0]?.evaluationSplit, "holdout");

    writeFileSync(file, `${JSON.stringify({
      id: "s1",
      name: "scenario",
      repoCommit: "short",
      evaluationSplit: "holdout",
      anchor: { file: "src/A.java", line: 1, column: 1, profile: "service" }
    })}\n`, "utf8");
    assert.throws(() => loadScenarios(file), /full 40-character repoCommit/);

    writeFileSync(file, `${JSON.stringify({
      id: "s1",
      name: "scenario",
      repoCommit: "a".repeat(40),
      evaluationSplit: "tuning",
      anchor: { file: "src/A.java", line: 1, column: 1, profile: "service" },
      golden: {
        mustReadCoordinateRangesV2: [{ file: "src/A.java", start: { line: 2, column: 1 }, end: { line: 1, column: 1 } }]
      }
    })}\n`, "utf8");
    assert.throws(() => loadScenarios(file), /end-exclusive UTF-16 range/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
