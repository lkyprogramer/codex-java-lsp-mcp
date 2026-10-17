import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { writeJson } from "./ilv2-mac-contracts.mjs";
import { eventually } from "./ilv2-mac-owner-fixture.mjs";
import { call, children, httpClient, startOwner, stdioClient, withDaemonLog } from "./ilv2-mac-mcp-owner-fixture.mjs";

// MAC-08B MCP contracts: the HTTP daemon is the one owner (under the owner launcher, so its FSEvents
// trackers run for real); stdio only relays to it. Isolated caches, ports and HOME; never :38456.
const evidence = {};

/** Wall-clock and per-call cost fields differ between two identical calls; the facts must not. */
function facts(value) {
  if (Array.isArray(value)) return value.map(facts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(elapsed|Ms$|^ms$|At$|cost|timing|telemetry|bytes|Bytes|tokens|requestId)/i.test(key))
    .map(([key, entry]) => [key, facts(entry)]));
}

async function fresh(client, repoRoot) {
  return eventually(async () => {
    const status = await call(client, "java_status", { repoRoot });
    return status.indexView?.state === "FRESH" ? status : false;
  }, 120000);
}

test("stdio-http-share-one-owner", { timeout: 240000 }, async t => {
  const owner = await startOwner(t, "share");
  await withDaemonLog(owner, () => shareOneOwner(owner));
});

async function shareOneOwner(owner) {
  const repo = owner.repos[0];
  const http = await httpClient(owner);
  const probe = await fetch(owner.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) }).then(response => response.status, error => `${error.message} ${error.cause?.code ?? ""}`);
  evidence.directProbe = probe;
  const { client: stdio, pid: stdioPid } = await stdioClient(owner, repo).catch(error => { throw new Error(`stdio connect failed (direct probe ${probe}): ${error.message}`); });
  const [httpTools, stdioTools] = await Promise.all([http.listTools(), stdio.listTools()]);
  assert.deepEqual(stdioTools.tools.map(tool => tool.name).sort(), httpTools.tools.map(tool => tool.name).sort(), "stdio relays the owner's tool list");

  // The first indexed call starts the workspace in the owner (real FSEvents tracker, real full build).
  const query = { operation: "query", query: "demospring.OrderService", searchMode: "exact", preview: "none" };
  await call(http, "java_symbol", { repoRoot: repo, ...query });
  const status = await fresh(http, repo);
  const viaHttp = await call(http, "java_symbol", { repoRoot: repo, ...query });
  const viaStdio = await call(stdio, "java_symbol", query); // no root: the relay injects the stdio client's cwd
  assert.equal(viaHttp.error, undefined, viaHttp.error);
  assert.deepEqual(facts(viaStdio), facts(viaHttp), "stdio and HTTP answer from the same owner and snapshot");

  const daemonStatus = await call(http, "java_status", {});
  const workspaces = daemonStatus.index?.workspaces ?? [];
  assert.deepEqual(workspaces.map(workspace => workspace.canonicalRoot), [repo], "one owner, one workspace for both transports");
  const stdioChildren = children(stdioPid);
  assert.deepEqual(stdioChildren, [], "stdio starts no builder, query worker, tracker or JDT");

  // Owner down: stdio fails explicitly and quickly instead of building a runtime of its own.
  await owner.kill();
  const started = performance.now();
  const down = await call(stdio, "java_symbol", query);
  const downMs = performance.now() - started;
  assert.match(down.error ?? "", /owner unavailable/);
  assert.ok(downMs < 5000, `owner-unavailable took ${downMs.toFixed(0)} ms`);
  assert.deepEqual(children(stdioPid), [], "still no child after the owner is gone");
  evidence["stdio-http-share-one-owner"] = { snapshot: status.indexView, workspaces, stdioPid, stdioChildren, downMs, downError: down.error };
}

test("status-only-does-not-bootstrap", { timeout: 120000 }, async t => {
  const owner = await startOwner(t, "status", { repos: 2 });
  const [known, unknown] = owner.repos;
  const http = await httpClient(owner);
  const before = await call(http, "java_status", {});
  assert.equal(before.index, undefined, "status opens no index owner");
  const cold = await call(http, "java_status", { repoRoot: unknown });
  assert.equal(cold.indexView?.state, "NOT_READY");
  assert.equal(cold.runtime, "NONE", "status-only creates no runtime entry");
  await delay(300);
  assert.deepEqual(children(owner.daemon.pid), [], "status-only forks no builder, query worker, tracker or JDT");
  const afterCold = await call(http, "java_status", {});
  assert.equal(afterCold.index, undefined);

  // A known repo: status reports its labels from memory and still starts nothing for the unknown one.
  await call(http, "java_symbol", { repoRoot: known, operation: "query", query: "demospring.OrderService", searchMode: "exact", preview: "none" });
  await fresh(http, known);
  const again = await call(http, "java_status", { repoRoot: unknown });
  assert.equal(again.indexView?.state, "NOT_READY");
  const daemonStatus = await call(http, "java_status", {});
  assert.deepEqual(daemonStatus.index.workspaces.map(workspace => workspace.canonicalRoot), [known], "the unknown repo never got a workspace");
  const workspaceDir = path.join(owner.cache, "mac1", "workspaces");
  assert.ok(!existsSync(workspaceDir) || readdirSync(workspaceDir).length <= 1, "no workspace state was written for the unknown repo");
  evidence["status-only-does-not-bootstrap"] = { before, cold, again: again.indexView, workspaces: daemonStatus.index.workspaces };
});

test.after(async () => {
  await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), "mcp-owner-contracts.json"),
    { route: "G01-direct-owned-fixture", launchd: "NOT_RUN", evidence });
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
