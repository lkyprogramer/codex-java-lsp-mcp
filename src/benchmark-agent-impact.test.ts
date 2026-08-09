import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("benchmark loads scenarios from external jsonl and prints metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-"));
  const goldenDir = path.join(root, "golden");
  await mkdir(goldenDir, { recursive: true });
  const scenarioFile = path.join(goldenDir, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo",
    name: "Demo",
    repoCommit: "fixture",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/Demo.java",
      line: 1,
      column: 1,
      profile: "service"
    },
    golden: {
      mustHit: ["src/main/java/demo/Demo.java"],
      taskBlocking: [],
      shouldHit: [],
      support: []
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--read-plan-max-bytes", "2048",
    "--list-scenarios"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.metadata.projectId, "generic-java");
  assert.equal(payload.metadata.warmState, "cold-nolsp");
  assert.equal(payload.metadata.indexBackend, "v2");
  assert.equal(payload.metadata.indexPrepareTimeoutMs, 600000);
  assert.equal(payload.metadata.readPlanMaxBytes, 2048);
  assert.equal(payload.scenarios[0].id, "demo");
});

test("benchmark records an explicitly isolated JavaIndex cache directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-cache-"));
  const scenarioFile = path.join(root, "generic-java.scenarios.jsonl");
  const cacheDir = path.join(root, "isolated-index-cache");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo",
    name: "Demo",
    projectId: "generic-java",
    anchor: {
      file: "src/main/java/demo/Demo.java",
      line: 1,
      column: 1,
      profile: "service"
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--index-cache-dir", cacheDir,
    "--list-scenarios"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.metadata.indexCacheDir, cacheDir);
});

test("benchmark can run a no-lsp token baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-nolsp-"));
  const srcDir = path.join(root, "src", "main", "java", "demo");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const hiddenDir = path.join(root, "src", "main", "java", "hidden");
  const billingDir = path.join(root, "modules", "billing", "src", "main", "java", "external");
  await mkdir(hiddenDir, { recursive: true });
  await mkdir(billingDir, { recursive: true });
  await writeFile(path.join(srcDir, "DemoController.java"), [
    "package demo;",
    "import hidden.HiddenDto;",
    "public class DemoController {",
    "  private HiddenDto hidden;",
    "  public DemoResponse updateDemo(DemoRequest request) { return null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(srcDir, "DemoRequest.java"), "package demo; public record DemoRequest(String name) {}\n");
  await writeFile(path.join(srcDir, "DemoResponse.java"), "package demo; public record DemoResponse(String name) {}\n");
  await writeFile(path.join(hiddenDir, "HiddenDto.java"), "package hidden; class HiddenDto {}\n");
  await writeFile(path.join(billingDir, "BillingClient.java"), "package external; class BillingClient {}\n");

  const scenarioFile = path.join(root, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo-update",
    name: "DemoController#updateDemo",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/DemoController.java",
      line: 5,
      column: 29,
      profile: "controller",
      taskKeywords: ["demo", "update"]
    },
    golden: {
      mustHit: ["src/main/java/demo/DemoController.java", "src/main/java/demo/DemoRequest.java", "src/main/java/demo/DemoResponse.java"],
      taskBlocking: ["src/main/java/hidden/HiddenDto.java", "modules/billing/src/main/java/external/BillingClient.java"],
      shouldHit: ["src/main/java/demo/MissingService.java"],
      support: []
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--strategy", "no-lsp",
    "--runs", "1"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const attempt = payload.rows[0].attempts[0];
  assert.equal(payload.metadata.strategy, "no-lsp");
  assert.equal(attempt.strategy, "no-lsp");
  assert.ok(attempt.estimatedTokens > 0);
  assert.ok(attempt.rgRawBytesExposed > 0);
  // Regression: evaluate() computes rTaskBlocking but attemptPayload() once
  // whitelisted quality fields without forwarding it, silently dropping the
  // field from every attempt (fixed alongside this test). taskBlockingFiles()
  // is mustHit UNION taskBlocking (5 files here); 3 of them (the mustHit
  // trio) are read, neither taskBlocking file (HiddenDto/BillingClient) is.
  assert.equal(attempt.rTaskBlocking, 0.6);
  assert.deepEqual(attempt.goldenAttribution.find((item: Record<string, unknown>) => item.file === "src/main/java/demo/DemoController.java"), {
    scenario: "DemoController#updateDemo",
    file: "src/main/java/demo/DemoController.java",
    kind: "must",
    inFiles: true,
    inReadPlan: true,
    source: "no-lsp",
    blockedBy: "hit",
    profile: "controller",
    semanticUsed: false
  });
  assert.deepEqual(attempt.goldenAttribution.find((item: Record<string, unknown>) => item.file === "src/main/java/demo/MissingService.java"), {
    scenario: "DemoController#updateDemo",
    file: "src/main/java/demo/MissingService.java",
    kind: "should",
    inFiles: false,
    inReadPlan: false,
    source: "absent",
    blockedBy: "absent",
    absentReason: "golden-stale-or-low-value",
    profile: "controller",
    semanticUsed: false
  });
  assert.deepEqual(attempt.goldenAttribution.find((item: Record<string, unknown>) => item.file === "src/main/java/hidden/HiddenDto.java"), {
    scenario: "DemoController#updateDemo",
    file: "src/main/java/hidden/HiddenDto.java",
    kind: "taskBlocking",
    inFiles: false,
    inReadPlan: false,
    source: "absent",
    blockedBy: "absent",
    absentReason: "no-type-edge",
    profile: "controller",
    semanticUsed: false
  });
  assert.deepEqual(attempt.goldenAttribution.find((item: Record<string, unknown>) => item.file === "modules/billing/src/main/java/external/BillingClient.java"), {
    scenario: "DemoController#updateDemo",
    file: "modules/billing/src/main/java/external/BillingClient.java",
    kind: "taskBlocking",
    inFiles: false,
    inReadPlan: false,
    source: "absent",
    blockedBy: "absent",
    absentReason: "cross-module-cold",
    profile: "controller",
    semanticUsed: false
  });
});

test("impact benchmark exposes timing diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-impact-timing-"));
  const srcDir = path.join(root, "src", "main", "java", "demo");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(srcDir, "DemoService.java"), [
    "package demo;",
    "public class DemoService {",
    "  public DemoResult execute(DemoCommand command) { return null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(srcDir, "DemoCommand.java"), "package demo; public record DemoCommand(String id) {}\n");
  await writeFile(path.join(srcDir, "DemoResult.java"), "package demo; public record DemoResult(String id) {}\n");

  const scenarioFile = path.join(root, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo-service-execute",
    name: "DemoService#execute",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/DemoService.java",
      line: 3,
      column: 21,
      profile: "service",
      taskKeywords: ["demo", "execute"]
    },
    golden: {
      mustHit: ["src/main/java/demo/DemoService.java"],
      taskBlocking: [],
      shouldHit: [],
      support: []
    }
  })}\n`);

  const indexCacheA = path.join(root, "index-cache-a");
  const benchmarkArgs = [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--strategy", "impact",
    "--runs", "1",
    "--verbosity", "diagnostic",
    "--read-plan-max-items", "3",
    "--read-plan-max-bytes", "2048",
    "--index-cache-dir", indexCacheA
  ];
  const spawnOptions = {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, JAVA_LSP_SHADOW_RANKING: "1" }
  } as const;
  const result = spawnSync(process.execPath, benchmarkArgs, spawnOptions);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const attempt = payload.rows[0].attempts[0];
  const timing = attempt.timing;
  assert.equal(payload.metadata.indexBackend, "v2");
  assert.equal(typeof payload.metadata.prepareJavaIndexMs, "number");
  assert.ok(payload.metadata.prepareJavaIndexMs >= 0);
  assert.equal(payload.metadata.prepareJavaIndexStatus.pendingBackground, 0);
  assert.equal(payload.metadata.readPlanMaxItems, 3);
  assert.equal(payload.metadata.readPlanMaxBytes, 2048);
  assert.ok(attempt.readPlanItems > 1, "the fixture must exercise a multi-file range batch");
  assert.ok(attempt.readPlanFiles > 1);
  assert.ok(attempt.readPlanRanges >= 1);
  assert.ok(attempt.readPlanBytes > 0);
  assert.ok(attempt.budgetUtilization > 0 && attempt.budgetUtilization <= 1);
  assert.equal(typeof attempt.budgetExceededByAnchor, "boolean");
  assert.equal(typeof attempt.marginalUtilityBySelectedFile, "object");
  assert.equal(attempt.roundTrips, 2, "one impact request and one batched range query replace per-read-plan-item round trips");
  assert.equal(typeof timing.phaseMs, "object");
  assert.equal(timing.semantic.policy, "fast");
  assert.equal(timing.semantic.used, false);
  assert.equal(typeof timing.typeReference, "object");
  assert.equal(typeof timing.typeReference.elapsedMs, "number");
  assert.equal(typeof timing.typeReference.indexHits, "number");
  assert.equal(typeof timing.typeReference.cacheMisses, "number");
  assert.equal(typeof timing.importGraph, "object");
  assert.equal(typeof timing.importGraph.elapsedMs, "number");
  assert.equal(typeof timing.importGraph.scannedAnchors, "number");
  assert.equal(typeof timing.persistedSemantic, "object");
  assert.equal(typeof timing.persistedSemantic.elapsedMs, "number");
  assert.equal(typeof timing.persistedSemantic.edgesSeen, "number");
  assert.equal(typeof attempt.shadowRanking, "object", "diagnostic benchmark attempts must retain opted-in shadow diagnostics");
  assert.equal(typeof attempt.shadowQuality, "object", "benchmark must score the shadow candidate and read-plan outputs against the same golden scenario");
  assert.equal(attempt.shadowQuality.rReadMust, 1);
  assert.equal(attempt.determinism.candidatePaths[0], "src/main/java/demo/DemoService.java");
  assert.deepEqual(
    [...attempt.determinism.candidatePaths.slice(1)].sort(),
    ["src/main/java/demo/DemoCommand.java", "src/main/java/demo/DemoResult.java"]
  );
  assert.equal(Array.isArray(attempt.determinism.familyScores), true, "Task 36 determinism evidence requires opted-in family scores");
  assert.deepEqual(
    attempt.determinism.readPlan.map((item: Record<string, unknown>) => item.path).sort(),
    ["src/main/java/demo/DemoCommand.java", "src/main/java/demo/DemoResult.java", "src/main/java/demo/DemoService.java"]
  );
  assert.deepEqual(attempt.determinism.completion, {
    semantic: "COMPLETE",
    semanticUsed: false,
    readiness: "NEW",
    coverage: "COMPLETE",
    requestGeneration: 0,
    indexedGeneration: 0,
    changedDuringRequest: false
  });

  const replayArgs = [...benchmarkArgs];
  replayArgs[replayArgs.indexOf(indexCacheA)] = path.join(root, "index-cache-b");
  const replay = spawnSync(process.execPath, replayArgs, spawnOptions);
  assert.equal(replay.status, 0, replay.stderr);
  const replayAttempt = JSON.parse(replay.stdout).rows[0].attempts[0];
  assert.deepEqual(
    replayAttempt.determinism,
    attempt.determinism,
    `two isolated cold indexes of the same unchanged repo must agree\nfirst=${JSON.stringify(attempt.determinism)}\nsecond=${JSON.stringify(replayAttempt.determinism)}`
  );
  assert.deepEqual(
    attempt.frameworkEvidence.mapstruct,
    { selected: 0, readPlan: 0, golden: 0, byKind: {} },
    "every impact attempt emits a stable MapStruct evidence summary, including zero-use repositories"
  );
});
