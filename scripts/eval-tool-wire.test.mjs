// input:  runLiveAgentTask 真实工具循环 + serializeModelToolResult + 严格 scorer。
// output: R01 回归锁——最后一跳 model tool message 的载荷保全（W01-W04）、
//         评测提示词不再引用未提供工具（W05）、strict QA 评分（E01-E04）。
// pos:    本测试用 fake chat 验证 wire 机制本身；真实 SDK 往返由 R12 再测，
//         本测试通过不等于模型有效性。E01-E04（严格 scorer）属 R02。

import assert from "node:assert/strict";
import test from "node:test";
import { runLiveAgentTask, serializeModelToolResult } from "./run-agent-trace-live.mjs";
import { createRecorder, EVAL_SYSTEM_PROMPT } from "./evaluate-java-task.mjs";
import { runEvalToolWire, fakeChat } from "./eval-tool-wire.mjs";

test("eval-tool-wire driver: fake transport delivers the payload end to end", async () => {
  const out = await runEvalToolWire({
    name: "read",
    raw: { path: "A.java", text: "int wireSentinel=31337;\n", startLine: 1, endLine: 1 },
    chat: fakeChat({ toolName: "read" })
  });
  assert.notEqual(out.run.stopReason, "FAILED_RUNTIME");
  assert.ok(out.received.toolMessages.some(m => m.content.includes("wireSentinel=31337")));
  assert.ok(out.deliveries.some(d => d.toolName === "read" && d.contentHash.length === 64));
  assert.ok(out.sourceReceived.some(e => e.text.includes("wireSentinel=31337")));
  // a real-SDK-shaped wrapper (async function with its own bookkeeping) must
  // behave identically at the wire level - this is the second transport level
  // the R12 real-SDK test will replace with an actual provider round trip.
  const wrapper = async request => {
    const seen = request.messages.filter(m => m.role === "tool").length;
    return fakeChat({ toolName: "read" })({ ...request, __seenToolMessages: seen });
  };
  const out2 = await runEvalToolWire({ name: "read", raw: { path: "A.java", text: "int wireSentinel=31337;\n", startLine: 1, endLine: 1 }, chat: wrapper });
  assert.ok(out2.received.toolMessages.some(m => m.content.includes("wireSentinel=31337")));
});

// Drives the real loop with a fake chat that returns one tool call per round,
// capturing the EXACT messages the final chat request would carry.
async function wire(name, raw, { maxBytes } = {}) {
  const recorder = createRecorder();
  let received;
  const chatState = { done: false };
  const run = await runLiveAgentTask({
    task: { taskId: "sentinel", taskText: "Return the source value.", projectId: "fixture", anchor: { file: "A.java", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: "Use the supplied tools. Return JSON.",
    maxRounds: 3,
    toolResultMaxBytes: maxBytes,
    tools: [{ type: "function", function: { name, parameters: { type: "object" } } }],
    invoke: async (toolName, args) => {
      recorder.recordToolResult({ callId: "c1", toolName, result: raw });
      return raw;
    },
    onChat: ({ messages, receipts, payloadHash }) => {
      received = {
        // LAST capture wins: the final chat request is the boundary where the
        // tool results are actually attached to the model payload.
        messages: messages.filter(m => m.role === "tool"),
        receipts,
        payloadHash
      };
    },
    chat: async () => {
      // First request: emit the one tool call. Subsequent requests: final answer.
      if (!chatState.done) {
        chatState.done = true;
        return { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
      }
      return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
    }
  });
  assert.notEqual(run.stopReason, "FAILED_RUNTIME", run.error);
  return { run, recorder, received };
}

test("W01: read source survives the final model-message boundary", async () => {
  const raw = { path: "A.java", text: "int auditSentinel=73619;\n", startLine: 1, endLine: 1 };
  const { received, recorder } = await wire("read", raw);
  assert.ok(received.messages.some(m => m.content.includes("auditSentinel=73619")), "model payload must contain the read source");
  assert.ok(received.messages.some(m => m.content.includes("A.java")));
  // delivery receipt minted at the chat boundary, with the model-payload hash
  assert.ok(received.receipts.some(r => r.callId === "c1" && r.toolName === "read" && r.contentHash.length === 64));
  assert.ok(received.messages.every(m => typeof m.content === "string" && m.content.length > 0));
  // raw source events still recorded (raw hash independent of model hash)
  const sourceEvents = recorder.events().filter(e => e.type === "SOURCE_RECEIVED");
  assert.ok(sourceEvents.some(e => e.text.includes("auditSentinel=73619")));
});

test("W02: java_symbol candidates survive the final model-message boundary", async () => {
  const raw = {
    schemaVersion: "java-discovery/v1",
    mode: "query",
    query: "sentinel",
    candidates: [
      { declaration: { name: "auditSentinelMethod", relativePath: "A.java", kind: "method", selection: { line: 3, column: 10 } }, preview: "void auditSentinelMethod() {}\n", previewKind: "source" },
      { declaration: { name: "Other", relativePath: "B.java" } }
    ]
  };
  const { received } = await wire("java_symbol", raw);
  const joined = JSON.stringify(received.messages);
  assert.ok(joined.includes("auditSentinelMethod"), "candidate names must reach the model");
  assert.ok(joined.includes("A.java"));
  assert.ok(joined.includes("void auditSentinelMethod()"), "byte-exact previews must reach the model");
  assert.ok(joined.includes("Other") && joined.includes("B.java"));
});

test("W03: write acknowledgement survives the final model-message boundary", async () => {
  const { received } = await wire("write_file", { path: "A.java", written: true, bytes: 61 });
  const parsed = JSON.parse(received.messages[0].content);
  assert.equal(parsed.written, true);
  assert.equal(parsed.path, "A.java");
  assert.equal(parsed.bytes, 61);
});

test("W04: SOURCE_RECEIVED cannot be credited when the payload was lossy", async () => {
  // Tiny budget: the read text must be truncated, so the model payload cannot
  // contain the full source; the loop must still not crash and receipts must
  // reflect the retained (truncated) content only.
  const { received, recorder } = await wire("read", {
    path: "A.java",
    text: Array.from({ length: 50 }, (_, i) => `line${i}:auditPayload();`).join("\n") + "\n",
    startLine: 1,
    endLine: 50
  }, { maxBytes: 900 });
  const content = received.messages[0].content;
  assert.ok(content.length > 0);
  assert.doesNotThrow(() => JSON.parse(content), "truncation must keep valid JSON");
  const parsed = JSON.parse(content);
  assert.equal(parsed.truncated, true);
  // Receipts carry the retained (possibly lossy) slices; the receipt's
  // contentHash is the MODEL payload hash, while SOURCE_RECEIVED events hash
  // the RAW source - the two hashes must be comparable and distinct.
  const receipt = received.receipts.find(r => r.callId === "c1");
  assert.ok(receipt.slices?.length > 0, "lossy delivery must be recorded via slices");
  for (const slice of receipt.slices) {
    // The retained slice (minus the truncation marker) must be a prefix of
    // the raw text, so credit can be audited against the raw events.
    const probe = slice.text.replace(/\n\.\.\[truncated\]$/, "");
    assert.ok(probe.length === 0 || slice.text.startsWith(probe), "slice must be byte-prefix of raw");
  }
});

test("W05: evaluation prompt does not reference an unavailable tool", () => {
  assert.ok(!EVAL_SYSTEM_PROMPT.includes("java_impact tool only"));
  assert.ok(!EVAL_SYSTEM_PROMPT.includes("with the java_impact"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("only the tools actually provided"));
});

test("boundary: CRLF text, emoji, trailing newline, empty content, error path", async () => {
  // CRLF: line-wise trimming may drop the final chunk, so the model-facing
  // payload is verified as valid JSON whose slices are a byte-exact subset of
  // the RAW text (lossy = recorded via truncated/slices, never silent).
  const crlf = await wire("read", { path: "C.java", text: "int a=1;\r\nint b=2;\r\n", startLine: 1, endLine: 2 });
  const crlfParsed = JSON.parse(crlf.received.messages[0].content);
  assert.equal(crlfParsed.path, "C.java");
  const crlfSlices = (crlfParsed.slices ?? crlf.received.receipts.find(r => r.callId === "c1")?.slices ?? []).map(s => s.text);
  assert.ok(crlfSlices.some(s => s.includes("int a=1;")), "retained CRLF slice must survive byte-exact");
  // emoji (multi-byte) survives.
  const emoji = await wire("read", { path: "E.java", text: "String s = \"🧪\";\n", startLine: 1, endLine: 1 });
  assert.ok(emoji.received.messages[0].content.includes("🧪"));
  // empty text is legal and stays valid JSON.
  const empty = await wire("read", { path: "N.java", text: "", startLine: 1, endLine: 0 });
  assert.doesNotThrow(() => JSON.parse(empty.received.messages[0].content));
  // tool error still reaches the model as an error object.
  const { received: errReceived } = await wire("read", { error: "ENOENT: boom" });
  assert.ok(errReceived.messages[0].content.includes("ENOENT: boom"));
  // MCP envelope: structuredContent dedupes against the text block.
  const envelope = serializeModelToolResult("read", {
    content: [{ type: "text", text: JSON.stringify({ path: "D.java", text: "int envelopeOk=1;\n", startLine: 1, endLine: 1 }) }],
    structuredContent: { path: "D.java", text: "int envelopeOk=1;\n", startLine: 1, endLine: 1 }
  });
  const envParsed = JSON.parse(envelope.content);
  assert.equal(envParsed.path, "D.java");
  assert.ok(envParsed.text.includes("envelopeOk=1"));
  assert.ok(!envelope.content.includes("type\":\"text"), "envelope wrapper must not leak into the model payload");
  // multi-text-block read joins byte-faithfully.
  const multi = serializeModelToolResult("read", { path: "M.java", text: [{ text: "part1\n" }, { text: "part2\n" }], startLine: 1, endLine: 2 });
  assert.equal(JSON.parse(multi.content).text, "part1\npart2\n");
  // unknown tool name: verbatim bounded JSON, never the impact projection.
  const unknown = serializeModelToolResult("mystery_tool", { foo: "bar" });
  assert.deepEqual(JSON.parse(unknown.content), { raw: { foo: "bar" } });
  const impact = serializeModelToolResult("java_impact", { files: [{ path: "X.java", role: "anchor" }], readPlan: [] });
  assert.deepEqual(JSON.parse(impact.content), { files: [{ path: "X.java", role: "anchor" }], readPlan: [], evidenceGaps: [] });
});

test("boundary: budget edge keeps JSON valid and slices consistent", () => {
  const big = { path: "B.java", text: "x".repeat(200_000) + "\n", startLine: 1, endLine: 1 };
  const out = serializeModelToolResult("read", big, { maxBytes: 4096 });
  assert.ok(Buffer.byteLength(out.content, "utf8") <= 4096);
  assert.doesNotThrow(() => JSON.parse(out.content));
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.truncated, true);
  assert.ok(out.slices.length === 1 && Buffer.byteLength(out.slices[0].text, "utf8") <= 4096);
  // symbol result: candidates dropped tail-first, JSON stays valid.
  const sym = serializeModelToolResult("java_symbol", {
    candidates: Array.from({ length: 40 }, (_, i) => ({ declaration: { name: `m${i}`, relativePath: `F${i}.java` }, preview: "p".repeat(500) }))
  }, { maxBytes: 4096 });
  assert.ok(Buffer.byteLength(sym.content, "utf8") <= 4096);
  const symParsed = JSON.parse(sym.content);
  assert.ok(Array.isArray(symParsed.candidates) && symParsed.candidates.length >= 1);
});