import assert from "node:assert/strict";
import test from "node:test";
import {
  compactImpactForModel,
  selectLiveTasks,
  summarizeLiveTasks,
  taskSuccessFromCoverage,
  runLiveAgentTask
} from "./run-agent-trace-live.mjs";
import { mergeUsage, openaiCompatibleChat, usageFromCompletion } from "./openai-compatible-chat.mjs";
import { parseAgentTraceCli, runAgentTraceMatrix } from "./run-agent-trace-matrix.mjs";

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
