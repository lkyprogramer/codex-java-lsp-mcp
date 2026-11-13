// input: the exact serialized chat request body (openai-compatible-chat onSerializedBody) and the source
//        units an evaluator expects the model to have received.
// output: receipts binding each unit to a tool message, a JSON pointer and the source bytes,
//         plus a verifier that re-reads the workspace files.
// pos: post-ILV2 Q01 (docs/java-specialist-post-ilv2-v1/docs/05-contracts.md §5.6). A receipt proves only
//      that the serialized body contained these source bytes: not that the provider received the request,
//      that the model used it, or that the task succeeded. Whole-field receipts use the bundle's v1 format.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isMain, readJson, requireValue, runCli } from "./ilv2-mac-contracts.mjs";

export const RECEIPT_SCHEMA = "post-ilv2/evidence-receipt/v1";
const SLICED_RECEIPT_SCHEMA = "post-ilv2/evidence-receipt/v2";
export const LIMITS = Object.freeze({ maxBodyBytes: 8 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxUnits: 8, maxLines: 80, maxBytes: 16000 });

export class ReceiptError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const require = (condition, reason) => { if (!condition) throw new ReceiptError(reason); };
const sha256 = value => createHash("sha256").update(value).digest("hex");

/**
 * JSON.parse that refuses duplicate object keys (JSON.parse keeps the last one silently, so a body
 * could show one text to a reader and another to a scorer). Non-finite numbers cannot occur in JSON.
 */
export function strictParse(text) {
  require(typeof text === "string", "INVALID_JSON");
  let value;
  try { value = JSON.parse(text); } catch { throw new ReceiptError("INVALID_JSON"); }
  // One pass over the text: a stack of key sets for the open objects; strings are skipped as a unit.
  const stack = [];
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      let end = index + 1;
      while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      if (expectKey && stack.length > 0) {
        const key = JSON.parse(text.slice(index, end + 1));
        const keys = stack[stack.length - 1];
        require(!(keys instanceof Set) || !keys.has(key), "DUPLICATE_JSON_KEY");
        if (keys instanceof Set) keys.add(key);
        expectKey = false;
      }
      index = end;
    } else if (char === "{") { stack.push(new Set()); expectKey = true; }
    else if (char === "[") { stack.push(null); expectKey = false; }
    else if (char === "}" || char === "]") { stack.pop(); expectKey = false; }
    else if (char === ",") expectKey = stack[stack.length - 1] instanceof Set;
  }
  return value;
}

/** RFC 6901 pointer into a parsed value. */
export function resolvePointer(value, address) {
  if (address === "") return value;
  require(typeof address === "string" && address.startsWith("/"), "INVALID_POINTER");
  let current = value;
  for (const encoded of address.slice(1).split("/")) {
    require(!/~(?![01])/.test(encoded), "INVALID_POINTER_ESCAPE");
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      require(/^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < current.length, "POINTER_MISSING");
      current = current[Number(key)];
    } else if (current && typeof current === "object") {
      require(Object.hasOwn(current, key), "POINTER_MISSING");
      current = current[key];
    } else throw new ReceiptError("POINTER_NOT_CONTAINER");
  }
  return current;
}

/** LF separates lines; CR and a missing final newline are kept byte for byte. */
export function lfLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) { lines.push(bytes.subarray(start, index + 1)); start = index + 1; }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

/** The bytes of lines start..end (one-based, inclusive) of `bytes`. */
export function lineRangeBytes(bytes, startLine, endLine) {
  const lines = lfLines(bytes);
  require(Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && startLine <= endLine, "INVALID_RANGE");
  require(endLine <= lines.length, "RANGE_OUT_OF_BOUNDS");
  return Buffer.concat(lines.slice(startLine - 1, endLine));
}

/** The text the serialized body actually carries for one unit, or a ReceiptError. */
function deliveredText(request, unit) {
  require(Number.isInteger(unit.messageIndex) && unit.messageIndex >= 0 && unit.messageIndex < request.messages.length, "INVALID_MESSAGE_INDEX");
  const message = request.messages[unit.messageIndex];
  require(message && typeof message === "object" && message.role === "tool", "NOT_TOOL_MESSAGE");
  require(typeof unit.toolCallId === "string" && unit.toolCallId !== "" && message.tool_call_id === unit.toolCallId, "TOOL_CALL_MISMATCH");
  require(typeof message.content === "string", "UNSUPPORTED_CONTENT_SHAPE");
  require(typeof unit.textPointer === "string", "INVALID_POINTER");
  const delivered = unit.textPointer === "" ? message.content : resolvePointer(strictParse(message.content), unit.textPointer);
  require(typeof delivered === "string", "SOURCE_NOT_TEXT");
  return delivered;
}

function parseBody(body) {
  require(typeof body === "string", "INVALID_BODY");
  require(Buffer.byteLength(body, "utf8") <= LIMITS.maxBodyBytes, "REQUEST_BODY_CAP");
  const request = strictParse(body);
  require(request && typeof request === "object" && Array.isArray(request.messages), "NO_MESSAGES");
  return request;
}

function receiptLimit(receipt, part) {
  if (receipt.units.length >= LIMITS.maxUnits) return "UNIT_CAP";
  if (receipt.sourceBytes + part.bytes > LIMITS.maxBytes) return "SOURCE_BYTE_BUDGET";
  if (receipt.sourceLines + part.lines > LIMITS.maxLines) return "SOURCE_LINE_BUDGET";
}

function splitReceiptUnit(unit, lines, size) {
  if (lines.length <= LIMITS.maxLines && size <= LIMITS.maxBytes) {
    return [{ unit, lines: lines.length, bytes: size }];
  }
  const ranges = [];
  let from = 0;
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    require(line.length <= LIMITS.maxBytes, "SOURCE_BYTE_BUDGET");
    if (index - from === LIMITS.maxLines || bytes + line.length > LIMITS.maxBytes) {
      ranges.push({ from, to: index, bytes });
      from = index;
      bytes = 0;
    }
    bytes += line.length;
  }
  ranges.push({ from, to: lines.length, bytes });
  // Offsets are zero-based lines in the pointed-to text, independent of the file's line numbers.
  // Adjacent parts cannot fit in one receipt. They retain the original unit ID across receipts.
  return ranges.map(({ from, to, bytes }) => ({
    unit: { ...unit, startLine: unit.startLine + from, endLine: unit.startLine + to - 1, textLineOffset: from },
    lines: to - from,
    bytes
  }));
}

function buildReceipts({ body, workspaceId, contentManifestId, units }, batch) {
  require(typeof workspaceId === "string" && workspaceId !== "" && typeof contentManifestId === "string" && contentManifestId !== "", "MISSING_VIEW");
  require(Array.isArray(units), "INVALID_UNITS");
  const request = parseBody(body);
  const requestBodySha256 = sha256(body);
  const newReceipt = () => ({
    schema: RECEIPT_SCHEMA, workspaceId, contentManifestId, requestBodySha256,
    units: [], refused: [], sourceBytes: 0, sourceLines: 0
  });
  let receipt = newReceipt();
  const receipts = [receipt];
  const ids = new Set();
  for (const unit of units) {
    try {
      require(unit && typeof unit.id === "string" && unit.id !== "" && !ids.has(unit.id), "DUPLICATE_OR_MISSING_UNIT_ID");
      ids.add(unit.id);
      require(typeof unit.contentHash === "string" && /^[a-f0-9]{64}$/.test(unit.contentHash), "INVALID_SOURCE_HASH");
      require(typeof unit.relativePath === "string" && unit.relativePath !== "", "INVALID_PATH");
      require(Number.isInteger(unit.startLine) && Number.isInteger(unit.endLine) && unit.startLine >= 1 && unit.startLine <= unit.endLine, "INVALID_RANGE");
      require(typeof unit.sourceText === "string", "SOURCE_NOT_TEXT");
      // The claimed range must describe the text: a receipt that cannot verify is not issued.
      const source = Buffer.from(unit.sourceText, "utf8");
      const lines = lfLines(source);
      require(lines.length === unit.endLine - unit.startLine + 1, "SOURCE_RANGE_MISMATCH");
      require(deliveredText(request, unit) === unit.sourceText, "FINAL_TEXT_MISMATCH");
      const verified = { id: unit.id, toolCallId: unit.toolCallId, messageIndex: unit.messageIndex, textPointer: unit.textPointer,
        relativePath: unit.relativePath, contentHash: unit.contentHash, startLine: unit.startLine, endLine: unit.endLine, previewKind: "source" };
      const parts = batch ? splitReceiptUnit(verified, lines, source.length) : [{ unit: verified, lines: lines.length, bytes: source.length }];
      for (const part of parts) {
        const limit = receiptLimit(receipt, part);
        if (limit) {
          require(batch, limit);
          receipt = newReceipt();
          receipts.push(receipt);
        }
        if (part.unit.textLineOffset !== undefined) receipt.schema = SLICED_RECEIPT_SCHEMA;
        receipt.units.push(part.unit);
        receipt.sourceBytes += part.bytes;
        receipt.sourceLines += part.lines;
      }
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      receipt.refused.push({ id: typeof unit?.id === "string" ? unit.id : null, reason: error.reason });
    }
  }
  return receipts;
}

/** Verify the exact bytes at the given tool-message pointers and apply one receipt's limits. */
export function receiptForSerializedRequest(options) {
  return buildReceipts(options, false)[0];
}

/** Verify whole source units before partitioning them into independently bounded receipts. */
export function receiptsForSerializedRequest(options) {
  return buildReceipts(options, true).filter(receipt => receipt.units.length || receipt.refused.length);
}

/** Reads `relativePath` under `root`: no symlink on the way, a regular file of at most 2 MiB, unchanged while read. */
export async function readBoundedSource(root, relativePath) {
  require(typeof relativePath === "string" && relativePath !== "" && !path.posix.isAbsolute(relativePath)
    && !relativePath.includes("\\") && !relativePath.includes("\0"), "INVALID_PATH");
  require(relativePath.split("/").every(part => part !== "" && part !== "." && part !== ".."), "PATH_ESCAPE");
  const realRoot = await realpath(root);
  let current = realRoot;
  try {
    for (const part of relativePath.split("/")) {
      current = path.join(current, part);
      require(!(await lstat(current)).isSymbolicLink(), "SYMLINK_REFUSED");
    }
    const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      require(before.isFile(), "SOURCE_NOT_REGULAR");
      require(before.size <= BigInt(LIMITS.maxFileBytes), "SOURCE_FILE_CAP");
      const data = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      require(length <= LIMITS.maxFileBytes && length === Number(before.size), "SOURCE_CHANGED");
      const after = await handle.stat({ bigint: true });
      const now = await lstat(current, { bigint: true });
      const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      require(identity(before) === identity(after) && identity(after) === identity(now), "SOURCE_CHANGED");
      require((await realpath(current)).startsWith(realRoot + path.sep), "PATH_ESCAPE");
      return data.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError("SOURCE_UNAVAILABLE");
  }
}

/**
 * Re-checks the body hash, held view, file hash and exact range bytes. v2 supports a whole-line
 * slice of the pointed-to text, while v1 always compares the whole field (check_delivery.py).
 */
export async function verifyReceipt({ body, receipt, workspaceRoot, expectedView }) {
  require(receipt && (receipt.schema === RECEIPT_SCHEMA || receipt.schema === SLICED_RECEIPT_SCHEMA), "SCHEMA_MISMATCH");
  for (const key of ["workspaceId", "contentManifestId"]) {
    require(typeof expectedView?.[key] === "string" && expectedView[key] !== "", "MISSING_VIEW");
    require(receipt[key] === expectedView[key], "VIEW_MISMATCH");
  }
  const request = parseBody(body);
  require(receipt.requestBodySha256 === sha256(Buffer.from(body, "utf8")), "REQUEST_HASH_MISMATCH");
  require(Array.isArray(receipt.units) && receipt.units.length > 0 && receipt.units.length <= LIMITS.maxUnits, "UNIT_CAP_OR_EMPTY");
  const ids = new Set();
  let bytes = 0;
  let lines = 0;
  for (const unit of receipt.units) {
    require(unit && typeof unit.id === "string" && unit.id !== "" && !ids.has(unit.id), "DUPLICATE_OR_MISSING_UNIT_ID");
    ids.add(unit.id);
    require(unit.previewKind === "source", "NOT_SOURCE");
    require(typeof unit.contentHash === "string" && /^[a-f0-9]{64}$/.test(unit.contentHash), "INVALID_SOURCE_HASH");
    const delivered = deliveredText(request, unit);
    const file = await readBoundedSource(workspaceRoot, unit.relativePath);
    require(sha256(file) === unit.contentHash, "SOURCE_HASH_MISMATCH");
    const expected = lineRangeBytes(file, unit.startLine, unit.endLine);
    try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(expected); } catch { throw new ReceiptError("INVALID_SOURCE_ENCODING"); }
    let encoded = Buffer.from(delivered, "utf8");
    if (receipt.schema === SLICED_RECEIPT_SCHEMA && unit.textLineOffset !== undefined) {
      const offset = unit.textLineOffset;
      require(Number.isSafeInteger(offset) && offset >= 0, "INVALID_TEXT_LINE_OFFSET");
      encoded = lineRangeBytes(encoded, offset + 1, offset + unit.endLine - unit.startLine + 1);
    }
    require(encoded.equals(expected), "FINAL_TEXT_MISMATCH");
    bytes += encoded.length;
    lines += unit.endLine - unit.startLine + 1;
    require(bytes <= LIMITS.maxBytes, "SOURCE_BYTE_BUDGET");
    require(lines <= LIMITS.maxLines, "SOURCE_LINE_BUDGET");
  }
  return { status: "REQUEST_BODY_VERIFIED", verifiedUnits: receipt.units.length, sourceBytes: bytes, sourceLines: lines,
    networkDelivery: "NOT_CHECKED", modelUse: "NOT_CHECKED", taskSuccess: "NOT_CHECKED" };
}

/**
 * RFC 6901 pointer of the string equal to `text` whose own unit says it is `relativePath` from
 * `startLine` (siblings path/relativePath + startLine, or a sibling evidenceRange as on a
 * java_symbol candidate). Equal text at another location never stands in for this unit; the root
 * value itself is never a match (deliveredText reads "" as the raw content string).
 */
export function findTextPointer(value, text, { relativePath, startLine }) {
  const locatedAt = node => {
    const where = node?.evidenceRange && typeof node.evidenceRange === "object" ? node.evidenceRange : node;
    return (where?.relativePath ?? where?.path) === relativePath && where?.startLine === startLine;
  };
  const visit = (node, pointer) => {
    if (!node || typeof node !== "object") return undefined;
    for (const [key, child] of Array.isArray(node) ? node.map((child, index) => [String(index), child]) : Object.entries(node)) {
      const at = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (typeof child === "string") {
        if (child === text && !Array.isArray(node) && locatedAt(node)) return at;
      } else {
        const found = visit(child, at);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(value, "");
}

/**
 * Receipt units from the live eval loop's SOURCE_RECEIVED events (Q01 full chain). The tool message
 * is found by its tool_call_id in the final body (every message with that id is tried, since some
 * providers reuse ids across rounds) and the pointer by the recorded slice text at the slice's own
 * path and start line. The expected bytes always come from the workspace file, never from the event
 * or the body, so a slice the body lost or altered is refused by receiptForSerializedRequest instead
 * of being reconstructed here. A slice read from other bytes than the file now holds is refused here
 * as SOURCE_HASH_MISMATCH (pass the root that still holds them, e.g. the pristine fixture); a slice
 * without a recorded file hash is checked only by the byte comparison against the current file.
 */
export async function receiptUnitsFromEvents({ body, events, workspaceRoot, loadSource = event => readBoundedSource(workspaceRoot, event.path) }) {
  const request = parseBody(body);
  const units = [];
  const refused = [];
  const files = new Map();
  let ordinal = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "SOURCE_RECEIVED") continue;
    const id = `u${++ordinal}`;
    try {
      require(typeof event.path === "string" && event.path !== "", "INVALID_PATH");
      const key = JSON.stringify([event.path, event.fileContentHash]);
      if (!files.has(key)) files.set(key, await loadSource(event));
      const bytes = files.get(key);
      const contentHash = sha256(bytes);
      require(event.fileContentHash === undefined || event.fileContentHash === contentHash, "SOURCE_HASH_MISMATCH");
      require(Number.isInteger(event.startLine) && Number.isInteger(event.endLine) && event.startLine >= 1 && event.startLine <= event.endLine, "INVALID_RANGE");
      let messageIndex = -1;
      let textPointer;
      request.messages.forEach((message, index) => {
        if (textPointer !== undefined || message?.role !== "tool" || message.tool_call_id !== event.callId) return;
        if (messageIndex < 0) messageIndex = index;
        if (typeof message.content !== "string") return;
        try {
          const found = findTextPointer(strictParse(message.content), String(event.text), { relativePath: event.path, startLine: event.startLine });
          if (found !== undefined) { messageIndex = index; textPointer = found; }
        } catch (error) { if (!(error instanceof ReceiptError)) throw error; }
      });
      units.push({ id, toolCallId: event.callId, messageIndex, textPointer, relativePath: event.path, contentHash,
        startLine: event.startLine, endLine: event.endLine, sourceText: lineRangeBytes(bytes, event.startLine, event.endLine).toString("utf8") });
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      refused.push({ id, reason: error.reason });
    }
  }
  return { units, refused };
}

async function main(args) {
  const options = Object.fromEntries(args.flatMap((value, index) => value.startsWith("--") ? [[value.slice(2), args[index + 1]]] : []));
  requireValue(options.request && options.receipt && options.workspace && options.view,
    "usage: ilv2-mac-delivery-receipt.mjs --request BODY_FILE --receipt RECEIPT_JSON --workspace DIR --view VIEW_JSON");
  const { readFile } = await import("node:fs/promises");
  try {
    const result = await verifyReceipt({ body: await readFile(options.request, "utf8"), receipt: await readJson(options.receipt),
      workspaceRoot: path.resolve(options.workspace), expectedView: await readJson(options.view) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    console.log(JSON.stringify({ status: "REFUSED", reason: error.reason }));
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
