#!/usr/bin/env node
// input: Frozen holdout tasks, OpenAI-compatible credentials, and local java_impact via MCP stdio.
// output: MEASURED usage and a path-coverage proxy; real task outcome stays UNMEASURED until the external evaluator (T09). Never invents 0 for missing usage.
// pos: V5R live agent-trace execute path. 112K context cap. Golden mustHit is never sent to the model.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSubmitAnswerTool, validateSubmission } from "./eval-answer-contract.mjs";
import { serializeModelToolResult, MODEL_TOOL_MESSAGE_MAX_BYTES } from "./eval-tool-wire.mjs";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_PROMPT_CAP_TOKENS,
  chatRequestConfigForAudit,
  completionForAudit,
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

// R01: the model-boundary serializer lives in eval-tool-wire.mjs (docs/03 §1.1).
export { serializeModelToolResult, MODEL_TOOL_MESSAGE_MAX_BYTES } from "./eval-tool-wire.mjs";

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

export function formatSpanRanges(spans) {
  const merged = [];
  const ordered = [...(spans ?? [])]
    .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end))
    .map(span => ({
      start: Math.min(span.start, span.end),
      end: Math.max(span.start, span.end)
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.map(span => `${span.start}-${span.end}`).join(",");
}

export function compactContextForModel(result, maxChars = MAX_TOOL_RESULT_CHARS) {
  const packed = result?.evidence ?? result?.contexts ?? [];
  const seen = new Set();
  const evidence = [];
  for (const item of packed) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    evidence.push({
      path: item.path,
      role: item.role,
      ranges: typeof item.ranges === "string" && item.ranges ? item.ranges : formatSpanRanges(item.spans)
    });
    if (evidence.length >= 3) break;
  }
  const payload = {
    coverage: result?.coverage,
    candidates: (result?.candidates ?? []).slice(0, 12).map(item => (
      typeof item === "string"
        ? { path: item }
        : { path: item.path, role: item.role, hop: item.hop, reason: item.reason }
    )),
    evidence,
    unresolved: (result?.unresolved ?? []).slice(0, 8).flatMap(item => {
      const path = item?.path || (looksLikeRelPath(item?.id) ? item.id : "");
      return path ? [{ path, role: item.role }] : [];
    }),
    next: (result?.next ?? []).slice(0, 4).map(item => ({
      action: item.action,
      file: item.file,
      line: item.line,
      ...(item.direction ? { direction: item.direction } : {}),
      ...(item.closure ? { closure: item.closure } : {}),
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
    coverage: coverageProxy(task.requiredContextFiles, []),
    taskOutcome: unmeasuredTaskOutcome(),
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

// Path-coverage proxy: reports how many required context files were observed in
// tool results. It is a localization signal only and NEVER establishes task
// success; real task outcome is measured by the external evaluator (T09) and
// stays UNMEASURED until then. Renamed from taskSuccessFromCoverage (T01).
export function coverageProxy(requiredFiles, observedPaths) {
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

// The only legal task-outcome value before the external evaluator (T09) runs.
// A path mention or a complete coverage proxy must never promote this to PASS.
export function unmeasuredTaskOutcome() {
  return { status: "UNMEASURED", authority: "external-evaluator" };
}

// Fields a source-only probe report may never overwrite: live runtime identity
// and measurement outcomes belong to their own scopes.
export const SOURCE_REPORT_PROTECTED_FIELDS = Object.freeze([
  "installedRuntimeSha",
  "taskOutcome",
  "modelUsage",
  "scopes"
]);

// Merge a source-scope probe/coverage report into a summary without letting it
// overwrite live runtime identity or outcome fields (T01 scope separation).
export function mergeSourceReport(summary, sourceReport) {
  const base = { ...(summary ?? {}) };
  const report = { ...(sourceReport ?? {}) };
  for (const field of SOURCE_REPORT_PROTECTED_FIELDS) delete report[field];
  base.scopes = {
    ...(base.scopes ?? {}),
    sourceReport: { status: sourceReport ? "INCLUDED" : "NOT_INCLUDED" }
  };
  return { ...base, ...report };
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
  // v1.1 usage rows gain auditable fields (rawUsage, per-field nulls). The
  // v1 contract is the stable core, so the compatibility view projects it
  // back to the exact v1 usage shape rather than byte-comparing extensions.
  if (fields.modelUsage && typeof fields.modelUsage === "object") {
    fields.modelUsage = {
      status: fields.modelUsage.status,
      ...(fields.modelUsage.promptTokens != null ? { promptTokens: fields.modelUsage.promptTokens } : {}),
      ...(fields.modelUsage.completionTokens != null ? { completionTokens: fields.modelUsage.completionTokens } : {}),
      ...(fields.modelUsage.totalTokens != null ? { totalTokens: fields.modelUsage.totalTokens } : {})
    };
  }
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
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
  toolResultMaxBytes = MODEL_TOOL_MESSAGE_MAX_BYTES,
  onChat,
  onCompletion,
  chatRequestConfig = {},
  // Eval protocol v1.2: { max_lines, max_bytes } of the task. When given, a
  // ledger of the source received so far follows every tool round, identical
  // for every arm.
  sourceBudget,
  submission
}) {
  const started = Date.now();
  const observedPaths = new Set();
  const candidatePaths = new Set();
  const toolCalls = [];
  // R01: one receipt per tool message; it becomes "attached" only when a
  // chat request carrying that exact message is dispatched.
  const toolReceipts = [];
  let attachedCount = 0;
  let requestIndex = 0;
  let usage = { status: "UNMEASURED" };
  let auditCallbackFailed = false;
  const submitTool = submission ? buildSubmitAnswerTool(submission.answerKeys, submission.fields) : null;
  const baseTools = tools ?? [JAVA_IMPACT_TOOL];
  if (submitTool && baseTools.some(tool => tool?.function?.name === "submit_answer")) throw new TypeError("runner owns submit_answer");
  const exposedTools = submitTool ? [...baseTools, submitTool] : baseTools;
  const submissionAudit = submitTool ? {
    schemaVersion: submission.fields ? "typed-answer-submission/v2" : "typed-answer-submission/v1",
    schema: structuredClone(submitTool.function.parameters),
    ...(submission.contract ? { publicContract: structuredClone(submission.contract) } : {}),
    attempts: [], drafts: [], recoveryCount: 0,
    acceptedAnswer: null, acceptedRequestIndex: null, receipts: []
  } : null;
  let submissionViolation;
  let recoveryPending = false;
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
  if (submitTool) messages.push({
    role: "user",
    content: "Finish by calling submit_answer exclusively with every public answer key and its declared type. Ordinary text is a draft and cannot submit an answer. The public contract allows at most one recovery request."
  });
  // R01: receipts are minted at the request boundary, right before the
  // request is dispatched, for EVERY chat request (including the forced
  // final-answer request). Receipts that never reach a request stay
  // fetched-only and are never credited as received.
  const dispatch = async (request, { forcedAnswer = false } = {}) => {
    const index = requestIndex;
    const modelSettings = {
      maxTokens: request.maxTokens,
      reasoningEffort: chatRequestConfig.reasoningEffort,
      chatTemplateKwargs: chatRequestConfig.chatTemplateKwargs
    };
    const newReceipts = toolReceipts.slice(attachedCount);
    if (typeof onChat === "function") {
      try {
        await onChat({
          round: requestIndex,
          requestIndex,
          maxTokens: request.maxTokens,
          requestConfig: chatRequestConfigForAudit(modelSettings),
          forcedAnswer,
          messages: structuredClone(request.messages),
          tools: request.tools.map(tool => tool?.function?.name ?? tool?.name),
          receipts: toolReceipts.slice(),
          newReceipts,
          payloadHash: createHash("sha256").update(JSON.stringify(request.messages), "utf8").digest("hex")
        });
      } catch (error) {
        auditCallbackFailed = true;
        throw error;
      }
    }
    attachedCount = toolReceipts.length;
    requestIndex += 1;
    const completion = await chat({
      ...request,
      ...(modelSettings.reasoningEffort ? { reasoningEffort: modelSettings.reasoningEffort } : {}),
      ...(modelSettings.chatTemplateKwargs ? { chatTemplateKwargs: modelSettings.chatTemplateKwargs } : {})
    });
    // Provider work already happened even if recording the response fails.
    // Account exactly once at this boundary for normal and forced requests.
    usage = mergeUsage(usage, usageFromCompletion(completion));
    if (typeof onCompletion === "function") {
      try {
        await onCompletion({ requestIndex: index, forcedAnswer, response: completionForAudit(completion) });
      } catch (error) {
        auditCallbackFailed = true;
        throw error;
      }
    }
    return completion;
  };
  // Received source as the kit counts it: every retained slice, overlaps
  // included (a preview and a later read of the same lines count twice).
  const ledger = { lines: 0, bytes: 0 };
  const pushToolMessage = (id, name, raw) => {
    const serialized = serializeModelToolResult(name, raw, { maxBytes: toolResultMaxBytes });
    for (const slice of serialized.slices ?? []) {
      ledger.lines += slice.endLine - slice.startLine + 1;
      ledger.bytes += Buffer.byteLength(slice.text, "utf8");
    }
    messages.push({ role: "tool", tool_call_id: id, content: serialized.content });
    toolReceipts.push({
      callId: id,
      toolName: name,
      contentHash: serialized.modelPayloadHash,
      rawHash: serialized.rawHash,
      payloadBytes: Buffer.byteLength(serialized.content, "utf8"),
      truncated: serialized.truncated,
      slices: serialized.slices
    });
    return serialized;
  };
  let stopReason = "MODEL_STOP";
  // T09: the strict-JSON Q-track answer is the last assistant turn; expose it
  // so the external evaluator can score the answer itself (never the proxy).
  let finalContent = "";
  // T09: some open-weight models keep calling tools past the point where the
  // evidence is complete. A single stop nudge (identical for every arm) is a
  // harness-level convergence aid, not a hint about the answer. R01: it is
  // only appended AFTER every tool reply of the round (an assistant
  // tool_calls message must be followed directly by its tool messages).
  let answerNudgeSent = false;
  let runtimeError;
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const roundTools = recoveryPending ? [submitTool] : exposedTools;
      const estimated = estimatePromptTokens(messages, roundTools);
      if (estimated >= promptCap) {
        stopReason = "FAILED_CONTEXT_CAP";
        break;
      }
      if (recoveryPending) submissionAudit.recoveryCount += 1;
      const completion = await dispatch({
        messages,
        tools: roundTools,
        maxTokens: maxCompletionTokens
      });
      const choice = completion?.choices?.[0];
      const message = choice?.message ?? {};
      const calls = message.tool_calls ?? [];
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: calls.length ? calls : undefined
      });
      if (submitTool) {
        if (message.content != null && message.content !== "") submissionAudit.drafts.push({ requestIndex: requestIndex - 1, rawContent: message.content });
        const submitCalls = calls.filter(call => call?.function?.name === "submit_answer");
        if (!calls.length || submitCalls.length || recoveryPending) {
          const exclusive = calls.length === 1 && submitCalls.length === 1;
          const validation = !exclusive
            ? { ok: false, reason: calls.length ? "exclusive_submit_required" : "missing_submission" }
            : choice?.finish_reason === "length"
              ? { ok: false, reason: "length_truncated" }
              : validateSubmission(submitCalls[0]?.function?.arguments, submission.answerKeys, submission.fields);
          for (const call of calls) {
            const name = call?.function?.name;
            const id = call?.id ?? `call-${toolCalls.length}`;
            const rawArguments = call?.function?.arguments;
            toolCalls.push({ name, args: name === "submit_answer" && validation.ok ? validation.value : null, pathCount: 0, ...(validation.ok ? {} : { error: true }) });
            if (name === "submit_answer") submissionAudit.attempts.push({
              callId: id, requestIndex: requestIndex - 1, rawArguments,
              schemaVersion: submissionAudit.schemaVersion, accepted: validation.ok,
              ...(validation.ok ? {} : { reason: validation.reason, ...(validation.key ? { key: validation.key, rule: validation.rule } : {}) })
            });
            // Every rejected call is replied to, but none is invoked. In
            // particular a read mixed with submit cannot create source receipts.
            pushToolMessage(id, name, validation.ok
              ? { status: "SUBMITTED" }
              : { error: "Submission violates the public contract", errorClass: "PROTOCOL", reason: validation.reason });
          }
          if (validation.ok) {
            finalContent = JSON.stringify(validation.value);
            submissionAudit.acceptedAnswer = structuredClone(validation.value);
            submissionAudit.acceptedRequestIndex = requestIndex - 1;
            submissionAudit.receipts = structuredClone(toolReceipts.slice(0, attachedCount));
            stopReason = "SUBMITTED";
            break;
          }
          // Preserve provider truncation as the first stop cause even when
          // the public-contract recovery later succeeds or fails.
          submissionViolation ??= choice?.finish_reason === "length" ? "MAX_COMPLETION_TOKENS" : "INVALID_SUBMISSION";
          stopReason = "INVALID_SUBMISSION";
          if (recoveryPending || round === maxRounds - 1) break;
          recoveryPending = true;
          messages.push({
            role: "user",
            content: `Public submission contract recovery (one request maximum): call submit_answer as the only tool action, with exactly the public keys, declared types and advertised constraints.${validation.key ? ` Public field ${validation.key} violated its ${validation.rule ?? "type"} constraint.` : ""} Use facts already available; no other tool actions are allowed. Assistant text cannot submit an answer.`
          });
          continue;
        }
      }
      if (!calls.length) {
        stopReason = choice?.finish_reason === "length" ? "MAX_COMPLETION_TOKENS" : "MODEL_STOP";
        finalContent = message.content ?? "";
        break;
      }
      for (const call of calls) {
        const name = call?.function?.name;
        const id = call?.id ?? `call-${toolCalls.length}`;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          toolCalls.push({ name, args: null, pathCount: 0, error: true });
          pushToolMessage(id, name, { error: "invalid tool arguments", errorClass: "PROTOCOL" });
          continue;
        }
        const raw = await callTool(name, args, id);
        if (raw && typeof raw === "object" && "error" in raw && raw.error) {
          toolCalls.push({ name, args, pathCount: 0, error: true });
          pushToolMessage(id, name, raw);
          continue;
        }
        const serialized = pushToolMessage(id, name, raw);
        const toolPaths = name === "java_impact" || name === "java_context"
          ? (serialized.paths ?? collectImpactPaths(raw))
          : [...(typeof raw?.path === "string" ? [raw.path] : []), ...collectCandidatePaths(raw)];
        for (const filePath of toolPaths) observedPaths.add(filePath);
        for (const filePath of collectCandidatePaths(raw)) candidatePaths.add(filePath);
        toolCalls.push({ name, args, pathCount: toolPaths.length });
      }
      if (sourceBudget) {
        messages.push({
          role: "user",
          content: `Source budget: remainingLines=${Math.max(0, sourceBudget.max_lines - ledger.lines)}, remainingBytes=${Math.max(0, sourceBudget.max_bytes - ledger.bytes)} (read windows and previews together). ${ledger.lines >= sourceBudget.max_lines || ledger.bytes >= sourceBudget.max_bytes ? "Source budget exhausted: cannot receive more source." : "Receiving source beyond either limit fails the task."}`
        });
      }
      if (!answerNudgeSent && round >= Math.floor(maxRounds * 0.6)) {
        answerNudgeSent = true;
        messages.push({
          role: "user",
          content: submitTool
            ? "Use the available evidence to finish now by calling submit_answer exclusively, with exactly the public keys and declared types."
            : "You have gathered enough evidence. Stop calling tools and answer the task now with ONE strict JSON object only, using exactly the keys named in the task."
        });
      }
      if (round === maxRounds - 1) stopReason = "MAX_ROUNDS";
    }
  } catch (error) {
    stopReason = "FAILED_RUNTIME";
    runtimeError = error instanceof Error ? error.message : String(error);
  }
  const primaryStopReason = submissionViolation ?? stopReason;
  let finalAnswerMode = submitTool ? (stopReason === "SUBMITTED" ? "SUBMITTED" : "NO_SUBMISSION")
    : finalContent === "" ? "NO_ANSWER" : "MODEL_ANSWER";
  // Forced-answer fallback: when the loop produced no final answer, ask
  // once more with no tools at all so the model must commit to
  // an answer (or fail honestly). Identical for every arm. It is a real
  // request, so it goes through the same receipt boundary.
  if (!submitTool && finalContent === "" && stopReason !== "FAILED_RUNTIME" && stopReason !== "FAILED_CONTEXT_CAP") {
    try {
      const forced = await dispatch({
        messages: [
          ...messages,
          {
            role: "user",
            content: "Final answer now. No tools. Reply with ONE strict JSON object only, using exactly the keys named in the task."
          }
        ],
        tools: [],
        maxTokens: maxCompletionTokens
      }, { forcedAnswer: true });
      const forcedMessage = forced?.choices?.[0]?.message ?? {};
      finalContent = forcedMessage.content ?? "";
      if (finalContent) {
        stopReason = "FORCED_ANSWER";
        finalAnswerMode = "FORCED_ANSWER";
      }
    } catch (error) {
      if (auditCallbackFailed) {
        stopReason = "FAILED_RUNTIME";
        finalAnswerMode = "NO_ANSWER";
        runtimeError = error instanceof Error ? error.message : String(error);
      }
      // Legacy transport failures keep their original stop reason. Audit
      // callback failures are explicit runtime failures, never swallowed.
    }
  }
  const coverage = coverageProxy(task.requiredContextFiles, [...observedPaths]);
  const unscored = stopReason === "FAILED_CONTEXT_CAP"
    || stopReason === "FAILED_RUNTIME"
    || stopReason === "SERENA_UNAVAILABLE";
  return {
    taskId: task.taskId,
    arm,
    stopReason,
    primaryStopReason,
    finalAnswerMode,
    wallMs: Date.now() - started,
    toolCallCount: toolCalls.length,
    usage,
    coverage,
    candidatePaths: [...candidatePaths],
    taskOutcome: unmeasuredTaskOutcome(),
    taskSuccess: unscored ? null : coverage.success,
    finalContent,
    ...(submissionAudit ? { submission: submissionAudit } : {}),
    contextCapped: stopReason === "FAILED_CONTEXT_CAP",
    ...(runtimeError ? { error: runtimeError.slice(0, 500) } : {})
  };
}

export function liveProjectCacheRoot(outputDir, projectId) {
  return path.join(outputDir, "mcp-cache", projectId);
}

export async function resolveLiveRepositories(repositories) {
  const resolved = {};
  for (const [projectId, repoRoot] of Object.entries(repositories ?? {})) {
    if (!repoRoot) continue;
    resolved[projectId] = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
  }
  return resolved;
}

export async function prewarmLiveProjectCaches(tasks, repositories, outputDir) {
  const { runColdIndexBuild } = await import("../dist/java-index/cold-build.js");
  const { repoCacheRoot } = await import("../dist/repo-layout.js");
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.projectId)) continue;
    seen.add(task.projectId);
    const repoRoot = repositories[task.projectId];
    if (!repoRoot) throw new Error(`missing repository root for ${task.projectId}`);
    const cacheBase = liveProjectCacheRoot(outputDir, task.projectId);
    const cacheDir = repoCacheRoot(repoRoot, cacheBase);
    process.stderr.write(`[live-trace] prewarm ${task.projectId}\n`);
    await mkdir(cacheDir, { recursive: true });
    const result = await runColdIndexBuild(repoRoot, cacheDir, 1);
    if (!result?.ok) throw new Error(`prewarm ${task.projectId} failed`);
  }
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
  repositories = await resolveLiveRepositories(repositories);
  await prewarmLiveProjectCaches(tasks, repositories, outputDir);
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
          cacheRoot: liveProjectCacheRoot(outputDir, task.projectId),
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
    taskOutcome: unmeasuredTaskOutcome(),
    taskSuccess: {
      status: scored.length ? "MEASURED" : "UNMEASURED",
      tasks: results.length,
      scored: scored.length,
      successes,
      mean: scored.length ? successes / scored.length : null
    },
    scopes: {
      fixture: { status: "NOT_RUN" },
      function: { status: "NOT_RUN" },
      mcp: { status: "NOT_RUN" },
      live: { status: results.length ? "MEASURED" : "UNMEASURED", model },
      sourceReport: { status: "NOT_INCLUDED", note: "source probe reports are recorded separately and cannot overwrite live runtime identity" }
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
    coverage: coverageProxy(task.requiredContextFiles, []),
    taskOutcome: unmeasuredTaskOutcome(),
    taskSuccess: null,
    contextCapped: false,
    error: message.slice(0, 500)
  };
}

export async function openImpactSession({ repoRoot, serverJs, cacheRoot, env }) {
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
  return impactSessionFromClient({ repoRoot, client });
}

/** MCP mapping shared by the live session and capture-client contract tests. */
export function impactSessionFromClient({ repoRoot, client }) {
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
    // T09: raw discovery call for the task-eval host recorder. Returns the
    // parsed java-discovery/v1 payload so the recorder can hash the exact
    // source previews that crossed the wire.
    async symbol(args, wireText) {
      const result = await client.callTool({
        name: "java_symbol",
        arguments: {
          repoRoot,
          query: args.query,
          ...(args.terms ? { terms: args.terms } : {}),
          ...(args.searchMode ? { searchMode: args.searchMode } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.module ? { module: args.module } : {}),
          ...(args.sourceSet ? { sourceSet: args.sourceSet } : {}),
          ...(args.preview !== undefined ? { preview: args.preview } : {})
        }
      }, undefined, { timeout: IMPACT_TIMEOUT_MS });
      const text = result.content?.map(part => part.text).join("\n") ?? "{}";
      if (typeof wireText === "function") wireText(text);
      if (result.isError) return { error: text };
      return JSON.parse(text);
    },
    async evidence(args) {
      return callNamed("java_symbol", { repoRoot, operation: "evidence", file: args.file, line: args.line, column: args.column });
    },
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
