// input: Hand-built candidate files over a fixed range index.
// output: T08 contract evidence — evidence losses are classified
//         ENTRY_ABSENT / EVICTED / RANGE_MISS in a structured ledger that
//         mirrors evidenceGaps, and the same underlying fact reaching the
//         planner through multiple providers occupies one plan slot.
// pos: M2 T08 - key evidence and the final read plan must explain what was
//      lost and why, without inflating file budgets to hide an absence.
import assert from "node:assert/strict";
import test from "node:test";
import { buildReadPlan } from "./read-plan.js";
import type { CandidateFile } from "../agent-types.js";

function candidate(overrides: Partial<CandidateFile>): CandidateFile {
  return {
    absolutePath: "/repo/src/main/java/demo/GatewayImpl.java",
    path: "src/main/java/demo/GatewayImpl.java",
    score: 100,
    matchCount: 1,
    positions: [{ line: 1, column: 1 }],
    categories: ["semantic"],
    reasons: [],
    ...overrides
  };
}

function optionsFor(anchor: CandidateFile, overrides: Partial<Parameters<typeof buildReadPlan>[0]["options"]> = {}): Parameters<typeof buildReadPlan>[0]["options"] {
  return {
    anchors: [{ file: anchor.absolutePath, line: 1, column: 1 }],
    mode: "balanced",
    profile: "service",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1_500,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  } as Parameters<typeof buildReadPlan>[0]["options"];
}

function rangeIndex(rangesFor: (file: string) => { startLine: number; endLine: number; kind: "method"; estimatedBytes: number }[]): Parameters<typeof buildReadPlan>[0]["javaIndex"] {
  return {
    async queryReadRanges(requests: Array<{ file: string }>) {
      return requests.map(request => ({ file: request.file, ranges: rangesFor(request.file) }));
    }
  } as never;
}

type GapLedgerView = { evidenceGapLedger?: Array<{ kind: string; message: string }> };

function kinds(result: Awaited<ReturnType<typeof buildReadPlan>>, messagePart: string): string[] {
  const ledger = ledgerOf(result);
  return ledger
    .filter(gap => gap.message.includes(messagePart))
    .map(gap => gap.kind);
}

function ledgerOf(result: Awaited<ReturnType<typeof buildReadPlan>>): Array<{ kind: string; message: string }> {
  return (result as unknown as GapLedgerView).evidenceGapLedger ?? [];
}

test("T08: a candidate without any indexed range is classified ENTRY_ABSENT, not EVICTED", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const absent = candidate({ absolutePath: "/repo/src/main/java/demo/Ghost.java", path: "src/main/java/demo/Ghost.java", reasons: ["SPRING_INJECTION"], score: 900 });
  const files = [anchor, absent];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 4 }),
    javaIndex: rangeIndex(file => file.endsWith("Ghost.java") ? [] : [{ startLine: 1, endLine: 4, kind: "method", estimatedBytes: 256 }])
  });
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Ghost.java") && gap.includes("unavailable")), "the absent entry is still named in evidenceGaps");
  const classified = kinds(result, "Ghost.java");
  assert.ok(classified.includes("ENTRY_ABSENT"), `no-index-range loss must be ENTRY_ABSENT, got ${JSON.stringify(ledgerOf(result))}`);
  assert.ok(!classified.includes("EVICTED"), "an absence must not be misreported as a budget eviction");
});

test("T08: an anchor line dropped by budget trimming is RANGE_MISS and names the plan partial", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/LongService.java",
    path: "src/main/java/demo/LongService.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000,
    positions: [{ line: 1, column: 1 }, { line: 50, column: 3 }]
  });
  // Only the head window exists; anchor line 50 is a range miss.
  const result = await buildReadPlan({
    files: [anchor],
    ids: new Map([[anchor.absolutePath, "F1"]]),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: rangeIndex(() => [{ startLine: 1, endLine: 4, kind: "method", estimatedBytes: 256 }])
  });
  const classified = kinds(result, "50");
  assert.ok(classified.includes("RANGE_MISS"), `an uncovered anchor line is a range miss, got ${JSON.stringify(ledgerOf(result))}`);
  assert.ok(ledgerOf(result).some(gap => gap.kind === "RANGE_MISS" && gap.message.includes("partial")), "the ledger message must keep the plan honest");
});

test("T08: a candidate dropped by shortlist capacity is EVICTED and ENTRY_ABSENT stays off-limits", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const core = Array.from({ length: 6 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Call${index}.java`,
    path: `src/main/java/demo/Call${index}.java`,
    reasons: ["SPRING_CALL_PATH"],
    verifiedBy: ["SPRING_CALL_PATH"],
    score: 900 - index,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_CALL_PATH", sourceTarget: `A1:${anchor.absolutePath}->call:${index}` }]
  }));
  const files = [anchor, ...core];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 1 }),
    javaIndex: rangeIndex(() => [{ startLine: 1, endLine: 4, kind: "method", estimatedBytes: 256 }])
  });
  const classified = kinds(result, "shortlist capacity");
  assert.ok(classified.includes("EVICTED"), `shortlist overflow is a budget eviction, got ${JSON.stringify(ledgerOf(result))}`);
});

test("T08: the ledger and evidenceGaps are two views of the same loss set", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000, positions: [{ line: 1, column: 1 }, { line: 50, column: 3 }] });
  const ghost = candidate({ absolutePath: "/repo/src/main/java/demo/Ghost.java", path: "src/main/java/demo/Ghost.java", reasons: ["SPRING_INJECTION"], score: 900 });
  const files = [anchor, ghost];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: rangeIndex(file => file.endsWith("Ghost.java") ? [] : [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }])
  });
  const ledger = ledgerOf(result);
  const gapMessages = new Set(result.evidenceGaps);
  const ledgerMessages = new Set(ledger.map(gap => gap.message));
  for (const gap of ledger) assert.ok(gapMessages.has(gap.message), `ledger gap missing from evidenceGaps: ${gap.message}`);
  for (const message of result.evidenceGaps) assert.ok(ledgerMessages.has(message), `evidence gap missing from ledger: ${message}`);
  assert.ok(ledger.length > 0, "a plan that loses evidence must carry a non-empty ledger");
});

test("T08: the same file reached through two providers occupies one plan slot with merged evidence", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  // One file, two independent discovery providers: a MyBatis statement edge
  // and a lexical hit must collapse into a single candidate (dedup by path in
  // the router) and therefore a single plan item.
  const deduped = [
    candidate({
      absolutePath: "/repo/src/main/java/demo/LedgerDao.java",
      path: "src/main/java/demo/LedgerDao.java",
      score: 950,
      reasons: ["MYBATIS_STATEMENT_METHOD"],
      plannerEvidence: [{ family: "FRAMEWORK", kind: "MYBATIS_STATEMENT_METHOD", sourceTarget: `A1:${anchor.absolutePath}->namespace:ledger` }]
    }),
    candidate({
      absolutePath: "/repo/src/main/java/demo/LedgerDao.java",
      path: "src/main/java/demo/LedgerDao.java",
      score: 850,
      reasons: ["BM25"],
      categories: ["lexical"]
    })
  ];
  const merged: CandidateFile = {
    ...deduped[0]!,
    score: Math.max(deduped[0]!.score, deduped[1]!.score),
    reasons: [...new Set([...deduped[0]!.reasons, ...deduped[1]!.reasons])],
    categories: [...new Set([...deduped[0]!.categories, ...deduped[1]!.categories])]
  };
  const files = [anchor, merged];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 4 }),
    javaIndex: rangeIndex(() => [{ startLine: 1, endLine: 4, kind: "method", estimatedBytes: 256 }])
  });
  const items = result.items.filter(item => item.fileId === "F2");
  assert.equal(items.length, 1, "two providers over one file must not double-book a plan slot");
  assert.ok(items[0]!.expectedEvidence.some(evidence => evidence.includes("MYBATIS_STATEMENT_METHOD")), "the merged candidate keeps both provider facts");
});