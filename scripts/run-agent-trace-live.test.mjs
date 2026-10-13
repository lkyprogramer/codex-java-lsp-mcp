import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TRACE_SCHEMA_VERSION
} from "./run-agent-trace-matrix.mjs";
import {
  ARM_SYSTEM_PROMPTS,
  LIVE_TRACE_SCHEMA_VERSION,
  armPromptFingerprint,
  MISS_DISCOVERY_GAP,
  MISS_IN_POOL_NOT_PACKED,
  MISS_SINGLE_ARM_MISS,
  buildPairedHitRate,
  classifyRequiredFile,
  collectCandidatePaths,
  collectImpactPaths,
  compactContextForModel,
  compactImpactForModel,
  liveJavaContextArgs,
  liveProjectCacheRoot,
  liveV1Fields,
  pairedHitRateFromN5Cells,
  parseHitFraction,
  selectLiveTasks,
  serenaUnavailableResult,
  summarizeLiveTasks,
  coverageProxy,
  impactSessionFromClient,
  runLiveAgentTask
} from "./run-agent-trace-live.mjs";
import { mergeUsage, openaiCompatibleChat, usageFromCompletion } from "./openai-compatible-chat.mjs";
import { parseAgentTraceCli, runAgentTraceMatrix } from "./run-agent-trace-matrix.mjs";
import { serializeModelToolResult } from "./eval-tool-wire.mjs";

test("live project cache is shared across arms so create can load a prewarmed snapshot", () => {
  const root = liveProjectCacheRoot("/tmp/l1", "lishuedu");
  assert.equal(root.endsWith(`${path.sep}mcp-cache${path.sep}lishuedu`) || root.endsWith("/mcp-cache/lishuedu"), true);
  assert.equal(root.includes(`${path.sep}old`), false);
  assert.equal(root.includes(`${path.sep}jin`), false);
});

test("selectLiveTasks with maxTasks 6 and onePerProject false returns all six holdouts", () => {
  const tasks = [
    { taskId: "lishuedu:a", projectId: "lishuedu" },
    { taskId: "lishuedu:b", projectId: "lishuedu" },
    { taskId: "cipherlink:a", projectId: "cipherlink" },
    { taskId: "cipherlink:b", projectId: "cipherlink" },
    { taskId: "exam-parent-v3:a", projectId: "exam-parent-v3" },
    { taskId: "exam-parent-v3:b", projectId: "exam-parent-v3" }
  ];
  const selected = selectLiveTasks(tasks, { maxTasks: 6, onePerProject: false });
  assert.deepEqual(selected.map(task => task.taskId), [
    "lishuedu:a",
    "lishuedu:b",
    "cipherlink:a",
    "cipherlink:b",
    "exam-parent-v3:a",
    "exam-parent-v3:b"
  ]);
});

test("selectLiveTasks picks the first holdout of each project", () => {
  const selected = selectLiveTasks([
    { taskId: "lishuedu:a", projectId: "lishuedu" },
    { taskId: "lishuedu:b", projectId: "lishuedu" },
    { taskId: "cipherlink:a", projectId: "cipherlink" },
    { taskId: "exam-parent-v3:a", projectId: "exam-parent-v3" }
  ], { maxTasks: 3, onePerProject: true });
  assert.deepEqual(selected.map(task => task.taskId), [
    "lishuedu:a",
    "cipherlink:a",
    "exam-parent-v3:a"
  ]);
  const second = selectLiveTasks([
    { taskId: "lishuedu:a", projectId: "lishuedu" },
    { taskId: "lishuedu:b", projectId: "lishuedu" },
    { taskId: "cipherlink:a", projectId: "cipherlink" },
    { taskId: "cipherlink:b", projectId: "cipherlink" },
    { taskId: "exam-parent-v3:a", projectId: "exam-parent-v3" },
    { taskId: "exam-parent-v3:b", projectId: "exam-parent-v3" }
  ], { maxTasks: 3, onePerProject: true, offset: 1 });
  assert.deepEqual(second.map(task => task.taskId), [
    "lishuedu:b",
    "cipherlink:b",
    "exam-parent-v3:b"
  ]);
});

test("T01: coverage proxy is renamed and can never claim task success", async () => {
  const mod = await import("./run-agent-trace-live.mjs");
  assert.equal(typeof mod.coverageProxy, "function", "taskSuccessFromCoverage must be renamed to coverageProxy");
  assert.equal(typeof mod.taskSuccessFromCoverage, "undefined", "no taskSuccessFromCoverage export may remain");
  const hit = mod.coverageProxy(["src/A.java", "src/B.java"], ["src/A.java", "src/B.java", "src/C.java"]);
  assert.equal(hit.success, true, "path proxy may report a complete hit");
  const outcome = mod.unmeasuredTaskOutcome();
  assert.equal(outcome.status, "UNMEASURED", "task outcome stays UNMEASURED until the external evaluator (T09)");
  assert.equal(outcome.authority, "external-evaluator");
});

test("T01: complete paths with a wrong answer never write PASS and empty observations stay UNMEASURED", async () => {
  const mod = await import("./run-agent-trace-live.mjs");
  const miss = mod.coverageProxy(["src/A.java", "src/MeQueryService.java"], []);
  assert.equal(miss.success, false, "empty observations must not be a complete proxy hit");
  assert.deepEqual(miss.missing, ["src/A.java", "src/MeQueryService.java"]);
  const outcome = mod.unmeasuredTaskOutcome();
  assert.notEqual(outcome.status, "PASS", "a path mention never sets task outcome to PASS");
  const summary = mod.summarizeLiveTasks([serenaUnavailableResult({ taskId: "lishuedu:a", requiredContextFiles: ["src/A.java"] })], {
    model: "test-model",
    baseUrlHost: "unparsed"
  });
  assert.equal(summary.taskOutcome?.status, "UNMEASURED", "summary taskOutcome must be UNMEASURED before T09");
  assert.equal(summary.taskSuccess?.status, "UNMEASURED", "proxy-only runs must not report a measured success rate");
});

test("T01: live result scopes are separated and source reports cannot overwrite runtime identity or outcome", async () => {
  const mod = await import("./run-agent-trace-live.mjs");
  const result = serenaUnavailableResult({ taskId: "lishuedu:a", requiredContextFiles: ["src/A.java"] });
  assert.equal(result.taskOutcome?.status, "UNMEASURED", "per-task results carry an explicit UNMEASURED task outcome");
  const summary = mod.summarizeLiveTasks([result], { model: "test-model", baseUrlHost: "unparsed" });
  assert.ok(summary.scopes, "summary must separate fixture/function/mcp/live/sourceReport scopes");
  for (const scope of ["fixture", "function", "mcp", "live", "sourceReport"]) {
    assert.ok(summary.scopes[scope], `missing scope ${scope}`);
  }
  assert.notEqual(summary.scopes.live.status, summary.scopes.sourceReport.status, "live and sourceReport must be distinct scopes");
  assert.equal(summary.scopes.sourceReport.status, "NOT_INCLUDED");
  const base = { installedRuntimeSha: "sha-abc", taskOutcome: summary.taskOutcome, modelUsage: summary.modelUsage };
  const merged = mod.mergeSourceReport(base, { installedRuntimeSha: "spoofed", taskOutcome: { status: "PASS" }, sourceProbe: { passed: 3, failed: 9 } });
  assert.equal(merged.installedRuntimeSha, "sha-abc", "source report must not overwrite installedRuntimeSha");
  assert.equal(merged.taskOutcome.status, "UNMEASURED", "source report must not overwrite task outcome");
  assert.equal(merged.sourceProbe?.failed, 9, "source reports may add their own scope data");
});

test("coverage success requires every required path and does not use model text", () => {
  const hit = coverageProxy(
    ["src/A.java", "src/B.java"],
    ["src/A.java", "src/B.java", "src/C.java"]
  );
  assert.equal(hit.success, true);
  const miss = coverageProxy(["src/A.java", "src/MeQueryService.java"], ["src/A.java"]);
  assert.equal(miss.success, false);
  assert.deepEqual(miss.missing, ["src/MeQueryService.java"]);
});

test("compact context uses selected spans and never includes scores or mustHit", () => {
  const compact = compactContextForModel({
    coverage: "PARTIAL",
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    anchor: { path: "src/A.java", symbol: "run" },
    resolvedAnchors: [{ path: "src/A.java", symbol: "run", layer: "graph" }],
    contexts: [{ path: "src/A.java", role: "ANCHOR", proof: ["DECLARES"], spans: [{ start: 1, end: 4, text: "class A {}" }] }],
    unresolved: [],
    next: [],
    score: 0.9
  });
  assert.equal(compact.paths.includes("src/A.java"), true);
  assert.equal(compact.text.includes("mustHit"), false);
  assert.equal(compact.text.includes("score"), false);
  assert.equal(compact.text.includes("DECLARES"), false);
  assert.equal(compact.text.includes("class A {}"), false);
  assert.equal(compact.text.includes("resolvedIntent"), false);
  assert.equal(compact.text.includes("\"anchor\""), false);
  assert.equal(compact.text.includes("\"ranges\":\"1-4\""), true);
});

test("C2 slim context P50 is at most 1.2 of impact compact on six first-call shapes", () => {
  const pairs = [
    firstCallPair(13, 24, 4),
    firstCallPair(10, 24, 4),
    firstCallPair(11, 24, 4),
    firstCallPair(12, 24, 4),
    firstCallPair(8, 24, 4),
    firstCallPair(12, 24, 4)
  ];
  const ratios = pairs.map(([context, impact]) => {
    const contextBytes = Buffer.byteLength(compactContextForModel(context).text, "utf8");
    const impactBytes = Buffer.byteLength(compactImpactForModel(impact).text, "utf8");
    return contextBytes / impactBytes;
  });
  const ordered = [...ratios].sort((left, right) => left - right);
  const p50 = ordered[Math.floor((ordered.length - 1) / 2)];
  assert.ok(p50 <= 1.2, `p50=${p50} ratios=${ratios.map(value => value.toFixed(3)).join(",")}`);
});

function firstCallPair(impactFiles, candidateCount, evidenceCount) {
  const files = Array.from({ length: impactFiles }, (_, index) => ({
    id: String(index + 1),
    path: `src/mod/File${index}.java`,
    role: index === 0 ? "anchor" : "related",
    confidence: "high"
  }));
  const impact = {
    files,
    readPlan: files.slice(0, Math.min(6, files.length)).map(file => ({
      fileId: file.id,
      ranges: [{ startLine: 1, endLine: 40 }],
      estimatedBytes: 1200,
      reason: "impact"
    })),
    evidenceGaps: ["gap"]
  };
  const context = {
    coverage: "PARTIAL",
    candidates: Array.from({ length: candidateCount }, (_, index) => ({
      path: `src/mod/File${index}.java`,
      role: index === 0 ? "ANCHOR" : "CALLEE",
      hop: index === 0 ? 0 : 1,
      reason: index === 0 ? "ANCHOR" : "CALLS_EXACT←Svc.run"
    })),
    evidence: Array.from({ length: evidenceCount }, (_, index) => ({
      path: `src/mod/File${index}.java`,
      role: index === 0 ? "ANCHOR" : "CALLEE",
      ranges: "12-48,60-75"
    })),
    unresolved: [{ path: "src/mod/File8.java", role: "entity" }],
    next: [{ action: "navigate", file: "src/mod/File8.java", line: 1, direction: "callees", reason: "entity" }]
  };
  return [context, impact];
}

test("live java_context args default to search and never send scenarioId as task", () => {
  const args = liveJavaContextArgs(
    { intent: "auto" },
    {
      scenarioId: "paper-task-claim-iam-holdout",
      taskText: "PaperTaskCommandAppService claim operator identity",
      anchor: { file: "src/A.java", line: 12, column: 4 }
    },
    { sessionId: "live:demo:jin", generation: 0 }
  );
  assert.equal(args.mode, "search");
  assert.equal(args.file, "src/A.java");
  assert.equal(args.task, "PaperTaskCommandAppService claim operator identity");
  assert.equal(args.sessionId, "live:demo:jin");
  assert.equal(JSON.stringify(args).includes("paper-task-claim-iam-holdout"), false);
  const ignored = liveJavaContextArgs(
    { intent: "auto", task: "paper-task-claim-iam-holdout" },
    {
      scenarioId: "paper-task-claim-iam-holdout",
      taskText: "claim paper task identity",
      anchor: { file: "src/A.java", line: 1, column: 1 }
    }
  );
  assert.equal(ignored.task, "claim paper task identity");
});

test("E2 arm prompts are symmetric and drop navigate suppression", () => {
  assert.equal(ARM_SYSTEM_PROMPTS.jin.includes("Prefer one search"), false);
  assert.equal(ARM_SYSTEM_PROMPTS.jin.includes("Do not use mode=navigate"), false);
  assert.equal(ARM_SYSTEM_PROMPTS.old.includes("Prefer one search"), false);
  assert.match(ARM_SYSTEM_PROMPTS.old, /java_impact tool only/);
  assert.match(ARM_SYSTEM_PROMPTS.jin, /java_context tool only/);
  assert.match(ARM_SYSTEM_PROMPTS.jin, /Intent is required/);
  assert.match(ARM_SYSTEM_PROMPTS.old, /unresolved \/ next \/ evidenceGaps/);
  assert.match(ARM_SYSTEM_PROMPTS.jin, /unresolved \/ next \/ evidenceGaps/);
  assert.match(ARM_SYSTEM_PROMPTS.old, /8-round limit/);
  assert.match(ARM_SYSTEM_PROMPTS.jin, /8-round limit/);
  const oldFp = armPromptFingerprint("old");
  const jinFp = armPromptFingerprint("jin");
  assert.equal(oldFp.text, ARM_SYSTEM_PROMPTS.old);
  assert.equal(jinFp.text, ARM_SYSTEM_PROMPTS.jin);
  assert.equal(oldFp.sha256.length, 64);
  assert.notEqual(oldFp.sha256, jinFp.sha256);
  const summary = summarizeLiveTasks([], { model: "demo", baseUrlHost: "example.test" });
  assert.equal(summary.promptFingerprints.old.sha256, oldFp.sha256);
  assert.equal(summary.promptFingerprints.jin.sha256, jinFp.sha256);
});

test("serena unavailable is unscored UNMEASURED, never TaskSuccess 0", () => {
  const result = serenaUnavailableResult({
    taskId: "demo:t",
    requiredContextFiles: ["src/A.java"]
  });
  assert.equal(result.stopReason, "SERENA_UNAVAILABLE");
  assert.equal(result.taskSuccess, null);
  assert.equal(result.usage.status, "UNMEASURED");
  const summary = summarizeLiveTasks([result], { model: "demo", baseUrlHost: "example.test" });
  assert.equal(summary.taskSuccess.status, "UNMEASURED");
  assert.equal(summary.taskSuccess.mean, null);
  assert.equal(summary.successLayers.patchGeneration.status, "UNMEASURED");
  assert.equal(summary.arms[0].status, "UNAVAILABLE");
});

test("jin arm records coverage from java_context spans", async () => {
  let called = false;
  const result = await runLiveAgentTask({
    task: {
      taskId: "demo:t",
      projectId: "demo",
      scenarioId: "t",
      requiredContextFiles: ["src/A.java"],
      anchor: { file: "src/A.java", line: 1, column: 1 }
    },
    arm: "jin",
    tools: [{ type: "function", function: { name: "java_context" } }],
    chat: async ({ tools }) => {
      assert.equal(tools[0].function.name, "java_context");
      if (called) {
        return {
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        };
      }
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{
              id: "c1",
              function: { name: "java_context", arguments: JSON.stringify({ intent: "auto", file: "src/A.java", line: 1, column: 1 }) }
            }]
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      };
    },
    invoke: async (name) => {
      assert.equal(name, "java_context");
      called = true;
      return {
        coverage: "PARTIAL",
        contexts: [{ path: "src/A.java", role: "ANCHOR", proof: ["DECLARES"], spans: [{ start: 1, end: 2 }] }]
      };
    }
  });
  assert.equal(result.arm, "jin");
  assert.equal(result.taskSuccess, true);
  assert.equal(result.toolCallCount, 1);
});

test("jin candidatePaths count as coverage hits after E3", async () => {
  const result = await runLiveAgentTask({
    task: {
      taskId: "demo:t",
      projectId: "demo",
      scenarioId: "t",
      requiredContextFiles: ["src/A.java", "src/Hidden.java"],
      anchor: { file: "src/A.java", line: 1, column: 1 }
    },
    arm: "jin",
    tools: [{ type: "function", function: { name: "java_context" } }],
    chat: async () => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{
            id: "c1",
            function: { name: "java_context", arguments: JSON.stringify({ intent: "auto" }) }
          }]
        }
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    invoke: async () => ({
      contexts: [{ path: "src/A.java", role: "ANCHOR", spans: [{ start: 1, end: 2 }] }],
      evidence: [{ path: "src/A.java", role: "ANCHOR", spans: [{ start: 1, end: 2 }] }],
      candidates: [{ path: "src/Hidden.java", role: "CALLEE", hop: 1, reason: "CALLS_EXACT←A.run" }]
    }),
    maxRounds: 1
  });
  assert.equal(result.taskSuccess, true);
  assert.deepEqual(result.coverage.missing, []);
  assert.deepEqual(result.candidatePaths, ["src/Hidden.java"]);
});

test("compact impact never includes golden names and truncates large payloads", () => {
  const compact = compactImpactForModel({
    files: [{ id: "1", path: "src/A.java", role: "anchor", confidence: "high" }],
    readPlan: [{ fileId: "1", ranges: [{ startLine: 1, endLine: 2 }], estimatedBytes: 10, reason: "anchor" }],
    evidenceGaps: ["gap"]
  }, 40);
  assert.equal(compact.paths.includes("src/A.java"), true);
  assert.equal(compact.text.includes("mustHit"), false);
  assert.match(compact.text, /truncated|src\/A\.java/);
});

test("missing usage stays UNMEASURED instead of 0", () => {
  assert.equal(usageFromCompletion({}).status, "UNMEASURED");
  assert.equal(mergeUsage({ status: "UNMEASURED" }, { status: "UNMEASURED" }).status, "UNMEASURED");
});

test("openai client disables Qwen thinking via chat_template_kwargs", async () => {
  let body;
  let url;
  await openaiCompatibleChat({
    baseUrl: "http://47.106.205.246:1082/v1",
    apiKey: "sk-test",
    model: "demo",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (posted, init) => {
      url = posted;
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    }
  });
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(url, "http://47.106.205.246:1082/v1/chat/completions");
});

test("FAILED_RUNTIME and FAILED_CONTEXT_CAP are excluded from TaskSuccess mean", () => {
  const summary = summarizeLiveTasks([
    { taskSuccess: true, usage: { status: "MEASURED", totalTokens: 10 }, toolCallCount: 1 },
    { taskSuccess: null, stopReason: "FAILED_CONTEXT_CAP", usage: { status: "UNMEASURED" }, toolCallCount: 0 },
    { taskSuccess: null, stopReason: "FAILED_RUNTIME", usage: { status: "UNMEASURED" }, toolCallCount: 0 }
  ], { model: "demo", baseUrlHost: "example.test" });
  assert.equal(summary.taskSuccess.status, "MEASURED");
  assert.equal(summary.taskSuccess.tasks, 3);
  assert.equal(summary.taskSuccess.scored, 1);
  assert.equal(summary.taskSuccess.mean, 1);
  assert.equal(summary.lambdaMagnitude.scalarAllowed, false);
});

test("matrix and live report schemas are v2", () => {
  assert.equal(AGENT_TRACE_SCHEMA_VERSION, "java-intelligence-jin-n5-three-arm-trace/v2");
  assert.equal(LIVE_TRACE_SCHEMA_VERSION, "java-intelligence-v5r-live-agent-trace/v2");
});

test("candidates and path-like unresolved enter observed paths", () => {
  const result = {
    candidates: [{ path: "src/Hidden.java", role: "CALLEE", hop: 1, reason: "CALLS_EXACT←A.run" }],
    evidence: [{ path: "src/A.java", role: "ANCHOR" }],
    contexts: [{ path: "src/A.java", role: "ANCHOR" }],
    files: [{ id: "1", path: "src/B.java" }],
    unresolved: [{ id: "src/Gap.java", role: "entity" }, { id: "O3", role: "entity" }]
  };
  assert.deepEqual(collectImpactPaths(result).sort(), ["src/A.java", "src/B.java", "src/Gap.java", "src/Hidden.java"]);
  assert.deepEqual(collectCandidatePaths(result), ["src/Hidden.java"]);
});

test("miss labels follow pool then single-arm then discovery-gap", () => {
  assert.equal(classifyRequiredFile("a", { oldHit: true, jinHit: true, inPool: true }), null);
  assert.equal(classifyRequiredFile("b", { oldHit: false, jinHit: false, inPool: false }), MISS_DISCOVERY_GAP);
  assert.equal(classifyRequiredFile("c", { oldHit: true, jinHit: false, inPool: true }), MISS_IN_POOL_NOT_PACKED);
  assert.equal(classifyRequiredFile("d", { oldHit: false, jinHit: false, inPool: true }), MISS_IN_POOL_NOT_PACKED);
  assert.equal(classifyRequiredFile("e", { oldHit: true, jinHit: false, inPool: false }), MISS_SINGLE_ARM_MISS);
});

test("paired hit-rate is per-task and reports unreachable-excluding mean", () => {
  const paired = buildPairedHitRate([
    {
      taskId: "demo:t1",
      arm: "old",
      taskSuccess: false,
      coverage: { required: 2, hit: 1, success: false, missing: ["src/Gap.java"] }
    },
    {
      taskId: "demo:t1",
      arm: "jin",
      taskSuccess: false,
      coverage: { required: 2, hit: 1, success: false, missing: ["src/Gap.java"] },
      candidatePaths: ["src/Packed.java"]
    },
    {
      taskId: "demo:t2",
      arm: "old",
      taskSuccess: true,
      coverage: { required: 2, hit: 2, success: true, missing: [] }
    },
    {
      taskId: "demo:t2",
      arm: "jin",
      taskSuccess: false,
      coverage: { required: 2, hit: 1, success: false, missing: ["src/Packed.java"] },
      candidatePaths: ["src/Packed.java"]
    }
  ]);
  assert.equal(paired.tasks.length, 2);
  assert.equal(paired.tasks[0].old, 0.5);
  assert.equal(paired.tasks[0].jin, 0.5);
  assert.equal(paired.tasks[0].delta, 0);
  assert.equal(paired.tasks[1].delta, -0.5);
  assert.equal(paired.direction.jinWorse, 1);
  assert.equal(paired.direction.tie, 1);
  assert.equal(paired.unreachableRequired.length, 1);
  assert.equal(paired.unreachableRequired[0].file, "src/Gap.java");
  assert.equal(paired.tasks[0].excludingUnreachable.old, 1);
  assert.equal(paired.misses.some(row => row.file === "src/Packed.java" && row.label === MISS_IN_POOL_NOT_PACKED), true);
});

test("T2 N5-02 replay keeps v1 fields and adds paired hit-rate", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const anchor = JSON.parse(readFileSync(path.join(root, "docs/phase-e/e1-n5-02-v1-anchor.json"), "utf8"));
  const summary = JSON.parse(readFileSync(path.join(root, "docs/phase-jin/jin-n5-02-live-summary.json"), "utf8"));
  const recomputed = summarizeLiveTasks(anchor.tasks, {
    model: anchor.liveV1.model,
    baseUrlHost: anchor.liveV1.baseUrlHost,
    contextWindowTokens: anchor.liveV1.contextWindowTokens
  });
  const v1 = liveV1Fields(recomputed);
  assert.deepEqual(v1.taskSuccess, anchor.liveV1.taskSuccess);
  assert.deepEqual(v1.successLayers, anchor.liveV1.successLayers);
  assert.deepEqual(v1.arms, anchor.liveV1.arms);
  assert.deepEqual(v1.modelUsage, anchor.liveV1.modelUsage);
  assert.deepEqual(v1.lambdaMagnitude, anchor.liveV1.lambdaMagnitude);
  assert.deepEqual(v1.blindReview, anchor.liveV1.blindReview);
  assert.equal(v1.taskSuccess.successes, 1);
  assert.equal(v1.arms.find(arm => arm.arm === "old").successes, 1);
  assert.equal(v1.arms.find(arm => arm.arm === "jin").successes, 0);
  assert.equal(recomputed.pairedHitRate.direction.n, 6);
  assert.equal(recomputed.pairedHitRate.direction.jinWorse, 6);
  assert.equal(recomputed.pairedHitRate.direction.jinBetter, 0);
  assert.ok(recomputed.pairedHitRate.mean.delta < 0);
  const cellsReplay = pairedHitRateFromN5Cells(summary.cells);
  assert.deepEqual(summary.cells, JSON.parse(readFileSync(path.join(root, "docs/phase-jin/jin-n5-02-live-summary.json"), "utf8")).cells);
  assert.equal(cellsReplay.direction.jinWorse, 6);
  assert.equal(cellsReplay.tasks.length, 6);
  for (const cell of summary.cells) {
    const parsed = parseHitFraction(cell.old.hit);
    const row = recomputed.pairedHitRate.tasks.find(task => task.oldHit === cell.old.hit && task.jinHit === cell.jin.hit);
    assert.ok(row, cell.task);
    assert.equal(row.oldHit, cell.old.hit);
    assert.equal(row.jinHit, cell.jin.hit);
    assert.equal(row.old, parsed.rate);
  }
  assert.equal(summary.schemaVersion, "java-intelligence-jin-n5-three-arm-trace/v1");
  assert.equal(summary.taskSuccess.successes, 1);
  const contextReplay = JSON.parse(readFileSync(path.join(root, "docs/phase-jin/jin-n5-context-replay.json"), "utf8"));
  const candidatePoolByTask = {};
  for (const result of anchor.tasks) {
    if (result.arm !== "old") continue;
    const scenarioId = result.taskId.split(":").slice(1).join(":");
    candidatePoolByTask[result.taskId] = contextReplayPool(contextReplay, scenarioId);
  }
  const withPool = summarizeLiveTasks(anchor.tasks, {
    model: anchor.liveV1.model,
    baseUrlHost: anchor.liveV1.baseUrlHost,
    contextWindowTokens: anchor.liveV1.contextWindowTokens,
    candidatePoolByTask
  });
  assert.deepEqual(liveV1Fields(withPool).taskSuccess, anchor.liveV1.taskSuccess);
  const meQuery = withPool.pairedHitRate.misses.find(row => row.file.endsWith("MeQueryService.java"));
  assert.equal(meQuery.label, MISS_IN_POOL_NOT_PACKED);
  const payAccount = withPool.pairedHitRate.misses.find(row => row.file.endsWith("PayAccount.java"));
  assert.equal(payAccount.label, MISS_IN_POOL_NOT_PACKED);
  const printJob = withPool.pairedHitRate.misses.find(row => row.file.endsWith("ExamRoomPrintBundleJob.java"));
  assert.equal(printJob.label, MISS_DISCOVERY_GAP);
});

function contextReplayPool(replay, scenarioId) {
  const paths = new Set();
  for (const row of replay.results ?? []) {
    if (row.scenarioId !== scenarioId) continue;
    for (const file of row.selected ?? []) paths.add(file);
    for (const file of row.gateTargetsDiscovered ?? []) paths.add(file);
  }
  return [...paths];
}

test("execute-live is required after authorization; key alone still does not send", async () => {
  const result = await runAgentTraceMatrix(parseAgentTraceCli(
    ["--authorize-external"],
    { OPENAI_API_KEY: "sk-test" }
  ));
  assert.equal(result.status, "READY_BUT_NOT_EXECUTED");
  assert.equal(result.modelUsage.status, "UNMEASURED");
});

test("live agent task stops with FAILED_CONTEXT_CAP before calling chat when prompt is already over cap", async () => {
  let chats = 0;
  const result = await runLiveAgentTask({
    task: {
      taskId: "demo:t",
      projectId: "demo",
      scenarioId: "t",
      requiredContextFiles: ["src/A.java"],
      anchor: { file: "src/A.java", line: 1, column: 1 }
    },
    chat: async () => {
      chats += 1;
      return { choices: [{ message: { content: "ok" } }] };
    },
    impact: async () => ({ files: [], readPlan: [] }),
    promptCap: 1
  });
  assert.equal(chats, 0);
  assert.equal(result.contextCapped, true);
  assert.equal(result.taskSuccess, null);
  assert.equal(result.stopReason, "FAILED_CONTEXT_CAP");
});

test("impact error is returned to the model and does not drop measured usage", async () => {
  let impacts = 0;
  const result = await runLiveAgentTask({
    task: {
      taskId: "demo:t",
      projectId: "demo",
      scenarioId: "t",
      requiredContextFiles: ["src/A.java"],
      anchor: { file: "src/A.java", line: 1, column: 1 }
    },
    chat: async ({ messages }) => {
      const toolText = messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
      if (toolText.includes("src/A.java")) {
        return {
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
        };
      }
      if (toolText.includes("Deadline exceeded")) {
        return {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{
                id: "c2",
                function: { name: "java_impact", arguments: JSON.stringify({ file: "src/A.java", line: 1, column: 1 }) }
              }]
            }
          }],
          usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 }
        };
      }
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{
              id: "c1",
              function: { name: "java_impact", arguments: JSON.stringify({ file: "src/A.java", line: 1, column: 1 }) }
            }]
          }
        }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
      };
    },
    impact: async () => {
      impacts += 1;
      if (impacts === 1) return { error: "Deadline exceeded during runtime.create after 654ms" };
      return { files: [{ id: "1", path: "src/A.java", role: "anchor" }], readPlan: [] };
    }
  });
  assert.equal(impacts, 2);
  assert.equal(result.taskSuccess, true);
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.usage.status, "MEASURED");
  assert.equal(result.usage.totalTokens, 25);
});

test("live agent task records coverage from tool results without sending mustHit to the model", async () => {
  const result = await runLiveAgentTask({
    task: {
      taskId: "demo:t",
      projectId: "demo",
      scenarioId: "t",
      requiredContextFiles: ["src/A.java"],
      anchor: { file: "src/A.java", line: 1, column: 1 }
    },
    chat: async ({ messages }) => {
      assert.equal(JSON.stringify(messages).includes("mustHit"), false);
      if (messages.some(message => message.role === "tool")) {
        return {
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        };
      }
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{
              id: "c1",
              function: { name: "java_impact", arguments: JSON.stringify({ file: "src/A.java", line: 1, column: 1 }) }
            }]
          }
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      };
    },
    impact: async () => ({
      files: [{ id: "1", path: "src/A.java", role: "anchor" }],
      readPlan: [{ fileId: "1", ranges: [{ startLine: 1, endLine: 2 }], estimatedBytes: 4 }]
    })
  });
  assert.equal(result.taskSuccess, true);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.usage.status, "MEASURED");
  assert.equal(result.usage.totalTokens, 40);
});

const auditTask = {
  taskId: "audit:repair",
  projectId: "fixture",
  requiredContextFiles: [],
  anchor: { file: "A.java", line: 1, column: 1 }
};

for (const [finishReason, expected] of [["length", "MAX_COMPLETION_TOKENS"], ["stop", "MODEL_STOP"]]) {
  test(`forced packaging preserves primary ${expected} and raw completion`, async () => {
    const requests = [];
    const responses = [];
    let step = 0;
    const result = await runLiveAgentTask({
      task: auditTask,
      maxRounds: 16,
      tools: [{ type: "function", function: { name: "write_file" } }],
      chatRequestConfig: { reasoningEffort: "none", chatTemplateKwargs: { enable_thinking: false }, apiKey: "must-not-log" },
      onChat: request => requests.push(request),
      onCompletion: response => responses.push(response),
      chat: async request => {
        step += 1;
        assert.equal(request.reasoningEffort, "none");
        assert.deepEqual(request.chatTemplateKwargs, { enable_thinking: false });
        assert.equal(request.maxTokens, 2048);
        assert.equal(request.apiKey, undefined);
        return {
          id: `response-${step}`,
          model: "fixture-model",
          debug: { apiKey: "must-not-log" },
          choices: [{ index: 0, finish_reason: step === 1 ? finishReason : "stop", message: {
            role: "assistant", content: step === 1 ? "" : '{"patchApplied":false}', debug: "must-not-log"
          } }],
          usage: { prompt_tokens: 10, completion_tokens: step === 1 ? 2048 : 2, total_tokens: step === 1 ? 2058 : 12 }
        };
      }
    });
    assert.equal(result.stopReason, "FORCED_ANSWER", "legacy packaging flag remains compatible");
    assert.equal(result.primaryStopReason, expected);
    assert.equal(result.finalAnswerMode, "FORCED_ANSWER");
    assert.equal(result.toolCallCount, 0, "a forced claim cannot create a patch");
    assert.equal(step, 2, "empty completion stops before the round limit");
    assert.deepEqual(requests.map(r => [r.requestIndex, r.forcedAnswer]), [[0, false], [1, true]]);
    assert.deepEqual(responses.map(r => [r.requestIndex, r.forcedAnswer]), [[0, false], [1, true]]);
    assert.deepEqual(requests[0].requestConfig, { max_tokens: 2048, reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(requests[1].tools, []);
    assert.equal(responses[0].response.choices[0].finish_reason, finishReason);
    assert.equal(responses[0].response.choices[0].message.content, "");
    assert.equal(responses[0].response.usage.completion_tokens, 2048);
    assert.equal(JSON.stringify({ requests, responses }).includes("must-not-log"), false);
  });
}

test("round exhaustion keeps its primary cause and forced request attaches the final tool receipt", async () => {
  const requests = [];
  const completions = [];
  const call = { id: "last-read", type: "function", function: { name: "read", arguments: '{"path":"A.java"}' } };
  const result = await runLiveAgentTask({
    task: auditTask,
    maxRounds: 1,
    tools: [{ type: "function", function: { name: "read" } }],
    invoke: async () => ({ path: "A.java", startLine: 1, text: "int n=1;\n", contentHash: "f".repeat(64) }),
    onChat: request => requests.push(request),
    onCompletion: response => completions.push(response),
    chat: async ({ tools }) => tools.length
      ? { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [call] } }] }
      : { choices: [{ finish_reason: "stop", message: { content: "{}" } }] }
  });
  assert.equal(result.primaryStopReason, "MAX_ROUNDS");
  assert.equal(result.finalAnswerMode, "FORCED_ANSWER");
  assert.equal(requests[1].newReceipts[0].callId, "last-read");
  assert.deepEqual(completions[0].response.choices[0].message.tool_calls, [call]);
});

test("normal model answer and failed runtime remain separate from forced packaging", async () => {
  for (const fail of [false, true]) {
    let responses = 0;
    const result = await runLiveAgentTask({
      task: auditTask,
      onCompletion: () => responses += 1,
      chat: async () => {
        if (fail) throw new Error("fixture connection failed");
        return { choices: [{ finish_reason: "stop", message: { content: "{}" } }] };
      }
    });
    assert.equal(result.primaryStopReason, fail ? "FAILED_RUNTIME" : "MODEL_STOP");
    assert.equal(result.finalAnswerMode, fail ? "NO_ANSWER" : "MODEL_ANSWER");
    assert.equal(responses, fail ? 0 : 1);
  }
});

test("discovery MCP forwards every advertised argument and keeps none/window source receipts exact", async () => {
  const captured = [];
  const source = "  boolean allowed() {\n    return true;\n  }\n";
  const client = {
    async callTool(request) {
      captured.push(request);
      const candidate = {
        declaration: { id: "m", name: "allowed", relativePath: "A.java", contentHash: "f".repeat(64), selection: { line: 4, column: 3 } }
      };
      if (request.arguments.preview === "window") Object.assign(candidate, {
        preview: source, previewKind: "source", evidenceRange: { startLine: 4, endLine: 6 }
      });
      return { content: [{ type: "text", text: JSON.stringify({ schemaVersion: "java-discovery/v1", candidates: [candidate] }) }] };
    }
  };
  const session = impactSessionFromClient({ repoRoot: "/isolated/fixture", client });
  for (const preview of ["none", "window"]) {
    const args = { query: "allowed", terms: ["allowed"], searchMode: "exact", limit: 3, module: "core", sourceSet: "main", preview };
    const raw = await session.symbol(args);
    assert.deepEqual(captured.at(-1), { name: "java_symbol", arguments: { repoRoot: "/isolated/fixture", ...args } });
    const serialized = serializeModelToolResult("java_symbol", raw);
    assert.equal(serialized.slices.length, preview === "none" ? 0 : 1);
    if (preview === "window") {
      assert.deepEqual(serialized.slices[0], {
        path: "A.java", startLine: 4, endLine: 6, text: source, fileContentHash: "f".repeat(64),
        sliceHash: createHash("sha256").update(source, "utf8").digest("hex")
      });
      assert.equal(JSON.parse(serialized.content).candidates[0].preview, source);
    }
  }
});

const submitCall = (args = '{"answer":"structurally valid"}', id = "submit") => ({ id, type: "function", function: { name: "submit_answer", arguments: args } });
const readCall = { id: "read-source", type: "function", function: { name: "read", arguments: '{"path":"A.java"}' } };
const toolCompletion = (calls, finish_reason = "tool_calls", content = null) => ({ choices: [{ finish_reason, message: { content, tool_calls: calls } }] });
const typedOptions = { task: auditTask, tools: [{ type: "function", function: { name: "read" } }], submission: { answerKeys: { answer: "string" } } };

test("public recovery identifies the violated field rule and allows only one existing-fact submission", async () => {
  const fields = { answer: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", description: "Simple method name." } };
  let requests = 0;
  let invokes = 0;
  const result = await runLiveAgentTask({ ...typedOptions,
    submission: { answerKeys: { answer: "string" }, fields, contract: { version: "public-test/v1", sha256: "c".repeat(64) } },
    invoke: async () => { invokes++; throw new Error("recovery may not fetch source"); },
    chat: async ({ tools, messages }) => {
      requests++;
      if (requests === 1) {
        assert.equal(tools.at(-1).function.parameters.properties.answer.pattern, fields.answer.pattern);
        return toolCompletion([submitCall('{"answer":"pkg.Owner#method"}')]);
      }
      assert.deepEqual(tools.map(t => t.function.name), ["submit_answer"]);
      assert.match(messages.at(-1).content, /answer.*pattern/i);
      return toolCompletion([submitCall('{"answer":"method"}')]);
    }
  });
  assert.equal(requests, 2);
  assert.equal(invokes, 0);
  assert.equal(result.submission.recoveryCount, 1);
  assert.deepEqual(result.submission.acceptedAnswer, { answer: "method" });
  assert.equal(result.submission.attempts[0].accepted, false);
  assert.equal(result.submission.attempts[0].rawArguments, '{"answer":"pkg.Owner#method"}');
  assert.deepEqual(result.submission.publicContract, { version: "public-test/v1", sha256: "c".repeat(64) });
});

test("typed submission succeeds in one request and preserves raw draft without cleanup", async () => {
  let requests = 0;
  const draft = '<think>draft</think> {"answer":"unsubmitted"}';
  const result = await runLiveAgentTask({ ...typedOptions, chat: async ({ tools }) => {
    requests += 1;
    assert.deepEqual(tools.map(tool => tool.function.name), ["read", "submit_answer"]);
    return toolCompletion([submitCall()], "tool_calls", draft);
  } });
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "SUBMITTED");
  assert.equal(result.finalAnswerMode, "SUBMITTED");
  assert.deepEqual(JSON.parse(result.finalContent), { answer: "structurally valid" });
  assert.equal(result.submission.drafts[0].rawContent, draft);
  assert.equal(result.submission.attempts[0].rawArguments, '{"answer":"structurally valid"}');
  assert.equal(result.submission.recoveryCount, 0);
  assert.deepEqual(result.submission.receipts, []);
});

test("typed read then submit freezes only previously dispatched receipts even without onChat", async () => {
  for (const withCallback of [false, true]) {
    let step = 0;
    const requests = [];
    const result = await runLiveAgentTask({ ...typedOptions,
      ...(withCallback ? { onChat: async request => { await Promise.resolve(); requests.push(request); } } : {}),
      invoke: async () => ({ path: "A.java", startLine: 2, text: "int value = 1;\n", contentHash: "f".repeat(64) }),
      chat: async () => ++step === 1 ? toolCompletion([readCall]) : toolCompletion([submitCall()])
    });
    assert.equal(step, 2);
    assert.equal(result.submission.acceptedRequestIndex, 1);
    assert.deepEqual(result.submission.receipts.map(receipt => receipt.callId), ["read-source"]);
    assert.equal(result.submission.receipts[0].slices[0].startLine, 2);
    assert.equal(result.submission.receipts[0].slices[0].text, "int value = 1;\n");
    if (withCallback) assert.equal(requests[1].newReceipts[0].contentHash, result.submission.receipts[0].contentHash);
  }
});

for (const [label, first] of [
  ["prose draft", { choices: [{ finish_reason: "stop", message: { content: 'prefix {"answer":"value"} </function>' } }] }],
  ["duplicate keys", toolCompletion([submitCall('{"answer":"a","answer":"b"}')])],
  ["wrong type", toolCompletion([submitCall('{"answer":false}')])],
  ["extra key", toolCompletion([submitCall('{"answer":"a","extra":1}')])],
  ["length-truncated valid JSON", toolCompletion([submitCall()], "length")],
  ["mixed unseen read", toolCompletion([readCall, submitCall()])]
]) {
  test(`typed ${label} gets only one public-contract recovery without invoking rejected actions`, async () => {
    let step = 0;
    let invoked = 0;
    const requests = [];
    const result = await runLiveAgentTask({ ...typedOptions,
      onChat: request => requests.push(request),
      invoke: async () => { invoked += 1; throw new Error("must not invoke"); },
      chat: async ({ tools, messages }) => {
        step += 1;
        if (step === 1) return first;
        assert.deepEqual(tools.map(tool => tool.function.name), ["submit_answer"]);
        assert.equal(messages.at(-1).content.includes("Public submission contract recovery"), true);
        return toolCompletion([submitCall()]);
      }
    });
    assert.equal(invoked, 0);
    assert.equal(step, 2);
    assert.equal(result.stopReason, "SUBMITTED");
    assert.equal(result.primaryStopReason, label === "length-truncated valid JSON" ? "MAX_COMPLETION_TOKENS" : "INVALID_SUBMISSION");
    assert.equal(result.submission.recoveryCount, 1);
    assert.equal(result.submission.receipts.some(receipt => receipt.slices.length > 0), false);
    const firstCalls = first.choices[0].message.tool_calls ?? [];
    assert.equal(result.toolCallCount, firstCalls.length + 1);
    assert.deepEqual(requests[1].messages.filter(message => message.role === "tool").map(message => message.tool_call_id), firstCalls.map(call => call.id));
    if (label === "prose draft") assert.equal(result.submission.drafts[0].rawContent, first.choices[0].message.content);
  });
}

test("invalid recovery remains failure and cannot call another action", async () => {
  let requests = 0;
  let invokes = 0;
  const result = await runLiveAgentTask({ ...typedOptions,
    invoke: async () => { invokes += 1; },
    chat: async () => ++requests === 1 ? toolCompletion([submitCall('{}')]) : toolCompletion([readCall])
  });
  assert.equal(requests, 2);
  assert.equal(invokes, 0);
  assert.equal(result.stopReason, "INVALID_SUBMISSION");
  assert.equal(result.finalAnswerMode, "NO_SUBMISSION");
  assert.equal(result.finalContent, "");
  assert.equal(result.submission.acceptedAnswer, null);
  assert.equal(result.submission.recoveryCount, 1);
});

test("typed recovery respects round and context caps and never forces an extra request", async () => {
  let requests = 0;
  const exhausted = await runLiveAgentTask({ ...typedOptions, maxRounds: 1,
    invoke: async () => ({ path: "A.java", startLine: 1, text: "value\n" }),
    chat: async () => { requests += 1; return toolCompletion([readCall]); }
  });
  assert.equal(requests, 1);
  assert.equal(exhausted.stopReason, "MAX_ROUNDS");
  assert.equal(exhausted.submission.recoveryCount, 0);
  assert.equal(exhausted.submission.receipts.length, 0);
  const invalid = await runLiveAgentTask({ ...typedOptions, maxRounds: 1, chat: async () => toolCompletion([submitCall('{}')]) });
  assert.equal(invalid.stopReason, "INVALID_SUBMISSION");
  assert.equal(invalid.submission.recoveryCount, 0);
  requests = 0;
  const capped = await runLiveAgentTask({ ...typedOptions, promptCap: 1000, chat: async () => {
    requests += 1;
    return { choices: [{ finish_reason: "stop", message: { content: "x".repeat(10000) } }] };
  } });
  assert.equal(requests, 1);
  assert.equal(capped.stopReason, "FAILED_CONTEXT_CAP");
  assert.equal(capped.primaryStopReason, "INVALID_SUBMISSION");
  assert.equal(capped.submission.recoveryCount, 0);
});

test("source exhaustion prompt declares remaining zero without claiming evidence completion", async () => {
  let step = 0;
  const result = await runLiveAgentTask({ ...typedOptions, sourceBudget: { max_lines: 1, max_bytes: 6 },
    invoke: async () => ({ path: "A.java", startLine: 1, text: "value\n" }),
    chat: async ({ messages }) => {
      if (++step === 1) return toolCompletion([readCall]);
      const prompt = messages.filter(message => message.role === "user").map(message => message.content).join("\n");
      assert.match(prompt, /remainingLines=0, remainingBytes=0/);
      assert.match(prompt, /cannot receive more source/);
      assert.equal(prompt.includes("enough evidence"), false);
      return toolCompletion([submitCall()]);
    }
  });
  assert.equal(result.stopReason, "SUBMITTED");
});

test("async request/completion callback failures are observed and stop typed execution", async () => {
  for (const callback of ["onChat", "onCompletion"]) {
    let calls = 0;
    const result = await runLiveAgentTask({ ...typedOptions,
      [callback]: async () => { throw new Error(`${callback} audit failed`); },
      chat: async () => { calls += 1; return toolCompletion([submitCall()]); }
    });
    assert.equal(result.stopReason, "FAILED_RUNTIME");
    assert.match(result.error, /audit failed/);
    assert.equal(calls, callback === "onChat" ? 0 : 1);
    assert.equal(result.submission.acceptedAnswer, null);
  }
});

test("legacy forced fallback observes async audit callback failures", async () => {
  for (const callback of ["onChat", "onCompletion"]) {
    let callbacks = 0;
    const result = await runLiveAgentTask({ task: auditTask,
      [callback]: async () => { if (++callbacks === 2) throw new Error("forced audit failed"); },
      chat: async () => ({ choices: [{ finish_reason: "stop", message: { content: "" } }] })
    });
    assert.equal(result.stopReason, "FAILED_RUNTIME");
    assert.equal(result.finalAnswerMode, "NO_ANSWER");
    assert.match(result.error, /forced audit failed/);
  }
});

for (const withCalls of [false, true]) {
  for (const recovery of ["submit", "invalid", "last-round"]) {
    test(`typed length ${withCalls ? "with" : "without"} calls retains primary truncation after ${recovery}`, async () => {
      let requests = 0;
      const first = withCalls
        ? toolCompletion([submitCall()], "length")
        : { choices: [{ finish_reason: "length", message: { content: '{"answer":"draft"}' } }] };
      const result = await runLiveAgentTask({ ...typedOptions,
        maxRounds: recovery === "last-round" ? 1 : 4,
        chat: async () => ++requests === 1 ? first : toolCompletion([submitCall(recovery === "submit" ? '{"answer":"accepted"}' : '{}')])
      });
      assert.equal(requests, recovery === "last-round" ? 1 : 2);
      assert.equal(result.primaryStopReason, "MAX_COMPLETION_TOKENS");
      assert.equal(result.stopReason, recovery === "submit" ? "SUBMITTED" : "INVALID_SUBMISSION");
      assert.equal(result.submission.recoveryCount, recovery === "last-round" ? 0 : 1);
      if (withCalls) assert.equal(result.submission.attempts[0].reason, "length_truncated");
      else assert.equal(result.submission.drafts[0].rawContent, '{"answer":"draft"}');
      if (recovery !== "submit") assert.equal(result.finalContent, "");
    });
  }
}

for (const mode of ["typed", "legacy-forced"]) {
  test(`${mode} completion audit rejection retains completed provider usage and callback raw metadata`, async () => {
    const captured = [];
    let requests = 0;
    const result = await runLiveAgentTask({
      ...(mode === "typed" ? typedOptions : { task: auditTask }),
      onCompletion: async event => {
        captured.push(event);
        if (mode === "typed" || event.forcedAnswer) throw new Error("usage audit failed");
      },
      chat: async () => {
        requests += 1;
        return {
          id: `usage-response-${requests}`, model: "fake-provider",
          ...toolCompletion(mode === "typed" ? [submitCall()] : [], mode === "typed" ? "tool_calls" : "stop"),
          usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, prompt_tokens_details: { cached_tokens: 12 } }
        };
      }
    });
    assert.equal(requests, mode === "typed" ? 1 : 2);
    assert.equal(result.stopReason, "FAILED_RUNTIME");
    assert.match(result.error, /usage audit failed/);
    assert.equal(result.usage.status, "MEASURED");
    assert.equal(result.usage.promptTokens, 123 * requests);
    assert.equal(result.usage.completionTokens, 45 * requests);
    assert.equal(result.usage.totalTokens, 168 * requests);
    assert.equal(result.usage.cachedInputTokens, 12 * requests);
    assert.equal(captured.at(-1).response.id, `usage-response-${requests}`);
    assert.equal(captured.at(-1).response.model, "fake-provider");
    assert.equal(captured.at(-1).response.usage.total_tokens, 168);
    assert.equal(captured.at(-1).forcedAnswer, mode === "legacy-forced");
    if (mode === "typed") {
      assert.equal(captured[0].response.choices[0].message.tool_calls[0].function.arguments, '{"answer":"structurally valid"}');
      assert.equal(result.submission.acceptedAnswer, null);
      assert.deepEqual(result.submission.receipts, []);
    }
  });
}


test("evidence session mapping explicitly selects operation and isolated repo anchor", async () => {
  const captured = [];
  const raw = { schemaVersion: "java-evidence-unit/v1", scopeState: "PARTIAL", units: [], omitted: [{ reason: "STALE" }] };
  const session = impactSessionFromClient({ repoRoot: "/isolated/fixture", client: { async callTool(request) {
    captured.push(request); return { content: [{ type: "text", text: JSON.stringify(raw) }] };
  } } });
  assert.deepEqual(await session.evidence({ file: "A.java", line: 4, column: 8, query: "ignored" }), raw);
  assert.deepEqual(captured, [{ name: "java_symbol", arguments: { repoRoot: "/isolated/fixture", operation: "evidence", file: "A.java", line: 4, column: 8 } }]);
});
