// input: Fixed complex Java navigation scenarios.
// output: v5 java_impact payload, latency, precision, recall, and read-plan metrics.
// pos: Repeatable benchmark entrypoint for the clean agent router.
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "./agent-router/index.js";
import { JdtlsSession } from "./jdtls-session.js";
import { SourceIndex } from "./source-index.js";
import type { ImpactOptions } from "./agent-types.js";

type Scenario = {
  id: string;
  name: string;
  anchor: {
    file: string;
    line: number;
    column: number;
    profile: ImpactOptions["profile"];
    focusModules?: string[];
    taskKeywords?: string[];
  };
  groundTruth: string[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.JAVA_LSP_BENCH_REPO_ROOT || process.env.LISHUEDU_ROOT || path.resolve(projectDir, "..", "..");
const router = new AgentRouter(repoRoot, new JdtlsSession(repoRoot), new SourceIndex(repoRoot));

const scenarios: Scenario[] = [
  {
    id: "storage-signed-url",
    name: "StorageGateway#getSignedUrl",
    anchor: {
      file: "modules/integration/src/main/java/com/lishu/edu/integration/domain/port/StorageGateway.java",
      line: 21,
      column: 28,
      profile: "port",
      taskKeywords: ["storage", "signed", "url", "report"]
    },
    groundTruth: [
      "modules/integration/src/main/java/com/lishu/edu/integration/domain/port/StorageGateway.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/domain/contract/StorageSignedUrlCommand.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/domain/contract/StorageSignedUrlResult.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/infrastructure/storage/AliyunOssGateway.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/infrastructure/storage/StubStorageGateway.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/infrastructure/storage/AliyunOssConfig.java",
      "modules/integration/src/main/java/com/lishu/edu/integration/application/service/StorageAppService.java",
      "modules/report/src/main/java/com/lishu/edu/report/application/service/ReportBatchExportQueryService.java",
      "modules/report/src/main/java/com/lishu/edu/report/application/service/ReportExportTaskCommandService.java",
      "modules/report/src/main/java/com/lishu/edu/report/application/service/BusinessOperationDashboardAppService.java"
    ]
  },
  {
    id: "school-template-parser",
    name: "SchoolTemplateImportParser#parse",
    anchor: {
      file: "modules/school/src/main/java/com/lishu/edu/school/application/port/SchoolTemplateImportParser.java",
      line: 16,
      column: 34,
      profile: "parser",
      focusModules: ["school"],
      taskKeywords: ["school", "template", "import", "parser"]
    },
    groundTruth: [
      "modules/school/src/main/java/com/lishu/edu/school/application/port/SchoolTemplateImportParser.java",
      "modules/school/src/main/java/com/lishu/edu/school/infrastructure/excel/SchoolTemplateImportExcelParser.java",
      "modules/school/src/main/java/com/lishu/edu/school/domain/template/SchoolTemplateParsedTemplate.java",
      "modules/school/src/main/java/com/lishu/edu/school/application/service/SchoolTemplateImportAppService.java",
      "modules/school/src/main/java/com/lishu/edu/school/application/service/SchoolTemplateImportDiffBuilder.java",
      "modules/school/src/test/java/com/lishu/edu/school/infrastructure/excel/SchoolTemplateImportExcelParserTest.java",
      "modules/school/src/test/java/com/lishu/edu/school/application/service/SchoolTemplateImportDiffBuilderTest.java"
    ]
  },
  {
    id: "report-reusable-zip",
    name: "ReportBatchExportTaskRepository#findReusableReadyZip",
    anchor: {
      file: "modules/report/src/main/java/com/lishu/edu/report/domain/port/ReportBatchExportTaskRepository.java",
      line: 36,
      column: 14,
      profile: "repository",
      focusModules: ["report"],
      taskKeywords: ["report", "batch", "export", "zip", "task"]
    },
    groundTruth: [
      "modules/report/src/main/java/com/lishu/edu/report/domain/port/ReportBatchExportTaskRepository.java",
      "modules/report/src/main/java/com/lishu/edu/report/infrastructure/persistence/repository/ReportBatchExportTaskRepositoryImpl.java",
      "modules/report/src/main/java/com/lishu/edu/report/infrastructure/persistence/entity/ReportBatchExportTaskDO.java",
      "modules/report/src/main/java/com/lishu/edu/report/infrastructure/persistence/mapper/ReportBatchExportTaskMapper.java",
      "modules/report/src/main/java/com/lishu/edu/report/application/service/ReportBatchExportCommandService.java",
      "modules/report/src/main/java/com/lishu/edu/report/application/service/ReportBatchExportQueryService.java",
      "modules/report/src/test/java/com/lishu/edu/report/application/service/ReportBatchExportCommandServiceTest.java",
      "modules/report/src/main/resources/db/migration/V011__report_batch_export_task.sql"
    ]
  },
  {
    id: "school-confirm-controller",
    name: "SchoolTemplateImportController#confirm",
    anchor: {
      file: "modules/school/src/main/java/com/lishu/edu/school/interfaces/web/SchoolTemplateImportController.java",
      line: 109,
      column: 12,
      profile: "controller",
      focusModules: ["school"],
      taskKeywords: ["school", "template", "import", "confirm"]
    },
    groundTruth: [
      "modules/school/src/main/java/com/lishu/edu/school/interfaces/web/SchoolTemplateImportController.java",
      "modules/school/src/main/java/com/lishu/edu/school/interfaces/assembler/SchoolTemplateImportAssembler.java",
      "modules/school/src/main/java/com/lishu/edu/school/interfaces/dto/SchoolTemplateImportConfirmRequest.java",
      "modules/school/src/main/java/com/lishu/edu/school/interfaces/dto/SchoolTemplateImportConfirmResponse.java",
      "modules/school/src/main/java/com/lishu/edu/school/application/dto/SchoolTemplateImportConfirmCommand.java",
      "modules/school/src/main/java/com/lishu/edu/school/application/dto/SchoolTemplateImportConfirmResult.java",
      "modules/school/src/main/java/com/lishu/edu/school/application/service/SchoolTemplateImportAppService.java"
    ]
  },
  {
    id: "benefit-product-code-dto",
    name: "ParentStudentBenefitItemResponse.productCode",
    anchor: {
      file: "modules/benefits/src/main/java/com/lishu/edu/benefits/interfaces/dto/ParentStudentBenefitItemResponse.java",
      line: 19,
      column: 16,
      profile: "dto",
      focusModules: ["benefits", "product"],
      taskKeywords: ["benefit", "product", "code", "parent"]
    },
    groundTruth: [
      "modules/benefits/src/main/java/com/lishu/edu/benefits/interfaces/dto/ParentStudentBenefitItemResponse.java",
      "modules/benefits/src/main/java/com/lishu/edu/benefits/application/dto/ParentStudentBenefitItemView.java",
      "modules/benefits/src/main/java/com/lishu/edu/benefits/interfaces/assembler/BenefitEntitlementAssembler.java",
      "modules/benefits/src/main/java/com/lishu/edu/benefits/application/service/ParentBenefitQueryAppService.java",
      "modules/benefits/src/main/java/com/lishu/edu/benefits/interfaces/controller/ParentBenefitController.java",
      "modules/product/src/main/java/com/lishu/edu/product/application/service/ProductQueryAppService.java",
      "modules/product/src/main/java/com/lishu/edu/product/application/dto/ProductView.java",
      "modules/benefits/src/test/java/com/lishu/edu/benefits/application/service/ParentBenefitQueryAppServiceTest.java",
      "modules/benefits/src/test/java/com/lishu/edu/benefits/interfaces/assembler/BenefitEntitlementAssemblerTest.java"
    ]
  }
];

const rows = [];
for (const scenario of scenarios) {
  const startedAt = performance.now();
  const result = await router.impact({
    anchors: [scenario.anchor],
    mode: "balanced",
    profile: scenario.anchor.profile,
    semanticPolicy: "auto",
    semanticTimeoutMs: 1500,
    testReadMode: "defer",
    focusModules: scenario.anchor.focusModules || [],
    excludeModules: [],
    taskKeywords: scenario.anchor.taskKeywords || [],
    crossModulePolicy: "auto"
  });
  const elapsedMs = performance.now() - startedAt;
  const rawSearchPayload = Buffer.byteLength(JSON.stringify(result), "utf8");
  const readingPayload = readPlanBytes(result);
  const candidatePaths = result.files.map(file => String(file.path));
  const quality = evaluate(candidatePaths, scenario.groundTruth);
  rows.push({
    id: scenario.id,
    name: scenario.name,
    rawSearchPayload,
    readingPayload,
    totalAgentVisiblePayload: rawSearchPayload + readingPayload,
    estimatedTokens: Math.round((rawSearchPayload + readingPayload) / 4),
    elapsedMs,
    roundTrips: 1 + result.readPlan.length,
    returnedFiles: quality.returnedFiles,
    hitFiles: quality.hitFiles,
    precision: quality.precision,
    recall: quality.recall,
    readPlanItems: result.readPlan.length,
    rgRawBytesSuppressed: result.counts.totalRgRawBytes
  });
}

const totals = rows.reduce((acc, row) => {
  acc.rawSearchPayload += row.rawSearchPayload;
  acc.readingPayload += row.readingPayload;
  acc.totalAgentVisiblePayload += row.totalAgentVisiblePayload;
  acc.estimatedTokens += row.estimatedTokens;
  acc.elapsedMs += row.elapsedMs;
  acc.roundTrips += row.roundTrips;
  acc.returnedFiles += row.returnedFiles;
  acc.hitFiles += row.hitFiles;
  return acc;
}, {
  rawSearchPayload: 0,
  readingPayload: 0,
  totalAgentVisiblePayload: 0,
  estimatedTokens: 0,
  elapsedMs: 0,
  roundTrips: 0,
  returnedFiles: 0,
  hitFiles: 0
});
const groundTruth = scenarios.reduce((sum, scenario) => sum + scenario.groundTruth.length, 0);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  repoRoot,
  totals: {
    ...totals,
    precision: totals.returnedFiles ? totals.hitFiles / totals.returnedFiles : 0,
    recall: groundTruth ? totals.hitFiles / groundTruth : 1
  },
  rows
}, null, 2));

function readPlanBytes(result: Awaited<ReturnType<AgentRouter["impact"]>>): number {
  const files = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  let bytes = 0;
  for (const item of result.readPlan) {
    const file = files.get(item.fileId);
    if (!file) {
      continue;
    }
    const lines = readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/);
    bytes += Buffer.byteLength(lines.slice(item.startLine - 1, item.endLine).join("\n"), "utf8");
  }
  return bytes;
}

function evaluate(candidateFiles: string[], groundTruth: string[]): { returnedFiles: number; hitFiles: number; precision: number; recall: number } {
  const candidates = new Set(candidateFiles);
  const expected = new Set(groundTruth);
  const hitFiles = [...candidates].filter(file => expected.has(file)).length;
  return {
    returnedFiles: candidates.size,
    hitFiles,
    precision: candidates.size ? hitFiles / candidates.size : 0,
    recall: expected.size ? hitFiles / expected.size : 1
  };
}
