// input:  runLiveAgentTask 真实工具循环 + serializeModelToolResult + recorder。
// output: R01 回归锁——最后一跳 model tool message 的载荷保全（W01-W05）、
//         只有真正随 chat 请求发出的切片才是 SOURCE_RECEIVED、切片行号与
//         文本逐字节精确、预算硬上限、tool_calls 后紧跟 tool 回复（nudge 在后）、
//         forced-answer 请求同样铸造回执。
// pos:    fake chat 只验证 wire 机制；真实 transport 往返另行记录，本测试
//         通过不等于模型有效性。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runLiveAgentTask } from "./run-agent-trace-live.mjs";
import { createRecorder, EVAL_SYSTEM_PROMPT, boundSourceResult } from "./evaluate-java-task.mjs";
import { runEvalToolWire, fakeChat, serializeModelToolResult, splitSourceLines, MODEL_TOOL_MESSAGE_MAX_BYTES } from "./eval-tool-wire.mjs";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const toolCall = (id, name, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

test("eval-tool-wire driver: payload delivered; RECEIVED comes only from attached slices", async () => {
  const out = await runEvalToolWire({
    name: "read",
    raw: { path: "A.java", text: "int wireSentinel=31337;\n", startLine: 1, endLine: 1, contentHash: "f".repeat(64) },
    chat: fakeChat({ toolName: "read" })
  });
  assert.notEqual(out.run.stopReason, "FAILED_RUNTIME");
  assert.ok(out.received.toolMessages.some(m => m.content.includes("wireSentinel=31337")));
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].contentHash, sha256(out.received.toolMessages[0].content));
  assert.equal(out.sourceFetched.length, 1, "raw tool output is FETCHED");
  assert.equal(out.sourceReceived.length, 1);
  assert.equal(out.sourceReceived[0].text, "int wireSentinel=31337;\n");
  assert.equal(out.sourceReceived[0].fileContentHash, "f".repeat(64));
  assert.equal(out.sourceReceived[0].origin, "explicit_read");
});

// Drives the real loop with a scripted chat, capturing every request.
async function wire(name, raw, { maxBytes } = {}) {
  const recorder = createRecorder();
  const requests = [];
  const rawResults = [];
  let step = 0;
  const run = await runLiveAgentTask({
    task: { taskId: "sentinel", taskText: "Return the source value.", projectId: "fixture", anchor: { file: "A.java", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: "Use the supplied tools. Return JSON.",
    maxRounds: 3,
    toolResultMaxBytes: maxBytes,
    tools: [{ type: "function", function: { name, parameters: { type: "object" } } }],
    invoke: async (toolName, _args, callId) => {
      rawResults.push({ callId, toolName, result: structuredClone(raw) });
      recorder.recordToolResult({ callId, toolName, result: raw });
      return raw;
    },
    onChat: request => {
      requests.push(request);
      for (const receipt of request.newReceipts) recorder.recordModelDelivery(receipt, request);
    },
    chat: async () => {
      step += 1;
      if (step === 1) return { choices: [{ message: { tool_calls: [toolCall("c1", name)] }, finish_reason: "tool_calls" }] };
      return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
    }
  });
  assert.notEqual(run.stopReason, "FAILED_RUNTIME", run.error);
  const last = requests[requests.length - 1];
  return { run, recorder, requests, rawResults, toolMessages: last.messages.filter(m => m.role === "tool"), receipts: last.receipts };
}

test("W01: read source survives the final model-message boundary", async () => {
  const { toolMessages, receipts } = await wire("read", { path: "A.java", text: "int auditSentinel=73619;\n", startLine: 1, endLine: 1 });
  assert.ok(toolMessages.some(m => m.content.includes("auditSentinel=73619")));
  assert.ok(receipts.some(r => r.callId === "c1" && r.toolName === "read" && r.contentHash === sha256(toolMessages[0].content)));
});

test("read file length survives wire clipping without becoming source or exhausting the file", () => {
  const raw = { path: "A.java", startLine: 1, endLine: 80, totalLines: 500, text: "int field;\n".repeat(80), remainingSourceBudget: { lines: 80, bytes: 15000 } };
  const full = serializeModelToolResult("read", raw);
  const model = JSON.parse(full.content);
  assert.equal(model.totalLines, 500);
  assert.equal(model.hasMore, true);
  assert.equal(model.truncated, undefined, "a complete requested window is distinct from an incomplete file");
  const clipped = serializeModelToolResult("read", raw, { maxBytes: 450 });
  const result = JSON.parse(clipped.content);
  assert.equal(result.totalLines, 500);
  assert.equal(result.hasMore, true);
  assert.ok(result.endLine < 80);
  assert.equal(result.remainingSourceBudget.lines, 160 - result.endLine);
  assert.equal(clipped.slices[0].text, result.text);
  assert.equal(clipped.slices[0].endLine, result.endLine);
});

test("W02: every java_symbol field survives (locators, completeness flags, previews)", async () => {
  const raw = {
    schemaVersion: "java-discovery/v1",
    repoHash: "r",
    generation: 3,
    scopeState: "PARTIAL",
    truncated: true,
    stopReason: "deadline",
    candidates: [
      {
        declaration: { id: "m1", name: "auditSentinelMethod", relativePath: "A.java", contentHash: "c".repeat(64), fqn: "x.A#auditSentinelMethod", kind: "method", selection: { line: 3, column: 10 } },
        matchedBy: ["identifier"],
        binding: "source-declaration",
        preview: "void auditSentinelMethod() {}\n",
        previewKind: "source",
        evidenceRange: { startLine: 3, endLine: 3 }
      },
      { declaration: { id: "o", name: "Other", relativePath: "B.java", selection: { line: 1, column: 1 } }, binding: "ambiguous" }
    ]
  };
  const { toolMessages, recorder } = await wire("java_symbol", raw);
  const parsed = JSON.parse(toolMessages[0].content);
  assert.deepEqual(parsed, raw, "within budget the model sees the result unchanged");
  const received = recorder.events().filter(e => e.type === "SOURCE_RECEIVED");
  assert.equal(received.length, 1);
  assert.deepEqual([received[0].startLine, received[0].endLine], [3, 3]);
  assert.equal(received[0].fileContentHash, "c".repeat(64));
});

test("W03: write acknowledgement survives the final model-message boundary", async () => {
  const { toolMessages } = await wire("write_file", { path: "A.java", written: true, bytes: 61 });
  assert.deepEqual(JSON.parse(toolMessages[0].content), { path: "A.java", written: true, bytes: 61 });
});

test("replace_file acknowledgements and errors reach the model without source credit; raw records remain intact", async () => {
  for (const raw of [
    { path: "A.java", written: true, bytes: 61, replacements: 1, debugDetail: "raw-only" },
    { error: "replace failed: before has multiple matches", errorClass: "REPLACE_MATCH", debugDetail: "raw-only" }
  ]) {
    const { toolMessages, receipts, recorder, rawResults } = await wire("replace_file", raw);
    const expected = raw.error
      ? { error: raw.error, errorClass: raw.errorClass }
      : { path: raw.path, written: true, bytes: raw.bytes, replacements: 1 };
    assert.deepEqual(JSON.parse(toolMessages[0].content), expected);
    assert.deepEqual(rawResults, [{ callId: "c1", toolName: "replace_file", result: raw }]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].toolName, "replace_file");
    assert.equal(receipts[0].contentHash, sha256(toolMessages[0].content));
    assert.equal(receipts[0].rawHash, serializeModelToolResult("replace_file", raw).rawHash);
    assert.deepEqual(receipts[0].slices, []);
    assert.equal(recorder.events().filter(event => event.type === "MODEL_PAYLOAD_ATTACHED").length, 1);
    assert.equal(recorder.events().filter(event => event.type.startsWith("SOURCE_")).length, 0);
  }
});

test("W04: a lossy payload credits exactly the retained whole lines", async () => {
  const text = Array.from({ length: 50 }, (_, i) => `line${i + 1}:auditPayload();\n`).join("");
  const { toolMessages, recorder } = await wire("read", { path: "A.java", text, startLine: 1, endLine: 50 }, { maxBytes: 900 });
  const parsed = JSON.parse(toolMessages[0].content);
  assert.ok(Buffer.byteLength(toolMessages[0].content, "utf8") <= 900);
  assert.equal(parsed.truncated, true);
  const keptLines = splitSourceLines(parsed.text);
  assert.ok(keptLines.length > 0 && keptLines.length < 50);
  assert.equal(parsed.endLine, keptLines.length, "endLine describes what was kept");
  assert.equal(parsed.nextStartLine, keptLines.length + 1);
  assert.ok(text.startsWith(parsed.text), "kept text is a byte-exact prefix; no truncation marker inside source");
  const received = recorder.events().filter(e => e.type === "SOURCE_RECEIVED");
  assert.equal(received.length, 1);
  assert.equal(received[0].endLine, keptLines.length);
  assert.equal(received[0].text, parsed.text);
  const fetched = recorder.events().filter(e => e.type === "SOURCE_FETCHED");
  assert.equal(fetched[0].endLine, 50, "the raw fetch saw all 50 lines; only the kept ones are received");
});

test("W05: evaluation prompt does not reference an unavailable tool", () => {
  assert.ok(!EVAL_SYSTEM_PROMPT.includes("java_impact tool only"));
  assert.ok(!EVAL_SYSTEM_PROMPT.includes("with the java_impact"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("only the tools actually provided"));
});

test("protocol: tool replies directly follow tool_calls; the nudge comes after all of them", async () => {
  const requests = [];
  let step = 0;
  await runLiveAgentTask({
    task: { taskId: "t", taskText: "x", projectId: "p", anchor: { file: "A", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: "s",
    maxRounds: 2,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    invoke: async (_name, args) => (args.bad ? { error: "ENOENT" } : { path: "A.java", startLine: 1, endLine: 1, text: "q\n" }),
    onChat: request => requests.push(request),
    chat: async () => {
      step += 1;
      if (step <= 2) {
        return { choices: [{ message: { tool_calls: [toolCall(`a${step}`, "read"), toolCall(`b${step}`, "read", '{"bad":true}'), toolCall(`c${step}`, "read", "{not json")] }, finish_reason: "tool_calls" }] };
      }
      return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
    }
  });
  for (const request of requests) {
    const messages = request.messages;
    messages.forEach((message, index) => {
      if (message.role !== "assistant" || !message.tool_calls) return;
      const ids = message.tool_calls.map(call => call.id);
      const replies = messages.slice(index + 1, index + 1 + ids.length);
      assert.deepEqual(replies.map(m => m.role), ids.map(() => "tool"), `tool_calls at ${index} must be followed by exactly its tool replies`);
      assert.deepEqual(replies.map(m => m.tool_call_id), ids);
    });
  }
  const finalRoles = requests[requests.length - 1].messages.map(m => m.role).join(",");
  assert.ok(finalRoles.includes("assistant,tool,tool,tool,user"), finalRoles);
});

test("receipts: every request is a boundary, including the forced final-answer request", async () => {
  const recorder = createRecorder();
  const requests = [];
  let step = 0;
  const run = await runLiveAgentTask({
    task: { taskId: "t", taskText: "x", projectId: "p", anchor: { file: "A", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: "s",
    maxRounds: 1,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    invoke: async () => ({ path: "A.java", startLine: 1, endLine: 1, text: "lastRound();\n" }),
    onChat: request => {
      requests.push(request);
      for (const receipt of request.newReceipts) recorder.recordModelDelivery(receipt, request);
    },
    chat: async () => {
      step += 1;
      if (step === 1) return { choices: [{ message: { tool_calls: [toolCall("z1", "read")] }, finish_reason: "tool_calls" }] };
      return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
    }
  });
  assert.equal(run.stopReason, "FORCED_ANSWER");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].tools, [], "the forced request carries no tools");
  assert.equal(requests[1].newReceipts.length, 1, "the last round's tool result is attached by the forced request");
  const attached = recorder.events().filter(e => e.type === "MODEL_PAYLOAD_ATTACHED");
  assert.equal(attached[0].requestIndex, 1);
  assert.equal(recorder.events().filter(e => e.type === "SOURCE_RECEIVED").length, 1);
});

test("receipts: a tool result that never reaches a request is never received", async () => {
  const recorder = createRecorder();
  let step = 0;
  const run = await runLiveAgentTask({
    task: { taskId: "t", taskText: "x", projectId: "p", anchor: { file: "A", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: "s",
    maxRounds: 3,
    promptCap: 200,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    invoke: async (toolName, _args, callId) => {
      const raw = { path: "A.java", startLine: 1, endLine: 1, text: `${"neverSent();".repeat(200)}\n` };
      recorder.recordToolResult({ callId, toolName, result: raw });
      return raw;
    },
    onChat: request => {
      for (const receipt of request.newReceipts) recorder.recordModelDelivery(receipt, request);
    },
    chat: async () => {
      step += 1;
      return { choices: [{ message: { tool_calls: [toolCall("n1", "read")] }, finish_reason: "tool_calls" }] };
    }
  });
  assert.equal(run.stopReason, "FAILED_CONTEXT_CAP");
  assert.equal(recorder.events().filter(e => e.type === "SOURCE_FETCHED").length, 1);
  assert.equal(recorder.events().filter(e => e.type === "SOURCE_RECEIVED").length, 0);
});

test("serializer: CRLF, emoji, empty, errors and MCP envelopes", () => {
  const crlf = serializeModelToolResult("read", { path: "C.java", text: "int a=1;\r\nint b=2;\r\n", startLine: 1 });
  assert.equal(JSON.parse(crlf.content).endLine, 2, "no phantom line after the final CRLF");
  assert.equal(crlf.slices[0].text, "int a=1;\r\nint b=2;\r\n");
  const emoji = serializeModelToolResult("read", { path: "E.java", text: "String s = \"🧪\";\n", startLine: 1 });
  assert.ok(emoji.content.includes("🧪"));
  const empty = serializeModelToolResult("read", { path: "N.java", text: "", startLine: 1 });
  assert.deepEqual(empty.slices, []);
  assert.equal(JSON.parse(empty.content).endLine, 0);
  const error = serializeModelToolResult("read", { error: "ENOENT: boom", errorClass: "IO" });
  assert.deepEqual(JSON.parse(error.content), { error: "ENOENT: boom", errorClass: "IO" });
  const mcpError = serializeModelToolResult("java_symbol", { isError: true, content: [{ type: "text", text: "bad " }, { type: "text", text: "query" }] });
  assert.equal(JSON.parse(mcpError.content).error, "bad query");
  const envelope = serializeModelToolResult("read", {
    content: [{ type: "text", text: JSON.stringify({ path: "D.java", text: "int envelopeOk=1;\n", startLine: 1 }) }],
    structuredContent: { path: "D.java", text: "int envelopeOk=1;\n", startLine: 1 }
  });
  assert.equal(envelope.content.split("envelopeOk").length, 2, "structuredContent and its text rendering are not both injected");
  const multiBlock = serializeModelToolResult("read", { content: [{ type: "text", text: "{\"path\":\"M.java\",\"startLine\":1," }, { type: "text", text: "\"text\":\"part1\\npart2\\n\"}" }] });
  assert.equal(JSON.parse(multiBlock.content).text, "part1\npart2\n", "every text block is kept, not only the first");
  const unknown = serializeModelToolResult("mystery_tool", { foo: "bar" });
  assert.equal(JSON.parse(unknown.content).error, "UNSUPPORTED_TOOL_RESULT");
  const impact = serializeModelToolResult("java_impact", { files: [{ path: "X.java", role: "anchor" }], readPlan: [] });
  assert.deepEqual(JSON.parse(impact.content), { files: [{ path: "X.java", role: "anchor" }], readPlan: [], evidenceGaps: [] });
  assert.equal(crlf.modelPayloadHash, sha256(crlf.content));
  assert.equal(crlf.rawHash.length, 64);
  assert.notEqual(crlf.rawHash, crlf.modelPayloadHash);
});

test("serializer: an oversized single line is an explicit budget error, never half a line", () => {
  const out = serializeModelToolResult("read", { path: "B.java", text: `${"x".repeat(200_000)}\n`, startLine: 7 }, { maxBytes: 4096 });
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.error, "MODEL_BUDGET_EXCEEDED");
  assert.deepEqual(out.slices, []);
  assert.equal(out.truncated, true);
});

test("serializer: java_symbol slices use evidenceRange; over budget, candidates are admitted in rank order (preview, else locator)", () => {
  const candidate = (i, preview = `void m${i}() {\n  work();\n}\n`) => ({
    declaration: { name: `m${i}`, relativePath: `F${i}.java`, contentHash: `${i}`.padStart(64, "0"), selection: { line: 10, column: 3 } },
    preview,
    previewKind: "source",
    evidenceRange: { startLine: 9, endLine: 9 + splitSourceLines(preview).length - 1 }
  });
  const small = serializeModelToolResult("java_symbol", { schemaVersion: "java-discovery/v1", candidates: [candidate(0)] });
  assert.deepEqual([small.slices[0].startLine, small.slices[0].endLine], [9, 11], "range from evidenceRange, not selection.line");
  const mismatched = { ...candidate(1), evidenceRange: { startLine: 9, endLine: 20 } };
  assert.deepEqual(serializeModelToolResult("java_symbol", { schemaVersion: "java-discovery/v1", candidates: [mismatched] }).slices, [], "a preview that does not match its range is not creditable");
  const many = serializeModelToolResult("java_symbol", {
    schemaVersion: "java-discovery/v1",
    candidates: Array.from({ length: 40 }, (_, i) => candidate(i, `${"p".repeat(400)}\n`))
  }, { maxBytes: 4096 });
  const parsed = JSON.parse(many.content);
  assert.ok(Buffer.byteLength(many.content, "utf8") <= 4096);
  assert.equal(typeof parsed.candidates[0].preview, "string", "the best-ranked preview survives");
  assert.ok(parsed.modelBudget.droppedCandidates > 0 && parsed.candidates.length + parsed.modelBudget.droppedCandidates === 40);
  assert.equal(many.slices.length, parsed.candidates.filter(c => typeof c.preview === "string").length);
  const huge = serializeModelToolResult("java_symbol", { schemaVersion: "java-discovery/v1", candidates: [candidate(0, `${"q".repeat(50_000)}\n`)] }, { maxBytes: 4096 });
  assert.ok(Buffer.byteLength(huge.content, "utf8") <= 4096);
  assert.equal(JSON.parse(huge.content).candidates[0].previewDropped, "MODEL_BUDGET");
  assert.deepEqual(huge.slices, []);
});

test("serializer: content is always valid JSON within maxBytes, for every tool shape", () => {
  const sizes = [0, 1, 100, 3_000, 40_000];
  const shapes = size => [
    ["read", { path: "R.java", text: Array.from({ length: Math.max(1, size / 40) }, (_, i) => `${i}${"r".repeat(38)}\n`).join(""), startLine: 1 }],
    ["java_symbol", { schemaVersion: "java-discovery/v1", candidates: Array.from({ length: Math.ceil(size / 500) }, (_, i) => ({ declaration: { name: `n${i}`, relativePath: `P${i}.java` }, preview: "s".repeat(400) + "\n", previewKind: "source", evidenceRange: { startLine: 1, endLine: 1 } })) }],
    ["list", { path: ".", entries: Array.from({ length: Math.max(1, size / 20) }, (_, i) => `dir/file${i}.java\n`).join("") }],
    ["rg", { pattern: "x", path: ".", matches: 1, output: "a.java:1:" + "x".repeat(size) + "\n" }],
    ["test", { status: "COMPILE_FAILED", exitCode: 1, output: "err\n".repeat(size) }],
    ["mystery", { blob: "z".repeat(size) }]
  ];
  for (const maxBytes of [512, 2048, MODEL_TOOL_MESSAGE_MAX_BYTES]) {
    for (const size of sizes) {
      for (const [tool, raw] of shapes(size)) {
        const out = serializeModelToolResult(tool, raw, { maxBytes });
        assert.ok(Buffer.byteLength(out.content, "utf8") <= maxBytes, `${tool} size=${size} max=${maxBytes}`);
        assert.doesNotThrow(() => JSON.parse(out.content));
        for (const slice of out.slices) assert.ok(out.content.includes(JSON.stringify(slice.text).slice(1, -1)), "slices are retained in content");
      }
    }
  }
});

test("R08: a java_symbol preview is credited against its evidence source; a redacted preview never", () => {
  const xmlHash = "x".repeat(64);
  const javaHash = "j".repeat(64);
  const declaration = { id: "m", name: "load", relativePath: "src/main/java/demo/Mapper.java", contentHash: javaHash, selection: { line: 3, column: 9 } };
  const raw = {
    schemaVersion: "java-discovery/v1",
    scopeState: "READY",
    candidates: [
      {
        declaration,
        matchedBy: ["framework"],
        binding: "source-declaration",
        preview: "  <select id=\"load\">\r\n    SELECT 1\r\n",
        previewKind: "source",
        evidenceRange: { relativePath: "src/main/resources/Mapper.xml", contentHash: xmlHash, startLine: 2, endLine: 3 }
      },
      {
        declaration: { ...declaration, id: "t" },
        binding: "source-declaration",
        preview: "String API_TOKEN = \"<value-redacted>\";\n",
        previewKind: "redacted-preview",
        evidenceRange: { relativePath: "src/main/java/demo/Mapper.java", contentHash: javaHash, startLine: 5, endLine: 5 }
      }
    ]
  };
  const { slices } = serializeModelToolResult("java_symbol", raw, MODEL_TOOL_MESSAGE_MAX_BYTES);
  assert.deepEqual(slices.map(({ sliceHash, ...slice }) => slice), [{
    path: "src/main/resources/Mapper.xml",
    startLine: 2,
    endLine: 3,
    text: raw.candidates[0].preview,
    fileContentHash: xmlHash
  }], "the XML slice with the XML hash; the redacted preview is not source evidence");
  assert.equal(slices[0].sliceHash, sha256(raw.candidates[0].preview));
  assert.equal(splitSourceLines(raw.candidates[0].preview).length, 2, "CRLF counts one terminator per line");
});


test("read source-budget clipping and exhaustion keep terminal status and exact continuation on wire", () => {
  const partial = serializeModelToolResult("read", { path: "A.java", startLine: 7, endLine: 7, text: "x\r\n", truncated: true,
    nextStartLine: 8, sourceBudgetLimited: true, remainingSourceBudget: { lines: 0, bytes: 9 }, terminal: true });
  const payload = JSON.parse(partial.content);
  assert.equal(payload.text, "x\r\n");
  assert.equal(payload.nextStartLine, 8);
  assert.equal(payload.sourceBudgetLimited, true);
  assert.equal(payload.terminal, true);
  assert.deepEqual(payload.remainingSourceBudget, { lines: 0, bytes: 9 });
  assert.equal(partial.slices[0].endLine, 7);
  const exhausted = serializeModelToolResult("read", { error: "SOURCE_BUDGET_EXHAUSTED", errorClass: "SOURCE_BUDGET",
    remainingSourceBudget: { lines: 2, bytes: 0 }, terminal: true });
  assert.deepEqual(exhausted.slices, []);
  assert.equal(JSON.parse(exhausted.content).terminal, true);
  assert.deepEqual(JSON.parse(exhausted.content).remainingSourceBudget, { lines: 2, bytes: 0 });
});


test("source and wire caps charge only retained read/symbol slices and remain stable on reserialization", () => {
  const preview = "//" + "a".repeat(1997) + "\n";
  const candidates = Array.from({ length: 21 }, (_, i) => ({ declaration: { relativePath: `A${i}.java`, contentHash: "a".repeat(64), name: `A${i}` },
    previewKind: "source", preview, evidenceRange: { startLine: 1, endLine: 1 } }));
  const readLine = "\\".repeat(100) + "\n";
  const cases = [
    { name: "java_symbol", raw: { schemaVersion: "java-discovery/v1", candidates }, budget: { lines: 20, bytes: 40000 }, options: {} },
    { name: "read", raw: { path: "A.java", startLine: 1, text: readLine.repeat(151), contentHash: "a".repeat(64) }, budget: { lines: 150, bytes: 15150 }, options: { maxBytes: 2000 } }
  ];
  for (const { name, raw, budget, options } of cases) {
    const bounded = boundSourceResult(name, raw, budget);
    assert.equal(bounded.sourceBudgetLimited, true, "source cap removes at least one line");
    assert.deepEqual(bounded.remainingSourceBudget, { lines: 0, bytes: 0 });
    const wire = serializeModelToolResult(name, bounded, options);
    const payload = JSON.parse(wire.content);
    const delivered = wire.slices.reduce((sum, slice) => ({ lines: sum.lines + splitSourceLines(slice.text).length, bytes: sum.bytes + Buffer.byteLength(slice.text) }), { lines: 0, bytes: 0 });
    assert.ok(delivered.lines > 0 && delivered.lines < budget.lines, "wire cap removes additional source");
    assert.deepEqual(payload.remainingSourceBudget, { lines: budget.lines - delivered.lines, bytes: budget.bytes - delivered.bytes });
    assert.equal(payload.terminal, undefined, "wire omissions cannot claim an exhausted source budget");
    assert.equal(payload.sourceBudgetLimited, true);
    const second = serializeModelToolResult(name, payload, options);
    assert.equal(second.content, wire.content);
    assert.equal(second.modelPayloadHash, wire.modelPayloadHash);
    assert.deepEqual(second.slices, wire.slices, "second serialization must not refund or duplicate delivered lines");
    assert.deepEqual(boundSourceResult(name, raw, payload.remainingSourceBudget).remainingSourceBudget, { lines: 0, bytes: 0 }, "repeated source still consumes remaining budget");
  }
});


test("wire budget rejection refunds all undelivered source and keeps budget metadata on second serialization", () => {
  for (const name of ["read", "java_symbol"]) {
    const text = "x".repeat(3000) + "\n";
    const raw = name === "read" ? { path: "A.java", startLine: 1, text }
      : { candidates: [{ declaration: { relativePath: "A.java", name: "n".repeat(3000) }, previewKind: "source", preview: text, evidenceRange: { startLine: 1, endLine: 1 } }] };
    const bounded = boundSourceResult(name, raw, { lines: 1, bytes: 3001 });
    const wire = serializeModelToolResult(name, bounded, { maxBytes: 512 });
    assert.deepEqual(wire.slices, []);
    const payload = JSON.parse(wire.content);
    assert.equal(payload.error, "MODEL_BUDGET_EXCEEDED");
    assert.deepEqual(payload.remainingSourceBudget, { lines: 1, bytes: 3001 });
    assert.equal(payload.terminal, undefined);
    const second = serializeModelToolResult(name, payload, { maxBytes: 512 });
    assert.deepEqual(JSON.parse(second.content).remainingSourceBudget, payload.remainingSourceBudget);
    assert.equal(JSON.parse(second.content).terminal, undefined);
    assert.deepEqual(second.slices, []);
  }
});

test("evidence wire receipts retain exact CRLF ranges and hashes; omitted metadata is never source", async () => {
  const text = '<resultMap>\r\n  汉字\r\n</resultMap>\r\n';
  const raw = { schemaVersion: "java-evidence-unit/v1", generation: 3, scopeState: "PARTIAL", reasons: ["STALE"], omitted: [{ path: "stale.xml", contentHash: "s" }],
    units: [{ relation: "result-map-type", sourceKind: "mybatis", path: "mapper.xml", contentHash: "f".repeat(64), startLine: 2, endLine: 4, text, complete: true }] };
  const out = await runEvalToolWire({ name: "java_evidence", raw, chat: fakeChat({ toolName: "java_evidence" }) });
  assert.equal(out.sourceFetched.length, 1);
  assert.equal(out.sourceReceived.length, 1);
  const received = out.sourceReceived[0];
  assert.equal(received.text, text); assert.equal(received.startLine, 2); assert.equal(received.endLine, 4);
  assert.equal(received.fileContentHash, "f".repeat(64)); assert.equal(received.contentHash, sha256(text));
  const payload = JSON.parse(out.received.toolMessages[0].content);
  assert.equal(payload.scopeState, "PARTIAL"); assert.deepEqual(payload.omitted, raw.omitted);
  const noSource = await runEvalToolWire({ name: "java_evidence", raw: { ...raw, units: [] }, chat: fakeChat({ toolName: "java_evidence" }) });
  assert.equal(noSource.sourceReceived.length, 0);
});

test("evidence message clipping is incomplete, refunds actual removed source and is idempotent", () => {
  const text = Array.from({ length: 30 }, (_, i) => `  <row id="${i}">${"x".repeat(60)}</row>\r\n`).join("");
  const raw = { schemaVersion: "java-evidence-unit/v1", generation: 5, scopeState: "PARTIAL", omitted: [{ reason: "STALE" }], units: [{ relation: "result-map-type", sourceKind: "xml",
    path: "mapper.xml", contentHash: "f".repeat(64), startLine: 2, endLine: 31, text, complete: true }] };
  const limited = boundSourceResult("java_evidence", raw, { lines: 30, bytes: Buffer.byteLength(text) });
  const wire = serializeModelToolResult("java_evidence", limited, { maxBytes: 1100 });
  const payload = JSON.parse(wire.content);
  assert.equal(payload.units[0].complete, false); assert.equal(payload.units[0].originalEndLine, 31);
  assert.ok(wire.slices.length === 1); assert.ok(wire.slices[0].endLine < 31);
  const kept = wire.slices[0].text;
  assert.equal(payload.remainingSourceBudget.lines, 30 - splitSourceLines(kept).length);
  assert.equal(payload.remainingSourceBudget.bytes, Buffer.byteLength(text) - Buffer.byteLength(kept));
  const twice = serializeModelToolResult("java_evidence", payload, { maxBytes: 1100 });
  assert.equal(twice.content, wire.content); assert.deepEqual(twice.slices, wire.slices);
  assert.deepEqual(payload.omitted, raw.omitted); assert.equal(payload.scopeState, "PARTIAL");
});
