import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { advertiseOwnerEndpoint, OwnerRelay, ownerEndpointFile, resolveOwnerEndpoint, withLocalSelector } from "./stdio-owner-proxy.js";

const cwd = "/work/repo";
const toolCall = (name: string, args: Record<string, unknown>, id: number | string = 1): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as JSONRPCMessage;
const argsOf = (message: JSONRPCMessage) => (message as unknown as { params: { arguments: Record<string, unknown> } }).params.arguments;

test("withLocalSelector makes stdio's local context explicit and keeps server-wide calls server-wide", () => {
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_symbol", { query: "A" }), cwd)), { query: "A", repoRoot: cwd });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_symbol", { repoRoot: "sub" }), cwd)), { repoRoot: "/work/repo/sub" });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_symbol", { projectId: "p" }), cwd)), { projectId: "p" });
  // A file selects its own repo in the owner; it only becomes absolute.
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_impact", { file: "src/A.java", line: 1 }), cwd)), { file: "/work/repo/src/A.java", line: 1 });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_impact", { files: ["a/B.java", "/abs/C.java"] }), cwd)), { files: ["/work/repo/a/B.java", "/abs/C.java"] });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_impact", { anchors: [{ file: "D.java", line: 2 }] }), cwd)), { anchors: [{ file: "/work/repo/D.java", line: 2 }] });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_impact", { files: [] }), cwd)), { files: [], repoRoot: cwd });
  // Daemon-wide status and runtime-all stay daemon-wide; a starting status is repo-scoped.
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_status", {}), cwd)), {});
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_status", { start: true }), cwd)), { start: true, repoRoot: cwd });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_runtime", { all: true }), cwd)), { all: true });
  assert.deepEqual(argsOf(withLocalSelector(toolCall("java_runtime", {}), cwd)), { repoRoot: cwd });
  // Anything that is not a tool call request is relayed untouched.
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" } as JSONRPCMessage;
  assert.equal(withLocalSelector(list, cwd), list);
  const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "java_symbol", arguments: {} } } as JSONRPCMessage;
  assert.equal(withLocalSelector(notification, cwd), notification);
});

type Posted = { url: string; headers: Record<string, string>; body: JSONRPCMessage; signal: AbortSignal };
function relayWith(reply: (posted: Posted) => Promise<Response> | Response, options: { endpoint?: () => string | undefined; maxRequestMs?: number } = {}) {
  const sent: JSONRPCMessage[] = [];
  const posted: Posted[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const entry = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as JSONRPCMessage, signal: init.signal! };
    posted.push(entry);
    return reply(entry);
  }) as unknown as typeof fetch;
  const relay = new OwnerRelay({ send: message => { sent.push(message); }, cwd, fetchImpl, endpoint: options.endpoint ?? (() => "http://127.0.0.1:4321/mcp"), maxRequestMs: options.maxRequestMs });
  return { relay, sent, posted };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const errorOf = (message: JSONRPCMessage) => (message as unknown as { id: unknown; error: { code: number; message: string } });

test("the relay posts each request to the owner with the negotiated protocol version and returns its reply", async () => {
  const { relay, sent, posted } = relayWith(({ body }) => {
    const id = (body as { id?: number }).id;
    if ((body as { method: string }).method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    if (id === undefined) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } });
  });
  await relay.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} } as JSONRPCMessage);
  await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  await relay.handle(toolCall("java_symbol", { query: "A" }, 7));
  assert.equal(posted.length, 3);
  assert.equal(posted[0]!.headers["mcp-protocol-version"], undefined);
  assert.equal(posted[2]!.headers["mcp-protocol-version"], "2025-06-18");
  assert.deepEqual(argsOf(posted[2]!.body), { query: "A", repoRoot: cwd }, "the owner receives explicit selectors");
  assert.deepEqual(sent.map(message => (message as { id?: unknown }).id), [0, 7], "a notification gets no reply");
});

test("with no owner endpoint every request fails explicitly and nothing is fetched", async () => {
  const { relay, sent, posted } = relayWith(() => assert.fail("must not fetch"), { endpoint: () => undefined });
  await relay.handle(toolCall("java_symbol", {}, 3));
  await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(posted.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(errorOf(sent[0]!).id, 3);
  assert.equal(errorOf(sent[0]!).error.code, -32000);
  assert.match(errorOf(sent[0]!).error.message, /owner unavailable: no owner endpoint/);
});

test("an unreachable owner is reported with its URL and the socket error", async () => {
  const { relay, sent } = relayWith(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }); });
  await relay.handle(toolCall("java_symbol", {}, 4));
  assert.equal(errorOf(sent[0]!).error.message, "codex-java-lsp owner unavailable at http://127.0.0.1:4321/mcp: fetch failed (ECONNREFUSED)");
});

test("a cancel notification aborts only its own in-flight POST", async () => {
  const pending = new Map<number, () => void>();
  const { relay, sent, posted } = relayWith(({ body, signal }) => new Promise<Response>((resolve, reject) => {
    const id = (body as { id: number }).id;
    signal.addEventListener("abort", () => reject(signal.reason));
    pending.set(id, () => resolve(json({ jsonrpc: "2.0", id, result: { content: [] } })));
  }), { maxRequestMs: 60_000 });
  const slow = relay.handle(toolCall("java_symbol", {}, 10));
  const other = relay.handle(toolCall("java_symbol", {}, 11));
  await new Promise(resolve => setImmediate(resolve));
  await relay.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 10 } } as JSONRPCMessage);
  // The cancel itself aborts the POST at once: not the relay's own timeout later.
  assert.equal(posted.find(entry => (entry.body as { id: number }).id === 10)!.signal.aborted, true);
  assert.equal(posted.find(entry => (entry.body as { id: number }).id === 11)!.signal.aborted, false);
  await slow;
  pending.get(11)!();
  await other;
  const byId = new Map(sent.map(message => [(message as { id: number }).id, message]));
  assert.match(errorOf(byId.get(10)!).error.message, /request cancelled/);
  assert.ok("result" in byId.get(11)!, "the other request still completes");
});

test("a hung owner is bounded by maxRequestMs", async () => {
  const { relay, sent } = relayWith(({ signal }) => new Promise<Response>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason)); }), { maxRequestMs: 30 });
  const started = performance.now();
  await relay.handle(toolCall("java_symbol", {}, 5));
  assert.ok(performance.now() - started < 1000);
  assert.match(errorOf(sent[0]!).error.message, /owner unavailable at .*: no reply within 30 ms/);
});

test("an owner error without a request id is returned under the caller's id, and close drops later replies", async () => {
  const { relay, sent } = relayWith(() => json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "bad session" } }, 400));
  await relay.handle(toolCall("java_symbol", {}, 6));
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 6, error: { code: -32600, message: "bad session" } });
  relay.close();
  await relay.handle(toolCall("java_symbol", {}, 8));
  assert.equal(sent.length, 1);
});

test("the advertised endpoint is loopback-only, an explicit endpoint wins, and only its own record is removed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owner-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JAVA_LSP_CACHE_ROOT: root } as NodeJS.ProcessEnv;
  assert.equal(resolveOwnerEndpoint(env), undefined);
  const remove = await advertiseOwnerEndpoint("http://127.0.0.1:5555/mcp", env);
  assert.equal(resolveOwnerEndpoint(env), "http://127.0.0.1:5555/mcp");
  assert.equal(resolveOwnerEndpoint({ ...env, JAVA_LSP_OWNER_ENDPOINT: "http://localhost:6666/mcp" }), "http://localhost:6666/mcp");
  assert.throws(() => resolveOwnerEndpoint({ ...env, JAVA_LSP_OWNER_ENDPOINT: "http://10.0.0.2:5555/mcp" }), /loopback/);
  // A successor advertised itself: the old owner's remover leaves it in place.
  const file = ownerEndpointFile(env);
  await writeFile(file, JSON.stringify({ url: "http://127.0.0.1:7777/mcp", pid: process.pid + 1, startedAt: "x" }));
  await remove();
  assert.equal(JSON.parse(await readFile(file, "utf8")).pid, process.pid + 1);
});
