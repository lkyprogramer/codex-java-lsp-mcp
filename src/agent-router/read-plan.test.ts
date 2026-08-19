// input: Router candidates carrying static Java-index evidence.
// output: Protected read-plan paths for direct and persisted implementations.
// pos: Task 22 regression coverage for must-read implementation evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { buildReadPlan, protectedReadPlanPaths } from "./read-plan.js";
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

test("protected read plan retains exact structural evidence without turning a generic type reference into core", () => {
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
    implementation.absolutePath,
    directImplementation.absolutePath,
    directMethodType.absolutePath
  ]));
});

test("an indexed direct CALLS edge receives a core slot while an unlocated legacy CALLS edge does not", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderService.java",
    path: "src/main/java/demo/OrderService.java",
    categories: ["target"],
    reasons: ["target"],
    score: 1_000
  });
  const direct = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderClient.java",
    path: "src/main/java/demo/OrderClient.java",
    reasons: ["CALLS"],
    score: 100,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/OrderClient.java`,
      callDepth: 0,
      callOrigin: "anchor"
    }]
  });
  const unknownDepth = candidate({
    absolutePath: "/repo/src/main/java/demo/LegacyCall.java",
    path: "src/main/java/demo/LegacyCall.java",
    reasons: ["CALLS"],
    score: 900,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/LegacyCall.java`
    }]
  });
  const files = [anchor, direct, unknownDepth];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
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
        ranges: [{
          startLine: 1,
          endLine: 10,
          range: { start: { line: 1, column: 1 }, end: { line: 11, column: 1 } },
          kind: "method",
          estimatedBytes: request.file.includes("OrderService") ? 1_500 : 900
        }]
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
  assert.deepEqual(result.selectedCoordinateRangesByPath.get(anchor.absolutePath), [
    { start: { line: 1, column: 1 }, end: { line: 11, column: 1 } }
  ]);
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

test("protected core is ordered by family utility per byte when only one of two candidates fits", async () => {
  // The Task 30 protected-core rule is utility/byte. A small, lower-score
  // collaborator must therefore win when it yields more evidence per byte.
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

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"], "the higher utility-per-byte core candidate must win the shared byte budget");
});

test("protected core uses absolute utility when the file cap binds but bytes do not", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const highValue = candidate({ absolutePath: "/repo/src/main/java/demo/Implementation.java", path: "src/main/java/demo/Implementation.java", reasons: ["SPRING_CALL_PATH"], verifiedBy: ["SPRING_CALL_PATH"], score: 500 });
  const cheapLowValue = candidate({ absolutePath: "/repo/src/main/java/demo/Mapper.java", path: "src/main/java/demo/Mapper.java", reasons: ["SPRING_CALL_PATH"], verifiedBy: ["SPRING_CALL_PATH"], score: 50 });
  const files = [anchor, highValue, cheapLowValue];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 2, readPlanMaxBytes: 20_000 }),
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

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
});

test("Spring injection remains structural and cannot displace resolved JDT core evidence", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const definition = candidate({
    absolutePath: "/repo/src/main/java/demo/ResolvedDefinition.java",
    path: "src/main/java/demo/ResolvedDefinition.java",
    reasons: ["DEFINITION"],
    score: 200,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: "A1->type:ResolvedDefinition" }]
  });
  const injection = candidate({
    absolutePath: "/repo/src/main/java/demo/InjectedService.java",
    path: "src/main/java/demo/InjectedService.java",
    categories: ["framework"],
    reasons: ["SPRING_INJECTION"],
    score: 900
  });
  const files = [anchor, definition, injection];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
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

test("non-protected static evidence does not consume protected core quota", async () => {
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
  const protectedCore = candidate({
    absolutePath: "/repo/src/main/java/demo/ResolvedCollaborator.java",
    path: "src/main/java/demo/ResolvedCollaborator.java",
    reasons: ["SPRING_CALL_PATH"],
    verifiedBy: ["SPRING_CALL_PATH"],
    score: 800
  });
  const files = [anchor, ...lexical, ...structural, protectedCore];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F8", "F2"]);
});

test("a Spring call path from a structural seed does not displace an anchor's direct implementation core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPort.java",
    path: "src/main/java/demo/OrderPort.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const implementation = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPortImpl.java",
    path: "src/main/java/demo/OrderPortImpl.java",
    reasons: ["IMPLEMENTS"],
    score: 400,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: "A1:/repo/src/main/java/demo/OrderPortImpl.java->/repo/src/main/java/demo/OrderPortImpl.java"
    }]
  });
  const nestedSpringCall = candidate({
    absolutePath: "/repo/src/main/java/demo/OtherPort.java",
    path: "src/main/java/demo/OtherPort.java",
    reasons: ["SPRING_CALL_PATH"],
    score: 900,
    plannerEvidence: [{
      family: "FRAMEWORK",
      kind: "SPRING_CALL_PATH",
      sourceTarget: "A1:/repo/src/main/java/demo/OrderPortImpl.java->method:demo.OtherPort.lookup"
    }]
  });
  const files = [anchor, implementation, nestedSpringCall];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
});

test("a resolved shallow call outranks an anchor Spring call path in a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPort.java",
    path: "src/main/java/demo/OrderPort.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const mapper = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderMapper.java",
    path: "src/main/java/demo/OrderMapper.java",
    reasons: ["CALLS"],
    score: 200,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: "A1:/repo/src/main/java/demo/OrderPortImpl.java->/repo/src/main/java/demo/OrderMapper.java",
      callDepth: 1
    }]
  });
  const springPath = candidate({
    absolutePath: "/repo/src/main/java/demo/ExpensiveService.java",
    path: "src/main/java/demo/ExpensiveService.java",
    categories: ["framework"],
    reasons: ["SPRING_CALL_PATH"],
    score: 900,
    plannerEvidence: [{
      family: "FRAMEWORK",
      kind: "SPRING_CALL_PATH",
      sourceTarget: "A1:/repo/src/main/java/demo/OrderPort.java->method:demo.ExpensiveService.run"
    }]
  });
  const files = [anchor, mapper, springPath];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
});

test("direct implementations take the bounded core ahead of higher-scoring second-hop method types", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/StorageGateway.java",
    path: "src/main/java/demo/StorageGateway.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const firstImplementation = candidate({
    absolutePath: "/repo/src/main/java/demo/AliyunStorageGateway.java",
    path: "src/main/java/demo/AliyunStorageGateway.java",
    reasons: ["IMPLEMENTS"],
    score: 100,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTS", sourceTarget: "A1:/repo/StorageGateway.java->/repo/AliyunStorageGateway.java" }]
  });
  const secondImplementation = candidate({
    absolutePath: "/repo/src/main/java/demo/StubStorageGateway.java",
    path: "src/main/java/demo/StubStorageGateway.java",
    reasons: ["IMPLEMENTS"],
    score: 100,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTS", sourceTarget: "A1:/repo/StorageGateway.java->/repo/StubStorageGateway.java" }]
  });
  const command = candidate({
    absolutePath: "/repo/src/main/java/demo/StorageCommand.java",
    path: "src/main/java/demo/StorageCommand.java",
    reasons: ["IMPLEMENTATION_METHOD_TYPE"],
    score: 300,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTATION_METHOD_TYPE", sourceTarget: "A1:/repo/AliyunStorageGateway.java->/repo/StorageCommand.java" }]
  });
  const result = candidate({
    absolutePath: "/repo/src/main/java/demo/StorageResult.java",
    path: "src/main/java/demo/StorageResult.java",
    reasons: ["IMPLEMENTATION_METHOD_TYPE"],
    score: 300,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTATION_METHOD_TYPE", sourceTarget: "A1:/repo/AliyunStorageGateway.java->/repo/StorageResult.java" }]
  });
  const files = [anchor, firstImplementation, secondImplementation, command, result];

  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F2", "F3"],
    "the first-hop concrete implementations are the actionable alternatives for an interface task"
  );
});

test("explicit implementation method types outrank legacy compatibility paths in a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPort.java",
    path: "src/main/java/demo/OrderPort.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const implementation = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPortAdapter.java",
    path: "src/main/java/demo/OrderPortAdapter.java",
    reasons: ["IMPLEMENTS"],
    score: 100,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTS", sourceTarget: "A1:/repo/OrderPort.java->/repo/OrderPortAdapter.java" }]
  });
  const methodType = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderRecord.java",
    path: "src/main/java/demo/OrderRecord.java",
    reasons: ["IMPLEMENTATION_METHOD_TYPE"],
    score: 200,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTATION_METHOD_TYPE", sourceTarget: "A1:/repo/OrderPortAdapter.java->/repo/OrderRecord.java" }]
  });
  const compatibilityOnly = candidate({
    absolutePath: "/repo/src/main/java/demo/ImportedStatus.java",
    path: "src/main/java/demo/ImportedStatus.java",
    reasons: ["DIRECT_DECLARATION"],
    score: 900,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "DIRECT_DECLARATION", sourceTarget: "A1:/repo/OrderPort.java->/repo/ImportedStatus.java" }]
  });
  const files = [anchor, implementation, methodType, compatibilityOnly];

  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set(files.slice(1).map(file => file.absolutePath))
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F2", "F3"],
    "fallback preservation cannot displace parsed implementation evidence"
  );
});

test("a generic anchor reference cannot displace a direct method relation from protected core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const methodRelation = candidate({
    absolutePath: "/repo/src/main/java/demo/MethodCollaborator.java",
    path: "src/main/java/demo/MethodCollaborator.java",
    reasons: ["METHOD_RELATION"],
    score: 200,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "METHOD_RELATION", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/MethodCollaborator.java" }]
  });
  const directReference = candidate({
    absolutePath: "/repo/src/main/java/demo/DirectReference.java",
    path: "src/main/java/demo/DirectReference.java",
    reasons: ["REFERENCE"],
    score: 900,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "REFERENCE", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/DirectReference.java" }]
  });
  const files = [anchor, methodRelation, directReference];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 2, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set([methodRelation.absolutePath])
  });

  assert.deepEqual(plan.items.map(item => item.fileId), ["F1", "F2"]);
});

test("a shallow resolved CALLS path outranks a deeper call when the protected core is constrained", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const shallowCall = candidate({
    absolutePath: "/repo/src/main/java/demo/ResponseAssembler.java",
    path: "src/main/java/demo/ResponseAssembler.java",
    reasons: ["CALLS"],
    score: 200,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "CALLS", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/ResponseAssembler.java", callDepth: 1 }]
  });
  const nestedCall = candidate({
    absolutePath: "/repo/src/main/java/demo/ApplicationService.java",
    path: "src/main/java/demo/ApplicationService.java",
    reasons: ["CALLS"],
    score: 900,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "CALLS", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/ApplicationService.java", callDepth: 2 }]
  });
  const files = [anchor, shallowCall, nestedCall];

  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set(files.slice(1).map(file => file.absolutePath))
  });

  assert.deepEqual(plan.items.map(item => item.fileId), ["F1", "F2"]);
});

test("a direct anchor CALLS receiver outranks an unrelated implementation expansion in a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderController.java",
    path: "src/main/java/demo/OrderController.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const directReceiver = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderQueryPort.java",
    path: "src/main/java/demo/OrderQueryPort.java",
    reasons: ["CALLS"],
    score: 120,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/OrderQueryPort.java`,
      callDepth: 1,
      callOrigin: "anchor"
    }]
  });
  const unrelatedImplementation = candidate({
    absolutePath: "/repo/src/main/java/demo/OtherQueryServiceImpl.java",
    path: "src/main/java/demo/OtherQueryServiceImpl.java",
    reasons: ["typeGraph:implementation-lookup"],
    score: 900,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/OtherQueryServiceImpl.java`
    }]
  });
  const files = [anchor, directReceiver, unrelatedImplementation];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F2"],
    "the exact receiver called by the anchor must survive before unrelated type-graph expansion"
  );
});

test("an implementer of a called port outranks a sibling CALLS receiver in a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/ExportController.java",
    path: "src/main/java/demo/ExportController.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const calledPort = candidate({
    absolutePath: "/repo/src/main/java/demo/ExportGenerator.java",
    path: "src/main/java/demo/ExportGenerator.java",
    reasons: ["CALLS"],
    score: 400,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/ExportGenerator.java`,
      callDepth: 0,
      callOrigin: "anchor"
    }]
  });
  const implementer = candidate({
    absolutePath: "/repo/src/main/java/demo/ExcelExportGenerator.java",
    path: "src/main/java/demo/ExcelExportGenerator.java",
    reasons: ["typeGraph:implementation-lookup"],
    score: 120,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: "A1:/repo/src/main/java/demo/ExcelExportGenerator.java->/repo/src/main/java/demo/ExportGenerator.java"
    }]
  });
  const siblingPort = candidate({
    absolutePath: "/repo/src/main/java/demo/SubjectRepository.java",
    path: "src/main/java/demo/SubjectRepository.java",
    reasons: ["CALLS"],
    score: 380,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/SubjectRepository.java`,
      callDepth: 0,
      callOrigin: "anchor"
    }]
  });
  const files = [anchor, calledPort, implementer, siblingPort];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F3", "F2"],
    "the implementer of a port the anchor already called must close that hop before another port"
  );
});

test("a first-hop implementer outranks a same-priority method-parameter DTO in a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/CheckController.java",
    path: "src/main/java/demo/CheckController.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const dto = candidate({
    absolutePath: "/repo/src/main/java/demo/ExaminationCheckPeopleDTO.java",
    path: "src/main/java/demo/ExaminationCheckPeopleDTO.java",
    reasons: ["METHOD_RELATION"],
    score: 400,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "METHOD_RELATION",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/ExaminationCheckPeopleDTO.java`
    }]
  });
  const implementer = candidate({
    absolutePath: "/repo/src/main/java/demo/ManageCurrentUserServiceImpl.java",
    path: "src/main/java/demo/ManageCurrentUserServiceImpl.java",
    reasons: ["typeGraph:implementation-lookup"],
    score: 120,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/ManageCurrentUserServiceImpl.java`
    }]
  });
  const files = [anchor, dto, implementer];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F3"],
    "the called service implementer must survive before a request DTO"
  );
});

test("a response-wrapper CALLS envelope does not evict a first-hop implementer from a constrained core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/CheckController.java",
    path: "src/main/java/demo/CheckController.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const wrapper = candidate({
    absolutePath: "/repo/src/main/java/demo/CommonResult.java",
    path: "src/main/java/demo/CommonResult.java",
    reasons: ["CALLS"],
    score: 400,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "CALLS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/CommonResult.java`,
      callDepth: 0,
      callOrigin: "anchor"
    }]
  });
  const implementer = candidate({
    absolutePath: "/repo/src/main/java/demo/ManageCurrentUserServiceImpl.java",
    path: "src/main/java/demo/ManageCurrentUserServiceImpl.java",
    reasons: ["typeGraph:implementation-lookup"],
    score: 120,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/ManageCurrentUserServiceImpl.java`
    }]
  });
  const files = [anchor, wrapper, implementer];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F3"],
    "CommonResult.success must not consume the last core slot ahead of the implementer"
  );
});

test("a Boot application takes the leftover framework slot instead of a lexical sibling", async () => {
  const anchor = candidate({
    absolutePath: "/repo/exam-management/src/main/java/demo/CheckController.java",
    path: "exam-management/src/main/java/demo/CheckController.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const implementer = candidate({
    absolutePath: "/repo/exam-service/src/main/java/demo/ManageCurrentUserServiceImpl.java",
    path: "exam-service/src/main/java/demo/ManageCurrentUserServiceImpl.java",
    reasons: ["typeGraph:implementation-lookup"],
    score: 120,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/exam-service/src/main/java/demo/ManageCurrentUserServiceImpl.java`
    }]
  });
  const application = candidate({
    absolutePath: "/repo/exam-management/src/main/java/demo/ExamManagementApplication.java",
    path: "exam-management/src/main/java/demo/ExamManagementApplication.java",
    categories: ["framework"],
    reasons: ["SPRING_BOOT_APPLICATION"],
    score: 90,
    plannerEvidence: [{
      family: "FRAMEWORK",
      kind: "SPRING_BOOT_APPLICATION",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/exam-management/src/main/java/demo/ExamManagementApplication.java`
    }]
  });
  const lexical = candidate({
    absolutePath: "/repo/exam-management/src/main/java/demo/DictionaryTreeController.java",
    path: "exam-management/src/main/java/demo/DictionaryTreeController.java",
    reasons: ["REFERENCE"],
    score: 55
  });
  const files = [anchor, implementer, application, lexical];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    plan.items.map(item => item.fileId),
    ["F1", "F2", "F3"],
    "the Boot application must occupy the leftover slot ahead of a same-module lexical controller"
  );
});

test("a concrete anchor's declared interface contract outranks downstream implementation context", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/CloudSmsGateway.java",
    path: "src/main/java/demo/CloudSmsGateway.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const contract = candidate({
    absolutePath: "/repo/src/main/java/demo/SmsGateway.java",
    path: "src/main/java/demo/SmsGateway.java",
    reasons: ["TYPE_SYMMETRIC"],
    score: 100,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "TYPE_SYMMETRIC",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/SmsGateway.java`
    }]
  });
  const downstream = candidate({
    absolutePath: "/repo/src/main/java/demo/DefaultSmsClientFactory.java",
    path: "src/main/java/demo/DefaultSmsClientFactory.java",
    reasons: ["IMPLEMENTS"],
    score: 900,
    plannerEvidence: [{
      family: "STATIC_STRUCTURE",
      kind: "IMPLEMENTS",
      sourceTarget: `A1:${anchor.absolutePath}->/repo/src/main/java/demo/DefaultSmsClientFactory.java`
    }]
  });
  const files = [anchor, contract, downstream];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(plan.items.map(item => item.fileId), ["F1", "F2"]);
});

test("an exact anchor method relation outranks a lower-value import in protected core", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const methodRelation = candidate({
    absolutePath: "/repo/src/main/java/demo/MethodCollaborator.java",
    path: "src/main/java/demo/MethodCollaborator.java",
    reasons: ["METHOD_RELATION"],
    score: 200,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "METHOD_RELATION", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/MethodCollaborator.java" }]
  });
  const lowerImport = candidate({
    absolutePath: "/repo/src/main/java/demo/LowerImport.java",
    path: "src/main/java/demo/LowerImport.java",
    reasons: ["DIRECT_DECLARATION"],
    score: 100,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "DIRECT_DECLARATION", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->/repo/src/main/java/demo/LowerImport.java" }]
  });
  const files = [anchor, methodRelation, lowerImport];
  const plan = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set(files.slice(1).map(file => file.absolutePath))
  });

  assert.deepEqual(plan.items.map(item => item.fileId), ["F1", "F2"]);
});

test("only method-level dependencies of a resolved implementation receive protected core slots", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderPort.java",
    path: "src/main/java/demo/OrderPort.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const mapper = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderMapper.java",
    path: "src/main/java/demo/OrderMapper.java",
    reasons: ["implementationField"],
    score: 80,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "FIELD_TYPE", sourceTarget: "A1:/repo/src/main/java/demo/OrderPortImpl.java->/repo/src/main/java/demo/OrderMapper.java" }]
  });
  const entity = candidate({
    absolutePath: "/repo/src/main/java/demo/OrderEntity.java",
    path: "src/main/java/demo/OrderEntity.java",
    reasons: ["implementationMethodType"],
    score: 70,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTATION_METHOD_TYPE", sourceTarget: "A1:/repo/src/main/java/demo/OrderPortImpl.java->/repo/src/main/java/demo/OrderEntity.java" }]
  });
  const highScoringContext = candidate({
    absolutePath: "/repo/src/main/java/demo/UnrelatedContext.java",
    path: "src/main/java/demo/UnrelatedContext.java",
    reasons: ["SPRING_RESPONSE_TYPE"],
    categories: ["framework"],
    score: 900,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_RESPONSE_TYPE", sourceTarget: "A1:/repo/src/main/java/demo/OrderPort.java->/repo/src/main/java/demo/UnrelatedContext.java" }]
  });
  const files = [anchor, mapper, entity, highScoringContext];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 3 }),
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(
    result.items.map(item => item.fileId),
    ["F1", "F3", "F4"],
    "a field-type collaborator remains useful evidence but cannot displace a direct implementation or framework context from the bounded core"
  );
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

test("missing buckets release capacity after bounded baseline-safe core slots", async () => {
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
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 8, readPlanMaxBytes: 10_000 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set(baselineSafe.map(file => file.absolutePath))
  });

  for (const file of baselineSafe) {
    const fileId = `F${files.indexOf(file) + 1}`;
    assert.ok(result.items.some(item => item.fileId === fileId), `${file.path} must retain its seed safe slot`);
  }
  assert.equal(result.items.length, 8, "missing buckets must release their capacity to useful remaining candidates");
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

test("deferred tests stay in candidate output but never consume a V6 read-plan slot", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const deferredTest = candidate({
    absolutePath: "/repo/src/test/java/demo/HighScoreTest.java",
    path: "src/test/java/demo/HighScoreTest.java",
    sourceSet: "test",
    reasons: ["rg:tests"],
    score: 900
  });
  const mainContext = candidate({
    absolutePath: "/repo/src/main/java/demo/MainContext.java",
    path: "src/main/java/demo/MainContext.java",
    sourceSet: "main",
    reasons: ["rg:java"],
    score: 100
  });
  const files = [anchor, deferredTest, mainContext];
  const requestedPaths: string[] = [];
  const index = fixedRangeIndex();
  index.queryReadRanges = async (requests: Array<{ file: string }>) => {
    requestedPaths.push(...requests.map(request => request.file));
    return requests.map(request => ({
      file: request.file,
      ranges: [{
        startLine: 1,
        endLine: 4,
        range: { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } },
        kind: "method" as const,
        estimatedBytes: 256
      }]
    }));
  };

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, testReadMode: "defer" }),
    javaIndex: index
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"]);
  assert.ok(requestedPaths.includes(deferredTest.absolutePath), "deferred tests remain in discovery so they cannot reshape the main-source shortlist");
});

test("externally protected deferred tests cannot displace an exact main-source core file", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const deferredTest = candidate({
    absolutePath: "/repo/src/test/java/demo/AnchorTest.java",
    path: "src/test/java/demo/AnchorTest.java",
    sourceSet: "test",
    reasons: ["IMPLEMENTATION"],
    score: 900,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "IMPLEMENTATION", sourceTarget: "A1->test" }]
  });
  const mainImplementation = candidate({
    absolutePath: "/repo/src/main/java/demo/AnchorImplementation.java",
    path: "src/main/java/demo/AnchorImplementation.java",
    sourceSet: "main",
    reasons: ["IMPLEMENTATION"],
    score: 400,
    plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "IMPLEMENTATION", sourceTarget: "A1->main" }]
  });
  const files = [anchor, deferredTest, mainImplementation];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, testReadMode: "defer" }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set([deferredTest.absolutePath])
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"]);
});

test("deferred externally protected tests cannot exhaust the bounded range shortlist", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const deferredTests = Array.from({ length: 8 }, (_, index) => candidate({
    absolutePath: `/repo/src/test/java/demo/Anchor${index}Test.java`,
    path: `src/test/java/demo/Anchor${index}Test.java`,
    sourceSet: "test",
    reasons: ["CALLS"],
    score: 900 - index,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "CALLS", sourceTarget: `A1->test:${index}`, callDepth: 0 }]
  }));
  const mainContext = candidate({
    absolutePath: "/repo/src/main/java/demo/MainContext.java",
    path: "src/main/java/demo/MainContext.java",
    sourceSet: "main",
    reasons: ["rg:java"],
    score: 10
  });
  const files = [anchor, ...deferredTests, mainContext];
  const requestedPaths: string[] = [];
  const index = fixedRangeIndex();
  index.queryReadRanges = async (requests: Array<{ file: string }>) => {
    requestedPaths.push(...requests.map(request => request.file));
    return requests.map(request => ({
      file: request.file,
      ranges: [{
        startLine: 1,
        endLine: 4,
        range: { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } },
        kind: "method" as const,
        estimatedBytes: 256
      }]
    }));
  };

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2, testReadMode: "defer" }),
    javaIndex: index,
    protectedPaths: new Set(deferredTests.map(file => file.absolutePath))
  });

  assert.ok(requestedPaths.includes(mainContext.absolutePath));
  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F10"]);
});

test("parsed second-hop implementation evidence outranks a compatibility-only direct declaration", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const directDeclaration = candidate({
    absolutePath: "/repo/src/main/java/demo/Request.java",
    path: "src/main/java/demo/Request.java",
    reasons: ["DIRECT_DECLARATION"],
    score: 300,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "DIRECT_DECLARATION", sourceTarget: "A1:/repo/src/main/java/demo/Anchor.java->Request" }]
  });
  const implementation = candidate({
    absolutePath: "/repo/src/main/java/demo/AnchorImplementation.java",
    path: "src/main/java/demo/AnchorImplementation.java",
    reasons: ["IMPLEMENTS"],
    score: 200,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTS", sourceTarget: "A1:/repo/src/main/java/demo/AnchorImplementation.java->Anchor" }]
  });
  const secondHop = candidate({
    absolutePath: "/repo/src/main/java/demo/Result.java",
    path: "src/main/java/demo/Result.java",
    reasons: ["IMPLEMENTATION_METHOD_TYPE"],
    score: 900,
    plannerEvidence: [{ family: "STATIC_STRUCTURE", kind: "IMPLEMENTATION_METHOD_TYPE", sourceTarget: "A1:/repo/src/main/java/demo/AnchorImplementation.java->Result" }]
  });
  const files = [anchor, directDeclaration, implementation, secondHop];

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 2 }),
    javaIndex: fixedRangeIndex(),
    protectedPaths: new Set([directDeclaration.absolutePath])
  });

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"]);
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

test("multi-anchor protected core reserves coverage for a lower-scored second-anchor candidate", async () => {
  const first = candidate({ absolutePath: "/repo/src/main/java/demo/First.java", path: "src/main/java/demo/First.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const second = candidate({ absolutePath: "/repo/src/main/java/demo/Second.java", path: "src/main/java/demo/Second.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const firstHigh = candidate({ absolutePath: "/repo/src/main/java/demo/FirstHigh.java", path: "src/main/java/demo/FirstHigh.java", score: 900, plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A1:${first.absolutePath}->first-high` }] });
  const firstOther = candidate({ absolutePath: "/repo/src/main/java/demo/FirstOther.java", path: "src/main/java/demo/FirstOther.java", score: 800, plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A1:${first.absolutePath}->first-other` }] });
  const secondOnly = candidate({ absolutePath: "/repo/src/main/java/demo/SecondOnly.java", path: "src/main/java/demo/SecondOnly.java", score: 100, plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A2:${second.absolutePath}->second-only` }] });
  const files = [first, second, firstHigh, firstOther, secondOnly];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: { ...optionsFor(first, { mode: "minimal", readPlanMaxItems: 4 }), anchors: [{ file: first.absolutePath, line: 1, column: 1 }, { file: second.absolutePath, line: 1, column: 1 }] },
    javaIndex: fixedRangeIndex()
  });

  assert.ok(result.selectedPaths.includes(secondOnly.absolutePath));
  assert.equal(result.selectedPaths.filter(path => path === firstHigh.absolutePath || path === firstOther.absolutePath).length, 1);
});

test("one shared protected candidate can cover both anchors in one core slot", async () => {
  const first = candidate({ absolutePath: "/repo/src/main/java/demo/First.java", path: "src/main/java/demo/First.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const second = candidate({ absolutePath: "/repo/src/main/java/demo/Second.java", path: "src/main/java/demo/Second.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const firstOnly = candidate({ absolutePath: "/repo/src/main/java/demo/FirstOnly.java", path: "src/main/java/demo/FirstOnly.java", score: 900, plannerEvidence: [{ family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A1:${first.absolutePath}->first-only` }] });
  const shared = candidate({
    absolutePath: "/repo/src/main/java/demo/Shared.java",
    path: "src/main/java/demo/Shared.java",
    score: 100,
    plannerEvidence: [
      { family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A1:${first.absolutePath}->shared` },
      { family: "EXACT_SEMANTIC", kind: "DEFINITION", sourceTarget: `A2:${second.absolutePath}->shared` }
    ]
  });
  const files = [first, second, firstOnly, shared];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: { ...optionsFor(first, { mode: "minimal", readPlanMaxItems: 3 }), anchors: [{ file: first.absolutePath, line: 1, column: 1 }, { file: second.absolutePath, line: 1, column: 1 }] },
    javaIndex: fixedRangeIndex()
  });

  assert.deepEqual(result.selectedPaths, [first.absolutePath, second.absolutePath, shared.absolutePath]);
});

test("swapping multi-anchor input order keeps the protected read-plan stable", async () => {
  const first = candidate({ absolutePath: "/repo/src/main/java/demo/First.java", path: "src/main/java/demo/First.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const second = candidate({ absolutePath: "/repo/src/main/java/demo/Second.java", path: "src/main/java/demo/Second.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const firstCorePath = "/repo/src/main/java/demo/FirstCore.java";
  const secondCorePath = "/repo/src/main/java/demo/SecondCore.java";
  const run = async (anchors: readonly CandidateFile[]) => {
    const core = anchors.map((anchorFile, index) => candidate({
      absolutePath: anchorFile.absolutePath === first.absolutePath ? firstCorePath : secondCorePath,
      path: anchorFile.absolutePath === first.absolutePath ? "src/main/java/demo/FirstCore.java" : "src/main/java/demo/SecondCore.java",
      score: anchorFile.absolutePath === first.absolutePath ? 900 : 100,
      plannerEvidence: [{
        family: "EXACT_SEMANTIC",
        kind: "DEFINITION",
        sourceTarget: `A${index + 1}:${anchorFile.absolutePath}->${anchorFile.absolutePath === first.absolutePath ? firstCorePath : secondCorePath}`
      }]
    }));
    const files = [first, second, ...core];
    return buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: {
        ...optionsFor(first, { mode: "minimal", readPlanMaxItems: 4 }),
        anchors: anchors.map(file => ({ file: file.absolutePath, line: 1, column: 1 }))
      },
      javaIndex: fixedRangeIndex()
    });
  };

  const forward = await run([first, second]);
  const reversed = await run([second, first]);

  assert.deepEqual(forward.selectedPaths, reversed.selectedPaths);
  assert.deepEqual(forward.evidenceGaps, reversed.evidenceGaps);
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

test("marginal selection is ordered by utility per byte when only one of two candidates fits", async () => {
  // The Task 30 marginal pass uses the same utility-per-byte policy as the
  // protected core, after recomputing diversity and overlap.
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

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F3"], "the higher utility-per-byte collaborator must win the shared byte budget");
});

test("marginal selection uses absolute utility when the file cap binds but bytes do not", async () => {
  const anchor = candidate({ absolutePath: "/repo/src/main/java/demo/Anchor.java", path: "src/main/java/demo/Anchor.java", reasons: ["target"], categories: ["target"], score: 1_000 });
  const highValue = candidate({ absolutePath: "/repo/src/main/java/demo/BigCollaborator.java", path: "src/main/java/demo/BigCollaborator.java", reasons: ["framework:repository"], categories: ["framework"], score: 500 });
  const cheapLowValue = candidate({ absolutePath: "/repo/src/main/java/demo/TinyCollaborator.java", path: "src/main/java/demo/TinyCollaborator.java", reasons: ["framework:repository"], categories: ["framework"], score: 50 });
  const files = [anchor, highValue, cheapLowValue];
  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "balanced", readPlanMaxItems: 2, readPlanMaxBytes: 20_000 }),
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

  assert.deepEqual(result.items.map(item => item.fileId), ["F1", "F2"]);
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

  assert.match(result.items[0]!.ranges[0]!.reason!, /AST method range/);
  assert.match(result.items[0]!.ranges[0]!.reason!, /AST owner type header/);
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

test("protected candidates omitted by the bounded shortlist produce an evidence gap", async () => {
  const anchor = candidate({
    absolutePath: "/repo/src/main/java/demo/Anchor.java",
    path: "src/main/java/demo/Anchor.java",
    reasons: ["target"],
    categories: ["target"],
    score: 1_000
  });
  const core = Array.from({ length: 6 }, (_, index) => candidate({
    absolutePath: `/repo/src/main/java/demo/Call${index}.java`,
    path: `src/main/java/demo/Call${index}.java`,
    reasons: ["SPRING_CALL_PATH"],
    verifiedBy: ["SPRING_CALL_PATH"],
    score: 900 - index,
    plannerEvidence: [{ family: "FRAMEWORK", kind: "SPRING_CALL_PATH", sourceTarget: `A1:${anchor.absolutePath}->call:${index}` }]
  }));
  const files = [anchor, ...core];
  let querySize = 0;

  const result = await buildReadPlan({
    files,
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options: optionsFor(anchor, { mode: "minimal", readPlanMaxItems: 1 }),
    javaIndex: {
      async queryReadRanges(requests: Array<{ file: string }>) {
        querySize = requests.length;
        return requests.map(request => ({
          file: request.file,
          ranges: [{ startLine: 1, endLine: 4, kind: "method" as const, estimatedBytes: 256 }]
        }));
      }
    } as never
  });

  assert.equal(querySize, 4, "the worker range batch remains capped at maxFiles times four");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("shortlist capacity")));
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
