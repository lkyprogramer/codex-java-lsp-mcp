// input: the exact serialized chat request body (openai-compatible-chat onSerializedBody) and the source
//        units an evaluator expects the model to have received.
// output: a post-ilv2/evidence-receipt/v1 receipt binding each unit to a tool message, a JSON pointer and
//         the source bytes, plus a verifier that re-reads the workspace files.
// pos: post-ILV2 Q01 (docs/java-specialist-post-ilv2-v1/docs/05-contracts.md §5.6). A receipt proves only
//      that the serialized body contained these source bytes: not that the provider received the request,
//      that the model used it, or that the task succeeded. Mirrors the bundle's tools/check_delivery.py.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isMain, readJson, requireValue, runCli } from "./ilv2-mac-contracts.mjs";

export const RECEIPT_SCHEMA = "post-ilv2/evidence-receipt/v1";
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

/**
 * Builds a receipt from the final serialized body. Each input unit names where the evaluator expects
 * its source (tool call, message, pointer) and the exact source bytes of its range (`sourceText`, read by
 * the evaluator from the held snapshot or file at `contentHash`). A unit whose text is not in the body
 * byte for byte is refused with its reason, never receipted: a planned range or a tool object that did
 * not reach the final message produces nothing.
 */
export function receiptForSerializedRequest({ body, workspaceId, contentManifestId, units }) {
  require(typeof workspaceId === "string" && workspaceId !== "" && typeof contentManifestId === "string" && contentManifestId !== "", "MISSING_VIEW");
  require(Array.isArray(units), "INVALID_UNITS");
  const request = parseBody(body);
  const accepted = [];
  const refused = [];
  const ids = new Set();
  let bytes = 0;
  let lines = 0;
  for (const unit of units) {
    try {
      require(unit && typeof unit.id === "string" && unit.id !== "" && !ids.has(unit.id), "DUPLICATE_OR_MISSING_UNIT_ID");
      ids.add(unit.id);
      require(typeof unit.contentHash === "string" && /^[a-f0-9]{64}$/.test(unit.contentHash), "INVALID_SOURCE_HASH");
      require(typeof unit.relativePath === "string" && unit.relativePath !== "", "INVALID_PATH");
      require(Number.isInteger(unit.startLine) && Number.isInteger(unit.endLine) && unit.startLine >= 1 && unit.startLine <= unit.endLine, "INVALID_RANGE");
      require(typeof unit.sourceText === "string", "SOURCE_NOT_TEXT");
      // The claimed range must describe the text: a receipt that cannot verify is not issued.
      require(lfLines(Buffer.from(unit.sourceText, "utf8")).length === unit.endLine - unit.startLine + 1, "SOURCE_RANGE_MISMATCH");
      const delivered = deliveredText(request, unit);
      require(delivered === unit.sourceText, "FINAL_TEXT_MISMATCH");
      const size = Buffer.byteLength(delivered, "utf8");
      require(accepted.length < LIMITS.maxUnits, "UNIT_CAP");
      require(bytes + size <= LIMITS.maxBytes, "SOURCE_BYTE_BUDGET");
      require(lines + (unit.endLine - unit.startLine + 1) <= LIMITS.maxLines, "SOURCE_LINE_BUDGET");
      bytes += size;
      lines += unit.endLine - unit.startLine + 1;
      accepted.push({ id: unit.id, toolCallId: unit.toolCallId, messageIndex: unit.messageIndex, textPointer: unit.textPointer,
        relativePath: unit.relativePath, contentHash: unit.contentHash, startLine: unit.startLine, endLine: unit.endLine, previewKind: "source" });
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      refused.push({ id: typeof unit?.id === "string" ? unit.id : null, reason: error.reason });
    }
  }
  return { schema: RECEIPT_SCHEMA, workspaceId, contentManifestId, requestBodySha256: sha256(Buffer.from(body, "utf8")),
    units: accepted, refused, sourceBytes: bytes, sourceLines: lines };
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
 * Re-checks a receipt against the body and the workspace files (check_delivery.py semantics): the body
 * hash, the held view, and for each unit the file hash and the exact bytes of its range in the body.
 */
export async function verifyReceipt({ body, receipt, workspaceRoot, expectedView }) {
  require(receipt && typeof receipt === "object" && receipt.schema === RECEIPT_SCHEMA, "SCHEMA_MISMATCH");
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
    const encoded = Buffer.from(delivered, "utf8");
    require(encoded.equals(expected), "FINAL_TEXT_MISMATCH");
    bytes += encoded.length;
    lines += unit.endLine - unit.startLine + 1;
    require(bytes <= LIMITS.maxBytes, "SOURCE_BYTE_BUDGET");
    require(lines <= LIMITS.maxLines, "SOURCE_LINE_BUDGET");
  }
  return { status: "REQUEST_BODY_VERIFIED", verifiedUnits: receipt.units.length, sourceBytes: bytes, sourceLines: lines,
    networkDelivery: "NOT_CHECKED", modelUse: "NOT_CHECKED", taskSuccess: "NOT_CHECKED" };
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
