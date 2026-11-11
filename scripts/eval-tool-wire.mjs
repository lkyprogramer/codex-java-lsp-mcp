// input:  工具名 + 原始工具结果（domain 对象或 MCP envelope）+ 单条 model tool
//         消息字节预算；驱动入口另需一个 chat 实现（fake 或真实 transport）。
// output: serializeModelToolResult -> ModelToolResult（合法 JSON content、只覆盖
//         content 中真实保留源码的 slices、rawHash/modelPayloadHash/truncated）；
//         runEvalToolWire -> 最后一跳 model 载荷、chat 边界回执与事件。
// pos:    docs/03 §1.1 规定的最后一跳边界（R01）。预算裁剪只裁结构中的片段/
//         整行再重新编码，绝不对 JSON 字符串 slice；裁不下就返回显式预算错误。
//         驱动本身不调用模型、不产生网络流量；真实 transport 的往返另行记录。
import { createHash } from "node:crypto";
import { compactContextForModel, compactImpactForModel, MAX_TOOL_RESULT_CHARS } from "./run-agent-trace-live.mjs";

/** docs/03 §1.1: one model tool message is at most 32 KiB. */
export const MODEL_TOOL_MESSAGE_MAX_BYTES = 32_768;
const MIN_MODEL_TOOL_MESSAGE_BYTES = 512;
const ERROR_TEXT_LIMIT = 2_000;

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const byteLength = text => Buffer.byteLength(text, "utf8");

/** Lines with their own terminators (LF or CRLF); a trailing terminator does
 * not create a phantom empty line. Joining the result reproduces the input. */
export function splitSourceLines(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  // Line numbers follow the index parser and rg: a line ends at LF; a lone
  // CR is line content (CRLF still keeps its CR with the line).
  const lines = text.split(/(?<=\n)/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function stableHash(raw) {
  if (typeof raw === "string") return sha256(raw);
  try {
    return sha256(JSON.stringify(raw) ?? "undefined");
  } catch {
    return sha256(String(raw));
  }
}

/** MCP envelope -> domain object. structuredContent wins over its own text
 * rendering (no double injection); otherwise ALL text blocks are joined. */
function unwrapEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { domain: raw, isError: false };
  if (!("content" in raw) && !("structuredContent" in raw)) return { domain: raw, isError: false };
  const isError = raw.isError === true;
  if (raw.structuredContent && typeof raw.structuredContent === "object") {
    return { domain: raw.structuredContent, isError };
  }
  const text = Array.isArray(raw.content)
    ? raw.content.map(part => (typeof part?.text === "string" ? part.text : "")).join("")
    : typeof raw.content === "string" ? raw.content : "";
  if (isError) return { domain: { error: text }, isError };
  try {
    return { domain: JSON.parse(text), isError };
  } catch {
    return { domain: { text }, isError };
  }
}

function joinTextBlocks(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(block => (typeof block?.text === "string" ? block.text : "")).join("");
  return "";
}

function fits(payload, maxBytes) {
  return byteLength(JSON.stringify(payload)) <= maxBytes;
}

function budgetError(toolName, maxBytes, detail) {
  return { error: "MODEL_BUDGET_EXCEEDED", errorClass: "MODEL_BUDGET", tool: toolName, maxBytes, detail };
}

/** Source clamping charges its retained input. The wire charges only source
 * it actually keeps; refund only what this serialization removes. A second
 * serialization sees that kept input, so it cannot refund it again. */
function wireSourceBudget(domain, suppliedSlices, retainedSlices) {
  if (!domain?.remainingSourceBudget) return {};
  const totals = slices => slices.reduce((sum, slice) => ({ lines: sum.lines + splitSourceLines(slice.text).length, bytes: sum.bytes + byteLength(slice.text) }), { lines: 0, bytes: 0 });
  const supplied = totals(suppliedSlices);
  const retained = totals(retainedSlices);
  const remainingSourceBudget = {
    lines: domain.remainingSourceBudget.lines + supplied.lines - retained.lines,
    bytes: domain.remainingSourceBudget.bytes + supplied.bytes - retained.bytes
  };
  return { remainingSourceBudget, ...(remainingSourceBudget.lines === 0 || remainingSourceBudget.bytes === 0 ? { terminal: true } : {}) };
}

function serializeRead(domain, maxBytes) {
  const text = joinTextBlocks(domain?.text);
  const lines = splitSourceLines(text);
  const startLine = Number.isInteger(domain?.startLine) && domain.startLine >= 1 ? domain.startLine : 1;
  const base = {
    path: typeof domain?.path === "string" ? domain.path : "",
    startLine,
    ...(Number.isInteger(domain?.totalLines) && domain.totalLines >= 0 ? { totalLines: domain.totalLines } : {}),
    ...(typeof domain?.contentHash === "string" ? { contentHash: domain.contentHash } : {}),
    ...(domain?.sourceBudgetLimited === true ? { sourceBudgetLimited: true } : {}),
    ...(typeof domain?.sourceBudgetReason === "string" ? { sourceBudgetReason: domain.sourceBudgetReason } : {}),
  };
  const build = kept => ({
    ...base,
    ...wireSourceBudget(domain, [{ text }], [{ text: lines.slice(0, kept).join("") }]),
    endLine: kept === 0 ? startLine - 1 : startLine + kept - 1,
    ...(Number.isInteger(domain?.totalLines) && domain.totalLines >= 0 ? { hasMore: startLine + kept - 1 < domain.totalLines } : {}),
    text: lines.slice(0, kept).join(""),
    // Truncation already applied by the tool (its own source cap) stays visible.
    ...(kept < lines.length || domain?.truncated === true ? { truncated: true } : {}),
    ...(kept < lines.length ? { nextStartLine: startLine + kept } : Number.isInteger(domain?.nextStartLine) ? { nextStartLine: domain.nextStartLine } : {})
  });
  // Largest whole-line prefix that fits (binary search over line count).
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(build(mid), maxBytes)) low = mid;
    else high = mid - 1;
  }
  if (low === 0 && lines.length > 0) {
    return { payload: { ...budgetError("read", maxBytes, `line ${startLine} alone exceeds the model message budget; read a different window`), ...wireSourceBudget(domain, [{ text }], []) }, slices: [], truncated: true };
  }
  const payload = build(low);
  const slices = low > 0 && base.path
    ? [{ path: base.path, startLine, endLine: payload.endLine, text: payload.text, ...(base.contentHash ? { fileContentHash: base.contentHash } : {}) }]
    : [];
  return { payload, slices, truncated: low < lines.length || domain?.truncated === true };
}

function candidateSlice(candidate) {
  const range = candidate?.evidenceRange;
  // R08: a preview is evidence of its own source (a MyBatis XML statement is
  // not the Java mapper file); older results only carried the declaration.
  const relativePath = range?.relativePath ?? candidate?.declaration?.relativePath;
  const contentHash = range?.relativePath ? range.contentHash : candidate?.declaration?.contentHash;
  if (candidate?.previewKind !== "source" || typeof candidate?.preview !== "string" || !relativePath
    || !Number.isInteger(range?.startLine) || !Number.isInteger(range?.endLine)) return null;
  // The preview must be exactly the declared window; anything else is not
  // creditable as received source.
  if (splitSourceLines(candidate.preview).length !== range.endLine - range.startLine + 1) return null;
  return {
    path: relativePath,
    startLine: range.startLine,
    endLine: range.endLine,
    text: candidate.preview,
    ...(typeof contentHash === "string" ? { fileContentHash: contentHash } : {})
  };
}

function serializeSymbol(domain, maxBytes) {
  if (!domain || typeof domain !== "object" || !Array.isArray(domain.candidates)) {
    return { payload: { error: "UNSUPPORTED_TOOL_RESULT", errorClass: "PROTOCOL", tool: "java_symbol", detail: "missing candidates" }, slices: [], truncated: false };
  }
  // Every top-level field (scopeState, truncated, stopReason, generation...)
  // and every candidate field survives when it fits. Over budget, candidates
  // are admitted greedily in rank order: whole (with preview) if it fits,
  // else as a locator without preview, else the remaining tail is dropped.
  const all = domain.candidates;
  const payload = { ...domain, candidates: all.map(candidate => ({ ...candidate })) };
  let candidates = payload.candidates;
  let droppedPreviews = 0;
  let droppedCandidates = 0;
  const suppliedSlices = all.map(candidateSlice).filter(Boolean);
  const fitsPayload = () => {
    if (domain.remainingSourceBudget) {
      delete payload.terminal;
      Object.assign(payload, wireSourceBudget(domain, suppliedSlices, candidates.map(candidateSlice).filter(Boolean)));
    }
    return fits(payload, maxBytes);
  };
  if (!fitsPayload()) {
    candidates = [];
    payload.candidates = candidates;
    payload.modelBudget = { droppedPreviews: 0, droppedCandidates: 0, maxBytes };
    for (let i = 0; i < all.length; i += 1) {
      candidates.push({ ...all[i] });
      if (fitsPayload()) continue;
      const locator = { ...all[i] };
      if (typeof locator.preview === "string") {
        delete locator.preview;
        delete locator.previewKind;
        locator.previewDropped = "MODEL_BUDGET";
        candidates[candidates.length - 1] = locator;
        payload.modelBudget.droppedPreviews = droppedPreviews + 1;
        if (fitsPayload()) {
          droppedPreviews += 1;
          continue;
        }
      }
      candidates.pop();
      droppedCandidates = all.length - i;
      break;
    }
    payload.modelBudget = { droppedPreviews, droppedCandidates, maxBytes };
  }
  if (!fitsPayload() || (all.length > 0 && candidates.length === 0)) {
    return { payload: { ...budgetError("java_symbol", maxBytes, "not even one candidate locator fits the model message budget"), ...wireSourceBudget(domain, suppliedSlices, []) }, slices: [], truncated: true };
  }
  const slices = candidates.map(candidateSlice).filter(Boolean);
  return { payload, slices, truncated: droppedPreviews > 0 || droppedCandidates > 0 };
}

function evidenceSlice(unit) {
  if (typeof unit?.path !== "string" || !unit.path || typeof unit.text !== "string" || !unit.text
    || !Number.isInteger(unit.startLine) || unit.startLine < 1 || !Number.isInteger(unit.endLine)
    || splitSourceLines(unit.text).length !== unit.endLine - unit.startLine + 1) return null;
  return { path: unit.path, startLine: unit.startLine, endLine: unit.endLine, text: unit.text,
    ...(typeof unit.contentHash === "string" ? { fileContentHash: unit.contentHash } : {}) };
}

const EVIDENCE_SCHEMAS = new Set(["java-evidence-unit/v1", "java-evidence-unit/v2"]);

/** Evidence metadata is not a receipt. Admit only exact whole-line text;
 * shortening a unit always preserves its original range and incompleteness. */
function serializeEvidence(domain, maxBytes) {
  // v2 (post-ILV2 Q04) adds Java declaration units with the same unit fields; v1 stays readable for old traces.
  if (!EVIDENCE_SCHEMAS.has(domain?.schemaVersion) || !Array.isArray(domain.units)) return {
    payload: { error: "UNSUPPORTED_TOOL_RESULT", errorClass: "PROTOCOL", tool: "java_evidence", detail: "missing evidence units" }, slices: [], truncated: false
  };
  const suppliedSlices = domain.units.map(evidenceSlice).filter(Boolean);
  const payload = { ...domain, units: domain.units.map(unit => ({ ...unit })) };
  const updateBudget = () => {
    if (domain.remainingSourceBudget) {
      delete payload.terminal;
      Object.assign(payload, wireSourceBudget(domain, suppliedSlices, payload.units.map(evidenceSlice).filter(Boolean)));
    }
    return fits(payload, maxBytes);
  };
  // Invalid ranges must never show source text that the recorder cannot charge.
  let truncated = false;
  for (const unit of payload.units) if (unit.text && !evidenceSlice(unit)) {
    delete unit.text; unit.complete = false; unit.sourceOmitted = "INVALID_SOURCE_RANGE"; truncated = true;
  }
  if (!updateBudget()) {
    payload.modelBudget = { maxBytes };
    // First remove text, retaining all stale/omitted flags and original ranges.
    payload.units = payload.units.map(unit => {
      if (!unit.text) return unit;
      return { ...unit, text: "", endLine: unit.startLine - 1, originalEndLine: unit.originalEndLine ?? unit.endLine,
        complete: false, sourceOmitted: "MODEL_BUDGET" };
    });
    if (!updateBudget()) return { payload: { ...budgetError("java_evidence", maxBytes, "evidence metadata exceeds the model message budget"),
      ...wireSourceBudget(domain, suppliedSlices, []) }, slices: [], truncated: true };
    for (let i = 0; i < domain.units.length; i += 1) {
      const unit = domain.units[i];
      if (!evidenceSlice(unit)) continue;
      const lines = splitSourceLines(unit.text);
      const build = kept => kept === lines.length ? { ...unit } : { ...unit,
        text: lines.slice(0, kept).join(""), endLine: unit.startLine + kept - 1,
        originalEndLine: unit.originalEndLine ?? unit.endLine, complete: false, sourceOmitted: "MODEL_BUDGET" };
      let low = 0, high = lines.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        payload.units[i] = build(mid);
        if (updateBudget()) low = mid; else high = mid - 1;
      }
      payload.units[i] = build(low);
    }
    truncated = true;
  }
  updateBudget();
  return { payload, slices: payload.units.map(evidenceSlice).filter(Boolean), truncated };
}

/** Bounded text field (list entries / rg output / test output): trimmed by
 * whole lines, never sliced inside a line or a JSON string. */
function serializeTextField(toolName, domain, field, keys, maxBytes) {
  const payload = {};
  for (const key of keys) if (domain?.[key] !== undefined) payload[key] = domain[key];
  const lines = splitSourceLines(typeof domain?.[field] === "string" ? domain[field] : "");
  const build = kept => ({ ...payload, [field]: lines.slice(0, kept).join(""), ...(kept < lines.length || domain?.truncated ? { truncated: true } : {}) });
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(build(mid), maxBytes)) low = mid;
    else high = mid - 1;
  }
  const result = build(low);
  if (!fits(result, maxBytes)) return { payload: budgetError(toolName, maxBytes, "result metadata exceeds the budget"), slices: [], truncated: true };
  return { payload: result, slices: [], truncated: low < lines.length };
}

/**
 * docs/03 §1.1 serializer. `content` is always valid JSON within maxBytes;
 * `slices` only describe source text actually retained in `content`, with
 * exact line ranges (no phantom lines, no truncation markers).
 * rg/list output is navigation text and is deliberately NOT creditable source.
 */
export function serializeModelToolResult(toolName, raw, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(MIN_MODEL_TOOL_MESSAGE_BYTES, Math.trunc(options.maxBytes))
    : MODEL_TOOL_MESSAGE_MAX_BYTES;
  const rawHash = stableHash(raw);
  const { domain, isError } = unwrapEnvelope(raw);
  let result;
  if (isError || (domain && typeof domain === "object" && !Array.isArray(domain) && domain.error)) {
    const payload = {
      error: String(domain?.error ?? "tool error").slice(0, ERROR_TEXT_LIMIT),
      ...(typeof domain?.errorClass === "string" ? { errorClass: domain.errorClass } : {}),
      ...(domain?.remainingSourceBudget ? { remainingSourceBudget: domain.remainingSourceBudget } : {}),
      ...(domain?.terminal === true ? { terminal: true } : {})
    };
    result = { payload, slices: [], truncated: false };
  } else {
    switch (toolName) {
      case "read":
        result = serializeRead(domain, maxBytes);
        break;
      case "java_symbol":
        result = serializeSymbol(domain, maxBytes);
        break;
      case "java_evidence":
        result = serializeEvidence(domain, maxBytes);
        break;
      case "write_file":
      case "replace_file":
        result = {
          payload: {
            path: typeof domain?.path === "string" ? domain.path : "",
            written: domain?.written === true,
            ...(Number.isFinite(domain?.bytes) ? { bytes: domain.bytes } : {}),
            ...(toolName === "replace_file" && Number.isInteger(domain?.replacements) ? { replacements: domain.replacements } : {})
          },
          slices: [],
          truncated: false
        };
        break;
      case "list":
        result = serializeTextField("list", domain, "entries", ["path"], maxBytes);
        break;
      case "rg":
        result = serializeTextField("rg", domain, "output", ["pattern", "path", "matches", "noMatches", "timedOut"], maxBytes);
        break;
      case "test":
        result = serializeTextField("test", domain, "output", ["status", "exitCode", "timedOut", "compiledFiles"], maxBytes);
        break;
      case "java_impact":
      case "java_context": {
        // Legacy projection keeps its historical 16000 cap; the final guard
        // below still enforces maxBytes.
        const legacyCap = Math.min(maxBytes, MAX_TOOL_RESULT_CHARS);
        const compact = toolName === "java_context" ? compactContextForModel(domain, legacyCap) : compactImpactForModel(domain, legacyCap);
        let payload;
        try {
          payload = JSON.parse(compact.text);
        } catch {
          payload = budgetError(toolName, maxBytes, "legacy compact projection is not valid JSON");
        }
        result = { payload, slices: [], truncated: false, paths: compact.paths };
        break;
      }
      default:
        // Unknown tools are never pushed through another tool's projection.
        result = { payload: { error: "UNSUPPORTED_TOOL_RESULT", errorClass: "PROTOCOL", tool: String(toolName) }, slices: [], truncated: false };
    }
  }
  let content = JSON.stringify(result.payload);
  if (byteLength(content) > maxBytes) {
    const suppliedSlices = toolName === "read" ? [{ text: joinTextBlocks(domain?.text) }] : toolName === "java_symbol" ? (domain?.candidates ?? []).map(candidateSlice).filter(Boolean) : toolName === "java_evidence" ? (domain?.units ?? []).map(evidenceSlice).filter(Boolean) : [];
    content = JSON.stringify({ ...budgetError(toolName, maxBytes, "serialized result exceeds the model message budget"), ...wireSourceBudget(domain, suppliedSlices, []) });
    result = { ...result, slices: [], truncated: true };
  }
  return {
    toolName,
    content,
    slices: result.slices.map(slice => ({ ...slice, sliceHash: sha256(slice.text) })),
    rawHash,
    modelPayloadHash: sha256(content),
    truncated: result.truncated === true,
    ...(result.paths ? { paths: result.paths } : {})
  };
}

/**
 * Runs the real runLiveAgentTask loop with one injected tool result and a
 * chat implementation supplied by the caller, returning everything the
 * boundary audit needs. `chat` receives the exact request the loop sends.
 */
export async function runEvalToolWire({ name, raw, chat, maxBytes, toolSchema, systemPrompt, taskText = "Return the source value.", maxRounds = 3 }) {
  // Imported lazily: run-agent-trace-live imports this module's serializer.
  const { runLiveAgentTask } = await import("./run-agent-trace-live.mjs");
  const { createRecorder } = await import("./evaluate-java-task.mjs");
  const recorder = createRecorder();
  const requests = [];
  let received;
  const run = await runLiveAgentTask({
    task: { taskId: "sentinel", taskText, projectId: "fixture", anchor: { file: "A.java", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: systemPrompt ?? "Use the supplied tools. Return JSON.",
    maxRounds,
    toolResultMaxBytes: maxBytes,
    tools: toolSchema ? [toolSchema] : [{ type: "function", function: { name, parameters: { type: "object" } } }],
    invoke: async (toolName, _args, callId) => {
      recorder.recordToolResult({ callId, toolName, result: raw });
      return raw;
    },
    onChat: request => {
      requests.push(request);
      // LAST capture wins: the final request carries every tool result.
      received = {
        toolMessages: request.messages.filter(m => m.role === "tool").map(m => ({ tool_call_id: m.tool_call_id, content: m.content })),
        receipts: request.receipts,
        payloadHash: request.payloadHash
      };
      for (const receipt of request.newReceipts) recorder.recordModelDelivery(receipt, { requestIndex: request.requestIndex, payloadHash: request.payloadHash });
    },
    chat
  });
  const events = recorder.events();
  return {
    run,
    received,
    requests,
    events,
    sourceFetched: events.filter(e => e.type === "SOURCE_FETCHED"),
    sourceReceived: events.filter(e => e.type === "SOURCE_RECEIVED"),
    deliveries: events.filter(e => e.type === "MODEL_PAYLOAD_ATTACHED")
  };
}

/** A deterministic fake chat: first call emits the one tool call, then a
 *  strict-JSON final answer. Wire-mechanism validation only. */
export function fakeChat({ toolName = "read", argumentsJson = "{}", answer = '{"ok":true}' } = {}) {
  let step = 0;
  return async () => {
    step += 1;
    if (step === 1) {
      return {
        choices: [{
          message: { tool_calls: [{ id: "c1", type: "function", function: { name: toolName, arguments: argumentsJson } }] },
          finish_reason: "tool_calls"
        }]
      };
    }
    return { choices: [{ message: { content: answer }, finish_reason: "stop" }] };
  };
}
