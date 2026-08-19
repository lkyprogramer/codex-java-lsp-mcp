import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ReadRange } from "../../agent-types.js";
import { buildReadPlan } from "../read-plan.js";
import { compareCostVectors, tailCvar } from "./cost-scorecard.js";
import { reconstructEstimatedTokens, retrievalCostFromV6 } from "./cost-model.js";
import { repairReadBytes } from "./repair-policy.js";
import { buildReadUnits } from "./read-unit-builder.js";
import { retrievalBudgetFor, type MaterializedReadWindow } from "./retrieval-types.js";
import {
  mergePackableSpans,
  packReadUnit,
  packSelectedUnits,
  spanKind,
  spanPackingProfile,
  type PackedSpan
} from "./span-packer.js";

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

function range(startLine: number, endLine: number, kind: "method" | "type" | "other", bytes: number): ReadRange {
  return {
    startLine,
    endLine,
    reason: kind === "method" ? "AST method range"
      : kind === "type" ? "AST owner type header"
        : "fixed-radius fallback",
    estimatedBytes: bytes
  };
}

function windowFor(file: CandidateFile, ranges: ReadRange[], kinds: string[], extreme = false): MaterializedReadWindow {
  return {
    file,
    ranges,
    coordinateRanges: ranges.map(item => ({
      start: { line: item.startLine, column: 1 },
      end: { line: item.endLine + 1, column: 1 }
    })),
    bytes: ranges.reduce((sum, item) => sum + item.estimatedBytes, 0),
    extremeMethod: extreme,
    rangeKinds: kinds
  };
}

function unitFor(ranges: ReadRange[], kinds: string[], extreme = false) {
  return buildReadUnits({
    windows: [windowFor(candidate(), ranges, kinds, extreme)],
    ids: new Map([[candidate().absolutePath, "F1"]]),
    options,
    priorityOf: () => "P0"
  })[0]!;
}

test("overlap merge unions type+method without expanding past the original envelope", () => {
  const spans: PackedSpan[] = [
    { ...range(1, 12, "type", 120), kind: "context" },
    { ...range(10, 40, "method", 400), kind: "primary" }
  ];
  const packed = mergePackableSpans(spans, 0);
  assert.equal(packed.length, 1);
  assert.equal(packed[0]!.startLine, 1);
  assert.equal(packed[0]!.endLine, 40);
  assert.equal(packed[0]!.kind, "primary");
  assert.ok(packed[0]!.estimatedBytes < 120 + 400);
  assert.equal(packed[0]!.endLine <= 40, true);
});

test("distant primary methods stay multi-span and are not fused into one runaway range", () => {
  const packed = mergePackableSpans([
    { ...range(10, 20, "method", 200), kind: "primary" },
    { ...range(80, 110, "method", 300), kind: "primary" }
  ], 0);
  assert.equal(packed.length, 2);
  assert.deepEqual(packed.map(span => span.startLine), [10, 80]);
});

test("extreme-method packing bounds the body instead of reading the whole file", () => {
  const unit = unitFor([range(1, 400, "method", 40_000)], ["method"], true);
  const packed = packReadUnit(unit, spanPackingProfile("balanced"), retrievalBudgetFor("balanced", { maxFiles: 6, maxReadBytes: 14 * 1024 }));
  assert.ok(packed.unit.estimatedBytes <= 8 * 1024);
  assert.ok(packed.unit.mergedRanges[0]!.endLine < 400);
  assert.equal(packed.report.stopReason, "EXTREME_METHOD_BOUNDED");
  assert.equal(packed.report.keptPrimary, true);
  const wholeFile = repairReadBytes(
    "WHOLE_FILE_UPPER_BOUND",
    { selected: [{ file: unit.relativePath, estimatedBytes: packed.unit.estimatedBytes }], missedRequired: [] },
    [{ file: unit.relativePath, memberBytes: packed.unit.estimatedBytes, wholeFileBytes: 40_000 }]
  );
  assert.ok(packed.unit.estimatedBytes < wholeFile);
});

test("source budget drops context before the last primary method snippet", () => {
  const unit = unitFor([
    range(1, 8, "type", 8_000),
    range(20, 40, "method", 400)
  ], ["type", "method"]);
  const packed = packReadUnit(unit, spanPackingProfile("balanced"), {
    maxReadBytes: 500
  });
  assert.equal(packed.unit.mergedRanges.length, 1);
  assert.equal(spanKind(packed.unit.mergedRanges[0]!.reason), "primary");
  assert.equal(packed.report.keptPrimary, true);
  assert.equal(packed.report.stopReason, "READ_BUDGET_EXHAUSTED");
});

test("packed planned-source cost is not worse than unpacked overlap and beats whole-file; tail does not worsen", () => {
  const unit = unitFor([
    range(1, 15, "type", 200),
    range(10, 50, "method", 800),
    range(200, 230, "method", 300)
  ], ["type", "method", "method"]);
  const budget = retrievalBudgetFor("balanced", { maxFiles: 6, maxReadBytes: 14 * 1024 });
  const packed = packSelectedUnits([unit], spanPackingProfile("balanced"), budget);
  assert.ok(packed.report.sourceBytesAfter <= packed.report.sourceBytesBefore);
  const unpacked = retrievalCostFromV6({
    resultBytes: packed.report.wireBytesProxy + 50,
    readBytes: packed.report.sourceBytesBefore,
    estimatedTokens: reconstructEstimatedTokens(packed.report.wireBytesProxy + 50, packed.report.sourceBytesBefore),
    suppressedRawBytes: 0
  });
  const packedCost = retrievalCostFromV6({
    resultBytes: packed.report.wireBytesProxy,
    readBytes: packed.report.sourceBytesAfter,
    estimatedTokens: packed.report.estimatedTokensAfter,
    suppressedRawBytes: 0
  });
  const tuning = compareCostVectors(unpacked, packedCost, "tuning");
  const holdout = compareCostVectors(unpacked, packedCost, "holdout");
  assert.equal(tuning.fields.find(field => field.field === "plannedSourceBytes")?.nonWorse, true);
  assert.equal(holdout.fields.find(field => field.field === "plannedSourceBytes")?.nonWorse, true);
  assert.ok(tailCvar([packed.report.sourceBytesAfter], 0.2) <= tailCvar([packed.report.sourceBytesBefore], 0.2));
  assert.ok(packed.report.sourceBytesAfter < 10_000);
  assert.equal(packed.units[0]!.mergedRanges.some(item => spanKind(item.reason) === "primary" || item.startLine === 10 || item.startLine === 200), true);
});

test("mode profiles differ: minimal uses a tighter span cap than recall", () => {
  assert.ok(spanPackingProfile("minimal").maxSpansPerFile < spanPackingProfile("recall").maxSpansPerFile);
  assert.ok(spanPackingProfile("minimal").extremeMethodMaxBytes < spanPackingProfile("recall").extremeMethodMaxBytes);
});

test("buildReadPlan default packing is off and keeps first-plan range identity; on packing does not change selected files", async () => {
  const previous = process.env.JAVA_LSP_SPAN_PACKING;
  const files = [
    candidate({ reasons: ["target"], score: 1000 }),
    candidate({
      absolutePath: "/repo/src/main/java/demo/OrderServiceImpl.java",
      path: "src/main/java/demo/OrderServiceImpl.java",
      reasons: ["IMPLEMENTS"],
      score: 200
    })
  ];
  const javaIndex = {
    async queryReadRanges(requests: Array<{ file: string }>) {
      return requests.map(request => ({
        file: request.file,
        ranges: [{
          startLine: 1,
          endLine: 8,
          range: { start: { line: 1, column: 1 }, end: { line: 9, column: 1 } },
          kind: "type" as const,
          estimatedBytes: 120
        }, {
          startLine: 6,
          endLine: 40,
          range: { start: { line: 6, column: 1 }, end: { line: 41, column: 1 } },
          kind: "method" as const,
          estimatedBytes: 400
        }]
      }));
    }
  } as never;
  try {
    delete process.env.JAVA_LSP_SPAN_PACKING;
    const off = await buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: { ...options, mode: "minimal", readPlanMaxItems: 2 },
      javaIndex
    });
    process.env.JAVA_LSP_SPAN_PACKING = "on";
    const on = await buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: { ...options, mode: "minimal", readPlanMaxItems: 2 },
      javaIndex
    });
    assert.deepEqual(on.selectedPaths, off.selectedPaths);
    assert.equal(off.spanPacking, undefined);
    assert.ok((on.spanPacking?.sourceBytesAfter ?? 0) <= (on.spanPacking?.sourceBytesBefore ?? 0));
    assert.ok((off.items[0]?.ranges.length ?? 0) >= 2);
    assert.equal(on.items[0]?.ranges.length, 1);
    assert.equal(on.items[0]?.ranges[0]?.startLine, 1);
    assert.equal(on.items[0]?.ranges[0]?.endLine, 40);
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_SPAN_PACKING;
    else process.env.JAVA_LSP_SPAN_PACKING = previous;
  }
});
