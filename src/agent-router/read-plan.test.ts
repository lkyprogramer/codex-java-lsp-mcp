// input: Router candidates carrying static Java-index evidence.
// output: Protected read-plan paths for direct and persisted implementations.
// pos: Task 22 regression coverage for must-read implementation evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { buildReadPlan, protectedReadPlanPaths, selectReadPlanFiles } from "./read-plan.js";
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

test("protected read plan retains exact main-source evidence without letting deferred tests consume the budget", () => {
  const direct = candidate({
    absolutePath: "/repo/src/main/java/demo/Command.java",
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"]
  });
  const implementation = candidate({
    reasons: ["persisted-typeHierarchy"],
    verifiedBy: ["persisted-typeHierarchy"]
  });
  const directImplementation = candidate({
    absolutePath: "/repo/src/main/java/demo/GatewayAdapter.java",
    reasons: ["typeGraph:implementation-lookup"],
    verifiedBy: ["typeGraph"],
    scoreBreakdown: [{ id: "finalize.type-relation", source: "finalize", delta: 95, reason: "implements anchor" }]
  });
  const directMethodType = candidate({
    absolutePath: "/repo/src/main/java/demo/CommandInput.java",
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"],
    scoreBreakdown: [{ id: "finalize.method-relation", source: "finalize", delta: 160, reason: "method parameter" }]
  });
  const deferredTestReference = candidate({
    absolutePath: "/repo/src/test/java/demo/GatewayAdapterTest.java",
    sourceSet: "test",
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"]
  });
  const concreteSubtype = candidate({
    absolutePath: "/repo/src/main/java/demo/ConcreteSubtype.java",
    reasons: ["typeGraph"],
    verifiedBy: ["typeGraph"]
  });

  const protectedPaths = protectedReadPlanPaths([
    direct,
    implementation,
    directImplementation,
    directMethodType,
    deferredTestReference,
    concreteSubtype
  ]);

  assert.deepEqual(protectedPaths, new Set([
    direct.absolutePath,
    implementation.absolutePath,
    directImplementation.absolutePath,
    directMethodType.absolutePath
  ]));
});

test("repository read plan keeps task-local entity and mapper context ahead of generic type references", () => {
  const anchor = candidate({
    absolutePath: "/repo/modules/report/src/main/java/demo/ReportBatchExportTaskRepository.java",
    path: "modules/report/src/main/java/demo/ReportBatchExportTaskRepository.java",
    module: "report",
    reasons: ["target"],
    verifiedBy: ["anchor"],
    score: 1_000
  });
  const entity = candidate({
    absolutePath: "/repo/modules/report/src/main/java/demo/ReportBatchExportTaskDO.java",
    path: "modules/report/src/main/java/demo/ReportBatchExportTaskDO.java",
    module: "report",
    sourceSet: "main",
    // The real lishuedu candidates originate in the broad `rg:java` section;
    // their persistence role is carried by the path, not a category label.
    categories: ["java"],
    reasons: ["rg:task"],
    verifiedBy: ["rg"],
    scoreBreakdown: [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "direct type-name collaborator" }],
    score: 640
  });
  const mapper = candidate({
    absolutePath: "/repo/modules/report/src/main/java/demo/ReportBatchExportTaskMapper.java",
    path: "modules/report/src/main/java/demo/ReportBatchExportTaskMapper.java",
    module: "report",
    sourceSet: "main",
    categories: ["java"],
    reasons: ["rg:task"],
    verifiedBy: ["rg"],
    scoreBreakdown: [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "direct type-name collaborator" }],
    score: 630
  });
  const genericReferences = Array.from({ length: 5 }, (_, index) => candidate({
    // A broad persistence rg section can also find application services. They
    // are valuable, but must not be mistaken for the local row-model/mapper
    // boundary simply because the search section was named "persistence".
    absolutePath: `/repo/modules/report/src/main/java/demo/application/service/GenericReference${index}.java`,
    path: `modules/report/src/main/java/demo/application/service/GenericReference${index}.java`,
    module: "report",
    sourceSet: "main",
    categories: ["java", "persistence"],
    reasons: ["typeReference", "rg:persistence"],
    verifiedBy: ["typeReference"],
    score: 900 - index
  }));

  const selected = selectReadPlanFiles({
    files: [anchor, ...genericReferences, entity, mapper],
    options: {
      anchors: [{ file: "modules/report/src/main/java/demo/ReportBatchExportTaskRepository.java", line: 1, column: 1 }],
      mode: "balanced",
      profile: "repository",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      testReadMode: "defer",
      focusModules: ["report"],
      excludeModules: [],
      taskKeywords: ["report", "batch", "export", "zip", "task"],
      crossModulePolicy: "auto"
    },
    maxItems: 6
  });

  assert.ok(selected.some(file => file.absolutePath === entity.absolutePath));
  assert.ok(selected.some(file => file.absolutePath === mapper.absolutePath));
});

test("repository persistence protection stays within the anchor type family", () => {
  const anchor = candidate({
    absolutePath: "/repo/exam-data/src/main/java/demo/PositionRepository.java",
    path: "exam-data/src/main/java/demo/PositionRepository.java",
    module: "exam-data",
    reasons: ["target"],
    verifiedBy: ["anchor"],
    score: 1_000
  });
  const position = candidate({
    absolutePath: "/repo/exam-data/src/main/java/demo/entity/Position.java",
    path: "exam-data/src/main/java/demo/entity/Position.java",
    module: "exam-data",
    sourceSet: "main",
    categories: ["persistence"],
    reasons: ["rg:persistence"],
    score: 800
  });
  const unrelatedEntities = Array.from({ length: 5 }, (_, index) => candidate({
    absolutePath: `/repo/exam-data/src/main/java/demo/entity/Unrelated${index}.java`,
    path: `exam-data/src/main/java/demo/entity/Unrelated${index}.java`,
    module: "exam-data",
    sourceSet: "main",
    categories: ["persistence"],
    reasons: ["rg:persistence"],
    score: 790 - index
  }));
  const progressService = candidate({
    absolutePath: "/repo/exam-service/src/main/java/demo/ExamProgressServiceImpl.java",
    path: "exam-service/src/main/java/demo/ExamProgressServiceImpl.java",
    module: "exam-service",
    sourceSet: "main",
    categories: ["semantic"],
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"],
    score: 280
  });

  const selected = selectReadPlanFiles({
    files: [anchor, position, ...unrelatedEntities, progressService],
    options: {
      anchors: [{ file: "exam-data/src/main/java/demo/PositionRepository.java", line: 1, column: 1 }],
      mode: "balanced",
      profile: "repository",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      testReadMode: "defer",
      focusModules: ["exam-data", "exam-service"],
      excludeModules: [],
      taskKeywords: ["position", "exists", "progress"],
      crossModulePolicy: "auto"
    },
    maxItems: 6
  });

  assert.ok(selected.some(file => file.absolutePath === position.absolutePath));
  assert.ok(selected.some(file => file.absolutePath === progressService.absolutePath));
});

test("repository read plan retains a repository implementation suffix and a task-discovered mapper", () => {
  const anchor = candidate({
    absolutePath: "/repo/transfer/src/main/java/demo/TransferRepository.java",
    path: "transfer/src/main/java/demo/TransferRepository.java",
    module: "transfer",
    reasons: ["target"],
    verifiedBy: ["anchor"],
    score: 1_000
  });
  const implementation = candidate({
    absolutePath: "/repo/transfer/src/main/java/demo/persistence/MybatisTransferRepository.java",
    path: "transfer/src/main/java/demo/persistence/MybatisTransferRepository.java",
    module: "transfer",
    sourceSet: "main",
    categories: ["semantic"],
    reasons: ["importGraph"],
    verifiedBy: ["importGraph"],
    score: 650
  });
  const mapper = candidate({
    absolutePath: "/repo/transfer/src/main/java/demo/persistence/mapper/UploadSessionMapper.java",
    path: "transfer/src/main/java/demo/persistence/mapper/UploadSessionMapper.java",
    module: "transfer",
    sourceSet: "main",
    categories: ["persistence"],
    reasons: ["rg:persistence"],
    scoreBreakdown: [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "direct type-name collaborator" }],
    score: 640
  });
  const distractions = Array.from({ length: 6 }, (_, index) => candidate({
    absolutePath: `/repo/transfer/src/main/java/demo/entity/Other${index}.java`,
    path: `transfer/src/main/java/demo/entity/Other${index}.java`,
    module: "transfer",
    sourceSet: "main",
    categories: ["persistence"],
    reasons: ["rg:persistence"],
    score: 900 - index
  }));

  const selected = selectReadPlanFiles({
    files: [anchor, ...distractions, implementation, mapper],
    options: {
      anchors: [{ file: "transfer/src/main/java/demo/TransferRepository.java", line: 1, column: 1 }],
      mode: "balanced",
      profile: "repository",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      testReadMode: "defer",
      focusModules: ["transfer"],
      excludeModules: [],
      taskKeywords: ["transfer", "upload", "session"],
      crossModulePolicy: "auto"
    },
    maxItems: 6
  });

  assert.ok(selected.some(file => file.absolutePath === implementation.absolutePath));
  assert.ok(selected.some(file => file.absolutePath === mapper.absolutePath));
});

test("token-aware read plan keeps its anchor, respects bytes, and makes one shortlisted range query", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderService.java",
    path: "src/main/java/demo/OrderService.java",
    categories: ["target"],
    reasons: ["target"],
    score: 1_000
  });
  const direct = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderRepository.java",
    path: "src/main/java/demo/OrderRepository.java",
    reasons: ["SPRING_CALL_PATH"],
    verifiedBy: ["SPRING_CALL_PATH"],
    score: 900
  });
  const duplicate = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderNameVariant.java",
    path: "src/main/java/demo/OrderNameVariant.java",
    reasons: ["rg:task"],
    verifiedBy: ["rg"],
    score: 899
  });
  let rangeQueries = 0;
  const index = {
    async queryReadRanges(requests: Array<{ file: string }>) {
      rangeQueries += 1;
      return requests.map(request => ({
        file: request.file,
        ranges: [{ startLine: 1, endLine: 10, kind: "method", estimatedBytes: request.file.includes("OrderService") ? 1_500 : 900 }]
      }));
    }
  };
  const tokenAwareOptions = {
    anchors: [{ file: anchor.absolutePath, line: 1, column: 1 }],
    mode: "minimal",
    profile: "service",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1_500,
    readPlanMaxItems: 2,
    readPlanMaxBytes: 2_000,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: ["order"],
    crossModulePolicy: "auto"
  };

  const result = await buildReadPlan({
    files: [anchor, direct, duplicate],
    ids: new Map([[anchor.absolutePath, "F1"], [direct.absolutePath, "F2"], [duplicate.absolutePath, "F3"]]),
    options: tokenAwareOptions as never,
    javaIndex: index as never
  });
  const plan = result as unknown as {
    items: Array<{ fileId: string; estimatedBytes: number; ranges: unknown[] }>;
    totalBytes: number;
    evidenceGaps: string[];
  };

  assert.equal(Array.isArray(result), false, "the planner must expose V6 ranges and budget diagnostics, not legacy line windows");
  assert.deepEqual(plan.items.map(item => item.fileId), ["F1"], "the anchor stays while another file would exceed the byte budget");
  assert.equal(plan.totalBytes, 1_500);
  assert.equal(rangeQueries, 1, "all shortlisted candidates use one worker range batch");
});

test("token-aware read plan keeps a framework collaborator ahead of duplicate lexical variants", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderService.java",
    categories: ["target"],
    reasons: ["target"],
    score: 1_000
  });
  const framework = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderRepository.java",
    categories: ["framework"],
    reasons: ["framework:repository"],
    score: 800
  });
  const duplicates = [0, 1, 2].map(index => candidate({
    absolutePath: `/repo/src/main/java/demo/OrderNameVariant${index}.java`,
    categories: ["java"],
    reasons: ["rg:order-name"],
    score: 901 - index
  }));
  const result = await buildReadPlan({
    files: [anchor, ...duplicates, framework],
    ids: new Map([anchor, ...duplicates, framework].map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: {
      anchors: [{ file: anchor.absolutePath, line: 1, column: 1 }],
      mode: "minimal",
      profile: "service",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      testReadMode: "defer",
      focusModules: [],
      excludeModules: [],
      taskKeywords: ["order"],
      crossModulePolicy: "auto"
    },
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        return requests.map(request => ({
          file: request.file,
          ranges: [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 512 }]
        }));
      }
    } as never
  });

  const selected = result.items.map(item => item.fileId);
  assert.ok(selected.includes("F5"), "a framework collaborator remains useful even below lexical raw scores");
  assert.ok(selected.filter(id => id === "F2" || id === "F3" || id === "F4").length <= 1, "no bucket forces repeated lexical evidence");
});

test("anchor range may exceed bytes but does not force an additional file", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/HugeService.java",
    categories: ["target"],
    reasons: ["target"],
    score: 1_000
  });
  const collaborator = candidate({
    absolutePath: "/repo/src/main/java/demo/SmallRepository.java",
    reasons: ["SPRING_CALL_PATH"],
    score: 800
  });
  const result = await buildReadPlan({
    files: [anchor, collaborator],
    ids: new Map([[anchor.absolutePath, "F1"], [collaborator.absolutePath, "F2"]]),
    options: {
      anchors: [{ file: anchor.absolutePath, line: 1, column: 1 }],
      mode: "minimal",
      profile: "service",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      readPlanMaxBytes: 1_000,
      testReadMode: "defer",
      focusModules: [],
      excludeModules: [],
      taskKeywords: ["huge"],
      crossModulePolicy: "auto"
    },
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        return requests.map(request => ({
          file: request.file,
          ranges: [{ startLine: 1, endLine: 20, kind: "method" as const, estimatedBytes: request.file.includes("Huge") ? 1_500 : 200 }]
        }));
      }
    } as never
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1"]);
  assert.equal(result.budgetExceededByAnchor, true);
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Anchor range exceeded")));
});

test("token-aware read plan caps protected core at four and releases the remaining slot", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const core = Array.from({ length: 5 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Core${index}.java`,
    path: `src/main/java/demo/Core${index}.java`,
    reasons: ["SPRING_CALL_PATH"],
    verifiedBy: ["SPRING_CALL_PATH"],
    score: 900 - index
  }));
  const lexical = candidate({ absolutePath: "/repo/src/main/java/demo/UsefulContext.java", path: "src/main/java/demo/UsefulContext.java", reasons: ["rg:task"], verifiedBy: ["rg"], score: 850 });
  const files = [anchor, ...core, lexical];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.equal(result.items.filter(item => item.expectedEvidence.includes("SPRING_CALL_PATH")).length, 4);
  assert.ok(result.items.some(item => item.fileId === "F7"), "unused core capacity must be available to a useful non-core candidate");
});

test("protected core is ordered by absolute utility, not utility/byte ratio, when only one of two mutually exclusive candidates fits", async () => {
  // Regression for the three-repo canary finding: a small, low-value core
  // candidate (e.g. a coarse mapper) must not out-rank a large, high-value
  // one (e.g. a resolved implementation) merely because it is cheaper - a
  // ratio-primary sort picks the cheap file first, consuming just enough
  // budget to starve the valuable one even though nothing here is actually
  // byte-constrained in aggregate.
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const highValue = candidate({ absolutePath: "/repo/src/main/java/demo/Implementation.java", path: "src/main/java/demo/Implementation.java", reasons: ["SPRING_CALL_PATH"], verifiedBy: ["SPRING_CALL_PATH"], score: 500 });
  const cheapLowValue = candidate({ absolutePath: "/repo/src/main/java/demo/Mapper.java", path: "src/main/java/demo/Mapper.java", reasons: ["SPRING_CALL_PATH"], verifiedBy: ["SPRING_CALL_PATH"], score: 50 });
  const files = [anchor, highValue, cheapLowValue];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    // Exactly enough for the anchor plus one 6,000-byte core file - not both.
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 3, readPlanMaxBytes: 6_100 }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        return requests.map(request => ({
          file: request.file,
          ranges: [{
            startLine: 1,
            endLine: 4,
            kind: "method" as const,
            estimatedBytes: request.file.includes("Anchor") ? 100 : request.file.includes("Implementation") ? 6_000 : 200
          }]
        }));
      }
    } as never
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"], "the high-utility implementation must win the shared byte budget over the cheaper, lower-value mapper");
});

test("structured JDT definition evidence is protected core without legacy reason aliases", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const definition = candidate({
    absolutePath: "/repo/src/main/java/demo/Definition.java",
    path: "src/main/java/demo/Definition.java",
    reasons: [],
    score: 400,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: "A1->type:Definition" }]
  });
  const lexical = candidate({
    absolutePath: "/repo/src/main/java/demo/NameMatch.java",
    path: "src/main/java/demo/NameMatch.java",
    reasons: ["rg:java"],
    score: 900
  });
  const files = [anchor, lexical, definition];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"]);
});

test("non-protected static evidence uses core capacity instead of the lexical quota", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const structural = Array.from({ length: 3 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Structural${index}.java`,
    path: `src/main/java/demo/Structural${index}.java`,
    reasons: ["REFERENCE"],
    score: 500 - index,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: `A1->type:${index}` }]
  }));
  const lexical = Array.from({ length: 3 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Lexical${index}.java`,
    path: `src/main/java/demo/Lexical${index}.java`,
    reasons: ["rg:java"],
    score: 900 - index,
    plannerEvidence: [{ family: "LEXICAL", kind: "LEXICAL:java", sourceTarget: "A1->LEXICAL:java" }]
  }));
  const files = [anchor, ...lexical, ...structural];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 5 }),
    javaIndex: fixedRangeIndex()
  });

  assert.equal(result.items.filter(item => ["F5", "F6", "F7"].includes(item.fileId)).length, 3);
});

test("framework evidence keeps its own quota when the same candidate also has static evidence", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const mixed = candidate({
    absolutePath: "/repo/src/main/java/demo/Request.java",
    path: "src/main/java/demo/Request.java",
    reasons: ["SPRING_REQUEST_BODY", "REFERENCE"],
    categories: ["framework", "semantic"],
    score: 900,
    plannerEvidence: [
      { family: "FRAMEWORK", kind: "SPRING_REQUEST_BODY", sourceTarget: "A1->request" },
      { family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: "A1->request" }
    ]
  });
  const structural = Array.from({ length: 4 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Structural${index}.java`,
    path: `src/main/java/demo/Structural${index}.java`,
    reasons: ["REFERENCE"],
    score: 800 - index,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: `A1->type:${index}` }]
  }));
  const files = [anchor, mixed, ...structural];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 6, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.equal(result.items.length, 6);
  assert.deepEqual(new Set(result.items.map(item => item.fileId)), new Set(["F1", "F2", "F3", "F4", "F5", "F6"]));
});

test("baseline-safe structural paths reserve only the bounded core slots", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const baselineSafe = Array.from({ length: 4 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Safe${index}.java`,
    path: `src/main/java/demo/Safe${index}.java`,
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"],
    score: 100 - index,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: `A1->safe:${index}` }]
  }));
  const challengers = Array.from({ length: 4 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Challenger${index}.java`,
    path: `src/main/java/demo/Challenger${index}.java`,
    reasons: ["REFERENCE"],
    score: 900 - index,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: `A1->challenger:${index}` }]
  }));
  const files = [anchor, ...challengers, ...baselineSafe];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 6, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set(baselineSafe.map(file => file.absolutePath))
  });

  for (const file of baselineSafe) {
    const fileId = `F${files.indexOf(file) + 1}`;
    assert.ok(result.items.some(item => item.fileId === fileId), `${file.path} must retain its seed safe slot`);
  }
  assert.equal(result.items.length, 5, "safe slots remain bounded; an absent non-core bucket does not force a low-value file");
});

test("deferred tests never consume protected core quota", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const deferredTests = Array.from({ length: 4 }, (_, index) => candidate({
    absolutePath: `/repo/src/test/java/demo/Exact${index}Test.java`,
    path: `src/test/java/demo/Exact${index}Test.java`,
    sourceSet: "test",
    reasons: ["IMPLEMENTATION"],
    score: 900 - index,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "IMPLEMENTATION", sourceTarget: `A1->test:${index}` }]
  }));
  const main = Array.from({ length: 2 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Main${index}.java`,
    path: `src/main/java/demo/Main${index}.java`,
    sourceSet: "main",
    reasons: ["IMPLEMENTATION"],
    score: 500 - index,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "IMPLEMENTATION", sourceTarget: `A1->main:${index}` }]
  }));
  const files = [anchor, ...deferredTests, ...main];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3, testReadMode: "defer" }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F6", "F7"]);
});

test("legacy tail protection does not promote application service suffixes without direct evidence", () => {
  const anchor = candidate({ absolutePath: "/repo/modules/orders/src/main/java/demo/OrderRepository.java", path: "modules/orders/src/main/java/demo/OrderRepository.java", module: "orders", sourceSet: "main", reasons: ["target"], score: 1_000 });
  const nameOnlyService = candidate({
    absolutePath: "/repo/modules/orders/src/main/java/demo/application/service/OrderCommandService.java",
    path: "modules/orders/src/main/java/demo/application/service/OrderCommandService.java",
    module: "orders",
    sourceSet: "main",
    reasons: ["rg:java", "taskContext:taskKeyword"],
    verifiedBy: ["rg", "TASK_KEYWORD"],
    score: 200
  });
  const options = optionsFor(anchor, { profile: "repository", focusModules: ["orders"] });

  assert.equal(protectedReadPlanPaths([anchor, nameOnlyService], new Set(), options).has(nameOnlyService.absolutePath), false);
});

test("token-aware read plan retains every readable anchor in a multi-anchor request", async () => {
  const first = candidate({ absolutePath: "/repo/src/main/java/demo/First.java", path: "src/main/java/demo/First.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const second = candidate({ absolutePath: "/repo/src/main/java/demo/Second.java", path: "src/main/java/demo/Second.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const context = candidate({ absolutePath: "/repo/src/main/java/demo/Context.java", path: "src/main/java/demo/Context.java", reasons: ["SPRING_CALL_PATH"], score: 900 });
  const files = [first, second, context];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: { ...optionsFor(first), anchors: [{ file: first.absolutePath, line: 1, column: 1 }, { file: second.absolutePath, line: 1, column: 1 }] },
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.slice(0, 2).map(item => item.fileId), ["F1", "F2"]);
});

test("anchors remain mandatory when their distinct files exceed the configured file budget", async () => {
  const anchors = Array.from({ length: 5 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Anchor${index}.java`,
    path: `src/main/java/demo/Anchor${index}.java`,
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  }));
  const result = await buildReadPlan({
    files: anchors,
    ids: new Map(anchors.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: {
      ...optionsFor(anchors[0]!, { mode: "minimal" }),
      anchors: anchors.map(file => ({ file: file.absolutePath, line: 1, column: 1 }))
    },
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2", "F3", "F4", "F5"]);
  assert.equal(result.budgetExceededByAnchor, true);
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Anchor files exceeded")));
});

test("two anchors remain mandatory when readPlanMaxItems is one", async () => {
  const anchors = [0, 1].map(index => candidate({
    absolutePath: `/repo/src/main/java/demo/Anchor${index}.java`,
    path: `src/main/java/demo/Anchor${index}.java`,
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  }));
  const result = await buildReadPlan({
    files: anchors,
    ids: new Map(anchors.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: {
      ...optionsFor(anchors[0]!, { mode: "minimal", readPlanMaxItems: 1 }),
      anchors: anchors.map(file => ({ file: file.absolutePath, line: 1, column: 1 }))
    },
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
  assert.equal(result.maxFiles, 1, "diagnostics retain the configured limit while flagging the anchor exception");
  assert.equal(result.budgetExceededByAnchor, true);
});

test("an unreadable non-anchor range cannot consume a read-plan file slot", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const unreadableCore = candidate({ absolutePath: "/repo/src/main/java/demo/Missing.java", path: "src/main/java/demo/Missing.java", reasons: ["SPRING_CALL_PATH"], score: 950 });
  const readableCore = candidate({ absolutePath: "/repo/src/main/java/demo/Repository.java", path: "src/main/java/demo/Repository.java", reasons: ["SPRING_INJECTION"], score: 900 });
  const files = [anchor, unreadableCore, readableCore];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        return requests.map(request => ({
          file: request.file,
          ranges: request.file.endsWith("Missing.java") ? [] : [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }]
        }));
      }
    } as never
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"]);
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Missing.java") && gap.includes("unavailable")));
});

test("marginal selection recomputes overlap after each selected file", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const first = candidate({
    absolutePath: "/repo/src/main/java/demo/First.java",
    path: "src/main/java/demo/First.java",
    reasons: ["REFERENCE"],
    categories: ["framework"],
    score: 800,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: "A1->reference" }]
  });
  const duplicate = candidate({
    absolutePath: "/repo/src/main/java/demo/Duplicate.java",
    path: "src/main/java/demo/Duplicate.java",
    reasons: ["REFERENCE"],
    categories: ["framework"],
    score: 799,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: "A1->reference" }]
  });
  const distinct = candidate({
    absolutePath: "/repo/src/main/java/demo/Distinct.java",
    path: "src/main/java/demo/Distinct.java",
    reasons: ["REFERENCE"],
    categories: ["framework"],
    score: 790,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: "A1->different-reference" }]
  });
  const files = [anchor, first, duplicate, distinct];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2", "F4"]);
});

test("marginal selection is ordered by absolute utility, not utility/byte ratio, when only one of two mutually exclusive candidates fits", async () => {
  // Same regression as the protected-core case above, for the generic
  // (non-core) marginal-utility loop: marginalUtility() already subtracts a
  // modest log-scaled byte penalty, so dividing by raw bytes again on top of
  // that let a cheap, low-utility candidate starve a large, high-utility one
  // whenever they could not both fit, even with ample budget headroom.
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const highValue = candidate({ absolutePath: "/repo/src/main/java/demo/BigCollaborator.java", path: "src/main/java/demo/BigCollaborator.java", reasons: ["framework:repository"], categories: ["framework"], score: 500 });
  const cheapLowValue = candidate({ absolutePath: "/repo/src/main/java/demo/TinyCollaborator.java", path: "src/main/java/demo/TinyCollaborator.java", reasons: ["framework:repository"], categories: ["framework"], score: 50 });
  const files = [anchor, highValue, cheapLowValue];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 3, readPlanMaxBytes: 6_100 }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        return requests.map(request => ({
          file: request.file,
          ranges: [{
            startLine: 1,
            endLine: 4,
            kind: "method" as const,
            estimatedBytes: request.file.includes("Anchor") ? 100 : request.file.includes("Big") ? 6_000 : 200
          }]
        }));
      }
    } as never
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"], "the high-utility collaborator must win the shared byte budget over the cheaper, lower-value one");
});

test("same evidence kind with a different source-target remains independently useful", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const first = candidate({
    absolutePath: "/repo/src/main/java/demo/First.java",
    path: "src/main/java/demo/First.java",
    reasons: ["SPRING_RESPONSE_TYPE"],
    categories: ["framework"],
    score: 800,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_RESPONSE_TYPE", sourceTarget: "A1->type:First" }]
  });
  const distinctTarget = candidate({
    absolutePath: "/repo/src/main/java/demo/Second.java",
    path: "src/main/java/demo/Second.java",
    reasons: ["SPRING_RESPONSE_TYPE"],
    categories: ["framework"],
    score: 799,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_RESPONSE_TYPE", sourceTarget: "A1->type:Second" }]
  });
  const lowerScoreDifferentKind = candidate({
    absolutePath: "/repo/src/main/java/demo/Third.java",
    path: "src/main/java/demo/Third.java",
    reasons: ["SPRING_REQUEST_BODY"],
    categories: ["framework"],
    score: 790,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_REQUEST_BODY", sourceTarget: "A1->type:Third" }]
  });
  const files = [anchor, first, distinctTarget, lowerScoreDifferentKind];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2", "F3"]);
});

test("a merged worker range reports every retained source-window reason", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });

  const result = await buildReadPlan({
    files: [anchor],
    ids: new Map([[anchor.absolutePath, "F1"]]),
    options: optionsFor(anchor),
    javaIndex: {
      async queryReadRanges() {
        return [{
          file: anchor.absolutePath,
          ranges: [{
            startLine: 3,
            endLine: 12,
            kind: "method" as const,
            kinds: ["type" as const, "method" as const],
            estimatedBytes: 512
          }]
        }];
      }
    } as never
  });

  assert.match(result.items[0]!.ranges[0]!.reason, /AST method range/);
  assert.match(result.items[0]!.ranges[0]!.reason, /AST owner type header/);
});

test("semanticPolicy required still uses one bounded V6 range batch", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const candidates = Array.from({ length: 30 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Candidate${index}.java`,
    path: `src/main/java/demo/Candidate${index}.java`,
    reasons: ["rg:java"],
    score: 900 - index
  }));
  const files = [anchor, ...candidates];
  let queryCount = 0;
  let querySize = 0;

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { semanticPolicy: "required", readPlanMaxItems: 2 }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        queryCount += 1;
        querySize = requests.length;
        return requests.map(request => ({
          file: request.file,
          ranges: [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }]
        }));
      }
    } as never
  });

  assert.equal(queryCount, 1);
  assert.equal(querySize, 8, "shortlist is capped at maxFiles times four");
  assert.ok(result.items.every(item => item.ranges.length > 0));
});

test("V6 shortlist does not promote a repository filename without protected structural evidence", async () => {
  const anchor = candidate({
    absolutePath: "/repo/modules/report/src/main/java/demo/ReportRepository.java",
    path: "modules/report/src/main/java/demo/ReportRepository.java",
    module: "report",
    sourceSet: "main",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const structuralNameOnly = candidate({
    absolutePath: "/repo/modules/report/src/main/java/demo/mapper/ReportMapper.java",
    path: "modules/report/src/main/java/demo/mapper/ReportMapper.java",
    module: "report",
    sourceSet: "main",
    reasons: ["rg:persistence"],
    categories: ["java"],
    score: 10,
    scoreBreakdown: [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "name-only collaborator" }]
  });
  const ranked = Array.from({ length: 5 }, (_, index) => candidate({
    absolutePath: `/repo/modules/report/src/main/java/demo/Ranked${index}.java`,
    path: `modules/report/src/main/java/demo/Ranked${index}.java`,
    module: "report",
    sourceSet: "main",
    reasons: ["REFERENCE"],
    score: 900 - index
  }));
  let queried: string[] = [];

  await buildReadPlan({
    files: [anchor, ...ranked, structuralNameOnly],
    ids: new Map(),
    options: optionsFor(anchor, {
      mode: "minimal",
      readPlanMaxItems: 1,
      profile: "repository",
      focusModules: ["report"]
    }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        queried = requests.map(request => request.file);
        return requests.map(request => ({
          file: request.file,
          ranges: [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }]
        }));
      }
    } as never
  });

  assert.equal(queried.length, 4);
  assert.equal(queried.includes(structuralNameOnly.absolutePath), false);
});

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
  };
}

function fixedRangeIndex(): Parameters<typeof buildReadPlan>[0]["javaIndex"] {
  return {
    async queryReadRanges(requests: Array<{ file: string }>) {
      return requests.map(request => ({ file: request.file, ranges: [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }] }));
    }
  } as never;
}
