import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceBundleCandidate } from "./graph-search.js";
import {
  CANDIDATE_FRONTIER_N,
  CANDIDATE_FRONTIER_N_MAX,
  CANDIDATE_WIRE_N,
  EVIDENCE_FILE_CAP,
  capEvidenceByFile,
  candidateReason,
  candidateRole,
  formatSpanRanges,
  frontierCandidates,
  nextSteps,
  parseSpanRanges,
  wireRank
} from "./context-candidates.js";

test("formatSpanRanges merges adjacent intervals", () => {
  assert.equal(formatSpanRanges([{ start: 12, end: 48 }, { start: 60, end: 75 }]), "12-48,60-75");
  assert.equal(formatSpanRanges([{ start: 1, end: 4 }, { start: 5, end: 8 }]), "1-8");
  assert.equal(parseSpanRanges("12-48,60-75").length, 2);
  assert.ok(EVIDENCE_FILE_CAP >= 1 && EVIDENCE_FILE_CAP <= 3);
  assert.deepEqual(capEvidenceByFile([
    { path: "src/A.java" },
    { path: "src/B.java" },
    { path: "src/A.java" },
    { path: "src/C.java" },
    { path: "src/D.java" },
    { path: "src/E.java" }
  ]).map(item => item.path), ["src/A.java", "src/B.java", "src/C.java"]);
});

test("frontierCandidates is path-level, hop-ordered, and capped at N", () => {
  const rows = frontierCandidates([
    { path: "src/Far.java", hops: 3, estimatedTokens: 10, provingPath: [], closedObligations: [] },
    {
      path: "src/Pay.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#PayService#create#1", toId: "src/Pay.java#Pay#save#1" }],
      closedObligations: ["O1"]
    },
    { path: "src/A.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O0"] },
    { path: "src/Pay.java", hops: 2, estimatedTokens: 10, provingPath: [], closedObligations: [] }
  ], 2);
  assert.equal(CANDIDATE_FRONTIER_N, 24);
  assert.equal(CANDIDATE_WIRE_N, 24);
  assert.ok(CANDIDATE_WIRE_N <= CANDIDATE_FRONTIER_N_MAX);
  assert.deepEqual(rows.map(item => item.path), ["src/A.java", "src/Pay.java"]);
  assert.equal(rows[0]!.role, "ANCHOR");
  assert.equal(rows[0]!.hop, 0);
  assert.equal(rows[1]!.role, "CALLEE");
  assert.equal(rows[1]!.hop, 1);
  assert.equal(rows[1]!.reason, "CALLS_EXACT←PayService.create");
});

test("hop-2 persistence and hop-1 contract remain when hop-1 CALLS would fill N", () => {
  const bundles: EvidenceBundleCandidate[] = [
    { path: "src/A.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O0"] },
    {
      path: "src/Dto.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "src/A.java", toId: "src/Dto.java#Dto" }],
      closedObligations: []
    },
    {
      path: "src/Mapper.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "MYBATIS_METHOD_BINDS_STATEMENT", fromId: "src/A.java#A#save#1", toId: "src/Mapper.java#Mapper" }],
      closedObligations: ["O2"]
    }
  ];
  for (let index = 0; index < 21; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "src/A.java#A#run#1", toId: `src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const rows = frontierCandidates(bundles, 24);
  const paths = rows.map(item => item.path);
  assert.equal(paths.length, 24);
  assert.ok(paths.includes("src/A.java"));
  assert.ok(paths.includes("src/Dto.java"), `dto missing: ${paths.join(",")}`);
  assert.ok(paths.includes("src/Mapper.java"), `mapper missing: ${paths.join(",")}`);
});

test("hop-2 reserved slots keep persistence/name-near files and drop unrelated hop-2 CALLS", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "modules/client/src/main/java/ClientReleaseMapper.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "MYBATIS_METHOD_BINDS_STATEMENT", fromId: "modules/client/src/main/java/ClientReleaseRepository.java#R", toId: "modules/client/src/main/java/ClientReleaseMapper.java#M" }],
      closedObligations: ["O2"]
    },
    {
      path: "modules/agency/src/main/java/AgencyLifecycleService.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/agency/src/main/java/Agency.java#A#run#1", toId: "modules/agency/src/main/java/AgencyLifecycleService.java#S#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/main/java/ExaminationRoomDownloadDTO.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java", toId: "exam-common/src/main/java/ExaminationRoomDownloadDTO.java#D" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 21; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `modules/client/src/main/java/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java#G#run#1", toId: `modules/client/src/main/java/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(paths.includes("modules/client/src/main/java/ClientReleaseMapper.java"), `mapper missing: ${paths.join(",")}`);
  assert.equal(paths.includes("modules/agency/src/main/java/AgencyLifecycleService.java"), false, `agency stole a slot: ${paths.join(",")}`);
});

test("hop-1 contract slots prefer a DTO over Constant/Result boilerplate", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/ExamRoomPrintController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-common/src/ExaminationRoomDownloadDTO.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExaminationRoomDownloadDTO.java#D" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/CommonResult.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/CommonResult.java#C" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ErrorMessageConstant.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ErrorMessageConstant.java#C" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ResultCode.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ResultCode.java#C" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ExamRoomHtmlConstant.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExamRoomHtmlConstant.java#C" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 21; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/ExamRoomPrintController.java#C#run#1", toId: `exam-service/src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  const dto = paths.indexOf("exam-common/src/ExaminationRoomDownloadDTO.java");
  assert.ok(dto >= 0, `dto missing: ${paths.join(",")}`);
  const boilerplate = paths.findIndex(path => /(?:Constant|CommonResult|ResultCode)\.java$/.test(path));
  assert.ok(boilerplate < 0 || dto < boilerplate, `dto should outrank boilerplate: ${paths.join(",")}`);
});

test("hop-1 Impl on the wire pulls its Service interface into reserved contract slots", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/ExamRoomPrintController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-service/src/DownloadCenterServiceImpl.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPLEMENTS" as const, fromId: "exam-service/src/DownloadCenterService.java#S", toId: "exam-service/src/DownloadCenterServiceImpl.java#I#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-service/src/DownloadCenterService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-service/src/DownloadCenterService.java#S" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ExaminationRoomDownloadDTO.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExaminationRoomDownloadDTO.java#D" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ExamRoomDownloadTypeEnum.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExamRoomDownloadTypeEnum.java#E" }],
      closedObligations: []
    },
    {
      path: "exam-service/src/ExamRoomPrintBundleWorker.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-service/src/ExamRoomPrintBundleWorker.java#W" }],
      closedObligations: []
    },
    {
      path: "exam-service/src/ExamAllocatePrintAsyncService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-service/src/ExamAllocatePrintAsyncService.java#S" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 20; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/ExamRoomPrintController.java#C#run#1", toId: `exam-service/src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(paths.includes("exam-service/src/DownloadCenterServiceImpl.java"), `impl missing: ${paths.join(",")}`);
  assert.ok(paths.includes("exam-service/src/DownloadCenterService.java"), `service missing: ${paths.join(",")}`);
  assert.ok(paths.includes("exam-common/src/ExaminationRoomDownloadDTO.java"), `dto missing: ${paths.join(",")}`);
});

test("hop-2 ServiceImpl companion includes persist Template and controller stem includes RendererRoute", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/OrderController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-service/src/ApplyPayService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/OrderController.java#C#run#1", toId: "exam-service/src/ApplyPayService.java#S#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-service/src/ApplyPayServiceImpl.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPLEMENTS" as const, fromId: "exam-service/src/ApplyPayService.java#S", toId: "exam-service/src/ApplyPayServiceImpl.java#I#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/repository/ApplyPayTemplate.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ApplyPayServiceImpl.java", toId: "exam-data/src/repository/ApplyPayTemplate.java#T" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/entity/MsDownloadBillLog.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/MsDownloadBillLogRepository.java#R", toId: "exam-data/src/entity/MsDownloadBillLog.java#E" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/entity/Order.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/OrderRepo.java#R", toId: "exam-data/src/entity/Order.java#E" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/entity/ApplyInfo.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/ApplyInfoRepo.java#R", toId: "exam-data/src/entity/ApplyInfo.java#E" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 20; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/OrderController.java#C#run#1", toId: `exam-service/src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const payPaths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(payPaths.includes("exam-data/src/repository/ApplyPayTemplate.java"), `template missing: ${payPaths.join(",")}`);
  assert.ok(payPaths.includes("exam-data/src/entity/ApplyInfo.java"), `apply info missing: ${payPaths.join(",")}`);

  const printBundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/ExamRoomPrintController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-service/src/ExamRoomPrintRendererRoute.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-service/src/ExamRoomPrintRendererRoute.java#R" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/entity/ApplySite.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/Repo.java#R", toId: "exam-data/src/entity/ApplySite.java#E" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 20; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    printBundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/ExamRoomPrintController.java#C#run#1", toId: `exam-service/src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const printPaths = frontierCandidates(printBundles, 24).map(item => item.path);
  assert.ok(printPaths.includes("exam-service/src/ExamRoomPrintRendererRoute.java"), `renderer missing: ${printPaths.join(",")}`);
});

test("hop-2 cross-module callee of a selected hop-1 service stays on the N=24 wire", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "modules/paper/src/main/java/PaperTaskCommandAppService.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "modules/paper/src/main/java/PaperAccessService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/paper/src/main/java/PaperTaskCommandAppService.java#P#run#1", toId: "modules/paper/src/main/java/PaperAccessService.java#A#run#1" }],
      closedObligations: []
    },
    {
      path: "modules/paper/src/main/java/PaperTaskQueryService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/paper/src/main/java/PaperTaskCommandAppService.java#P#run#1", toId: "modules/paper/src/main/java/PaperTaskQueryService.java#Q#run#1" }],
      closedObligations: []
    },
    {
      path: "modules/iam/src/main/java/MeQueryService.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_VIRTUAL" as const, fromId: "modules/paper/src/main/java/PaperAccessService.java#A#requireMe#1", toId: "modules/iam/src/main/java/MeQueryService.java#M#getMe#1" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 20; index += 1) {
    bundles.push({
      path: `modules/paper/src/main/java/PaperAutoRecord${String(index).padStart(2, "0")}.java`,
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/paper/src/main/java/PaperTaskCommandAppService.java#P#run#1", toId: `modules/paper/src/main/java/PaperAutoRecord${String(index).padStart(2, "0")}.java#R#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(paths.includes("modules/iam/src/main/java/MeQueryService.java"), `me query missing: ${paths.join(",")}`);
});

test("hop-2 name-near mapper beats unrelated persist entities and storage providers", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/mapper/ClientReleaseMapper.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "modules/client/src/main/java/ClientReleaseRepository.java", toId: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/mapper/ClientReleaseMapper.java#M" }],
      closedObligations: []
    },
    {
      path: "modules/client/src/main/java/com/hhtele/cipherlink/client/application/ClientReleaseRepository.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java", toId: "modules/client/src/main/java/com/hhtele/cipherlink/client/application/ClientReleaseRepository.java#R" }],
      closedObligations: []
    },
    {
      path: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/MybatisClientReleaseRepository.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "modules/client/src/main/java/ClientReleaseRepository.java", toId: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/MybatisClientReleaseRepository.java#M" }],
      closedObligations: []
    },
    {
      path: "modules/client/src/main/java/com/hhtele/cipherlink/client/application/DefaultClientReleasePublishAppService.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java#G#run#1", toId: "modules/client/src/main/java/com/hhtele/cipherlink/client/application/DefaultClientReleasePublishAppService.java#S#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/main/java/com/hhtele/exam/data/entity/ApplySite.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/main/java/Repo.java#R", toId: "exam-data/src/main/java/com/hhtele/exam/data/entity/ApplySite.java#E" }],
      closedObligations: []
    },
    {
      path: "modules/storage/src/main/java/AliyunOssObjectStorageProvider.java",
      hops: 2,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPLEMENTS", fromId: "modules/storage/src/main/java/ObjectStorageProvider.java", toId: "modules/storage/src/main/java/AliyunOssObjectStorageProvider.java#P" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 20; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `modules/client/src/main/java/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "modules/client/src/main/java/DefaultClientReleasePackageStorageGateway.java#G#run#1", toId: `modules/client/src/main/java/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(paths.includes("modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/mapper/ClientReleaseMapper.java"), `mapper missing: ${paths.join(",")}`);
  assert.ok(paths.includes("modules/client/src/main/java/com/hhtele/cipherlink/client/application/ClientReleaseRepository.java"));
  assert.ok(paths.includes("modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/MybatisClientReleaseRepository.java"));
  assert.ok(paths.includes("modules/client/src/main/java/com/hhtele/cipherlink/client/application/DefaultClientReleasePublishAppService.java"));
  assert.equal(paths.includes("modules/storage/src/main/java/AliyunOssObjectStorageProvider.java"), false);
});

test("Exam stems to Examination so hop-1 DTO outranks weaker ExamRoom VOs", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/ExamRoomPrintController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-common/src/ExaminationRoomDownloadDTO.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExaminationRoomDownloadDTO.java#D" }],
      closedObligations: []
    },
    {
      path: "exam-common/src/ExamRoomSeatVO.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "exam-service/src/ExamRoomPrintController.java", toId: "exam-common/src/ExamRoomSeatVO.java#V" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 21; index += 1) {
    const name = `Callee${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/ExamRoomPrintController.java#C#run#1", toId: `exam-service/src/${name}.java#C#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  const dto = paths.indexOf("exam-common/src/ExaminationRoomDownloadDTO.java");
  const vo = paths.indexOf("exam-common/src/ExamRoomSeatVO.java");
  assert.ok(dto >= 0, `dto missing: ${paths.join(",")}`);
  assert.ok(vo < 0 || dto < vo, `dto should outrank seat VO: ${paths.join(",")}`);
});

test("hop-1 name-near CALLS stay on the wire ahead of unrelated hop-1 persist entities", () => {
  const bundles: EvidenceBundleCandidate[] = [
    {
      path: "exam-service/src/ExamRoomPrintController.java",
      hops: 0,
      estimatedTokens: 10,
      provingPath: [],
      closedObligations: ["O0"]
    },
    {
      path: "exam-service/src/ExamRoomPrintBundleService.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT" as const, fromId: "exam-service/src/ExamRoomPrintController.java#C#run#1", toId: "exam-service/src/ExamRoomPrintBundleService.java#S#run#1" }],
      closedObligations: []
    },
    {
      path: "exam-data/src/Examination.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "REPOSITORY_MANAGES_ENTITY", fromId: "exam-data/src/Repo.java#R", toId: "exam-data/src/Examination.java#E" }],
      closedObligations: []
    }
  ];
  for (let index = 0; index < 21; index += 1) {
    const name = `SecurityImpl${String(index).padStart(2, "0")}`;
    bundles.push({
      path: `exam-service/src/${name}.java`,
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPLEMENTS" as const, fromId: "exam-service/src/Port.java#P", toId: `exam-service/src/${name}.java#S#run#1` }],
      closedObligations: []
    });
  }
  const paths = frontierCandidates(bundles, 24).map(item => item.path);
  assert.ok(paths.includes("exam-service/src/ExamRoomPrintBundleService.java"), `print bundle missing: ${paths.join(",")}`);
});

test("frontierCandidates keeps hop-1 CALLS before hop-1 IMPORTS when the cap is tight", () => {
  const rows = frontierCandidates([
    { path: "src/A.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O0"] },
    {
      path: "src/AaaConstant.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "src/A.java", toId: "src/AaaConstant.java#C" }],
      closedObligations: []
    },
    {
      path: "src/Ledger.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#A#pay#1", toId: "src/Ledger.java#Ledger" }],
      closedObligations: ["O1"]
    },
    {
      path: "src/ATest.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/ATest.java#T#run#1", toId: "src/A.java#A" }],
      closedObligations: []
    }
  ], 3);
  assert.deepEqual(rows.map(item => item.path), ["src/A.java", "src/Ledger.java", "src/AaaConstant.java"]);
  assert.ok(wireRank({
    path: "src/Ledger.java",
    hops: 1,
    provingPath: [{ kind: "CALLS_EXACT", fromId: "a", toId: "b" }]
  }) < wireRank({
    path: "src/AaaConstant.java",
    hops: 1,
    provingPath: [{ kind: "IMPORTS", fromId: "a", toId: "b" }]
  }));
});

test("candidateRole follows graph edge kinds without scores", () => {
  assert.equal(candidateRole({ hops: 0, provingPath: [] }), "ANCHOR");
  assert.equal(candidateRole({ hops: 1, provingPath: [{ kind: "CALLED_BY", fromId: "a", toId: "b" }] }), "CALLER");
  assert.equal(candidateRole({ hops: 1, provingPath: [{ kind: "MYBATIS_METHOD_BINDS_STATEMENT", fromId: "a", toId: "b" }] }), "PERSISTENCE");
  assert.equal(JSON.stringify(candidateReason({
    path: "src/A.java",
    hops: 1,
    estimatedTokens: 1,
    provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#PayService#create#1", toId: "x" }],
    closedObligations: []
  })).includes("score"), false);
});

test("nextSteps emit copy-pasteable navigate params for unpacked candidates", () => {
  const next = nextSteps({
    unresolved: [{ id: "entity", role: "entity" }],
    candidates: [
      { path: "src/A.java", role: "ANCHOR", hop: 0, reason: "ANCHOR" },
      { path: "src/B.java", role: "CALLEE", hop: 1, reason: "CALLS_EXACT←A.run" }
    ],
    evidence: [{ path: "src/A.java" }],
    anchorPath: "src/A.java"
  });
  assert.equal(next.length, 1);
  assert.equal(next[0]!.action, "navigate");
  assert.equal(next[0]!.file, "src/B.java");
  assert.equal(next[0]!.line, 1);
  assert.equal(next[0]!.direction, "callees");
  assert.equal(next[0]!.reason, "entity");
});
