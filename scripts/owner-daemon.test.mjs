import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startOwnerDaemon } from "./owner-daemon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "dist/server.js");

test("a driver's owner daemon is isolated, advertised on loopback and fully reaped on stop", { timeout: 60_000 }, async t => {
  if (!existsSync(serverJs)) { t.skip("BLOCKED_ENV: compiled candidate server unavailable"); return; }
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "owner-daemon-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cacheRoot = path.join(base, "cache");
  const owner = await startOwnerDaemon({ serverJs, cacheRoot, ephemeralCache: true, env: { PATH: process.env.PATH, HOME: "/nonexistent-production-home" } });
  let stopped = false;
  t.after(() => stopped ? undefined : owner.stop());
  const endpoint = new URL(owner.url);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.notEqual(endpoint.port, "38456", "never the production port");
  assert.equal(JSON.parse(readFileSync(path.join(cacheRoot, "owner-endpoint.json"), "utf8")).pid, owner.pid);
  assert.equal(owner.relayEnv.JAVA_LSP_OWNER_ENDPOINT, owner.url, "the relay reaches this owner and no other");
  assert.equal(owner.relayEnv.JAVA_LSP_CACHE_ROOT, realpathSync(cacheRoot));
  const reply = await fetch(owner.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "owner-daemon-test", version: "1" } } }) });
  assert.equal(reply.status, 200, await reply.text());
  assert.equal(owner.alive(), true);
  await owner.stop();
  stopped = true;
  assert.equal(owner.alive(), false);
  assert.throws(() => process.kill(-owner.pid, 0), /ESRCH/, "no member of the owner's process group survives");
  assert.equal(existsSync(cacheRoot), false, "an ephemeral cache goes with its owner");
});
