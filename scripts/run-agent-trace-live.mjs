#!/usr/bin/env node
// input: Frozen holdout tasks, OpenAI-compatible credentials, and local java_impact via MCP stdio.
// output: MEASURED usage and path-coverage TaskSuccess. Never invents 0 for missing usage.
// pos: V5R live agent-trace execute path. 112K context cap. Golden mustHit is never sent to the model.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
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
export const LIVE_TRACE_SCHEMA_VERSION = "java-intelligence-v5r-live-agent-trace/v2";
export const LIVE_TRACE_V1_FIELD_NAMES = Object.freeze([
  "status",
  "contextWindowTokens",
  "model",
  "baseUrlHost",
  "modelUsage",
  "taskSuccess",
  "successLayers",
  "arms",
  "lambdaMagnitude",
  "blindReview",
  "tasks"
]);
export const PAIRED_HIT_RATE_SCHEMA = "paired-hit-rate/v1";
export const MISS_IN_POOL_NOT_PACKED = "IN_POOL_NOT_PACKED";
export const MISS_DISCOVERY_GAP = "DISCOVERY_GAP";
export const MISS_SINGLE_ARM_MISS = "SINGLE_ARM_MISS";
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

export const JAVA_CONTEXT_TOOL = {
  type: "function",
  function: {
    name: "java_context",
    description: "Plan Java context as selected spans. Pass intent. Prefer one search from the given file/line/column. Stop when you can describe the impact. mode=navigate only for callers, callees, or a persistence/framework closure.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          enum: [
            "IMPLEMENTATION_CHANGE",
            "DOWNSTREAM_BEHAVIOR",
            "UPSTREAM_IMPACT",
            "CONTRACT_CHANGE",
            "PERSISTENCE_FLOW",
            "DATAFLOW_TRACE",
            "FRAMEWORK_WIRING",
            "TEST_PLANNING",
            "DIAGNOSTIC_ONLY",
            "auto"
          ]
        },
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        task: { type: "string" },
        mode: { type: "string", enum: ["search", "navigate"] },
        direction: { type: "string", enum: ["auto", "callers", "callees"] },
        closure: { type: "string", enum: ["persistence", "framework"] }
      },
      required: ["intent"]
    }
  }
};

const ARM_PROMPT_SHARED = "If the result points to uncovered directions (unresolved / next / evidenceGaps), call again until you can fully describe the impact surface, or until the 8-round limit. Never ask for whole files. Never invent file paths.";

export const ARM_SYSTEM_PROMPTS = {
  old: `Explore this task's impact surface with the java_impact tool only. ${ARM_PROMPT_SHARED}`,
  jin: `Explore this task's impact surface with the java_context tool only. Intent is required. ${ARM_PROMPT_SHARED}`,
  serena: "You navigate Java code with the Serena MCP tools as published. Do not invent tools. Stop when you can describe the impact. Never invent file paths."
};

export function armPromptFingerprint(arm) {
  const text = ARM_SYSTEM_PROMPTS[arm];
  if (typeof text !== "string") throw new Error(`unknown live arm prompt: ${arm}`);
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

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
  for (const context of [...(result?.contexts ?? []), ...(result?.evidence ?? [])]) {
    if (typeof context?.path === "string" && context.path) paths.add(normalizeRel(context.path));
  }
  for (const filePath of collectCandidatePaths(result)) paths.add(filePath);
  for (const item of result?.unresolved ?? []) {
    const value = typeof item === "string" ? item : (item?.path || (looksLikeRelPath(item?.id) ? item.id : ""));
    if (typeof value === "string" && value) paths.add(normalizeRel(value));
  }
  return [...paths];
}

function looksLikeRelPath(value) {
  return typeof value === "string" && (value.includes("/") || value.endsWith(".java"));
}

export function collectCandidatePaths(result) {
  const paths = new Set();
  for (const item of result?.candidates ?? []) {
    const value = typeof item === "string" ? item : item?.path;
    if (typeof value === "string" && value) paths.add(normalizeRel(value));
  }
  return [...paths];
}

export function compactContextForModel(result, maxChars = MAX_TOOL_RESULT_CHARS) {
  const packed = result?.evidence ?? result?.contexts ?? [];
  const payload = {
    coverage: result?.coverage,
    resolvedIntent: result?.resolvedIntent,
    anchor: result?.anchor,
    candidates: (result?.candidates ?? []).slice(0, 24).map(item => (
      typeof item === "string"
        ? { path: item }
        : { path: item.path, role: item.role, hop: item.hop, reason: item.reason }
    )),
    evidence: packed.map(item => ({
      path: item.path,
      role: item.role,
      spans: (item.spans ?? []).map(span => ({ start: span.start, end: span.end }))
    })),
    contexts: packed.map(item => ({
      path: item.path,
      role: item.role,
      spans: (item.spans ?? []).map(span => ({ start: span.start, end: span.end }))
    })),
    unresolved: (result?.unresolved ?? []).slice(0, 8).map(item => ({ id: item.id, role: item.role, path: item.path })),
    next: (result?.next ?? []).slice(0, 4).map(item => ({
      action: item.action,
      file: item.file,
      line: item.line,
      direction: item.direction,
      closure: item.closure,
      reason: item.reason
    }))
  };
  let text = JSON.stringify(payload);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…[truncated]`;
  return { text, paths: collectImpactPaths(result) };
}

export function serenaUnavailableResult(task, reason = "SERENA_MCP_COMMAND is not set") {
  return {
    taskId: task.taskId,
    arm: "serena",
    stopReason: "SERENA_UNAVAILABLE",
    wallMs: 0,
    toolCallCount: 0,
    usage: { status: "UNMEASURED" },
    coverage: taskSuccessFromCoverage(task.requiredContextFiles, []),
    taskSuccess: null,
    contextCapped: false,
    error: reason.slice(0, 500)
  };
}

export function liveJavaContextArgs(args, task, session) {
  const rawTask = typeof args?.task === "string" ? args.task.trim() : "";
  const scenarioId = typeof task?.scenarioId === "string" ? task.scenarioId : "";
  const fallback = typeof task?.taskText === "string" ? task.taskText.trim() : "";
  const taskText = rawTask && rawTask !== scenarioId ? rawTask : fallback;
  return {
    intent: args?.intent || "auto",
    file: args?.file || task.anchor.file,
    line: args?.line || task.anchor.line,
    column: args?.column || task.anchor.column,
    ...(taskText ? { task: taskText } : {}),
    mode: args?.mode || "search",
    ...(args?.direction ? { direction: args.direction } : {}),
    ...(args?.closure ? { closure: args.closure } : {}),
    ...(session?.sessionId
      ? { sessionId: session.sessionId, generation: session.generation ?? 0 }
      : {})
  };
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

export function parseHitFraction(text) {
  const match = String(text ?? "").trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) throw new Error(`invalid hit fraction: ${text}`);
  const hit = Number(match[1]);
  const required = Number(match[2]);
  if (!Number.isInteger(hit) || !Number.isInteger(required) || hit < 0 || required < 0 || hit > required) {
    throw new Error(`invalid hit fraction: ${text}`);
  }
  return { hit, required, rate: required === 0 ? null : hit / required };
}

export function coverageHitRate(coverage) {
  const required = coverage?.required ?? 0;
  if (required <= 0) return null;
  return (coverage.hit ?? 0) / required;
}

export function classifyRequiredFile(file, { oldHit, jinHit, inPool }) {
  if (oldHit && jinHit) return null;
  if (!oldHit && !jinHit && !inPool) return MISS_DISCOVERY_GAP;
  if (!jinHit && inPool) return MISS_IN_POOL_NOT_PACKED;
  if (oldHit !== jinHit) return MISS_SINGLE_ARM_MISS;
  return MISS_IN_POOL_NOT_PACKED;
}

export function liveV1Fields(summary) {
  const fields = {};
  for (const key of LIVE_TRACE_V1_FIELD_NAMES) fields[key] = summary?.[key];
  return fields;
}

export function pairedHitRateFromN5Cells(cells) {
  const tasks = (cells ?? []).map(cell => {
    const old = parseHitFraction(cell.old.hit);
    const jin = parseHitFraction(cell.jin.hit);
    return {
      task: cell.task,
      old: old.rate,
      jin: jin.rate,
      delta: jin.rate - old.rate,
      oldHit: cell.old.hit,
      jinHit: cell.jin.hit
    };
  });
  return {
    schemaVersion: PAIRED_HIT_RATE_SCHEMA,
    replay: "cells",
    tasks,
    mean: meanRates(tasks),
    direction: directionCounts(tasks.map(task => task.delta))
  };
}

export function buildPairedHitRate(results, { candidatePoolByTask = {} } = {}) {
  const byTask = new Map();
  for (const result of results ?? []) {
    const taskId = result?.taskId;
    const arm = result?.arm;
    if (!taskId || !arm) continue;
    const bucket = byTask.get(taskId) ?? {};
    bucket[arm] = result;
    byTask.set(taskId, bucket);
  }
  const tasks = [];
  const misses = [];
  const unreachableRequired = [];
  for (const [task, arms] of byTask) {
    const old = arms.old;
    const jin = arms.jin;
    if (!old || !jin) continue;
    if (old.taskSuccess === null || jin.taskSuccess === null) continue;
    const oldRate = coverageHitRate(old.coverage);
    const jinRate = coverageHitRate(jin.coverage);
    if (oldRate == null || jinRate == null) continue;
    const pool = new Set([
      ...(candidatePoolByTask[task] ?? []).map(normalizeRel),
      ...(jin.candidatePaths ?? []).map(normalizeRel)
    ]);
    const oldMissing = new Set((old.coverage?.missing ?? []).map(normalizeRel));
    const jinMissing = new Set((jin.coverage?.missing ?? []).map(normalizeRel));
    let unreachableCount = 0;
    for (const file of new Set([...oldMissing, ...jinMissing])) {
      const oldHit = !oldMissing.has(file);
      const jinHit = !jinMissing.has(file);
      const label = classifyRequiredFile(file, { oldHit, jinHit, inPool: pool.has(file) });
      if (!label) continue;
      misses.push({ task, file, label, oldHit, jinHit });
      if (label === MISS_DISCOVERY_GAP) {
        unreachableRequired.push({ task, file });
        unreachableCount += 1;
      }
    }
    const oldRequired = old.coverage.required;
    const jinRequired = jin.coverage.required;
    const oldReqEx = oldRequired - unreachableCount;
    const jinReqEx = jinRequired - unreachableCount;
    const excluding = {
      old: oldReqEx > 0 ? old.coverage.hit / oldReqEx : null,
      jin: jinReqEx > 0 ? jin.coverage.hit / jinReqEx : null
    };
    excluding.delta = excluding.old == null || excluding.jin == null ? null : excluding.jin - excluding.old;
    tasks.push({
      task,
      old: oldRate,
      jin: jinRate,
      delta: jinRate - oldRate,
      oldHit: `${old.coverage.hit}/${oldRequired}`,
      jinHit: `${jin.coverage.hit}/${jinRequired}`,
      excludingUnreachable: excluding
    });
  }
  const excludingRows = tasks
    .map(task => task.excludingUnreachable)
    .filter(row => row.old != null && row.jin != null);
  return {
    schemaVersion: PAIRED_HIT_RATE_SCHEMA,
    tasks,
    mean: meanRates(tasks),
    direction: directionCounts(tasks.map(task => task.delta)),
    excludingUnreachable: {
      mean: meanRates(excludingRows),
      direction: directionCounts(excludingRows.map(row => row.delta))
    },
    unreachableRequired,
    misses
  };
}

function meanRates(rows) {
  if (!rows.length) return { old: null, jin: null, delta: null };
  const old = rows.reduce((sum, row) => sum + row.old, 0) / rows.length;
  const jin = rows.reduce((sum, row) => sum + row.jin, 0) / rows.length;
  return { old, jin, delta: jin - old };
}

function directionCounts(deltas) {
  let jinBetter = 0;
  let jinWorse = 0;
  let tie = 0;
  for (const delta of deltas) {
    if (delta > 0) jinBetter += 1;
    else if (delta < 0) jinWorse += 1;
    else tie += 1;
  }
  return { jinBetter, jinWorse, tie, n: deltas.length };
}

export async function runLiveAgentTask({
  task,
  chat,
  impact,
  invoke,
  tools,
  systemPrompt,
  arm = "old",
  promptCap = DEFAULT_PROMPT_CAP_TOKENS,
  maxRounds = MAX_LIVE_ROUNDS,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS
}) {
  const started = Date.now();
  const observedPaths = new Set();
  const candidatePaths = new Set();
  const toolCalls = [];
  let usage = { status: "UNMEASURED" };
  const exposedTools = tools ?? [JAVA_IMPACT_TOOL];
  const callTool = invoke ?? (async (name, args) => {
    if (name !== "java_impact") return { error: `unknown tool ${name}` };
    return impact(args);
  });
  const messages = [
    {
      role: "system",
      content: systemPrompt ?? ARM_SYSTEM_PROMPTS[arm] ?? ARM_SYSTEM_PROMPTS.old
    },
    {
      role: "user",
      content: [
        `Task: ${task.taskText || task.name || "Java impact"}`,
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
      const estimated = estimatePromptTokens(messages, exposedTools);
      if (estimated >= promptCap) {
        stopReason = "FAILED_CONTEXT_CAP";
        break;
      }
      const completion = await chat({
        messages,
        tools: exposedTools,
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
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ error: "invalid tool arguments" }) });
          continue;
        }
        const raw = await callTool(name, args);
        if (raw && typeof raw === "object" && "error" in raw && raw.error) {
          toolCalls.push({ name, args, pathCount: 0, error: true });
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: JSON.stringify({ error: String(raw.error).slice(0, 500) })
          });
          continue;
        }
        const compact = name === "java_context" ? compactContextForModel(raw) : compactImpactForModel(raw);
        for (const filePath of compact.paths) observedPaths.add(filePath);
        for (const filePath of collectCandidatePaths(raw)) candidatePaths.add(filePath);
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
  const unscored = stopReason === "FAILED_CONTEXT_CAP"
    || stopReason === "FAILED_RUNTIME"
    || stopReason === "SERENA_UNAVAILABLE";
  return {
    taskId: task.taskId,
    arm,
    stopReason,
    wallMs: Date.now() - started,
    toolCallCount: toolCalls.length,
    usage,
    coverage,
    candidatePaths: [...candidatePaths],
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
  arms = ["old", "jin", "serena"],
  serverJs = path.join(scriptRoot, "dist", "server.js")
}) {
  const config = openaiCompatibleConfig(env);
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for --execute-live");
  }
  await mkdir(outputDir, { recursive: true });
  const results = [];
  const serenaCommand = String(env.SERENA_MCP_COMMAND || "").trim();
  for (const task of tasks) {
    const repoRoot = repositories[task.projectId];
    if (!repoRoot) throw new Error(`missing repository root for ${task.projectId}`);
    for (const arm of arms) {
      process.stderr.write(`[live-trace] start ${task.taskId} arm=${arm}\n`);
      if (arm === "serena" && !serenaCommand) {
        const unavailable = serenaUnavailableResult(task);
        results.push(unavailable);
        process.stderr.write(`[live-trace] skip ${task.taskId} arm=serena SERENA_UNAVAILABLE\n`);
        continue;
      }
      let session;
      try {
        session = await openImpactSession({
          repoRoot,
          serverJs,
          cacheRoot: path.join(outputDir, "mcp-cache", task.projectId, arm),
          env
        });
        if (arm !== "serena") await warmupImpact(session, task);
        const measured = await runLiveAgentTask({
          task: {
            ...task,
            name: task.scenarioId,
            anchor: task.anchor
          },
          arm,
          tools: arm === "jin" ? [JAVA_CONTEXT_TOOL] : [JAVA_IMPACT_TOOL],
          systemPrompt: ARM_SYSTEM_PROMPTS[arm],
          chat: ({ messages, tools, maxTokens }) => openaiCompatibleChat({
            ...config,
            messages,
            tools,
            maxTokens
          }),
          invoke: (name, args) => dispatchArmTool(session, arm, name, args, task, {
            sessionId: `live:${task.taskId}:${arm}`,
            generation: 0
          }),
          promptCap: DEFAULT_PROMPT_CAP_TOKENS,
          maxRounds: MAX_LIVE_ROUNDS,
          maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS
        });
        results.push(measured);
        process.stderr.write(`[live-trace] done ${task.taskId} arm=${arm} stop=${measured.stopReason} success=${measured.taskSuccess} tools=${measured.toolCallCount}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[live-trace] fail ${task.taskId} arm=${arm}: ${message.slice(0, 300)}\n`);
        results.push({ ...runtimeFailure(task, message), arm });
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
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  candidatePoolByTask = {}
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
    successLayers: {
      localization: {
        status: scored.length ? "MEASURED" : "UNMEASURED",
        scored: scored.length,
        successes,
        mean: scored.length ? successes / scored.length : null
      },
      patchGeneration: { status: "UNMEASURED" },
      compileTest: { status: "UNMEASURED" }
    },
    arms: summarizeArms(results),
    lambdaMagnitude: {
      n: results.length,
      tokensPerToolRound: lambdaCall,
      scalarAllowed: false,
      note: "n is too small for KEEP/REJECT via J(π); magnitude only"
    },
    blindReview: { status: "UNMEASURED" },
    pairedHitRate: buildPairedHitRate(results, { candidatePoolByTask }),
    promptFingerprints: {
      old: armPromptFingerprint("old"),
      jin: armPromptFingerprint("jin"),
      serena: armPromptFingerprint("serena")
    },
    tasks: results
  };
}

function summarizeArms(results) {
  const byArm = new Map();
  for (const result of results) {
    const arm = result.arm || "old";
    const bucket = byArm.get(arm) ?? { arm, tasks: 0, scored: 0, successes: 0, unavailable: 0 };
    bucket.tasks += 1;
    if (result.stopReason === "SERENA_UNAVAILABLE") bucket.unavailable += 1;
    if (result.taskSuccess !== null) {
      bucket.scored += 1;
      if (result.taskSuccess === true) bucket.successes += 1;
    }
    byArm.set(arm, bucket);
  }
  return [...byArm.values()].map(bucket => ({
    ...bucket,
    mean: bucket.scored ? bucket.successes / bucket.scored : null,
    status: bucket.unavailable === bucket.tasks ? "UNAVAILABLE" : bucket.scored ? "MEASURED" : "UNMEASURED"
  }));
}

async function dispatchArmTool(session, arm, name, args, task, liveSession) {
  if (arm === "jin") {
    if (name !== "java_context") return { error: `unknown tool ${name}` };
    return session.context(liveJavaContextArgs(args, task, liveSession));
  }
  if (name !== "java_impact") return { error: `unknown tool ${name}` };
  return session.impact({
    file: args.file,
    line: args.line,
    column: args.column,
    mode: args.mode || "balanced"
  });
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
  async function callNamed(name, args) {
    const result = await client.callTool({
      name,
      arguments: args
    }, undefined, { timeout: IMPACT_TIMEOUT_MS });
    const text = result.content?.map(part => part.text).join("\n") ?? "{}";
    if (result.isError) return { error: text };
    return JSON.parse(text);
  }
  return {
    async impact(args) {
      return callNamed("java_impact", {
        repoRoot,
        file: args.file,
        line: args.line,
        column: args.column,
        mode: args.mode || "balanced",
        semanticPolicy: "fast",
        verbosity: "compact",
        deadlineMs: 15_000
      });
    },
    async context(args) {
      return callNamed("java_context", {
        repoRoot,
        intent: args.intent || "auto",
        file: args.file,
        line: args.line,
        column: args.column,
        ...(args.task ? { task: args.task } : {}),
        mode: args.mode || "search",
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.closure ? { closure: args.closure } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId, generation: args.generation ?? 0 } : {})
      });
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
