import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openaiCompatibleChat } from "./openai-compatible-chat.mjs";
import { ReceiptError, lineRangeBytes, findTextPointer, receiptForSerializedRequest, receiptsForSerializedRequest, receiptUnitsFromEvents, strictParse, verifyReceipt } from "./ilv2-mac-delivery-receipt.mjs";
import { runLiveEvalRun } from "./evaluate-java-task.mjs";

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

test("byte-heavy fields are split on whole lines and verified at the recorded offset", async t => {
  const root = await workspace(t);
  const first = `${"界".repeat(3000)}\r\n`;
  const second = "é".repeat(4500);
  const text = first + second;
  const relativePath = "src/OrderService.java";
  await writeFile(path.join(root, relativePath), text);
  const source = unit({ startLine: 1, endLine: 2, sourceText: text, contentHash: hash(text) });
  const body = await capturedBody(JSON.stringify({ units: [{ text }] }));
  const receipts = receiptsForSerializedRequest({ body, ...VIEW, units: [source] });
  assert.deepEqual(receipts.map(receipt => [receipt.units[0].startLine, receipt.units[0].endLine, receipt.units[0].textLineOffset]),
    [[1, 1, 0], [2, 2, 1]]);
  for (const [index, receipt] of receipts.entries()) {
    const verified = await verifyReceipt({ body, receipt, workspaceRoot: root, expectedView: VIEW });
    assert.equal(verified.sourceBytes, Buffer.byteLength(index === 0 ? first : second));
  }
  const wrongOffset = structuredClone(receipts[1]);
  wrongOffset.units[0].textLineOffset = 0;
  await assert.rejects(verifyReceipt({ body, receipt: wrongOffset, workspaceRoot: root, expectedView: VIEW }), { reason: "FINAL_TEXT_MISMATCH" });
  const altered = await capturedBody(JSON.stringify({ units: [{ text: first + second.replace("é", "e") }] }));
  const [refusal] = receiptsForSerializedRequest({ body: altered, ...VIEW, units: [source] });
  assert.deepEqual(refusal.units, []);
  assert.deepEqual(refusal.refused, [{ id: source.id, reason: "FINAL_TEXT_MISMATCH" }]);
});

test("full fake-model chain: java_symbol, java_evidence and native read source is receipted from the last sent body; the write is checked separately", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-chain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await writeFile(path.join(fixture, "src/OrderService.java"), SOURCE);
  const STOCK = "class Stock { int n = 1; }\n";
  await writeFile(path.join(fixture, "src/Stock.java"), STOCK);
  const file = "src/OrderService.java";
  const discovery = { schemaVersion: "java-discovery/v1", scopeState: "READY", candidates: [{
    declaration: { name: "OrderService", kind: "class", relativePath: file, line: 3, column: 14, contentHash: hash(SOURCE) },
    evidenceRange: { relativePath: file, startLine: 3, endLine: 3, contentHash: hash(SOURCE) }, previewKind: "source", preview: range(3, 3) }] };
  const evidence = { schemaVersion: "java-evidence-unit/v2", scopeState: "READY", reasons: [], units: [{
    path: file, role: "anchor", startLine: 5, endLine: 7, text: range(5, 7), contentHash: hash(SOURCE), proof: "SOURCE_FACT", complete: true }] };
  const call = (id, name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const script = [
    call("c-symbol", "java_symbol", { query: "OrderService", preview: "head" }),
    call("c-evidence", "java_evidence", { file, line: 5, column: 17 }),
    call("c-read", "read", { path: file, startLine: 1, maxLines: 2 }),
    call("c-read-stock", "read", { path: "src/Stock.java" }),
    call("c-replace", "replace_file", { path: "src/Stock.java", before: "n = 1", after: "n = 2" }),
    call("c-reread-stock", "read", { path: "src/Stock.java" }),
    call("submit", "submit_answer", { patchApplied: true, summary: "Set n to 2." })
  ];
  const bodies = [];
  const run = await runLiveEvalRun({ tasks: [{ id: "R", corpus: "c", kind: "repair", query: "Change initial n to 2." }],
    arms: ["product"], productProfile: "evidence", repoRoots: { c: fixture }, outputDir: path.join(dir, "run"), kitRoot: dir,
    openSessionImpl: async () => ({ symbol: async () => structuredClone(discovery), evidence: async () => structuredClone(evidence), close: async () => {} }),
    repairJudge: async () => ({ state: "VALIDATED_SUCCESS", validatedSuccess: true }),
    // The production send path with a fake network: the receipt binds to the bytes it serialized.
    chat: request => openaiCompatibleChat({ baseUrl: "http://fake.invalid", apiKey: "k", model: "m", messages: request.messages, tools: request.tools,
      maxTokens: request.maxTokens, onSerializedBody: serialized => { bodies.push(serialized); },
      fetchImpl: async () => new Response(JSON.stringify(script[bodies.length - 1]), { status: 200 }) }) });
  const row = run.runs[0];
  assert.equal(bodies.length, script.length);
  const body = bodies.at(-1);
  const { units, refused } = await receiptUnitsFromEvents({ body, events: row.sourceReceived, workspaceRoot: fixture });
  // The re-read after the write is not the fixture's bytes: refused here, never receipted under the old hash.
  assert.deepEqual(refused.map(item => item.reason), ["SOURCE_HASH_MISMATCH"]);
  assert.deepEqual(units.map(unit => unit.toolCallId), ["c-symbol", "c-evidence", "c-read", "c-read-stock"]);
  const receipt = receiptForSerializedRequest({ body, ...VIEW, units });
  assert.deepEqual(receipt.refused, []);
  assert.equal(receipt.requestBodySha256, hash(body));
  const verified = await verifyReceipt({ body, receipt, workspaceRoot: fixture, expectedView: VIEW });
  assert.equal(verified.status, "REQUEST_BODY_VERIFIED");
  assert.equal(verified.sourceLines, 1 + 3 + 2 + 1);
  // The write happened in the attempt copy and its result reached the model; the fixture is untouched.
  const written = JSON.parse(body).messages.find(message => message.tool_call_id === "c-replace");
  assert.deepEqual([JSON.parse(written.content).written, JSON.parse(written.content).replacements], [true, 1]);
  assert.equal(await readFile(path.join(fixture, "src/Stock.java"), "utf8"), STOCK);
  // Reads keep their own before/after receipts; task success still comes only from the judge.
  assert.equal(row.candidateReceiptValidation.status, "VALID");
  const stockRows = row.candidateReceiptValidation.rows.filter(item => item.path === "src/Stock.java");
  assert.deepEqual(stockRows.map(item => [item.callId, item.finalCandidateMatches]), [["c-read-stock", false], ["c-reread-stock", true]]);
  assert.equal(row.sourceReceived.find(event => event.type === "SOURCE_RECEIVED" && event.callId === "c-reread-stock")?.text,
    "class Stock { int n = 2; }\n");
  assert.equal(row.taskSuccess, true);

  // Source the host kept only as paths in the final message is not delivered, whatever the tool returned.
  const parsed = JSON.parse(body);
  const lost = JSON.stringify({ ...parsed, messages: parsed.messages.map(message => message.role === "tool"
    ? { ...message, content: JSON.stringify({ path: file }) } : message) });
  const fromLost = await receiptUnitsFromEvents({ body: lost, events: row.sourceReceived, workspaceRoot: fixture });
  assert.deepEqual(receiptForSerializedRequest({ body: lost, ...VIEW, units: fromLost.units }).units, []);
  assert.deepEqual([...new Set(receiptForSerializedRequest({ body: lost, ...VIEW, units }).refused.map(item => item.reason))], ["POINTER_MISSING"]);
  // A request sent before any tool result cannot carry that source.
  const early = await receiptUnitsFromEvents({ body: bodies[0], events: row.sourceReceived, workspaceRoot: fixture });
  assert.deepEqual([...new Set(receiptForSerializedRequest({ body: bodies[0], ...VIEW, units: early.units }).refused.map(item => item.reason))], ["INVALID_MESSAGE_INDEX"]);
});

test("a pointer is taken only at the slice's own path and start line; equal text elsewhere does not stand in", () => {
  const content = { units: [{ path: "B.java", startLine: 9, text: "    }\n" }, { path: "A.java", startLine: 7, text: "    }\n" }] };
  assert.equal(findTextPointer(content, "    }\n", { relativePath: "A.java", startLine: 7 }), "/units/1/text");
  assert.equal(findTextPointer(content, "    }\n", { relativePath: "A.java", startLine: 8 }), undefined);
  const candidate = { candidates: [{ evidenceRange: { relativePath: "a/b~c.java", startLine: 3 }, preview: "x\n" }] };
  assert.equal(findTextPointer(candidate, "x\n", { relativePath: "a/b~c.java", startLine: 3 }), "/candidates/0/preview");
  assert.equal(findTextPointer({ "a/b": { "c~d": { path: "P", startLine: 1, text: "t" } } }, "t", { relativePath: "P", startLine: 1 }), "/a~1b/c~0d/text");
  assert.equal(findTextPointer("t", "t", { relativePath: "P", startLine: 1 }), undefined, "the root is never a match");
});
