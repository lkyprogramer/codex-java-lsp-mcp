#!/usr/bin/env node
// input: Frozen dev task set (dataset/prompts/dev.jsonl), gold (dataset/gold),
//         a model backend (OpenAI-compatible API or codex CLI), and the local
//         product MCP server for java_symbol. No backend credentials means the
//         run reports BLOCKED_AUTH and nothing is measured.
// output: A java-devkit-task-eval/v1 results pack: per-task taskOutcome
//         (UNMEASURED until the external evaluator scores it), a SOURCE_RECEIVED
//         ledger built from actual tool/model events (never model narrative),
//         provider raw usage (null when missing, never bytes/4), and a
//         BLOCKED_AUTH report when no agent backend is authorized.
// pos: M2 T09 - host recorder adapter. Q-track answers are strict JSON scored
//      against frozen gold; P-track outcomes come from externally frozen tests
//      run against the candidate worktree. Path occurrences only ever feed the
//      coverage proxy, never the task outcome.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runLiveAgentTask,
  openImpactSession,
  liveProjectCacheRoot
} from "./run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "./openai-compatible-chat.mjs";
import { buildToolSet, createAttemptWorkspace, nativeToolNames } from "./eval-native-tools.mjs";

/** R03: the native tool surface shared by BOTH arms; the only arm
 * difference is java_symbol on the product arm. */
export function nativeNames(arm) {
  if (arm && !["product", "control"].includes(arm)) {
    throw new Error(`unknown arm: ${arm}`);
  }
  return nativeToolNames();
}

export const EVAL_PACK_SCHEMA_VERSION = "java-devkit-task-eval/v1";
const DISCOVERY_SCHEMA = "java-discovery/v1";

// T09 step 3: the agent gets the same model, prompt and budget and may use
// its tools freely - it is never forced to call java_symbol first.
// R01/W05 + R03: the prompt only references tools actually provided; both
// arms share the same native tools (list/rg/read; repair adds write_file)
// and the ONLY arm difference is the product arm's java_symbol.
export const EVAL_SYSTEM_PROMPT = `You are a Java specialist agent working in the repository given in the task. Use only the tools actually provided in this session - both arms share the native list, rg and read tools; the product arm additionally provides java_symbol; repair tasks additionally get write_file - in any order, or none at all. Never assume a tool that is not listed. Finish by replying with ONE strict JSON object and nothing else: for qa tasks use exactly the keys named in the task; for repair tasks use {"patchApplied": true|false, "summary": "..."}.`;;

export const EVAL_JAVA_SYMBOL_TOOL = {
  type: "function",
  function: {
    name: "java_symbol",
    description: "Locate Java declarations (types/methods) by name, FQN, or task intent. Returns declarations with 1-based locators and byte-exact source previews.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name, FQN, owner#method, or free task text" },
        terms: { type: "array", items: { type: "string" }, description: "Alternative search terms" },
        searchMode: { type: "string", enum: ["auto", "exact", "text"] },
        limit: { type: "integer" },
        module: { type: "string" },
        sourceSet: { type: "string", enum: ["main", "test"] }
      },
      required: ["query"]
    }
  }
};

export const EVAL_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read an exact file window from the repository (repo-relative path).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        maxLines: { type: "integer" }
      },
      required: ["path"]
    }
  }
};

/** Backends that can run a live agent. Anything else is BLOCKED_AUTH. */
export function detectBackend(env = process.env, checks = { hasCodexCli: () => false }) {
  if (env.OPENAI_API_KEY && env.OPENAI_BASE_URL && env.OPENAI_MODEL) {
    return { kind: "openai-api", model: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL };
  }
  if (checks.hasCodexCli?.()) {
    return { kind: "codex-cli", model: env.CODEX_MODEL ?? "codex-cli" };
  }
  return null;
}

export function backendDeficit(env = process.env, checks = { hasCodexCli: () => false }) {
  const openaiMissing = [];
  if (!env.OPENAI_API_KEY) openaiMissing.push("OPENAI_API_KEY");
  if (!env.OPENAI_BASE_URL) openaiMissing.push("OPENAI_BASE_URL");
  if (!env.OPENAI_MODEL) openaiMissing.push("OPENAI_MODEL");
  if (openaiMissing.length === 0) return [];
  if (checks.hasCodexCli?.()) return [];
  return [...openaiMissing, "codex CLI"];
}

/** v1.1: missing or unmeasured usage stays null per field - never 0, never
 * estimated from bytes/4. Provider raw usage (credentials never appear in it;
 * auth lives only in the request header) is preserved plus its hash. */
export function usageOrNull(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (usage.status !== "MEASURED" && usage.status !== "PARTIAL") return null;
  const intOr = value => (typeof value === "number" && Number.isFinite(value)) ? value : null;
  const out = {
    status: usage.status,
    inputTokens: intOr(usage.promptTokens ?? usage.prompt_tokens),
    outputTokens: intOr(usage.completionTokens ?? usage.completion_tokens)
  };
  if (usage.cachedInputTokens != null) out.cachedInputTokens = intOr(usage.cachedInputTokens);
  if (usage.reasoningTokens != null) out.reasoningTokens = intOr(usage.reasoningTokens);
  if (usage.rawUsage != null) out.rawUsage = usage.rawUsage;
  if (usage.rawUsageHash != null) out.rawUsageHash = usage.rawUsageHash;
  return out;
}

/**
 * R02: strict JSON answer parsing, equivalent to the frozen kit's
 * parse_json (object_pairs_hook rejects duplicate keys at ANY nesting depth;
 * JSON literals NaN/Infinity are rejected by JSON.parse; input length is
 * bounded). Markdown fences are packaging the frozen task contract does not
 * accept for strict answers - they are a transport format failure, reported
 * as INVALID_ANSWER, never silently stripped or gold-mutated.
 */
export const MAX_STRICT_ANSWER_CHARS = 262_144;

export function findDuplicateJsonKeys(text) {
  const duplicates = new Set();
  const frameStack = [];
  let inString = false;
  let escape = false;
  let buffer = "";
  // expectKey tracks whether the next JSON string is an object key: true
  // after `{` or `,` inside an object; reset by `:` once the key is consumed.
  let expectKey = false;
  const topFrame = () => frameStack[frameStack.length - 1];
  const afterValue = () => { const top = topFrame(); expectKey = Boolean(top && top.kind === "obj"); };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') {
        inString = false;
        const value = buffer;
        buffer = "";
        if (expectKey) {
          const top = topFrame();
          if (top && top.kind === "obj") {
            if (top.keys.has(value)) duplicates.add(value);
            top.keys.add(value);
          }
          // expectKey stays set until the ':' that follows the key.
        } else {
          afterValue();
        }
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      buffer = "";
      escape = false;
      continue;
    }
    if (ch === ":") { expectKey = false; continue; }
    if (ch === "{") {
      frameStack.push({ kind: "obj", keys: new Set() });
      expectKey = true;
      continue;
    }
    if (ch === "}") { frameStack.pop(); afterValue(); continue; }
    if (ch === "[") { afterValue(); frameStack.push({ kind: "arr" }); expectKey = false; continue; }
    if (ch === "]") { frameStack.pop(); afterValue(); continue; }
    if (ch === ",") {
      const top = topFrame();
      expectKey = Boolean(top && top.kind === "obj");
      continue;
    }
  }
  return [...duplicates];
}

/** Frozen-kit type semantics ported to JS: type identity, exact key sets,
 * element-wise list equality. (JS has one number type, so int/float is not
 * distinguishable - recorded in the evaluation protocol.) */
export function strictEqualDeep(a, b) {
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((x, i) => strictEqualDeep(x, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length || !aKeys.every(key => key in b)) return false;
  return aKeys.every(key => strictEqualDeep(a[key], b[key]));
}

/**
 * R02: the single strict QA scorer. extra/missing/duplicate keys, type
 * mismatches (no String() coercion) and bounded-input violations all fail.
 * The answer alone is NOT an answer: scoreRunOutcome additionally gates on
 * the frozen required_evidence lines having been received.
 */
export function scoreQaAnswer(goldAnswer, rawAnswer) {
  if (typeof rawAnswer !== "string") {
    return { status: "INVALID_ANSWER", correct: false, reason: "not_string" };
  }
  const text = rawAnswer.trim();
  if (text.length > MAX_STRICT_ANSWER_CHARS) {
    return { status: "INVALID_ANSWER", correct: false, reason: "input_too_long" };
  }
  const duplicates = findDuplicateJsonKeys(text);
  if (duplicates.length > 0) {
    return { status: "INVALID_ANSWER", correct: false, reason: "duplicate_keys", duplicates };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "INVALID_ANSWER", correct: false, reason: "parse_error" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "INVALID_ANSWER", correct: false, reason: "not_object" };
  }
  if (!goldAnswer || typeof goldAnswer !== "object" || Array.isArray(goldAnswer)) {
    return { status: "NO_GOLD", correct: false };
  }
  const goldKeys = Object.keys(goldAnswer);
  const missing = goldKeys.filter(key => !(key in value));
  if (missing.length > 0) return { status: "INCOMPLETE_ANSWER", correct: false, missing };
  const extra = Object.keys(value).filter(key => !goldKeys.includes(key));
  if (extra.length > 0) return { status: "EXTRA_KEYS", correct: false, extra };
  const wrong = goldKeys.filter(key => !strictEqualDeep(value[key], goldAnswer[key]));
  if (wrong.length > 0) return { status: "WRONG_ANSWER", correct: false, wrong };
  return { status: "CORRECT", correct: true };
}

/** Line-set coverage of frozen required_evidence by actually received source
 * (SOURCE_RECEIVED rows). Mirrors the kit's line_set/validate_regions
 * semantics on the host-recorded events. */
export function receivedLineCoverage(requiredEvidence, sourceReceived) {
  const required = (Array.isArray(requiredEvidence) ? requiredEvidence : [])
    .map(item => ({
      path: String(item?.path ?? "").replaceAll("\\", "/"),
      startLine: Number(item?.start_line),
      endLine: Number(item?.end_line)
    }))
    .filter(item => item.path.length > 0
      && Number.isInteger(item.startLine) && item.startLine >= 1
      && Number.isInteger(item.endLine) && item.endLine >= item.startLine);
  const covered = new Set();
  for (const event of Array.isArray(sourceReceived) ? sourceReceived : []) {
    const path = String(event?.path ?? "").replaceAll("\\", "/");
    const start = Number(event?.startLine);
    const end = Number(event?.endLine);
    if (path.length === 0 || !Number.isInteger(start) || start < 1
      || !Number.isInteger(end) || end < start) continue;
    for (let line = start; line <= end; line += 1) covered.add(`${path}:${line}`);
  }
  const missing = [];
  for (const item of required) {
    for (let line = item.startLine; line <= item.endLine; line += 1) {
      if (!covered.has(`${item.path}:${line}`)) {
        missing.push({ path: item.path, startLine: item.startLine, endLine: item.endLine });
        break;
      }
    }
  }
  return {
    requiredLines: required.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0),
    missing
  };
}

/**
 * One SOURCE_RECEIVED event per chunk of actual source text that crossed the
 * wire. The recorder builds these from transport/tool output; a model
 * narrative (a summary that merely mentions a path) never creates an event.
 */
export function sourceReceivedEvent({ callId, toolName, path: repoRelativePath, text, startLine, endLine }) {
  return {
    type: "SOURCE_RECEIVED",
    callId,
    path: String(repoRelativePath).replaceAll("\\", "/").replace(/^\.\/+/, ""),
    contentHash: createHash("sha256").update(String(text), "utf8").digest("hex"),
    startLine: Number(startLine),
    endLine: Number(endLine),
    text: String(text),
    origin: toolName === "read" ? "explicit_read" : "tool_response"
  };
}

/**
 * Extracts SOURCE_RECEIVED events from one tool result. Two shapes exist:
 *  - the read tool: the host returns the exact file text plus its range;
 *  - java_symbol (discovery): candidates carry byte-exact source previews
 *    with evidenceRange, identified by the frozen schemaVersion.
 * Plain text summaries produce no event: a summary is not source.
 */
export function extractSourceEvents({ callId, toolName, result }) {
  const events = [];
  if (!result) return events;
  if (toolName === "read") {
    const text = typeof result.text === "string" ? result.text
      : Array.isArray(result) ? result.map(block => (typeof block?.text === "string" ? block.text : "")).join("")
        : "";
    if (typeof result.path === "string" && text) {
      const lines = text.split("\n");
      const startLine = Number(result.startLine ?? 1);
      events.push(sourceReceivedEvent({
        callId,
        toolName,
        path: result.path,
        text,
        startLine,
        endLine: startLine + Math.max(0, lines.length - 1)
      }));
    }
    return events;
  }
  const text = typeof result === "string" ? result
    : Array.isArray(result) ? result.map(block => (typeof block?.text === "string" ? block.text : "")).join("")
      : typeof result?.text === "string" ? result.text
        : "";
  let payload;
  if (typeof result === "object" && result !== null && !Array.isArray(result) && "schemaVersion" in result) {
    // The live session parses discovery wire text before handing it to the
    // recorder; accept the already-parsed payload instead of re-parsing.
    payload = result;
  } else if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      return events;
    }
  } else {
    return events;
  }
  if (!payload || payload.schemaVersion !== DISCOVERY_SCHEMA || !Array.isArray(payload.candidates)) {
    return events;
  }
  for (const candidate of payload.candidates) {
    if (candidate?.previewKind === "source" && typeof candidate.preview === "string"
      && candidate.declaration?.relativePath && candidate.evidenceRange) {
      events.push(sourceReceivedEvent({
        callId,
        toolName,
        path: candidate.declaration.relativePath,
        text: candidate.preview,
        startLine: candidate.evidenceRange.startLine,
        endLine: candidate.evidenceRange.endLine
      }));
    }
  }
  return events;
}

export function createRecorder() {
  const events = [];
  return {
    recordToolResult({ callId, toolName, result }) {
      for (const event of extractSourceEvents({ callId, toolName, result })) events.push(event);
      return events.length;
    },
    // R01: minted only at the chat request boundary. A delivery receipt proves
    // the exact model payload contained the tool content; it does NOT prove
    // the model attended to it.
    recordModelDelivery(receipt) {
      events.push({
        type: "MODEL_TOOL_DELIVERED",
        callId: receipt.callId,
        toolName: receipt.toolName,
        contentHash: receipt.contentHash,
        payloadBytes: receipt.payloadBytes,
        ...(receipt.slices?.length ? { slices: receipt.slices } : {})
      });
      return events.length;
    },
    events: () => events
  };
}

/**
 * Assembles the results pack over the FULL scheduled plan. v1.1 semantics:
 * successRate = successes / scheduled attempts (every planned
 * task x arm x repeat row, failures and missing included); conditional
 * accuracy is reported separately and can never replace it. A task whose
 * outcome was never externally measured stays UNMEASURED - the pack never
 * promotes a proxy into a task success.
 */
export function assemblePack({ status, backend, datasetHash, arms, repeats, runs, blockedReasons, planned }) {
  const byKey = new Map();
  for (const run of runs) {
    const key = `${run.taskId}\u0000${run.arm}\u0000${run.repeat}`;
    if (byKey.has(key)) {
      throw new Error(`duplicate scheduled attempt row: ${run.taskId} / ${run.arm} / repeat ${run.repeat}`);
    }
    byKey.set(key, run);
  }
  const packRow = run => ({
    taskId: run.taskId,
    arm: run.arm,
    repeat: run.repeat,
    taskOutcome: run.taskOutcome ?? "UNMEASURED",
    taskSuccess: run.taskSuccess === true ? true : (run.taskSuccess === false ? false : null),
    answerStatus: run.answerStatus ?? null,
    toolCallCount: run.toolCallCount ?? 0,
    sourceReceived: run.sourceReceived ?? [],
    usage: usageOrNull(run.usage),
    timedOut: Boolean(run.timedOut),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(typeof run.finalAnswer === "string" && run.finalAnswer.length > 0 ? { finalAnswer: run.finalAnswer } : {}),
    error: run.error ?? null
  });
  // The scheduled universe: the explicit plan when provided (missing rows are
  // synthesized as MISSING_RESULT), otherwise the rows actually delivered.
  const keyOf = row => `${row.taskId ?? row}\u0000${row.arm ?? ""}\u0000${row.repeat ?? 1}`;
  const universe = Array.isArray(planned) && planned.length > 0 ? planned : [...byKey.values()];
  const missing = [];
  const packs = [];
  for (const row of universe) {
    const run = byKey.get(keyOf(row));
    if (run) {
      packs.push(packRow(run));
    } else {
      const synthetic = {
        taskId: typeof row === "string" ? row : row.taskId,
        arm: row.arm ?? "",
        repeat: row.repeat ?? 1,
        taskOutcome: "UNMEASURED",
        taskSuccess: null,
        answerStatus: "MISSING_RESULT",
        error: "planned attempt has no recorded result"
      };
      missing.push(synthetic);
      packs.push(packRow(synthetic));
    }
  }
  const measured = packs.filter(pack => pack.taskSuccess === true || pack.taskSuccess === false);
  const successes = packs.filter(pack => pack.taskSuccess === true).length;
  return {
    schemaVersion: EVAL_PACK_SCHEMA_VERSION,
    status,
    ...(blockedReasons?.length ? { blockedReasons } : {}),
    backend: backend ?? null,
    datasetHash: datasetHash ?? null,
    arms,
    repeats,
    denominator: packs.length,
    ...(missing.length > 0 ? { missingResults: missing.map(m => m.taskId) } : {}),
    packs,
    // End-to-end rate: successes / scheduled. Never successes / measured.
    taskSuccessRate: packs.length > 0 ? successes / packs.length : null,
    conditionalAccuracy: measured.length > 0 ? successes / measured.length : null,
    measuredAttempts: measured.length
  };
}

export function loadTaskFile(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

export function loadGoldFile(file) {
  const rows = loadTaskFile(file);
  return new Map(rows.map(row => [row.id, row]));
}

/**
 * Live eval runner (T09 step 5): 12 devpilot tasks x arms x repeats through
 * the real product MCP server and an authorized model backend. Only reached
 * with a real backend; without one, main() already reported BLOCKED_AUTH.
 * Q-track outcomes are scored against frozen gold; P-track (repair) outcomes
 * stay UNMEASURED unless an external frozen-test runner is injected.
 */
export async function runLiveEvalRun({
  tasks,
  gold,
  arms = ["product", "control"],
  repeats = 1,
  repoRoots,
  outputDir,
  env = process.env,
  serverJs,
  repairTester
}) {
  const config = openaiCompatibleConfig(env);
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for a live eval run");
  }
  mkdirSync(outputDir, { recursive: true });
  const recorder = createRecorder();
  const runs = [];
  for (const task of tasks) {
    const repoRoot = repoRoots?.[task.corpus];
    if (!repoRoot) {
      for (const arm of arms) {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: "UNMEASURED",
            taskSuccess: null,
            error: `no staged repository for corpus ${task.corpus}`
          });
        }
      }
      continue;
    }
    const goldRow = gold?.get(task.id);
    // R03: the pristine fixture is opened ONCE per corpus for the MCP
    // session's index; each attempt then gets its own candidate workspace
    // that all host tools (list/rg/read/write) operate on.
    const fixtureRoot = repoRoot;
    const lastCandidateSession = {};
    for (const arm of arms) {
      let fixtureSession;
      try {
        fixtureSession = await openImpactSession({
          repoRoot: fixtureRoot,
          serverJs,
          cacheRoot: liveProjectCacheRoot(outputDir, task.corpus),
          env
        });
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          // Each attempt starts from a live session bound to the PRISTINE
          // fixture; a previous attempt's write-rebind may have closed it.
          if (!fixtureSession) {
            fixtureSession = await openImpactSession({
              repoRoot: fixtureRoot,
              serverJs,
              cacheRoot: liveProjectCacheRoot(outputDir, task.corpus),
              env
            });
          }
          let callSeq = 0;
          const eventsBefore = recorder.events().length;
          const deliveredReceipts = new Set();
          // One isolated candidate copy per attempt (arm x repeat); the
          // candidate root is the single read/write root for this attempt.
          const candidateRoot = createAttemptWorkspace(
            fixtureRoot,
            `${task.id}:${arm}:r${repeat}`,
            path.join(outputDir, "candidates")
          );
          const toolSet = buildToolSet(
            arm === "product" ? "product" : "control",
            task.kind === "repair" ? "repair" : "qa",
            { candidateRoot }
          );
          const attemptSession = { session: fixtureSession };
          const rebinding = { value: false };
          const rebindingError = { value: null };
          const rebondSession = async () => {
            const old = attemptSession.session;
            const cache = liveProjectCacheRoot(outputDir, task.corpus, `${arm}-cand-r${repeat}`);
            attemptSession.session = await openImpactSession({
              repoRoot: candidateRoot,
              serverJs,
              cacheRoot: cache,
              env
            });
            lastCandidateSession[arm] = attemptSession.session;
            fixtureSession = null; // the bound session is consumed by the rebind
            await old.close().catch(() => undefined);
          };
          // The frozen output contract (answer keys) is part of the task both
          // arms see; without it the model invents its own key names.
          const contract = task.output_contract?.answer_keys
            ? Object.entries(task.output_contract.answer_keys)
                .map(([key, type]) => `${key}: ${type}`)
                .join(", ")
            : "";
          const run = await runLiveAgentTask({
            task: {
              taskId: task.id,
              taskText: `${task.query}${contract ? `\nAnswer contract: reply with ONE JSON object with exactly these keys: ${contract}.` : ""}`,
              projectId: task.corpus,
              requiredContextFiles: (goldRow?.required_evidence ?? []).map(item => item.path),
              anchor: task.anchors?.[0] ?? { file: "unknown", line: 1, column: 1 }
            },
            arm: "old",
            // R03 symmetric tools: both arms get list/rg/read (repair adds
            // write_file); the ONLY arm difference is java_symbol.
            systemPrompt: EVAL_SYSTEM_PROMPT,
            tools: arm === "product"
              ? [EVAL_JAVA_SYMBOL_TOOL, ...toolSet.tools]
              : toolSet.tools,
            chat: ({ messages, tools, maxTokens }) => openaiCompatibleChat({ ...config, messages, tools, maxTokens }),
            // R01: delivery receipts are minted at the chat request boundary;
            // payload-attached evidence is only credited after this point.
            onChat: ({ receipts, payloadHash }) => {
              for (const receipt of receipts) {
                if (!deliveredReceipts.has(receipt.callId)) {
                  deliveredReceipts.add(receipt.callId);
                  recorder.recordModelDelivery(receipt);
                }
              }
            },
            // Both arms get the same, larger round budget; the model is free
            // to stop earlier whenever it has its answer.
            maxRounds: 16,
            invoke: async (name, args) => {
              callSeq += 1;
              const callId = `eval:${task.id}:${arm}:${repeat}:${callSeq}`;
              if (name === "java_symbol") {
                return attemptSession.session.symbol(args, text => {
                  recorder.recordToolResult({ callId, toolName: name, result: text });
                });
              }
              const result = await toolSet.invoke(name, args);
              if (result && result.written === true) {
                recorder.recordToolResult({ callId, toolName: name, result });
                // The candidate changed: rebase the discovery session onto
                // the candidate so the NEXT query observes the modification.
                if (!rebinding.value) {
                  rebinding.value = true;
                  try {
                    await rebondSession();
                  } catch (error) {
                    rebindingError.value = error instanceof Error ? error.message : String(error);
                  }
                }
              } else if (result && result.text != null) {
                recorder.recordToolResult({ callId, toolName: name, result });
              }
              return result;
            }
          });
          if (rebindingError.value) {
            recorder.recordToolResult({ callId: `eval:${task.id}:${arm}:${repeat}:rebind`, toolName: "session_rebind", result: { error: rebindingError.value } });
          }
          const sourceReceived = recorder.events().slice(eventsBefore);
          const scored = scoreRunOutcome({ task, goldRow, run: {
            stopReason: run.stopReason,
            error: run.error,
            finalContent: run.finalContent,
            usage: run.usage,
            toolCallCount: run.toolCallCount,
            sourceReceived
          }, repairTester });
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: scored.taskOutcome,
            taskSuccess: scored.taskSuccess,
            answerStatus: scored.answerStatus,
            stopReason: run.stopReason,
            toolCallCount: run.toolCallCount,
            usage: run.usage,
            sourceReceived: recorder.events().slice(eventsBefore),
            finalAnswer: typeof run.finalContent === "string" ? run.finalContent.slice(0, 1000) : "",
            timedOut: run.stopReason === "MAX_ROUNDS" || run.stopReason === "FAILED_RUNTIME",
            ...(run.error ? { error: run.error } : {})
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: "UNMEASURED",
            taskSuccess: null,
            error: message.slice(0, 300)
          });
        }
      } finally {
        // Close whatever session this arm is currently bound to (fixture or
        // rebound candidate) so no server process leaks.
        const toClose = new Set();
        if (fixtureSession) toClose.add(fixtureSession);
        if (lastCandidateSession[arm]) toClose.add(lastCandidateSession[arm]);
        for (const s of toClose) {
          await s.close().catch(() => undefined);
        }
      }
    }
  }
  return {
    runs,
    sourceReceived: recorder.events(),
    backend: { kind: "openai-api", model: config.model }
  };
}

/**
 * R02: the single canonical outcome scorer - there is no parallel weak
 * path. QA requires the strict answer AND full receipt of the frozen
 * required_evidence lines; repair requires the injected frozen judge to
 * return `passed === true` (a Promise or truthy object is never a success).
 * Failed stops and unmeasured kinds stay taskSuccess null - but their
 * scheduled row remains in the denominator.
 */
export function scoreRunOutcome({ task, goldRow, run, repairTester }) {
  const failed = run.stopReason === "FAILED_RUNTIME"
    || run.stopReason === "FAILED_CONTEXT_CAP"
    || run.stopReason === "MAX_COMPLETION_TOKENS";
  if (failed) {
    return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: run.stopReason };
  }
  if (task.kind === "qa") {
    if (goldRow?.answer === undefined || goldRow?.answer === null) {
      return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: "NO_GOLD" };
    }
    const score = scoreQaAnswer(goldRow.answer, run.finalContent);
    if (!score.correct) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: score.status };
    }
    // E04: a correct answer is not an answer until the required frozen
    // source lines were actually received on this attempt.
    const required = Array.isArray(goldRow.required_evidence) ? goldRow.required_evidence : [];
    if (required.length === 0) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: "NO_REQUIRED_EVIDENCE" };
    }
    const coverage = receivedLineCoverage(required, run.sourceReceived ?? []);
    if (coverage.missing.length > 0) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: "MISSING_REQUIRED_EVIDENCE", missingEvidence: coverage.missing };
    }
    return { taskOutcome: "MEASURED", taskSuccess: true, answerStatus: score.status };
  }
  if (task.kind === "repair") {
    if (typeof repairTester !== "function") {
      return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: "NO_FROZEN_JUDGE" };
    }
    const verdict = repairTester({ task, finalContent: run.finalContent });
    const passed = verdict != null && verdict.passed === true;
    return {
      taskOutcome: "MEASURED",
      taskSuccess: passed,
      answerStatus: passed ? (verdict?.status ?? "external") : (verdict?.status ?? "REJECTED")
    };
  }
  return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: task.kind };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const tasksFile = flag("--tasks");
  const goldFile = flag("--gold");
  const output = flag("--output");
  const arms = (flag("--arms") ?? "product,control").split(",").filter(Boolean);
  const repeats = Math.max(1, Number(flag("--repeats") ?? 1));
  const dryRun = argv.includes("--dry-run");
  const filter = (flag("--filter") ?? "").split(",").filter(Boolean);
  if (!tasksFile || !output) {
    console.error("usage: evaluate-java-task.mjs --tasks <dev.jsonl> [--gold <gold.jsonl>] [--filter <id,id..>] [--repo-roots <corpus=path,..>] --output <dir> [--arms product,control] [--repeats N] [--dry-run]");
    return 2;
  }
  const datasetHash = goldFile
    ? createHash("sha256").update(readFileSync(goldFile)).digest("hex")
    : null;
  const allTasks = loadTaskFile(tasksFile);
  const tasks = filter.length > 0 ? allTasks.filter(task => filter.includes(task.id)) : allTasks;
  const backend = detectBackend(env);
  if (!backend || dryRun) {
    const runs = tasks.flatMap(task => arms.flatMap(arm =>
      Array.from({ length: repeats }, (_, repeat) => ({
        taskId: task.id,
        arm,
        repeat: repeat + 1,
        taskOutcome: "UNMEASURED",
        taskSuccess: null
      }))));
    const pack = assemblePack({
      status: dryRun ? "DRY_RUN" : "BLOCKED_AUTH",
      backend: dryRun ? null : backend,
      datasetHash,
      arms,
      repeats,
      runs,
      blockedReasons: dryRun ? undefined : backendDeficit(env)
    });    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ status: pack.status, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, output: path.join(output, "results-pack.json") }, null, 2));
    return 0;
  }
  // Live path: an authorized backend exists. A live run additionally needs a
  // staged corpus per task and gold; without them the pack reports exactly
  // what is missing instead of measuring anything.
  const repoRoots = Object.fromEntries(String(flag("--repo-roots") ?? "").split(",")
    .filter(Boolean)
    .map(pair => {
      const index = pair.indexOf("=");
      return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : [pair, pair];
    }));
  if (!goldFile) {
    console.error("live run requires --gold <gold.jsonl> (frozen evaluator-side labels)");
    return 2;
  }
  const live = await runLiveEvalRun({
    tasks,
    gold: loadGoldFile(goldFile),
    arms,
    repeats,
    repoRoots,
    outputDir: output,
    env,
    serverJs: flag("--server-js") ?? path.join(path.dirname(new URL(import.meta.url).pathname), "dist", "server.js")
  });
  const pack = assemblePack({
    status: "MEASURED",
    backend: live.backend,
    datasetHash,
    arms,
    repeats,
    runs: live.runs,
    // Full scheduled plan: every task x arm x repeat row stays in the
    // denominator even if its result row never materialized.
    planned: tasks.flatMap(task => arms.map(arm =>
      Array.from({ length: repeats }, (_, i) => ({ taskId: task.id, arm, repeat: i + 1 }))))
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(path.join(output, "source-received.jsonl"),
    `${live.sourceReceived.map(event => JSON.stringify(event)).join("\n")}${live.sourceReceived.length ? "\n" : ""}`, "utf8");
  console.log(JSON.stringify({ status: pack.status, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, output: path.join(output, "results-pack.json") }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}