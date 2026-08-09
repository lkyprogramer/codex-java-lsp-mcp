import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstTaskBlockingRank,
  goldenEntries,
  ndcgReadAt6,
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
