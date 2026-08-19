import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ImpactResultV6 } from "../../agent-types.js";
import { projectImpactResultV6 } from "../format.js";
import { withConvergedCostV6 } from "../output-v6.js";
import { buildReadPlan } from "../read-plan.js";
import { requiredGroupsFromScenario } from "../../benchmark/golden-required-groups.js";
import type { Scenario } from "../../benchmark/golden-scenario.js";
import { buildFrontier, FRONTIER_MAX_PER_RELATION } from "./frontier-builder.js";
import { frontierOracleCoverage } from "./frontier-oracle.js";
import { buildReadUnits } from "./read-unit-builder.js";
import { retrievalBudgetFor, type MaterializedReadWindow, type ReadUnit } from "./retrieval-types.js";

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

function windowFor(file: CandidateFile, kind = "method"): MaterializedReadWindow {
  const ranges = [{
    startLine: 1,
    endLine: 10,
    reason: kind === "method" ? "AST method range" : "AST owner type header",
    estimatedBytes: 80 + Math.max(0, file.score)
  }];
  return {
    file,
    ranges,
    coordinateRanges: [{ start: { line: 1, column: 1 }, end: { line: 11, column: 1 } }],
    bytes: ranges[0]!.estimatedBytes,
    extremeMethod: false,
    rangeKinds: [kind]
  };
}

function unitsFor(files: CandidateFile[]): ReadUnit[] {
  return buildReadUnits({
    windows: files.map(file => windowFor(file)),
    ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
    options,
    priorityOf: file => file.reasons.includes("target") ? "P0" : "P1"
  });
}

function fileAt(relative: string, reasons: string[], score: number, extra: Partial<CandidateFile> = {}): CandidateFile {
  return candidate({
    absolutePath: `/repo/${relative}`,
    path: relative,
    reasons,
    categories: reasons.includes("target") ? ["target"] : ["semantic"],
    score,
    plannerEvidence: reasons.filter(reason => reason !== "target").map(kind => ({
      family: kind === "CALLS" ? "CALLS" : kind === "IMPLEMENTS" ? "STATIC_STRUCTURE" : "OTHER",
      kind,
      sourceTarget: kind
    })),
    ...extra
  });
}

test("frontier keeps first-plan identity and uses relative paths only", async () => {
  const previous = process.env.JAVA_LSP_FRONTIER_SHADOW;
  const files = [
    candidate({ reasons: ["target"], score: 1000 }),
    fileAt("src/main/java/demo/OrderServiceImpl.java", ["IMPLEMENTS"], 200),
    fileAt("src/main/java/demo/OrderHelper.java", ["CALLS"], 180),
    fileAt("src/main/java/demo/OrderRepo.java", ["CALLS"], 170)
  ];
  const javaIndex = {
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
  } as never;
  try {
    process.env.JAVA_LSP_FRONTIER_SHADOW = "off";
    const off = await buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: { ...options, mode: "minimal", readPlanMaxItems: 2 },
      javaIndex
    });
    process.env.JAVA_LSP_FRONTIER_SHADOW = "shadow";
    const on = await buildReadPlan({
      files,
      ids: new Map(files.map((file, index) => [file.absolutePath, `F${index + 1}`])),
      options: { ...options, mode: "minimal", readPlanMaxItems: 2 },
      javaIndex
    });
    assert.deepEqual(on.selectedPaths, off.selectedPaths);
    assert.deepEqual(on.items.map(item => item.fileId), off.items.map(item => item.fileId));
    assert.equal(off.frontierShadow, undefined);
    assert.equal(on.frontierShadow?.stopReason, "FRONTIER_AVAILABLE");
    assert.ok((on.frontierShadow?.items.length ?? 0) >= 1);
    assert.equal(on.frontierShadow?.items.some(item => item.path.startsWith("/")), false);
    assert.equal(JSON.stringify(on.frontierShadow).includes("/repo/"), false);
    assert.equal(on.frontierShadow?.items.some(item => on.selectedPaths.some(path => path.endsWith(item.path))), false);
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_FRONTIER_SHADOW;
    else process.env.JAVA_LSP_FRONTIER_SHADOW = previous;
  }
});

test("frontier is not a dropped top-K copy and spans more than one relation", () => {
  const selected = [fileAt("src/main/java/demo/Anchor.java", ["target"], 1000)];
  const calls = [1, 2, 3, 4, 5, 6].map(index => fileAt(`src/main/java/demo/Call${index}.java`, ["CALLS"], 900 - index));
  const impl = fileAt("src/main/java/demo/PortImpl.java", ["IMPLEMENTS"], 40);
  const xml = fileAt("src/main/java/demo/Mapper.xml", ["MYBATIS_STATEMENT_METHOD"], 30, {
    categories: ["persistence"],
    path: "src/main/resources/demo/Mapper.xml",
    absolutePath: "/repo/src/main/resources/demo/Mapper.xml"
  });
  const units = unitsFor([...selected, ...calls, impl, xml]);
  const frontier = buildFrontier(units, [selected[0]!.absolutePath], retrievalBudgetFor("balanced", { maxFiles: 6, maxReadBytes: 14 * 1024 }));
  const topK = [...calls, impl, xml]
    .sort((left, right) => right.score - left.score)
    .slice(0, frontier.items.length)
    .map(file => file.path);
  assert.ok(frontier.coverage.distinctRelations >= 2);
  assert.notDeepEqual(frontier.items.map(item => item.path), topK);
  assert.ok(frontier.items.filter(item => item.relation === "SECOND_HOP_EXACT").length <= FRONTIER_MAX_PER_RELATION);
  assert.ok(frontier.items.some(item => item.relation === "CLOSED_PORT_IMPLEMENTATION"));
  assert.equal("expectedGain" in (frontier.items[0] ?? {}), false);
});

test("frontier byte cap is hard and reverse-caller stays design-only", () => {
  const selected = fileAt("src/main/java/demo/Anchor.java", ["target"], 100);
  const extra = fileAt("src/main/java/demo/Helper.java", ["CALLS"], 80);
  const reverse = fileAt("src/main/java/demo/Caller.java", ["CALLS"], 70);
  const units = unitsFor([selected, extra, reverse]).map((unit, index) => index === 2
    ? { ...unit, relationClass: "REVERSE_CALLER_QUERY" as const, hop: "reverse" as const }
    : unit);
  const budget = retrievalBudgetFor("minimal", { maxFiles: 4, maxReadBytes: 6 * 1024 });
  budget.frontierMaxItems = 8;
  budget.frontierMaxBytes = 50;
  const frontier = buildFrontier(units, [selected.absolutePath], budget);
  assert.ok(frontier.coverage.estimatedReadBytes <= 50);
  assert.ok(frontier.coverage.responseBytes <= 50);
  assert.deepEqual(frontier.deferredQueries.map(item => item.relation), ["REVERSE_CALLER_QUERY"]);
  assert.equal(frontier.deferredQueries[0]?.notOpened, true);
  assert.equal(frontier.items.some(item => item.path.endsWith("Caller.java")), false);
});

test("holdout oracle coverage from the frozen first-plan pool is higher than first plan", () => {
  const holdouts = holdoutFixtures();
  const reports = holdouts.map(scenario => {
    const groups = requiredGroupsFromScenario(scenario.golden);
    const units = unitsFor([...scenario.firstPlan, ...scenario.poolNotPlan, ...scenario.decoys]);
    const frontier = buildFrontier(
      units,
      scenario.firstPlan.map(file => file.absolutePath),
      retrievalBudgetFor("balanced", { maxFiles: 6, maxReadBytes: 14 * 1024 })
    );
    return frontierOracleCoverage(
      groups,
      scenario.firstPlan.map(file => file.path ?? file.absolutePath.replace(/^\/repo\//, "")),
      frontier.items.map(item => item.path)
    );
  });
  const firstMean = reports.reduce((sum, report) => sum + report.firstCoverage, 0) / reports.length;
  const oracleMean = reports.reduce((sum, report) => sum + report.oracleCoverage, 0) / reports.length;
  assert.ok(oracleMean > firstMean, `oracle ${oracleMean} must beat first ${firstMean}`);
  assert.ok(oracleMean - firstMean >= 0.15);
  assert.equal(reports.filter(report => report.lifted).length >= 4, true);
  const paperTask = reports[1]!;
  assert.ok(paperTask.uncoveredGroupIds.some(id => id.includes("MeQueryService")));
});

test("standard projection does not publish frontier shadow on the public result", () => {
  const canonical = withConvergedCostV6(samplePayload(), 400, 0);
  const standard = projectImpactResultV6(canonical, "standard");
  const diagnostic = projectImpactResultV6(canonical, "diagnostic");
  assert.equal(standard.metrics?.readPlan?.frontierShadow, undefined);
  assert.equal((diagnostic.metrics?.readPlan as { frontierShadow?: { items: unknown[] } } | undefined)?.frontierShadow?.items.length, 1);
  assert.equal("retrieval" in standard, false);
});

function samplePayload(): ImpactResultV6 {
  return {
    version: 6,
    target: {
      file: "src/main/java/demo/DemoService.java",
      symbol: "DemoService#process",
      profile: "service",
      range: { start: { line: 10, column: 3 }, end: { line: 10, column: 3 } }
    },
    freshness: { requestGeneration: 1, indexedGeneration: 1, coverage: "COMPLETE", changedDuringRequest: false },
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
    metrics: {
      routingVersion: 6,
      elapsedMs: 12,
      readPlan: {
        frontierShadow: {
          items: [{ id: "C1", fileId: "F2", path: "src/main/java/demo/Helper.java", ranges: [], relation: "SECOND_HOP_EXACT", expectedEvidence: ["CALLS"], confidence: "medium", estimatedReadBytes: 80, hop: 1 }],
          deferredQueries: [],
          stopReason: "FRONTIER_AVAILABLE"
        }
      }
    }
  };
}

function holdoutFixtures(): Array<{
  golden: Scenario;
  firstPlan: CandidateFile[];
  poolNotPlan: CandidateFile[];
  decoys: CandidateFile[];
}> {
  const scenario = (id: string, mustHit: string[]): Scenario => ({
    id,
    name: id,
    anchor: { file: mustHit[0]!, line: 1, column: 1, profile: "service" },
    golden: { mustHit }
  });
  return [
    {
      golden: scenario("exam-score-export-cross-module-holdout", [
        "modules/exam/src/main/java/com/lishu/edu/exam/application/service/ExamScoreExportAppService.java",
        "modules/school/src/main/java/com/lishu/edu/school/application/service/SchoolQueryService.java",
        "modules/exam/src/main/java/com/lishu/edu/exam/domain/port/ExamScoreExportGenerator.java",
        "modules/exam/src/main/java/com/lishu/edu/exam/infrastructure/excel/ExamScoreExportExcelGenerator.java"
      ]),
      firstPlan: [
        fileAt("modules/exam/src/main/java/com/lishu/edu/exam/application/service/ExamScoreExportAppService.java", ["target"], 1000),
        fileAt("modules/exam/src/main/java/com/lishu/edu/exam/domain/port/ExamScoreExportGenerator.java", ["CALLS"], 200)
      ],
      poolNotPlan: [
        fileAt("modules/school/src/main/java/com/lishu/edu/school/application/service/SchoolQueryService.java", ["typeReference"], 60, { plannerEvidence: [{ family: "TYPE_GRAPH", kind: "typeReference", sourceTarget: "school" }] }),
        fileAt("modules/exam/src/main/java/com/lishu/edu/exam/infrastructure/excel/ExamScoreExportExcelGenerator.java", ["IMPLEMENTS"], 50)
      ],
      decoys: [1, 2, 3, 4, 5, 6].map(index => fileAt(`modules/exam/src/main/java/com/lishu/edu/exam/domain/port/Decoy${index}.java`, ["CALLS"], 400 - index))
    },
    {
      golden: scenario("paper-task-claim-iam-holdout", [
        "modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperTaskCommandAppService.java",
        "modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperAccessService.java",
        "modules/iam/src/main/java/com/lishu/edu/iam/application/service/MeQueryService.java",
        "modules/paper/src/main/java/com/lishu/edu/paper/infrastructure/persistence/repository/PaperRecordTaskRepositoryImpl.java"
      ]),
      firstPlan: [
        fileAt("modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperTaskCommandAppService.java", ["target"], 1000),
        fileAt("modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperAccessService.java", ["CALLS"], 180),
        fileAt("modules/paper/src/main/java/com/lishu/edu/paper/infrastructure/persistence/repository/PaperRecordTaskRepositoryImpl.java", ["IMPLEMENTS"], 160)
      ],
      poolNotPlan: [],
      decoys: [fileAt("modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperTaskQueryService.java", ["CALLS"], 90)]
    },
    {
      golden: scenario("client-release-storage-presign-holdout", [
        "modules/storage/src/main/java/com/hhtele/cipherlink/storage/infrastructure/DefaultClientReleasePackageStorageGateway.java",
        "modules/storage/src/main/java/com/hhtele/cipherlink/storage/application/ClientReleasePackageStorageGateway.java",
        "modules/storage/src/main/java/com/hhtele/cipherlink/storage/application/ObjectStorageProvider.java",
        "modules/client/src/main/java/com/hhtele/cipherlink/client/application/DefaultClientReleasePublishAppService.java"
      ]),
      firstPlan: [
        fileAt("modules/storage/src/main/java/com/hhtele/cipherlink/storage/infrastructure/DefaultClientReleasePackageStorageGateway.java", ["target"], 1000),
        fileAt("modules/storage/src/main/java/com/hhtele/cipherlink/storage/application/ClientReleasePackageStorageGateway.java", ["IMPLEMENTS"], 200)
      ],
      poolNotPlan: [
        fileAt("modules/storage/src/main/java/com/hhtele/cipherlink/storage/application/ObjectStorageProvider.java", ["METHOD_RELATION"], 70),
        fileAt("modules/client/src/main/java/com/hhtele/cipherlink/client/application/DefaultClientReleasePublishAppService.java", ["typeReference"], 55, { plannerEvidence: [{ family: "TYPE_GRAPH", kind: "typeReference", sourceTarget: "client" }] })
      ],
      decoys: [1, 2, 3, 4].map(index => fileAt(`modules/storage/src/main/java/com/hhtele/cipherlink/storage/application/Decoy${index}.java`, ["CALLS"], 300 - index))
    },
    {
      golden: scenario("backend-operation-log-aspect-async-audit-holdout", [
        "apps/cipherlink-backend/src/main/java/com/hhtele/cipherlink/backend/config/BackendOperationLogAspect.java",
        "modules/common/src/main/java/com/hhtele/cipherlink/common/operationlog/OperationLog.java",
        "modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/OperationLogAppService.java",
        "modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/OperationLogCommand.java",
        "modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/DefaultOperationLogAppService.java"
      ]),
      firstPlan: [
        fileAt("apps/cipherlink-backend/src/main/java/com/hhtele/cipherlink/backend/config/BackendOperationLogAspect.java", ["target"], 1000),
        fileAt("modules/common/src/main/java/com/hhtele/cipherlink/common/operationlog/OperationLog.java", ["CALLS"], 180),
        fileAt("modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/OperationLogAppService.java", ["CALLS"], 170)
      ],
      poolNotPlan: [
        fileAt("modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/OperationLogCommand.java", ["METHOD_RELATION"], 60),
        fileAt("modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/DefaultOperationLogAppService.java", ["IMPLEMENTS"], 50)
      ],
      decoys: [1, 2, 3, 4].map(index => fileAt(`modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/Decoy${index}.java`, ["CALLS"], 250 - index))
    },
    {
      golden: scenario("exam-room-print-download-types-persistent-bundle", [
        "exam-management/src/main/java/com/hhtele/exam/management/controller/examination/ExamRoomPrintController.java",
        "exam-service/exam-service-exam-site/src/main/java/com/hhtele/exam/service/exam/site/ExamRoomPrintBundleService.java",
        "exam-service/exam-service-exam-site/src/main/java/com/hhtele/exam/service/exam/site/impl/ExamRoomPrintBundleServiceImpl.java",
        "exam-data/src/main/java/com/hhtele/exam/data/entity/examination/ExamRoomPrintBundleJob.java",
        "exam-data/src/main/java/com/hhtele/exam/data/repository/examination/ExamRoomPrintBundleJobTemplate.java"
      ]),
      firstPlan: [
        fileAt("exam-management/src/main/java/com/hhtele/exam/management/controller/examination/ExamRoomPrintController.java", ["target"], 1000),
        fileAt("exam-service/exam-service-exam-site/src/main/java/com/hhtele/exam/service/exam/site/ExamRoomPrintBundleService.java", ["CALLS"], 180)
      ],
      poolNotPlan: [
        fileAt("exam-service/exam-service-exam-site/src/main/java/com/hhtele/exam/service/exam/site/impl/ExamRoomPrintBundleServiceImpl.java", ["IMPLEMENTS"], 70)
      ],
      decoys: [1, 2, 3].map(index => fileAt(`exam-management/src/main/java/com/hhtele/exam/management/service/Decoy${index}.java`, ["CALLS"], 220 - index))
    },
    {
      golden: scenario("candidate-pay-order-cross-module-admission", [
        "exam-candidate/src/main/java/com/hhtele/exam/candidate/controller/order/OrderController.java",
        "exam-service/exam-service-order/src/main/java/com/hhtele/exam/service/order/service/ApplyPayService.java",
        "exam-service/exam-service-order/src/main/java/com/hhtele/exam/service/order/service/impl/ApplyPayServiceImpl.java",
        "exam-data/src/main/java/com/hhtele/exam/data/repository/order/ApplyPayTemplate.java",
        "exam-data/src/main/java/com/hhtele/exam/data/repository/order/OrderRepository.java"
      ]),
      firstPlan: [
        fileAt("exam-candidate/src/main/java/com/hhtele/exam/candidate/controller/order/OrderController.java", ["target"], 1000),
        fileAt("exam-service/exam-service-order/src/main/java/com/hhtele/exam/service/order/service/ApplyPayService.java", ["CALLS"], 180)
      ],
      poolNotPlan: [
        fileAt("exam-service/exam-service-order/src/main/java/com/hhtele/exam/service/order/service/impl/ApplyPayServiceImpl.java", ["IMPLEMENTS"], 70)
      ],
      decoys: [1, 2, 3].map(index => fileAt(`exam-candidate/src/main/java/com/hhtele/exam/candidate/controller/order/Decoy${index}.java`, ["CALLS"], 210 - index))
    }
  ];
}
