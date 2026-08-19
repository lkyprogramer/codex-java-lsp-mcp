import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions } from "../../agent-types.js";
import { buildReadPlan } from "../read-plan.js";
import { closeContextRanges, buildReadUnits, windowsFromReadUnits } from "./read-unit-builder.js";
import { observeRetrievalParity, resetRetrievalParityTracker, retrievalParityTracker } from "./plan-selector.js";
import { planWithinRetrievalBudget, retrievalBudgetOverflowGaps } from "./selection-policy.js";
import { retrievalBudgetFor, type MaterializedReadWindow } from "./retrieval-types.js";
import { protectedSelectionUtility, selectionUtility } from "./selection-utility.js";

const options: ImpactOptions = {
  anchors: [{ file: "/repo/src/main/java/demo/OrderService.java", line: 12, column: 2 }],
  mode: "balanced",
  profile: "auto",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

function candidate(overrides: Partial<CandidateFile> = {}): CandidateFile {
  return {
    absolutePath: "/repo/src/main/java/demo/OrderService.java",
    path: "src/main/java/demo/OrderService.java",
    score: 100,
    matchCount: 1,
    positions: [{ line: 12, column: 2 }],
    categories: ["target"],
    reasons: ["target"],
    ...overrides
  };
}

function windowFor(file: CandidateFile, kinds: string[]): MaterializedReadWindow {
  const ranges = kinds.map((kind, index) => ({
    startLine: index * 10 + 1,
    endLine: index * 10 + 8,
    reason: kind === "method" ? "AST method range"
      : kind === "type" ? "AST owner type header"
        : kind === "xml-statement" ? "MyBatis XML statement"
          : kind === "xml-resultMap" ? "MyBatis XML resultMap"
            : "fixed-radius fallback",
    estimatedBytes: 100 + index
  }));
  return {
    file,
    ranges,
    coordinateRanges: ranges.map(range => ({
      start: { line: range.startLine, column: 1 },
      end: { line: range.endLine + 1, column: 1 }
    })),
    bytes: ranges.reduce((sum, range) => sum + range.estimatedBytes, 0),
    extremeMethod: false,
    rangeKinds: kinds
  };
}

test("context closure classifies method/statement as primary and type/resultMap as context without reordering", () => {
  const closed = closeContextRanges(
    windowFor(candidate(), ["type", "method", "xml-resultMap"]).ranges,
    ["type", "method", "xml-resultMap"]
  );
  assert.deepEqual(closed.primaryRanges.map(range => range.startLine), [11]);
  assert.deepEqual(closed.contextRanges.map(range => range.startLine), [1, 21]);
  assert.deepEqual(closed.mergedRanges.map(range => range.startLine), [1, 11, 21]);
});

test("ReadUnit round-trip preserves window ranges, bytes, and relative path identity", () => {
  const windows = [
    windowFor(candidate(), ["method"]),
    windowFor(candidate({
      absolutePath: "/repo/src/main/java/demo/OrderRepo.java",
      path: "src/main/java/demo/OrderRepo.java",
      categories: ["semantic"],
      reasons: ["CALLS"]
    }), ["method", "type"])
  ];
  const units = buildReadUnits({
    windows,
    ids: new Map(windows.map((item, index) => [item.file.absolutePath, `F${index + 1}`])),
    options,
    priorityOf: file => file.reasons.includes("target") ? "P0" : "P1"
  });
  const roundTrip = windowsFromReadUnits(units);
  assert.deepEqual(roundTrip.map(item => item.file.absolutePath), windows.map(item => item.file.absolutePath));
  assert.deepEqual(roundTrip.map(item => item.ranges), windows.map(item => item.ranges));
  assert.equal(roundTrip[1]!.bytes, windows[1]!.bytes);
  assert.equal(units[0]!.relativePath, "src/main/java/demo/OrderService.java");
  assert.equal(units[0]!.hop, 0);
  assert.equal(units[1]!.relationClass, "SECOND_HOP_EXACT");
});

test("selection utility is deterministic and prefers uncovered families then lower bytes when density binds", () => {
  const selected = [{ file: candidate(), estimatedBytes: 400 }];
  const left = {
    file: candidate({
      absolutePath: "/repo/src/main/java/demo/A.java",
      path: "src/main/java/demo/A.java",
      module: "other",
      reasons: ["CALLS"],
      score: 50
    }),
    estimatedBytes: 200
  };
  const right = {
    file: candidate({
      absolutePath: "/repo/src/main/java/demo/B.java",
      path: "src/main/java/demo/B.java",
      module: "other",
      reasons: ["CALLS"],
      score: 50
    }),
    estimatedBytes: 800
  };
  assert.equal(selectionUtility(left, selected), selectionUtility(left, selected));
  assert.ok(selectionUtility(left, selected) > selectionUtility(right, selected) - 20);
  assert.equal(protectedSelectionUtility(left) > 0, true);
});

test("hard files/spans/bytes caps report overflow without inventing a new selector", () => {
  const unit = buildReadUnits({
    windows: [windowFor(candidate(), ["method", "method", "method"])],
    ids: new Map([[candidate().absolutePath, "F1"]]),
    options,
    priorityOf: () => "P0"
  })[0]!;
  const tight = retrievalBudgetFor("minimal", { maxFiles: 1, maxReadBytes: 10 });
  tight.maxSpansPerFile = 1;
  const gaps = retrievalBudgetOverflowGaps([unit], tight);
  assert.ok(gaps.some(gap => gap.includes("maxSpansPerFile")));
  assert.equal(planWithinRetrievalBudget([unit], retrievalBudgetFor("balanced", { maxFiles: 6, maxReadBytes: 14 * 1024 })), true);
});

test("buildReadPlan ReadUnit path keeps first-call identity with the legacy selector", async () => {
  resetRetrievalParityTracker();
  const previous = process.env.JAVA_LSP_READUNIT_PLANNER;
  process.env.JAVA_LSP_READUNIT_PLANNER = "shadow";
  const anchor = candidate({ reasons: ["target"], categories: ["target"], score: 1000 });
  const impl = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderServiceImpl.java",
    path: "src/main/java/demo/OrderServiceImpl.java",
    categories: ["semantic"],
    reasons: ["IMPLEMENTS"],
    score: 200,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->${"/repo/src/main/java/demo/OrderServiceImpl.java"}`
    }]
  });
  const files = [anchor, impl];
  try {
    const result = await buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: { ...options, mode: "minimal", readPlanMaxItems: 2 },
      javaIndex: {
        async queryReadRanges(requests: Array<{ file: string }>) {
          return requests.map(request => ({
            file: request.file,
            ranges: [{
              startLine: 1,
              endLine: 10,
              range: { start: { line: 1, column: 1 }, end: { line: 11, column: 1 } },
              kind: "method" as const,
              estimatedBytes: 400
            }]
          }));
        }
      } as never
    });
    assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
    assert.equal(result.items.some(item => JSON.stringify(item).includes("/repo/")), false);
    assert.equal(retrievalParityTracker.matches, 1);
    assert.equal(retrievalParityTracker.mismatches, 0);
    const report = observeRetrievalParity(
      buildReadUnits({
        windows: files.map(file => windowFor(file, ["method"])),
        ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
        options,
        priorityOf: () => "P1"
      }),
      buildReadUnits({
        windows: files.map(file => windowFor(file, ["method"])),
        ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
        options,
        priorityOf: () => "P1"
      })
    );
    assert.equal(report.match, true);
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_READUNIT_PLANNER;
    else process.env.JAVA_LSP_READUNIT_PLANNER = previous;
  }
});

test("read-plan-budget remains the candidate-tail coverage helper, not the V6 byte-aware selector", async () => {
  const { selectReadPlanFiles } = await import("../read-plan.js");
  const { evidenceClassOf } = await import("../read-plan-budget.js");
  const { baselineReadPlanSafePaths } = await import("../rank-candidates.js");
  assert.equal(evidenceClassOf(candidate({ reasons: ["target"] })), "anchor");
  const selected = selectReadPlanFiles({
    files: [candidate(), candidate({
      absolutePath: "/repo/src/main/java/demo/Other.java",
      path: "src/main/java/demo/Other.java",
      reasons: ["rg"],
      score: 1
    })],
    options,
    maxItems: 1
  });
  assert.equal(selected[0]!.reasons.includes("target"), true);
  assert.equal(typeof baselineReadPlanSafePaths, "function");
});
