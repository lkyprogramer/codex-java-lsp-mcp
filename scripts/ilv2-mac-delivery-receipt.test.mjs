import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openaiCompatibleChat } from "./openai-compatible-chat.mjs";
import { ReceiptError, lineRangeBytes, receiptForSerializedRequest, strictParse, verifyReceipt } from "./ilv2-mac-delivery-receipt.mjs";

const SOURCE = "package example;\r\n\r\npublic class OrderService {\n    // 订单 🚚\n    public void cancel(long id) {\n        ledger.release(id);\n    }\n}";
const hash = text => createHash("sha256").update(text).digest("hex");
const VIEW = { workspaceId: "ws-fixture-01", contentManifestId: "cm-fixture-01" };

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/OrderService.java"), SOURCE);
  return root;
}

/** The final request body as a fake model client captures it: tool messages carry the product's JSON text. */
async function capturedBody(toolContent) {
  let body;
  await openaiCompatibleChat({
    baseUrl: "http://fake.invalid", apiKey: "k", model: "m",
    messages: [{ role: "user", content: "why is stock not released" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "java_symbol", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: toolContent }],
    onSerializedBody: serialized => { body = serialized; },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })
  });
  return body;
}

const range = (startLine, endLine) => lineRangeBytes(Buffer.from(SOURCE), startLine, endLine).toString("utf8");
const unit = (overrides = {}) => ({ id: "u1", toolCallId: "call-1", messageIndex: 2, textPointer: "/units/0/text",
  relativePath: "src/OrderService.java", contentHash: hash(SOURCE), startLine: 4, endLine: 7, sourceText: range(4, 7), ...overrides });

test("source that reaches the final serialized tool message is receipted and verifies against the workspace", async t => {
  const root = await workspace(t);
  const body = await capturedBody(JSON.stringify({ units: [{ text: range(4, 7) }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit()] });
  assert.deepEqual(receipt.refused, []);
  assert.equal(receipt.units.length, 1);
  assert.equal(receipt.requestBodySha256, hash(body));
  const verified = await verifyReceipt({ body, receipt, workspaceRoot: root, expectedView: VIEW });
  assert.equal(verified.status, "REQUEST_BODY_VERIFIED");
  assert.equal(verified.sourceLines, 4);
  assert.equal(verified.modelUse, "NOT_CHECKED");
});

test("CRLF lines are delivered byte for byte; a normalised copy is not the source", async t => {
  await workspace(t);
  const normalised = range(1, 3).replaceAll("\r\n", "\n");
  const body = await capturedBody(JSON.stringify({ units: [{ text: normalised }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit({ startLine: 1, endLine: 3, sourceText: range(1, 3) })] });
  assert.deepEqual(receipt.refused.map(item => item.reason), ["FINAL_TEXT_MISMATCH"]);
  assert.equal(receipt.units.length, 0);
});

test("a source present only in the tool object, not in the final message, produces no receipt", async t => {
  await workspace(t);
  // The tool returned the text, but the host kept only its paths when building the next request.
  const body = await capturedBody(JSON.stringify({ units: [{ path: "src/OrderService.java" }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit()] });
  assert.deepEqual(receipt.refused.map(item => item.reason), ["POINTER_MISSING"]);
});

test("wrong tool call, non-tool message and wrong hash are refused", async t => {
  const root = await workspace(t);
  const body = await capturedBody(JSON.stringify({ units: [{ text: range(4, 7) }] }));
  const reasons = receiptForSerializedRequest({ body, ...VIEW, units: [
    unit({ id: "a", toolCallId: "call-2" }), unit({ id: "b", messageIndex: 0 }), unit({ id: "c", contentHash: "z".repeat(64) })
  ] }).refused.map(item => item.reason);
  assert.deepEqual(reasons, ["TOOL_CALL_MISMATCH", "NOT_TOOL_MESSAGE", "INVALID_SOURCE_HASH"]);
  // A receipt claiming a hash the file does not have fails verification.
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit({ contentHash: hash("other") })] });
  await assert.rejects(verifyReceipt({ body, receipt, workspaceRoot: root, expectedView: VIEW }), (error) => error instanceof ReceiptError && error.reason === "SOURCE_HASH_MISMATCH");
});

test("a body changed after the receipt, another view, or a symlinked source are refused", async t => {
  const root = await workspace(t);
  const body = await capturedBody(JSON.stringify({ units: [{ text: range(4, 7) }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit()] });
  const reason = promise => promise.then(() => "VERIFIED", error => error.reason);
  assert.equal(await reason(verifyReceipt({ body: body.replace("why", "how"), receipt, workspaceRoot: root, expectedView: VIEW })), "REQUEST_HASH_MISMATCH");
  assert.equal(await reason(verifyReceipt({ body, receipt, workspaceRoot: root, expectedView: { ...VIEW, workspaceId: "ws-other-0001" } })), "VIEW_MISMATCH");
  await symlink(path.join(root, "src/OrderService.java"), path.join(root, "src/Linked.java"));
  const linked = { ...receipt, units: [{ ...receipt.units[0], relativePath: "src/Linked.java" }] };
  assert.equal(await reason(verifyReceipt({ body, receipt: linked, workspaceRoot: root, expectedView: VIEW })), "SYMLINK_REFUSED");
});

test("a claimed range that does not describe the text is refused before a receipt is issued", async t => {
  await workspace(t);
  const body = await capturedBody(JSON.stringify({ units: [{ text: range(4, 7) }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [unit({ endLine: 5 })] });
  assert.deepEqual(receipt.refused.map(item => item.reason), ["SOURCE_RANGE_MISMATCH"]);
});

test("duplicate JSON keys are refused: a reader and a scorer must see the same text", () => {
  assert.throws(() => strictParse('{"units":[{"text":"a","text":"b"}]}'), error => error.reason === "DUPLICATE_JSON_KEY");
  assert.deepEqual(strictParse('{"a":{"b":1},"c":[{"b":2}]}'), { a: { b: 1 }, c: [{ b: 2 }] });
});

test("the budget of 8 units, 80 lines and 16000 bytes is enforced across units", async t => {
  await workspace(t);
  const big = "x".repeat(9000);
  const body = await capturedBody(JSON.stringify({ units: [{ text: big }, { text: big }] }));
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units: [
    unit({ id: "a", textPointer: "/units/0/text", startLine: 4, endLine: 4, sourceText: big }), unit({ id: "b", textPointer: "/units/1/text", startLine: 4, endLine: 4, sourceText: big })
  ] });
  assert.equal(receipt.units.length, 1);
  assert.deepEqual(receipt.refused.map(item => item.reason), ["SOURCE_BYTE_BUDGET"]);
});
