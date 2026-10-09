// input:  openaiCompatibleChat with an injected fetch (no network).
// output: regression lock for the absolute request deadline: a stalled
//         header OR a stalled body both fail within timeoutMs, and the
//         credential never appears in the request body.
import assert from "node:assert/strict";
import test from "node:test";
import { openaiCompatibleChat } from "./openai-compatible-chat.mjs";

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
