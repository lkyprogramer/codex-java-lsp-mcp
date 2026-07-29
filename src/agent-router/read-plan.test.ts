// input: Router candidates carrying static Java-index evidence.
// output: Protected read-plan paths for direct and persisted implementations.
// pos: Task 22 regression coverage for must-read implementation evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { protectedReadPlanPaths, selectReadPlanFiles } from "./read-plan.js";
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
