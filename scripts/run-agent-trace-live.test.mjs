import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TRACE_SCHEMA_VERSION
} from "./run-agent-trace-matrix.mjs";
import {
  ARM_SYSTEM_PROMPTS,
  LIVE_TRACE_SCHEMA_VERSION,
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
  liveV1Fields,
  pairedHitRateFromN5Cells,
  parseHitFraction,
  selectLiveTasks,
  serenaUnavailableResult,
  summarizeLiveTasks,
  taskSuccessFromCoverage,
  runLiveAgentTask
} from "./run-agent-trace-live.mjs";
import { mergeUsage, openaiCompatibleChat, usageFromCompletion } from "./openai-compatible-chat.mjs";
import { parseAgentTraceCli, runAgentTraceMatrix } from "./run-agent-trace-matrix.mjs";

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

test("coverage success requires every required path and does not use model text", () => {
  const hit = taskSuccessFromCoverage(
    ["src/A.java", "src/B.java"],
    ["src/A.java", "src/B.java", "src/C.java"]
  );
  assert.equal(hit.success, true);
  const miss = taskSuccessFromCoverage(["src/A.java", "src/MeQueryService.java"], ["src/A.java"]);
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
  assert.equal(compact.text.includes("\"start\":1"), true);
});

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
  assert.match(ARM_SYSTEM_PROMPTS.jin, /Stop when you can describe the impact/);
  assert.match(ARM_SYSTEM_PROMPTS.jin, /Prefer one search/);
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

test("jin candidatePaths do not count as coverage hits", async () => {
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
      candidates: [{ path: "src/Hidden.java", role: "CALLS" }]
    }),
    maxRounds: 1
  });
  assert.equal(result.taskSuccess, false);
  assert.deepEqual(result.coverage.missing, ["src/Hidden.java"]);
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
  await openaiCompatibleChat({
    baseUrl: "http://example.test/v1",
    apiKey: "sk-test",
    model: "demo",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (_url, init) => {
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

test("candidates are not observed paths until E3", () => {
  const result = {
    candidates: [{ path: "src/Hidden.java", role: "CALLS" }],
    contexts: [{ path: "src/A.java", role: "ANCHOR" }],
    files: [{ id: "1", path: "src/B.java" }]
  };
  assert.deepEqual(collectImpactPaths(result).sort(), ["src/A.java", "src/B.java"]);
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
