#!/usr/bin/env node
// input: Frozen holdout tasks, OpenAI-compatible credentials, and local java_impact via MCP stdio.
// output: MEASURED usage and path-coverage TaskSuccess. Never invents 0 for missing usage.
// pos: V5R live agent-trace execute path. 112K context cap. Golden mustHit is never sent to the model.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_PROMPT_CAP_TOKENS,
  estimatePromptTokens,
  mergeUsage,
  openaiCompatibleChat,
  openaiCompatibleConfig,
  usageFromCompletion
} from "./openai-compatible-chat.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIVE_TRACE_SCHEMA_VERSION = "java-intelligence-v5r-live-agent-trace/v1";
export const MAX_LIVE_ROUNDS = 8;
export const MAX_TOOL_RESULT_CHARS = 16_000;
export const IMPACT_TIMEOUT_MS = 180_000;
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export const JAVA_IMPACT_TOOL = {
  type: "function",
  function: {
    name: "java_impact",
    description: "Read-only Java impact plan around an anchor file/line/column. Use semanticPolicy=fast. Do not dump whole source files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["minimal", "balanced", "precision", "recall"] }
      },
      required: ["file", "line", "column"]
    }
  }
};

export function selectLiveTasks(tasks, { maxTasks = 3, onePerProject = true, offset = 0 } = {}) {
  const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  if (!onePerProject) return tasks.slice(start, start + maxTasks);
  const seen = new Map();
  const selected = [];
  for (const task of tasks) {
    const count = seen.get(task.projectId) ?? 0;
    seen.set(task.projectId, count + 1);
    if (count !== start) continue;
    selected.push(task);
    if (selected.length >= maxTasks) break;
  }
  return selected;
}

export function collectImpactPaths(result) {
  const paths = new Set();
  for (const file of result?.files ?? []) {
    if (typeof file?.path === "string" && file.path) paths.add(normalizeRel(file.path));
  }
  const byId = new Map((result?.files ?? []).map(file => [file.id, file.path]));
  for (const item of result?.readPlan ?? []) {
    const mapped = byId.get(item.fileId);
    if (typeof mapped === "string" && mapped) paths.add(normalizeRel(mapped));
  }
  return [...paths];
}

export function compactImpactForModel(result, maxChars = MAX_TOOL_RESULT_CHARS) {
  const files = (result?.files ?? []).map(file => ({
    path: file.path,
    role: file.role,
    confidence: file.confidence
  }));
  const pathById = new Map((result?.files ?? []).map(file => [file.id, file.path]));
  const readPlan = (result?.readPlan ?? []).map(item => ({
    path: pathById.get(item.fileId) ?? item.fileId,
    ranges: item.ranges,
    estimatedBytes: item.estimatedBytes,
    reason: item.reason
  }));
  const payload = {
    files,
    readPlan,
    evidenceGaps: (result?.evidenceGaps ?? []).slice(0, 8)
  };
  let text = JSON.stringify(payload);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…[truncated]`;
  return { text, paths: collectImpactPaths(result) };
}

export function taskSuccessFromCoverage(requiredFiles, observedPaths) {
  const required = [...new Set((requiredFiles ?? []).map(normalizeRel))];
  const observed = new Set((observedPaths ?? []).map(normalizeRel));
  const missing = required.filter(file => !observed.has(file));
  return {
    required: required.length,
    hit: required.length - missing.length,
    success: required.length > 0 && missing.length === 0,
    missing
  };
}

export async function runLiveAgentTask({
  task,
  chat,
  impact,
  promptCap = DEFAULT_PROMPT_CAP_TOKENS,
  maxRounds = MAX_LIVE_ROUNDS,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS
}) {
  const started = Date.now();
  const observedPaths = new Set();
  const toolCalls = [];
  let usage = { status: "UNMEASURED" };
  const messages = [
    {
      role: "system",
      content: "You navigate Java code with the java_impact tool only. Call it with file/line/column. You may call it again on related files. Stop when you can describe the impact. Never ask for whole files. Never invent file paths."
    },
    {
      role: "user",
      content: [
        `Task: ${task.name ?? task.scenarioId}`,
        `Repository: ${task.projectId}`,
        `Anchor file: ${task.anchor.file}`,
        `Anchor line: ${task.anchor.line}`,
        `Anchor column: ${task.anchor.column}`,
        `Profile: ${task.anchor.profile ?? "auto"}`
      ].join("\n")
    }
  ];
  let stopReason = "MODEL_STOP";
  let runtimeError;
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const estimated = estimatePromptTokens(messages, [JAVA_IMPACT_TOOL]);
      if (estimated >= promptCap) {
        stopReason = "FAILED_CONTEXT_CAP";
        break;
      }
      const completion = await chat({
        messages,
        tools: [JAVA_IMPACT_TOOL],
        maxTokens: maxCompletionTokens
      });
      usage = mergeUsage(usage, usageFromCompletion(completion));
      const choice = completion?.choices?.[0];
      const message = choice?.message ?? {};
      const calls = message.tool_calls ?? [];
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: calls.length ? calls : undefined
      });
      if (!calls.length) {
        stopReason = choice?.finish_reason === "length" ? "MAX_COMPLETION_TOKENS" : "MODEL_STOP";
        break;
      }
      for (const call of calls) {
        const name = call?.function?.name;
        const id = call?.id ?? `call-${toolCalls.length}`;
        if (name !== "java_impact") {
          messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ error: `unknown tool ${name}` }) });
          continue;
        }
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ error: "invalid tool arguments" }) });
          continue;
        }
        const raw = await impact({
          file: args.file,
          line: args.line,
          column: args.column,
          mode: args.mode || "balanced"
        });
        if (raw && typeof raw === "object" && "error" in raw && raw.error) {
          toolCalls.push({ name, args, pathCount: 0, error: true });
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: JSON.stringify({ error: String(raw.error).slice(0, 500) })
          });
          continue;
        }
        const compact = compactImpactForModel(raw);
        for (const filePath of compact.paths) observedPaths.add(filePath);
        toolCalls.push({ name, args, pathCount: compact.paths.length });
        messages.push({ role: "tool", tool_call_id: id, content: compact.text });
      }
      if (round === maxRounds - 1) stopReason = "MAX_ROUNDS";
    }
  } catch (error) {
    stopReason = "FAILED_RUNTIME";
    runtimeError = error instanceof Error ? error.message : String(error);
  }
  const coverage = taskSuccessFromCoverage(task.requiredContextFiles, [...observedPaths]);
  const unscored = stopReason === "FAILED_CONTEXT_CAP" || stopReason === "FAILED_RUNTIME";
  return {
    taskId: task.taskId,
    stopReason,
    wallMs: Date.now() - started,
    toolCallCount: toolCalls.length,
    usage,
    coverage,
    taskSuccess: unscored ? null : coverage.success,
    contextCapped: stopReason === "FAILED_CONTEXT_CAP",
    ...(runtimeError ? { error: runtimeError.slice(0, 500) } : {})
  };
}

export async function executeLiveTrace({
  tasks,
  repositories,
  outputDir,
  env = process.env,
  serverJs = path.join(scriptRoot, "dist", "server.js")
}) {
  const config = openaiCompatibleConfig(env);
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for --execute-live");
  }
  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const task of tasks) {
    const repoRoot = repositories[task.projectId];
    if (!repoRoot) throw new Error(`missing repository root for ${task.projectId}`);
    process.stderr.write(`[live-trace] start ${task.taskId}\n`);
    let session;
    try {
      session = await openImpactSession({
        repoRoot,
        serverJs,
        cacheRoot: path.join(outputDir, "mcp-cache", task.projectId),
        env
      });
      await warmupImpact(session, task);
      const measured = await runLiveAgentTask({
        task: {
          ...task,
          name: task.scenarioId,
          anchor: task.anchor
        },
        chat: ({ messages, tools, maxTokens }) => openaiCompatibleChat({
          ...config,
          messages,
          tools,
          maxTokens
        }),
        impact: args => session.impact(args),
        promptCap: DEFAULT_PROMPT_CAP_TOKENS,
        maxRounds: MAX_LIVE_ROUNDS,
        maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS
      });
      results.push(measured);
      process.stderr.write(`[live-trace] done ${task.taskId} stop=${measured.stopReason} success=${measured.taskSuccess} tools=${measured.toolCallCount}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[live-trace] fail ${task.taskId}: ${message.slice(0, 300)}\n`);
      results.push(runtimeFailure(task, message));
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // shutdown is best-effort
        }
      }
    }
  }
  return summarizeLiveTasks(results, {
    model: config.model,
    baseUrlHost: safeHost(config.baseUrl),
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS
  });
}

export function summarizeLiveTasks(results, {
  model,
  baseUrlHost,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS
} = {}) {
  const scored = results.filter(result => result.taskSuccess !== null);
  const successes = scored.filter(result => result.taskSuccess === true).length;
  const measuredUsage = results.map(result => result.usage).reduce(mergeUsage, { status: "UNMEASURED" });
  const toolRounds = results.reduce((sum, result) => sum + (result.toolCallCount ?? 0), 0);
  const lambdaCall = measuredUsage.status === "MEASURED" && toolRounds > 0
    ? measuredUsage.totalTokens / toolRounds
    : null;
  return {
    schemaVersion: LIVE_TRACE_SCHEMA_VERSION,
    status: "MEASURED",
    contextWindowTokens,
    model,
    baseUrlHost,
    modelUsage: measuredUsage,
    taskSuccess: {
      status: scored.length ? "MEASURED" : "UNMEASURED",
      tasks: results.length,
      scored: scored.length,
      successes,
      mean: scored.length ? successes / scored.length : null
    },
    lambdaMagnitude: {
      n: results.length,
      tokensPerToolRound: lambdaCall,
      scalarAllowed: false,
      note: "n is too small for KEEP/REJECT via J(π); magnitude only"
    },
    blindReview: { status: "UNMEASURED" },
    tasks: results
  };
}

async function warmupImpact(session, task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const raw = await session.impact({
      file: task.anchor.file,
      line: task.anchor.line,
      column: task.anchor.column,
      mode: "balanced"
    });
    if (!(raw && typeof raw === "object" && raw.error)) {
      const paths = collectImpactPaths(raw);
      process.stderr.write(`[live-trace] warmup ${task.taskId} ok files=${paths.length} attempt=${attempt}\n`);
      return;
    }
    lastError = String(raw.error);
    process.stderr.write(`[live-trace] warmup ${task.taskId} fail attempt=${attempt}: ${lastError.slice(0, 200)}\n`);
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.stderr.write(`[live-trace] warmup ${task.taskId} gave up: ${String(lastError ?? "unknown").slice(0, 200)}\n`);
}

function runtimeFailure(task, message) {
  return {
    taskId: task.taskId,
    stopReason: "FAILED_RUNTIME",
    wallMs: 0,
    toolCallCount: 0,
    usage: { status: "UNMEASURED" },
    coverage: taskSuccessFromCoverage(task.requiredContextFiles, []),
    taskSuccess: null,
    contextCapped: false,
    error: message.slice(0, 500)
  };
}

async function openImpactSession({ repoRoot, serverJs, cacheRoot, env }) {
  const childEnv = { ...env };
  for (const name of ["OPENAI_API_KEY", "JAVA_LSP_AGENT_API_KEY", "ANTHROPIC_API_KEY"]) {
    delete childEnv[name];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    cwd: scriptRoot,
    env: {
      ...childEnv,
      PATH: withHomebrewPathFirst(childEnv.PATH),
      JAVA_LSP_REPO_ROOT: repoRoot,
      JAVA_LSP_CACHE_ROOT: cacheRoot,
      JDTLS_BIN: env.JDTLS_BIN || "/usr/bin/false",
      JAVA_LSP_ISOLATED_VALIDATION: "1"
    },
    stderr: "inherit"
  });
  const client = new Client({ name: "v5r-live-agent-trace", version: "0.1.0" });
  await client.connect(transport);
  return {
    async impact(args) {
      const result = await client.callTool({
        name: "java_impact",
        arguments: {
          repoRoot,
          file: args.file,
          line: args.line,
          column: args.column,
          mode: args.mode || "balanced",
          semanticPolicy: "fast",
          verbosity: "compact",
          // Cold runtime.create on the golden repos exceeds the 2s fast default.
          deadlineMs: 15_000
        }
      }, undefined, { timeout: IMPACT_TIMEOUT_MS });
      const text = result.content?.map(part => part.text).join("\n") ?? "{}";
      if (result.isError) return { error: text };
      return JSON.parse(text);
    },
    async close() {
      try {
        await client.callTool({
          name: "java_runtime",
          arguments: { repoRoot, action: "shutdown" }
        }, undefined, { timeout: SHUTDOWN_TIMEOUT_MS });
      } catch {
        // shutdown is best-effort; the stdio client close still runs
      }
      await client.close();
    }
  };
}

function normalizeRel(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function withHomebrewPathFirst(pathValue) {
  const homebrew = "/opt/homebrew/bin";
  const parts = String(pathValue || "/usr/bin:/bin").split(":").filter(part => part && part !== homebrew);
  return [homebrew, ...parts].join(":");
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "unparsed";
  }
}
