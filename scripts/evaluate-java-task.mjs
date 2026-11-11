#!/usr/bin/env node
// input: An explicit task file (--tasks), its gold (--gold), the optional MAC-10 dataset manifest
//         (--dataset) both must belong to,
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
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLiveAgentTask,
  openImpactSession
} from "./run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "./openai-compatible-chat.mjs";
import { buildToolSet, createAttemptWorkspace, nativeToolNames, validateArguments } from "./eval-native-tools.mjs";
import { serializeModelToolResult, splitSourceLines } from "./eval-tool-wire.mjs";
import { buildFrozenResultsPack, runProfileFrom } from "./eval-frozen-adapter.mjs";
import { evaluateRepair } from "./eval-repair-adapter.mjs";
import { parseStrictAnswer, loadPublicAnswerContract, buildSubmitAnswerTool } from "./eval-answer-contract.mjs";
export { MAX_STRICT_ANSWER_CHARS, findDuplicateJsonKeys, parseStrictAnswer } from "./eval-answer-contract.mjs";

/** R03: the native tool surface shared by BOTH arms; the only arm
 * difference is java_symbol on the product arm. */
export function nativeNames(arm) {
  if (arm && !["product", "control"].includes(arm)) {
    throw new Error(`unknown arm: ${arm}`);
  }
  return nativeToolNames();
}

export const EVAL_PACK_SCHEMA_VERSION = "java-devkit-task-eval/v1";
/**
 * Eval protocol v1.4 uses exclusive typed submission and explicit source
 * exhaustion; discovery defaults to locators without source previews.
 * Results from different protocol versions are not comparable.
 */
export const EVAL_PROTOCOL_VERSION = "eval-protocol/v1.5";
const DISCOVERY_SCHEMA = "java-discovery/v1";

// T09 step 3: the agent gets the same model, prompt and budget and may use
// its tools freely - it is never forced to call java_symbol first.
// R01/W05 + R03: the prompt only references tools actually provided; both
// arms share the same native tools (list/rg/read; repair adds write_file)
// and the ONLY arm difference is the product arm's java_symbol.
export const EVAL_SYSTEM_PROMPT = `You are a Java specialist agent working in the repository given in the task. Use only the tools actually provided in this session, in any order, or none at all. Never assume an unlisted tool. Locate declarations, then read the implementation needed for the question. rg/list and symbol results without source previews are locators only, not source evidence. Before submitting, read the implementation and field declarations supporting every answer, including relevant callees, helpers and XML mappings. Target exact matching lines with rg and short read windows; do not consume the budget by reading a large file from its beginning or by requesting previews for many candidates. After receiving that implementation, continue retrieval only to resolve a specific missing fact or dependency; do not repeat discovery of an already located declaration. For concrete return values, trace the operations in the received source step by step before answering. Source previews and explicit reads both consume the source budget, including repeated lines. Read non-Java evidence such as XML explicitly when the question requires it. Assistant body text is draft only. Finish exclusively with submit_answer as the only tool action in that response. For QA use exactly the task's public keys, field roles, types and representation constraints. Member names must be simple identifiers, without package, owner, signature, call arguments or explanation. Return an enum constant's simple name without its owner. Return an expression only when the question requests an expression; do not add prose inside string values. For repair use {"patchApplied": true|false, "summary": "..."}.`;

export const EVAL_JAVA_SYMBOL_TOOL = {
  type: "function",
  function: {
    name: "java_symbol",
    description: "Locate Java declarations (types/methods) by name, FQN, or task intent. Matching is lexical over code identifiers, comments and framework keys: query with likely code identifiers (usually English); a query sharing no word with the code returns emptyReason=no_vocabulary_overlap. Returns declarations with 1-based locators (the declaration name) and short byte-exact previews (preview=none by default; head or window on explicit request).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name, FQN, owner#method, or free task text" },
        terms: { type: "array", items: { type: "string" }, description: "Alternative search terms" },
        searchMode: { type: "string", enum: ["auto", "exact", "text"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        module: { type: "string" },
        sourceSet: { type: "string", enum: ["main", "test"] },
        preview: { type: "string", enum: ["none", "head", "window"] }
      },
      required: ["query"]
    }
  }
};

export const EVAL_JAVA_EVIDENCE_TOOL = {
  type: "function",
  function: {
    name: "java_evidence",
    description: "Request byte-exact indexed MyBatis XML source units linked by fully qualified Java names. For resultMap type links use an already located type declaration's 1-based anchor, not its constructor; method anchors return associated mapped XML statements. Unit completeness describes only the XML source range, not task completion. Stale or omitted bindings remain explicit.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { file: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } },
      required: ["file", "line", "column"]
    }
  }
};

export function productTools(productProfile = "broad") {
  if (!["broad", "evidence", "exact-evidence"].includes(productProfile)) throw new Error(`unknown productProfile: ${productProfile}`);
  if (productProfile !== "exact-evidence") return productProfile === "broad" ? [EVAL_JAVA_SYMBOL_TOOL] : [EVAL_JAVA_SYMBOL_TOOL, EVAL_JAVA_EVIDENCE_TOOL];
  const { terms: _terms, ...properties } = EVAL_JAVA_SYMBOL_TOOL.function.parameters.properties;
  return [{ type: "function", function: { ...EVAL_JAVA_SYMBOL_TOOL.function,
    description: "Locate Java type or method declarations by exact symbol name, FQN, or owner#method. Returns 1-based declaration anchors. Search is exact only; use native rg and read for text discovery. Source previews are opt-in and consume the shared source budget.",
    parameters: { ...EVAL_JAVA_SYMBOL_TOOL.function.parameters, additionalProperties: false,
      properties: { ...properties, query: { type: "string", description: "Exact symbol name, FQN, or owner#method" }, searchMode: { type: "string", enum: ["exact"] } } }
  } }, EVAL_JAVA_EVIDENCE_TOOL];
}

/** Validate the advertised product contract before dispatch, including bounds. */
export function validateProductArguments(tool, args) {
  const schema = tool.function.parameters;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) return `${key} is required`;
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key];
    if (!spec) return `unknown parameter: ${key}`;
    if (spec.type === "array" ? !Array.isArray(value) || value.some(item => typeof item !== spec.items.type)
      : spec.type === "integer" ? !Number.isInteger(value) : typeof value !== spec.type) return `${key} must be ${spec.type}`;
    if (spec.enum && !spec.enum.includes(value)) return `${key} must be one of ${spec.enum.join(", ")}`;
    if (spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum) return `${key} is out of bounds`;
    if (spec.minLength && value.length < spec.minLength) return `${key} must not be empty`;
  }
  return null;
}

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
  const parsed = parseStrictAnswer(rawAnswer);
  if (!parsed.ok) {
    return { status: "INVALID_ANSWER", correct: false, reason: parsed.reason, ...(parsed.duplicates ? { duplicates: parsed.duplicates } : {}) };
  }
  const value = parsed.value;
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

/** Only payload-attached source counts as received: SOURCE_RECEIVED rows
 * are minted from the slices of a tool message that was actually dispatched
 * in a chat request (recordModelDelivery). SOURCE_FETCHED rows (raw tool
 * output, possibly larger than what the model saw) are never credited. */
export function receivedSourceEvents(events) {
  return (Array.isArray(events) ? events : []).filter(event => event?.type === "SOURCE_RECEIVED");
}

/** Line-set coverage of frozen required_evidence by received source.
 * Mirrors the kit's line_set/validate_regions semantics. */
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
  let receivedLines = 0;
  let receivedBytes = 0;
  for (const event of receivedSourceEvents(sourceReceived)) {
    const path = String(event?.path ?? "").replaceAll("\\", "/");
    const start = Number(event?.startLine);
    const end = Number(event?.endLine);
    if (path.length === 0 || !Number.isInteger(start) || start < 1
      || !Number.isInteger(end) || end < start) continue;
    receivedLines += end - start + 1;
    receivedBytes += Buffer.byteLength(String(event.text ?? ""), "utf8");
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
    receivedLines,
    receivedBytes,
    missing
  };
}

/** Lines of a source window, terminators kept; a trailing terminator does
 * not add a phantom line. */
function countSourceLines(text) {
  return splitSourceLines(String(text)).length;
}

/**
 * One source event per window of actual source text. `type` is
 * SOURCE_FETCHED for raw tool output and SOURCE_RECEIVED only for slices
 * that crossed the model-payload boundary. `contentHash` hashes the slice
 * text; `fileContentHash` is the whole-file sha256 the frozen kit validates.
 */
export function sourceEvent({ type, callId, toolName, path: repoRelativePath, text, startLine, endLine, fileContentHash }) {
  return {
    type,
    callId,
    toolName,
    path: String(repoRelativePath).replaceAll("\\", "/").replace(/^\.\/+/, ""),
    contentHash: createHash("sha256").update(String(text), "utf8").digest("hex"),
    ...(typeof fileContentHash === "string" ? { fileContentHash } : {}),
    startLine: Number(startLine),
    endLine: Number(endLine),
    text: String(text),
    origin: toolName === "read" ? "explicit_read" : "tool_response"
  };
}

/**
 * Extracts raw SOURCE_FETCHED events from one tool result (the read tool's
 * exact window, java_symbol byte-exact previews). Fetched is not received:
 * these rows are diagnostics and never feed the task outcome.
 */
export function extractSourceEvents({ callId, toolName, result }) {
  const events = [];
  if (!result) return events;
  if (toolName === "read") {
    const text = typeof result.text === "string" ? result.text
      : Array.isArray(result) ? result.map(block => (typeof block?.text === "string" ? block.text : "")).join("")
        : "";
    if (typeof result.path === "string" && text) {
      const startLine = Number(result.startLine ?? 1);
      events.push(sourceEvent({
        type: "SOURCE_FETCHED",
        callId,
        toolName,
        path: result.path,
        text,
        startLine,
        endLine: startLine + Math.max(0, countSourceLines(text) - 1),
        fileContentHash: typeof result.contentHash === "string" ? result.contentHash : undefined
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
  // v2 (post-ILV2 Q04) keeps the v1 unit fields and adds Java declaration units.
  if (toolName === "java_evidence" && (payload?.schemaVersion === "java-evidence-unit/v1" || payload?.schemaVersion === "java-evidence-unit/v2")) {
    for (const unit of payload.units ?? []) {
      if (typeof unit.text !== "string" || !unit.text || typeof unit.path !== "string"
        || !Number.isInteger(unit.startLine) || unit.startLine < 1 || !Number.isInteger(unit.endLine)
        || splitSourceLines(unit.text).length !== unit.endLine - unit.startLine + 1) continue;
      events.push(sourceEvent({ type: "SOURCE_FETCHED", callId, toolName, path: unit.path, text: unit.text,
        startLine: unit.startLine, endLine: unit.endLine, fileContentHash: unit.contentHash }));
    }
    return events;
  }
  if (!payload || payload.schemaVersion !== DISCOVERY_SCHEMA || !Array.isArray(payload.candidates)) {
    return events;
  }
  for (const candidate of payload.candidates) {
    const sourcePath = candidate?.evidenceRange?.relativePath ?? candidate?.declaration?.relativePath;
    if (candidate?.previewKind === "source" && typeof candidate.preview === "string"
      && sourcePath && candidate.evidenceRange) {
      events.push(sourceEvent({
        type: "SOURCE_FETCHED",
        callId,
        toolName,
        path: sourcePath,
        text: candidate.preview,
        startLine: candidate.evidenceRange.startLine,
        endLine: candidate.evidenceRange.endLine,
        fileContentHash: candidate.evidenceRange.relativePath ? candidate.evidenceRange.contentHash : candidate.declaration.contentHash
      }));
    }
  }
  return events;
}

export function normalizeTaskAnchor(anchor) {
  return anchor ? { ...anchor, file: anchor.file ?? anchor.path ?? "unknown", column: anchor.column ?? 1 }
    : { file: "unknown", line: 1, column: 1 };
}

/** Evaluation-only projection; raw discovery remains in the audit journal. */
export function projectDiscoveryForModel(result) {
  if (!Array.isArray(result?.candidates)) return result;
  const projected = Object.fromEntries(Object.entries(result).filter(([key]) => !["repoHash", "generation", "candidates"].includes(key)));
  projected.candidates = result.candidates.map(candidate => {
    const { id: _id, sourceRoot: _root, ...declaration } = candidate.declaration ?? {};
    // The range owns the preview hash; retain the locator hash for no-preview results.
    if (candidate.evidenceRange?.contentHash && candidate.evidenceRange.relativePath === declaration.relativePath) delete declaration.contentHash;
    const { matchedBy: _matched, declaration: _declaration, ...rest } = candidate;
    return { declaration, ...rest };
  });
  return projected;
}

/** Exhaustion stops new reads before any source is fetched. Invalid public
 * arguments still return their contract error instead of a budget status. */
export async function invokeWithSourceBudget(toolSet, name, args, remaining) {
  if (name !== "read" || !remaining || (remaining.lines > 0 && remaining.bytes > 0)) return toolSet.invoke(name, args);
  const schema = toolSet.tools.find(tool => tool.function.name === name)?.function.parameters;
  if (!schema) return toolSet.invoke(name, args);
  const invalid = validateArguments(schema, args);
  if (invalid) return { error: invalid };
  for (const key of ["startLine", "maxLines"]) if (Object.hasOwn(args, key) && args[key] < 1) return { error: `${key} must be a positive integer` };
  return { error: "SOURCE_BUDGET_EXHAUSTED", errorClass: "SOURCE_BUDGET", remainingSourceBudget: { lines: Math.max(0, remaining.lines), bytes: Math.max(0, remaining.bytes) }, terminal: true };
}

/** Limit only whole source lines. Repeated deliveries are charged again. */
export function boundSourceResult(toolName, result, remaining) {
  if (!remaining || !result || typeof result !== "object") return result;
  let linesLeft = Math.max(0, remaining.lines);
  let bytesLeft = Math.max(0, remaining.bytes);
  let clipped = false;
  const prefix = text => {
    const lines = splitSourceLines(text);
    const kept = [];
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, "utf8");
      if (linesLeft < 1 || bytes > bytesLeft) break;
      kept.push(line);
      linesLeft -= 1;
      bytesLeft -= bytes;
    }
    if (kept.length !== lines.length) clipped = true;
    return { text: kept.join(""), lines: kept.length, shortened: kept.length !== lines.length };
  };
  if (toolName === "read" && typeof result.text === "string") {
    const kept = prefix(result.text);
    return { ...result, text: kept.text, endLine: result.startLine + kept.lines - 1,
      remainingSourceBudget: { lines: linesLeft, bytes: bytesLeft },
      ...(kept.shortened ? { truncated: true, nextStartLine: result.startLine + kept.lines, sourceBudgetLimited: true, terminal: linesLeft === 0 || bytesLeft === 0, ...(kept.lines === 0 && linesLeft > 0 && bytesLeft > 0 ? { sourceBudgetReason: "NEXT_LINE_EXCEEDS_REMAINING_BYTES" } : {}) } : {}) };
  }
  if (toolName === "java_evidence" && Array.isArray(result.units)) {
    const units = result.units.map(unit => {
      if (typeof unit.text !== "string" || !unit.text) return unit;
      const kept = prefix(unit.text);
      return { ...unit, text: kept.text, endLine: unit.startLine + kept.lines - 1,
        ...(kept.shortened ? { originalEndLine: unit.originalEndLine ?? unit.endLine, complete: false, sourceOmitted: "SOURCE_BUDGET" } : {}) };
    });
    return { ...result, units, remainingSourceBudget: { lines: linesLeft, bytes: bytesLeft },
      ...(clipped ? { truncated: true, sourceBudgetLimited: true } : {}) };
  }
  if (toolName !== "java_symbol" || !Array.isArray(result.candidates)) return result;
  const candidates = result.candidates.map(candidate => {
    if (candidate.previewKind !== "source" || typeof candidate.preview !== "string" || !candidate.evidenceRange) return candidate;
    const kept = prefix(candidate.preview);
    if (!kept.lines) {
      const { preview: _preview, previewKind: _kind, evidenceRange: _range, ...locator } = candidate;
      return { ...locator, declaration: { ...locator.declaration,
        ...(locator.declaration?.contentHash ? {} : { contentHash: candidate.evidenceRange.contentHash }) }, previewOmitted: "SOURCE_BUDGET" };
    }
    return { ...candidate, preview: kept.text,
      evidenceRange: { ...candidate.evidenceRange, endLine: candidate.evidenceRange.startLine + kept.lines - 1 },
      ...(kept.shortened ? { previewTruncated: true } : {}) };
  });
  return { ...result, candidates, remainingSourceBudget: { lines: linesLeft, bytes: bytesLeft }, ...(clipped ? { truncated: true, sourceBudgetLimited: true } : {}) };
}

/** Source received before a repair can legitimately differ from the final tree.
 * Verify against its exact recorded file version, separately from frozen scoring. */
export function diagnoseCandidateReceipts(events, { candidateRoot, snapshotRoot }) {
  const rows = events.filter(event => event.type === "SOURCE_RECEIVED").map(event => {
    const hash = event.fileContentHash;
    const snapshot = typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? path.join(snapshotRoot, hash) : null;
    const current = path.resolve(candidateRoot, event.path);
    const within = current.startsWith(`${path.resolve(candidateRoot)}${path.sep}`);
    const raw = snapshot && existsSync(snapshot) ? readFileSync(snapshot) : null;
    const exactText = raw ? splitSourceLines(raw.toString("utf8")).slice(event.startLine - 1, event.endLine).join("") : null;
    const valid = raw !== null && createHash("sha256").update(raw).digest("hex") === hash && exactText === event.text;
    const finalCandidateMatches = within && existsSync(current)
      ? createHash("sha256").update(readFileSync(current)).digest("hex") === hash : false;
    return { callId: event.callId, path: event.path, startLine: event.startLine, endLine: event.endLine,
      fileContentHash: hash ?? null, valid, finalCandidateMatches };
  });
  return { status: rows.every(row => row.valid) ? "VALID" : "INVALID", checkedReceipts: rows.length, rows };
}

export function createRecorder() {
  const events = [];
  return {
    recordToolResult({ callId, toolName, result }) {
      for (const event of extractSourceEvents({ callId, toolName, result })) events.push(event);
      return events.length;
    },
    /** R01: called only from the chat request boundary with the receipts the
     * request newly attached. Proves payload attachment, not attention. */
    recordModelDelivery(receipt, { requestIndex, payloadHash } = {}) {
      events.push({
        type: "MODEL_PAYLOAD_ATTACHED",
        callId: receipt.callId,
        toolName: receipt.toolName,
        contentHash: receipt.contentHash,
        rawHash: receipt.rawHash ?? null,
        payloadBytes: receipt.payloadBytes,
        truncated: receipt.truncated === true,
        ...(requestIndex !== undefined ? { requestIndex } : {}),
        ...(payloadHash ? { requestPayloadHash: payloadHash } : {})
      });
      for (const slice of receipt.slices ?? []) {
        events.push(sourceEvent({
          type: "SOURCE_RECEIVED",
          callId: receipt.callId,
          toolName: receipt.toolName,
          path: slice.path,
          text: slice.text,
          startLine: slice.startLine,
          endLine: slice.endLine,
          fileContentHash: slice.fileContentHash
        }));
      }
      return events.length;
    },
    record(event) {
      events.push(event);
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
export function assemblePack({ status, backend, datasetHash, arms, repeats, runs, blockedReasons, planned, productProfile = "broad", publicAnswerContract = null, identity = null }) {
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
    ...(run.attemptState ? { attemptState: run.attemptState } : {}),
    ...(run.repairJudge ? { repairJudge: run.repairJudge } : {}),
    ...(run.candidateReceiptValidation ? { candidateReceiptValidation: run.candidateReceiptValidation } : {}),
    ...(run.frozenScore ? { frozenScore: run.frozenScore, preliminary: run.preliminary } : {}),
    ...(run.partial ? { partial: true } : {}),
    toolCallCount: run.toolCallCount ?? 0,
    sourceReceived: receivedSourceEvents(run.sourceReceived),
    usage: usageOrNull(run.usage),
    timedOut: Boolean(run.timedOut),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.primaryStopReason ? { primaryStopReason: run.primaryStopReason } : {}),
    ...(run.finalAnswerMode ? { finalAnswerMode: run.finalAnswerMode } : {}),
    ...(run.submission ? { submission: run.submission } : {}),
    ...(run.publicAnswerContract ? { publicAnswerContract: run.publicAnswerContract } : {}),
    ...(typeof run.finalAnswer === "string" && run.finalAnswer.length > 0 ? { finalAnswer: run.finalAnswer } : {}),
    error: run.error ?? null
  });
  // The scheduled universe: the explicit plan when provided (missing rows are
  // synthesized as MISSING_RESULT), otherwise the rows actually delivered.
  const keyOf = row => `${row.taskId}\u0000${row.arm ?? ""}\u0000${row.repeat ?? 1}`;
  if (planned !== undefined) {
    if (!Array.isArray(planned)) throw new Error("planned must be a flat list of attempt rows");
    const seenPlan = new Set();
    for (const row of planned) {
      if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.taskId !== "string") {
        throw new Error("planned must be a flat list of {taskId, arm, repeat} rows");
      }
      if (seenPlan.has(keyOf(row))) throw new Error(`duplicate planned attempt: ${row.taskId} / ${row.arm} / repeat ${row.repeat}`);
      seenPlan.add(keyOf(row));
    }
    for (const key of byKey.keys()) {
      if (!seenPlan.has(key)) throw new Error(`result row outside the frozen plan: ${key.replaceAll("\u0000", " / ")}`);
    }
  }
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
    evalProtocol: EVAL_PROTOCOL_VERSION,
    productProfile,
    publicAnswerContract: publicAnswerContract ? { version: publicAnswerContract.version, sha256: publicAnswerContract.sha256 } : null,
    status,
    ...(blockedReasons?.length ? { blockedReasons } : {}),
    backend: backend ?? null,
    datasetHash: datasetHash ?? null,
    identity,
    arms,
    repeats,
    denominator: packs.length,
    ...(missing.length > 0 ? { missingResults: missing.map(m => m.taskId) } : {}),
    packs,
    // End-to-end rate: successes / scheduled. Never successes / measured. A pack that measured
    // nothing (no backend, dry run) has no rate at all: 0 would read as a measured failure.
    taskSuccessRate: status === "MEASURED" && packs.length > 0 ? successes / packs.length : null,
    conditionalAccuracy: measured.length > 0 ? successes / measured.length : null,
    measuredAttempts: measured.length
  };
}

export function loadTaskFile(file) {
  // A MAC-10 dataset row names its task `taskId`; kit rows use `id`.
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
    .map(row => row.id === undefined && typeof row.taskId === "string" ? { ...row, id: row.taskId } : row);
}

export function loadGoldFile(file) {
  const rows = loadTaskFile(file);
  return new Map(rows.map(row => [row.id, row]));
}

/** The full frozen schedule (task x arm x repeat, primary variant) - one
 * flat row per attempt, fixed before anything runs. */
export function buildPlannedAttempts(tasks, arms, repeats) {
  return tasks.flatMap(task => arms.flatMap(arm =>
    Array.from({ length: repeats }, (_, i) => ({ taskId: task.id, variant: "primary", arm, repeat: i + 1 }))));
}

/** Seed-balanced arm order per (task, repeat): the starting arm rotates with
 * the repeat index from a seeded per-task offset, so no arm is always run
 * first (warm caches, provider drift) and the order is reproducible. */
export function armOrder(arms, { seed = 1984, taskId, repeat }) {
  const offset = createHash("sha256").update(`${seed}:${taskId}`, "utf8").digest()[0];
  const shift = (offset + repeat - 1) % arms.length;
  return [...arms.slice(shift), ...arms.slice(0, shift)];
}

const REPAIR_BLOCKED_STATES = new Set(["BLOCKED_ENV", "BLOCKED_SETUP", "JUDGE_ERROR"]);

export function attemptStateOf(run) {
  if (run.setupError) return "BLOCKED_SETUP";
  if (["FAILED_RUNTIME", "FAILED_CONTEXT_CAP", "MAX_COMPLETION_TOKENS"].includes(run.stopReason)) return "FAILED_RUNTIME";
  if (typeof run.stopReason !== "string") return "MISSING_RESULT";
  return "COMPLETED";
}

/**
 * Live eval runner: every planned attempt (task x arm x repeat) gets its own
 * candidate workspace that is the single analysis/read/write/test root; the
 * product arm's java_symbol session is opened ON that candidate and re-opened
 * after every write so the next query observes the change. Arm order is
 * seed-balanced. QA is scored on payload-attached source only; repair is
 * judged by the frozen Python judge on the attempt's candidate tree.
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
  kitRoot,
  seed = 1984,
  maxRounds = 16,
  chat,
  chatRequestConfig = {},
  repairJudge = evaluateRepair,
  openSessionImpl = openImpactSession,
  productProfile = "broad",
  publicAnswerContract = null
}) {
  const productDeclarations = productTools(productProfile);
  if (publicAnswerContract) for (const task of tasks.filter(task => task.kind === "qa")) {
    const fields = publicAnswerContract.tasks.get(task.id);
    if (!fields) throw new TypeError(`public answer contract missing task: ${task.id}`);
    buildSubmitAnswerTool(task.output_contract?.answer_keys, fields);
  }
  const config = openaiCompatibleConfig(env);
  const effectiveChatRequestConfig = { ...chatRequestConfig,
    reasoningEffort: chatRequestConfig.reasoningEffort ?? config.reasoningEffort };
  if (!chat && (!config.baseUrl || !config.apiKey || !config.model)) {
    throw new Error("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for a live eval run");
  }
  const chatImpl = chat ?? (({ messages, tools, maxTokens, reasoningEffort, chatTemplateKwargs }) =>
    openaiCompatibleChat({ ...config, messages, tools, maxTokens, reasoningEffort, chatTemplateKwargs }));
  mkdirSync(outputDir, { recursive: true });
  const payloadLog = path.join(outputDir, "model-payloads.jsonl");
  const completionLog = path.join(outputDir, "model-completions.jsonl");
  const toolLog = path.join(outputDir, "raw-tool-results.jsonl");
  const recorder = createRecorder();
  const runs = [];
  for (const task of tasks) {
    const goldRow = gold?.get(task.id);
    const fixtureRoot = repoRoots?.[task.corpus]
      ?? (kitRoot ? path.join(path.resolve(kitRoot), "dataset", "corpora", task.corpus) : undefined);
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const arm of armOrder(arms, { seed, taskId: task.id, repeat })) {
        const attemptKey = `${task.id}:${arm}:r${repeat}`;
        const eventsBefore = recorder.events().length;
        const attemptStarted = Date.now();
        const contractIdentity = publicAnswerContract ? { version: publicAnswerContract.version, sha256: publicAnswerContract.sha256, applied: task.kind === "qa" } : null;
        const base = { taskId: task.id, variant: "primary", arm, repeat, kind: task.kind, productProfile, publicAnswerContract: contractIdentity };
        if (!fixtureRoot || !existsSync(fixtureRoot)) {
          runs.push({ ...base, attemptState: "BLOCKED_SETUP", taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: "NO_STAGED_REPOSITORY", error: `no staged repository for corpus ${task.corpus}` });
          continue;
        }
        let candidateRoot;
        let session = null;
        let sessionGeneration = 0;
        const sessions = [];
        let partial = false;
        const cacheFor = generation => path.join(outputDir, "mcp-cache", createHash("sha256").update(attemptKey).digest("hex").slice(0, 16), `w${generation}`);
        const openSession = async () => {
          const opened = await openSessionImpl({ repoRoot: candidateRoot, serverJs, cacheRoot: cacheFor(sessionGeneration), env });
          sessions.push(opened);
          return opened;
        };
        try {
          candidateRoot = createAttemptWorkspace(fixtureRoot, attemptKey, outputDir);
          const toolSet = buildToolSet(arm === "product" ? "product" : "control", task.kind === "repair" ? "repair" : "qa", { candidateRoot });
          // The control arm never needs (or pays for) a discovery session.
          if (arm === "product") session = await openSession();
          const contract = task.output_contract?.answer_keys
            ? Object.entries(task.output_contract.answer_keys).map(([key, type]) => `${key}: ${type}`).join(", ")
            : "";
          const budget = task.budget
            ? `\nSource budget: all source you receive (read windows and previews together) may total at most ${task.budget.max_lines} lines / ${task.budget.max_bytes} bytes; receiving more fails the task.`
            : "";
          let callSeq = 0;
          const snapshotRoot = path.join(outputDir, "source-snapshots", path.basename(candidateRoot));
          mkdirSync(snapshotRoot, { recursive: true });
          const sourceSpent = { lines: 0, bytes: 0 };
          const modelResult = (name, args, raw, callId) => {
            recorder.recordToolResult({ callId, toolName: name, result: raw });
            // Store exact file versions before a later mutation changes them.
            for (const event of extractSourceEvents({ callId, toolName: name, result: raw })) {
              const file = path.resolve(candidateRoot, event.path);
              if (!file.startsWith(`${candidateRoot}${path.sep}`) || !existsSync(file)) continue;
              const bytes = readFileSync(file);
              const hash = createHash("sha256").update(bytes).digest("hex");
              if (hash === event.fileContentHash) writeFileSync(path.join(snapshotRoot, hash), bytes);
            }
            const projected = name === "java_symbol" ? projectDiscoveryForModel(raw) : raw;
            const limited = task.kind === "qa" && task.budget ? boundSourceResult(name, projected, {
              lines: task.budget.max_lines - sourceSpent.lines,
              bytes: task.budget.max_bytes - sourceSpent.bytes
            }) : projected;
            // Reserve the serialized slices before dispatch (a conservative
            // upper bound if dispatch fails). Only onChat mints received events.
            const wire = serializeModelToolResult(name, limited);
            for (const slice of wire.slices ?? []) {
              sourceSpent.lines += splitSourceLines(slice.text).length;
              sourceSpent.bytes += Buffer.byteLength(slice.text, "utf8");
            }
            const result = JSON.parse(wire.content);
            appendFileSync(toolLog, `${JSON.stringify({ attempt: { taskId: task.id, arm, repeat, productProfile }, callSeq,
              callId, toolName: name, args, rawHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
              rawResult: raw, modelResult: result, sourceSlices: wire.slices ?? [] })}\n`, "utf8");
            return result;
          };
          const run = await runLiveAgentTask({
            task: {
              taskId: task.id,
              taskText: `${task.query}${contract ? `\nAnswer contract: submit_answer with exactly these keys: ${contract}.` : ""}${task.kind === "qa" && publicAnswerContract ? `\nPublic field roles and representations: ${JSON.stringify(publicAnswerContract.tasks.get(task.id))}` : ""}${task.kind === "qa" ? budget : ""}`,
              projectId: task.corpus,
              requiredContextFiles: [],
              anchor: normalizeTaskAnchor(task.anchors?.[0])
            },
            arm: "old",
            systemPrompt: EVAL_SYSTEM_PROMPT,
            submission: { answerKeys: task.kind === "repair" ? { patchApplied: "boolean", summary: "string" } : task.output_contract?.answer_keys,
              ...(task.kind === "qa" && publicAnswerContract ? { fields: publicAnswerContract.tasks.get(task.id), contract: { version: publicAnswerContract.version, sha256: publicAnswerContract.sha256 } } : {}) },
            tools: arm === "product" ? [...productDeclarations, ...toolSet.tools] : toolSet.tools,
            chat: chatImpl,
            chatRequestConfig: effectiveChatRequestConfig,
            maxRounds,
            // Eval protocol v1.4: the same enforced source budget for every arm.
            ...(task.kind === "qa" && task.budget ? { sourceBudget: task.budget } : {}),
            onChat: request => {
              appendFileSync(payloadLog, `${JSON.stringify({
                attempt: { taskId: task.id, arm, repeat, productProfile },
                requestIndex: request.requestIndex,
                payloadHash: request.payloadHash,
                productProfile,
                tools: request.tools,
                messages: request.messages,
                maxTokens: request.maxTokens,
                requestConfig: request.requestConfig,
                forcedAnswer: request.forcedAnswer
              })}\n`, "utf8");
              for (const receipt of request.newReceipts) {
                recorder.recordModelDelivery(receipt, { requestIndex: request.requestIndex, payloadHash: request.payloadHash });
              }
            },
            onCompletion: completion => {
              appendFileSync(completionLog, `${JSON.stringify({ attempt: { taskId: task.id, arm, repeat, productProfile }, ...completion })}\n`, "utf8");
            },
            invoke: async (name, args) => {
              callSeq += 1;
              const callId = `eval:${task.id}:${arm}:${repeat}:${callSeq}`;
              if (name === "java_symbol" || name === "java_evidence") {
                const declaration = arm === "product" && productDeclarations.find(tool => tool.function.name === name);
                if (!declaration) return modelResult(name, args, { error: `tool ${name} is not provided in this session` }, callId);
                const invalid = validateProductArguments(declaration, args);
                if (invalid) return modelResult(name, args, { error: invalid, errorClass: "CONTRACT" }, callId);
                if (!session) return modelResult(name, args, { error: "product session unavailable after a write; results would be stale", errorClass: "PARTIAL" }, callId);
                if (name === "java_evidence") {
                  const remaining = task.kind === "qa" && task.budget ? {
                    lines: Math.max(0, task.budget.max_lines - sourceSpent.lines),
                    bytes: Math.max(0, task.budget.max_bytes - sourceSpent.bytes)
                  } : null;
                  if (remaining && (remaining.lines === 0 || remaining.bytes === 0)) return modelResult(name, args,
                    { error: "SOURCE_BUDGET_EXHAUSTED", errorClass: "SOURCE_BUDGET", remainingSourceBudget: remaining, terminal: true }, callId);
                  return modelResult(name, args, await session.evidence(args), callId);
                }
                const result = await session.symbol({ ...args,
                  ...(productProfile === "exact-evidence" ? { searchMode: "exact" } : {}),
                  ...(!Object.hasOwn(args, "preview") ? { preview: "none" } : {}) });
                return modelResult(name, args, result, callId);
              }
              const remaining = task.kind === "qa" && task.budget ? {
                lines: Math.max(0, task.budget.max_lines - sourceSpent.lines),
                bytes: Math.max(0, task.budget.max_bytes - sourceSpent.bytes)
              } : null;
              const result = await invokeWithSourceBudget(toolSet, name, args, remaining);
              if (result?.written === true && arm === "product") {
                // The candidate changed: the next java_symbol query must see
                // it, so the session is re-opened on a fresh index.
                const old = session;
                session = null;
                await old?.close().catch(() => undefined);
                sessionGeneration += 1;
                try {
                  session = await openSession();
                } catch (error) {
                  partial = true;
                  recorder.record({ type: "SESSION_REBIND_FAILED", callId, error: String(error?.message ?? error).slice(0, 300) });
                }
              }
              return modelResult(name, args, result, callId);
            }
          });
          let repairVerdict = null;
          if (task.kind === "repair" && kitRoot) {
            repairVerdict = await repairJudge({
              kitRoot,
              taskId: task.id,
              mode: "candidate",
              candidateRoot,
              outputRoot: path.join(outputDir, "judge", path.basename(candidateRoot))
            });
          }
          const events = recorder.events().slice(eventsBefore);
          const candidateReceiptValidation = task.kind === "repair"
            ? diagnoseCandidateReceipts(events, { candidateRoot, snapshotRoot }) : null;
          const scored = scoreRunOutcome({ task, goldRow, run: { ...run, sourceReceived: events }, repairVerdict });
          runs.push({
            ...base,
            attemptState: attemptStateOf(run),
            taskOutcome: scored.taskOutcome,
            taskSuccess: scored.taskSuccess,
            answerStatus: scored.answerStatus,
            ...(scored.missingEvidence ? { missingEvidence: scored.missingEvidence } : {}),
            stopReason: run.stopReason,
            primaryStopReason: run.primaryStopReason,
            finalAnswerMode: run.finalAnswerMode,
            ...(run.submission ? { submission: run.submission } : {}),
            toolCallCount: run.toolCallCount,
            usage: run.usage,
            elapsedMs: Date.now() - attemptStarted,
            candidateRoot,
            ...(partial ? { partial: true } : {}),
            ...(candidateReceiptValidation ? { candidateReceiptValidation } : {}),
            ...(repairVerdict ? {
              repairJudge: {
                state: repairVerdict.state,
                validatedSuccess: repairVerdict.validatedSuccess === true,
                reason: repairVerdict.reason ?? null,
                judgeArtifactPath: repairVerdict.judgeArtifactPath ?? null,
                policy: repairVerdict.policy ?? null
              }
            } : {}),
            sourceReceived: events,
            finalAnswer: typeof run.finalContent === "string" ? run.finalContent : "",
            timedOut: run.stopReason === "MAX_ROUNDS",
            ...(run.error ? { error: run.error } : {})
          });
        } catch (error) {
          runs.push({
            ...base,
            attemptState: "FAILED_RUNTIME",
            taskOutcome: "UNMEASURED",
            taskSuccess: null,
            answerStatus: "ATTEMPT_SETUP_OR_RUNTIME_ERROR",
            ...(candidateRoot ? { candidateRoot } : {}),
            sourceReceived: recorder.events().slice(eventsBefore),
            error: String(error instanceof Error ? error.message : error).slice(0, 500)
          });
        } finally {
          for (const opened of sessions) await opened.close().catch(() => undefined);
        }
      }
    }
  }
  return {
    runs,
    productProfile,
    backend: chat ? { kind: "injected-chat" } : { kind: "openai-api", model: config.model, baseUrlHost: safeHost(config.baseUrl) }
  };
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/**
 * Preliminary per-attempt outcome (the frozen kit scorer, when available,
 * is authoritative for QA - see scoreWithFrozenKit). QA requires the strict
 * answer, every frozen required_evidence line among PAYLOAD-ATTACHED
 * source, and the task's received-source budget. Repair requires the frozen
 * judge's validatedSuccess === true on the attempt's candidate tree. Failed
 * stops and blocked judges stay taskSuccess null - their scheduled row
 * remains in the denominator.
 */
export function scoreRunOutcome({ task, goldRow, run, repairVerdict }) {
  const failed = run.stopReason === "FAILED_RUNTIME"
    || run.stopReason === "FAILED_CONTEXT_CAP"
    || run.stopReason === "MAX_COMPLETION_TOKENS";
  if (task.kind === "repair") {
    // The candidate tree is judged even when the agent loop failed: what
    // counts is the code it left behind, never its self-report.
    if (!repairVerdict || typeof repairVerdict !== "object" || typeof repairVerdict.then === "function") {
      return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: repairVerdict ? "INVALID_JUDGE_VERDICT" : "NO_FROZEN_JUDGE" };
    }
    if (REPAIR_BLOCKED_STATES.has(repairVerdict.state)) {
      return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: `REPAIR_${repairVerdict.state}` };
    }
    const passed = repairVerdict.validatedSuccess === true;
    return { taskOutcome: "MEASURED", taskSuccess: passed, answerStatus: passed ? "REPAIR_VALIDATED" : `REPAIR_${repairVerdict.state ?? "REJECTED"}` };
  }
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
    const required = Array.isArray(goldRow.required_evidence) ? goldRow.required_evidence : [];
    if (required.length === 0) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: "NO_REQUIRED_EVIDENCE" };
    }
    const coverage = receivedLineCoverage(required, run.sourceReceived ?? []);
    if (coverage.missing.length > 0) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: "MISSING_REQUIRED_EVIDENCE", missingEvidence: coverage.missing };
    }
    const budget = task.budget;
    if (budget && (coverage.receivedLines > budget.max_lines || coverage.receivedBytes > budget.max_bytes)) {
      return { taskOutcome: "MEASURED", taskSuccess: false, answerStatus: "RECEIVED_OVER_BUDGET" };
    }
    return { taskOutcome: "MEASURED", taskSuccess: true, answerStatus: score.status };
  }
  return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: task.kind };
}

function runPython(argv, { cwd, timeoutMs = 300_000 }) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C.UTF-8", HOME: process.env.HOME ?? "" }
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ? String(result.error.message ?? result.error) : null };
}

/**
 * The frozen kit is the single authoritative QA scorer: each arm's attempts
 * become a java-specialist-results/v1 pack (eval-frozen-adapter) and are
 * scored by `python -m harness score` against the kit's own corpora. QA
 * taskSuccess is replaced by the kit's qa_contract_pass; the JS outcome is
 * kept only as `preliminary`. Repair rows keep the frozen judge verdict.
 */
export function scoreWithFrozenKit({ kitRoot, tasks, runs, arms, repeats, outputDir, model, productProfile = "broad", python = process.env.JSB_PYTHON ?? "python3" }) {
  const kit = path.resolve(kitRoot);
  const dataset = path.join(kit, "dataset");
  const digest = runPython([python, "-c",
    "import json,sys;from pathlib import Path;from harness.dataset import dataset_digest;from harness.cli import corpus_fingerprint;d=Path(sys.argv[1]);print(json.dumps({'dataset':dataset_digest(d),'corpus':corpus_fingerprint(d/'corpora')}))",
    dataset], { cwd: kit });
  if (digest.status !== 0) {
    return { kind: "preliminary-js", reason: `frozen kit digest failed: ${(digest.error ?? digest.stderr).slice(0, 300)}` };
  }
  const hashes = JSON.parse(digest.stdout.trim());
  const splits = [...new Set(tasks.map(task => task.split))];
  const split = splits.length === 1 && ["dev", "locked"].includes(splits[0]) ? splits[0] : "all";
  const scoreDir = path.join(outputDir, "frozen-score");
  mkdirSync(scoreDir, { recursive: true });
  const reports = {};
  for (const arm of arms) {
    const armRuns = runs.filter(run => run.arm === arm);
    const plan = tasks.flatMap(task => Array.from({ length: repeats }, (_, i) => ({ taskId: task.id, variant: "primary", repeat: i })));
    const attempts = armRuns.map(run => {
      const parsed = parseStrictAnswer(run.finalAnswer);
      return {
        key: { taskId: run.taskId, variant: "primary", arm, repeat: run.repeat - 1 },
        state: run.attemptState === "COMPLETED" ? "COMPLETED"
          : run.attemptState === "BLOCKED_SETUP" ? "BLOCKED_SETUP"
            : run.attemptState === "MISSING_RESULT" ? "MISSING_RESULT" : "FAILED_RUNTIME",
        answer: run.kind === "qa" && parsed.ok ? parsed.value : null,
        usage: run.usage,
        sourceReceived: run.sourceReceived ?? [],
        elapsedMs: run.elapsedMs
      };
    });
    const pack = buildFrozenResultsPack({
      plan,
      attempts,
      arm,
      datasetHash: hashes.dataset,
      runProfile: { ...runProfileFrom({ corpusHash: hashes.corpus, corpusMode: "bundled-scoped", repeats, model }),
        eval_protocol: EVAL_PROTOCOL_VERSION, product_profile: productProfile },
      model
    });
    const packPath = path.join(scoreDir, `${arm}-results.json`);
    const reportPath = path.join(scoreDir, `${arm}-report.json`);
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    const scored = runPython([python, "-m", "harness", "--dataset", dataset, "score", "--input", packPath, "--split", split, "--output", reportPath], { cwd: kit });
    if (scored.status !== 0) {
      return { kind: "preliminary-js", reason: `frozen kit score failed for ${arm}: ${(scored.error ?? scored.stderr).slice(0, 300)}` };
    }
    reports[arm] = { packPath, reportPath, report: JSON.parse(readFileSync(reportPath, "utf8")) };
  }
  for (const run of runs) {
    if (run.kind !== "qa" || !reports[run.arm]) continue;
    const row = reports[run.arm].report.rows.find(r => r.task_id === run.taskId && r.variant === "primary" && r.repeat === run.repeat - 1);
    if (!row) continue;
    run.preliminary = { taskSuccess: run.taskSuccess, answerStatus: run.answerStatus };
    run.frozenScore = {
      qaContractPass: row.qa_contract_pass,
      valid: row.valid,
      budgetPass: row.budget_pass,
      receivedEvidenceComplete: row.received_evidence_complete,
      receivedLines: row.received_lines,
      receivedBytes: row.received_bytes,
      errors: row.errors
    };
    run.taskOutcome = "MEASURED";
    run.taskSuccess = row.qa_contract_pass === true;
  }
  const first = Object.values(reports)[0]?.report;
  return {
    kind: "frozen-kit",
    split,
    datasetHash: hashes.dataset,
    corpusHash: hashes.corpus,
    scorerHash: first?.scorer_hash ?? null,
    reports: Object.fromEntries(Object.entries(reports).map(([arm, value]) => [arm, { packPath: value.packPath, reportPath: value.reportPath }]))
  };
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
  const seed = Number(flag("--seed") ?? 1984);
  const maxRounds = Math.max(1, Number(flag("--max-rounds") ?? 16));
  const kitRoot = flag("--kit-root");
  const publicAnswerContract = flag("--public-answer-contract") ? loadPublicAnswerContract(flag("--public-answer-contract")) : null;
  const productProfile = flag("--product-profile") ?? "broad";
  productTools(productProfile);
  const dryRun = argv.includes("--dry-run");
  const filter = (flag("--filter") ?? "").split(",").filter(Boolean);
  if (!tasksFile || !output) {
    console.error("usage: evaluate-java-task.mjs --tasks <tasks.jsonl> [--gold <gold.jsonl>] [--dataset <dataset-manifest.json>] [--kit-root <frozen kit>] [--public-answer-contract <versioned.json>] [--filter <id,id..>] [--repo-roots <corpus=path,..>] --output <dir> [--arms product,control] [--repeats N] [--seed N] [--max-rounds N] [--server-js dist/server.js] [--product-profile broad|evidence|exact-evidence] [--dry-run]");
    return 2;
  }
  const datasetHash = goldFile
    ? createHash("sha256").update(readFileSync(goldFile)).digest("hex")
    : null;
  const tasksSha256 = createHash("sha256").update(readFileSync(tasksFile)).digest("hex");
  // MAC-10: the dataset is named, never implied. --tasks is one split's tasks part and --gold that same split's gold.
  let dataset = null;
  if (flag("--dataset")) {
    const { verifyDataset } = await import("./ilv2-mac-eval-dataset.mjs");
    const { manifest } = await verifyDataset(path.resolve(flag("--dataset")));
    const split = ["dev", "holdout"].find(name => manifest.parts[`tasks-${name}`]?.sha256 === tasksSha256);
    if (!split || (datasetHash && manifest.parts[`gold-${split}`]?.sha256 !== datasetHash)) {
      console.error("--tasks is not a tasks part of --dataset, or --gold is not the gold of the same split");
      return 2;
    }
    dataset = { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split };
  }
  const allTasks = loadTaskFile(tasksFile);
  const tasks = filter.length > 0 ? allTasks.filter(task => filter.includes(task.id)) : allTasks;
  // The full schedule is frozen before anything runs; every row stays in the
  // denominator whatever happens to it.
  const planned = buildPlannedAttempts(tasks, arms, repeats);
  mkdirSync(output, { recursive: true });
  const scheduleText = planned.map(row => JSON.stringify(row)).join("\n") + (planned.length ? "\n" : "");
  writeFileSync(path.join(output, "schedule.jsonl"), scheduleText, "utf8");
  const serverJs = flag("--server-js") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
  const identity = { datasetId: dataset?.datasetId ?? null, datasetDigest: dataset?.datasetDigest ?? null, split: dataset?.split ?? null, tasksSha256, goldSha256: datasetHash, scheduleSha256: createHash("sha256").update(scheduleText).digest("hex"),
    filter, seed, arms, repeats, productProfile, driver: { serverJs: path.resolve(serverJs), serverJsSha256: existsSync(serverJs) ? createHash("sha256").update(readFileSync(serverJs)).digest("hex") : null } };
  const backend = detectBackend(env);
  if (!backend || dryRun) {
    const runs = planned.map(row => ({ ...row, taskOutcome: "UNMEASURED", taskSuccess: null }));
    const pack = assemblePack({
      productProfile,
      publicAnswerContract,
      status: dryRun ? "DRY_RUN" : "BLOCKED_AUTH",
      backend: dryRun ? null : backend,
      datasetHash,
      arms,
      repeats,
      runs,
      planned,
      identity,
      blockedReasons: dryRun ? undefined : backendDeficit(env)
    });
    writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ status: pack.status, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, output: path.join(output, "results-pack.json") }, null, 2));
    // A dry run did what it was asked (froze the schedule); a missing backend measured nothing.
    return dryRun ? 0 : 2;
  }
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
    kitRoot,
    seed,
    maxRounds,
    productProfile,
    publicAnswerContract,
    serverJs
  });
  const scorer = kitRoot
    ? scoreWithFrozenKit({ kitRoot, tasks, runs: live.runs, arms, repeats, outputDir: output, model: live.backend.model ?? null, productProfile })
    : { kind: "preliminary-js", reason: "--kit-root not given: QA uses the preliminary JS scorer and repair is UNMEASURED" };
  const pack = assemblePack({
    status: "MEASURED",
    productProfile,
    publicAnswerContract,
    backend: live.backend,
    datasetHash,
    arms,
    repeats,
    runs: live.runs,
    planned,
    identity
  });
  pack.scorer = scorer;
  pack.seed = seed;
  pack.maxRounds = maxRounds;
  pack.byArm = Object.fromEntries(arms.map(arm => {
    const rows = pack.packs.filter(row => row.arm === arm);
    const successes = rows.filter(row => row.taskSuccess === true).length;
    const measured = rows.filter(row => row.taskSuccess === true || row.taskSuccess === false).length;
    return [arm, { scheduled: rows.length, successes, successRate: rows.length ? successes / rows.length : null, measured, conditionalAccuracy: measured ? successes / measured : null }];
  }));
  writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(path.join(output, "attempts.json"), `${JSON.stringify(live.runs, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: pack.status, scorer: scorer.kind, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, byArm: pack.byArm, output: path.join(output, "results-pack.json") }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}
