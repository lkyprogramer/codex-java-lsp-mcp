// input:  openaiCompatibleChat with an injected fetch (no network).
// output: regression lock for the absolute request deadline: a stalled
//         header OR a stalled body both fail within timeoutMs, and the
//         credential never appears in the request body.
import assert from "node:assert/strict";
import test from "node:test";
import { completionForAudit, openaiCompatibleChat } from "./openai-compatible-chat.mjs";

const base = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test-secret", model: "m", messages: [{ role: "user", content: "hi" }] };
const stall = signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

test("deadline covers a stalled response header", async () => {
  const started = Date.now();
  await assert.rejects(openaiCompatibleChat({ ...base, timeoutMs: 50, fetchImpl: (_url, init) => stall(init.signal) }), /exceeded 50ms/);
  assert.ok(Date.now() - started < 2_000);
});

test("deadline covers a stalled response body", async () => {
  const started = Date.now();
  const fetchImpl = async (_url, init) => ({ ok: true, status: 200, text: () => stall(init.signal) });
  await assert.rejects(openaiCompatibleChat({ ...base, timeoutMs: 50, fetchImpl }), /exceeded 50ms/);
  assert.ok(Date.now() - started < 2_000);
});

test("a normal response parses and the key stays in the header only", async () => {
  let seen;
  const fetchImpl = async (_url, init) => {
    seen = init;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
  };
  const out = await openaiCompatibleChat({ ...base, fetchImpl });
  assert.equal(out.choices[0].message.content, "{}");
  assert.ok(!seen.body.includes("sk-test-secret"));
  assert.equal(seen.headers.Authorization, "Bearer sk-test-secret");
});

test("default request stays at 2048 and explicit next off settings reach the body", async () => {
  for (const config of [{}, { reasoningEffort: "none", chatTemplateKwargs: { enable_thinking: false } }]) {
    let body;
    await openaiCompatibleChat({ ...base, ...config, fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
    } });
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, config.reasoningEffort);
    assert.equal(JSON.stringify(body).includes(base.apiKey), false);
  }
});

test("completion audit preserves partial tool arguments and measured usage without provider auth metadata", () => {
  const usage = {
    prompt_tokens: 25, completion_tokens: 2048, total_tokens: 2073,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 9, accepted_prediction_tokens: 0 }
  };
  const choice = { index: 0, finish_reason: "length", message: {
    role: "assistant", content: null, reasoning_content: "fixture thought",
    tool_calls: [{ id: "partial", type: "function", function: { name: "write_file", arguments: '{"path":"A.java","content":"' } }]
  } };
  const audit = completionForAudit({
    model: "fixture", choices: [choice], apiKey: "never-log", debug: "never-log",
    usage: { ...usage, apiKey: "never-log" }
  });
  assert.deepEqual(audit.choices[0], choice);
  assert.deepEqual(audit.usage, usage);
  assert.equal(JSON.stringify(audit).includes("never-log"), false);
  audit.choices[0].message.tool_calls[0].function.arguments = "mutated audit";
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"path":"A.java","content":"');
});
