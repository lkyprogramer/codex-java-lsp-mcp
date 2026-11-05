import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AliasRegistry } from "../../alias-registry.js";
import { JavaLspApplication } from "../../application.js";
import { assertOwnerLock, ownerCacheRoot } from "../../mac-platform/owner-lock.js";
import { createMcpServer } from "../../mcp-server-factory.js";
import { IndexOwner, WORKTREE_IDLE_MS } from "./index-owner.js";
import { PUBLICATION_HISTORY_FILE, type SnapshotPublication } from "./publication-history.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/java-index-v2", import.meta.url));

async function until(probe: () => unknown): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!probe()) {
    assert.ok(performance.now() < deadline, "isolated static index did not settle");
    await delay(10);
  }
}

test("48-hour GC unbinds one real linked worktree and its next static MCP query reuses the shared snapshot",
  { timeout: 120_000, skip: !process.env.ILV2_OWNER_CACHE_ROOT }, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-worktree-idle-case-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const main = path.join(dir, "main");
  await cp(fixturesRoot, main, { recursive: true });
  const worktree = path.join(dir, "linked");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", main, "-c", "core.hooksPath=/dev/null", ...args]);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  git("worktree", "add", "-q", "--detach", worktree);
  await writeFile(path.join(worktree, "untracked.txt"), "retain this file\n");
  const config = path.join(dir, "projects.json");
  const registry = new AliasRegistry(config);
  const mainPin = { id: "fixture-main", root: main, lspEnabled: true };
  const writePins = (...aliases: typeof mainPin[]) => writeFile(config, JSON.stringify({ aliases }));
  await writePins(mainPin);
  await registry.reloadIfChanged();
  let now = 0;
  const cache = ownerCacheRoot()!;
  const owner = await IndexOwner.open({ cacheRoot: cache, assertOwner: assertOwnerLock, gcCycleMs: 3_600_000,
    worktreeIdle: { mode: "enforce", isUnpinned: root => registry.isUnpinnedForReclaim(root), now: () => now } });
  t.after(() => owner.stop());
  const bound = async (root: string) => {
    const workspace = await owner.workspace(root);
    await until(() => owner.store.binding(workspace.workspaceId) && workspace.trackerStatus() === "FRESH" && !workspace.roundInFlight);
    return { workspace, binding: owner.store.binding(workspace.workspaceId)! };
  };
  const first = await bound(main);
  const linked = await bound(worktree);
  assert.equal(linked.binding.snapshotId, first.binding.snapshotId);
  const { workspaceId } = linked.workspace;
  const snapshotId = first.binding.snapshotId;
  const app = new JavaLspApplication({ registry, index: async () => owner, cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [], reclaimedFiles: 0 }) });
  const server = createMcpServer(app);
  const client = new Client({ name: "worktree-gc-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await app.initialize();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>, allowNotReady = false) => {
      const result = await client.callTool({ name, arguments: { repoRoot: worktree, ...args } });
      const content = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
      assert.ok(content);
      if (allowNotReady && result.isError) {
        assert.match(content, /NOT_READY|index, which is not ready/i);
        return undefined;
      }
      assert.notEqual(result.isError, true, content);
      return JSON.parse(content);
    };
    const symbol = (allowNotReady = false) => call("java_symbol",
      { operation: "query", query: "OrderService", searchMode: "exact", preview: "none" }, allowNotReady);
    await owner.sweep(); // Enroll the existing binding.
    now = WORKTREE_IDLE_MS - 1;
    const before = await symbol();
    assert.equal(before.indexView.snapshotId, snapshotId);
    assert.ok(before.candidates.length > 0, "the static MCP query found the indexed Java declaration");
    const renewed = now;
    now = renewed + WORKTREE_IDLE_MS - 1;
    await owner.sweep();
    assert.ok(owner.store.binding(workspaceId));
    now += 1;
    assert.equal((await call("java_status", { start: false })).started, false);
    await writeFile(config, "{ invalid");
    await registry.reloadIfChanged();
    assert.ok(registry.status().lastReloadError);
    await owner.sweep();
    assert.ok(owner.store.binding(workspaceId));
    await writePins(mainPin, { id: "fixture-linked", root: worktree, lspEnabled: true });
    await owner.sweep(); // The registry's ordinary request snapshot is still the old config.
    assert.ok(owner.store.binding(workspaceId));
    await writePins(mainPin);
    const shared = owner.store.acquireBound(first.workspace.workspaceId, "request")!;
    try {
      await owner.sweep();
      assert.ok(owner.store.binding(workspaceId), "a shared lease must defer the worktree unlink");
    } finally { shared.lease.release(); }
    await owner.retire(main); // Release worker connections; the pinned binding stays on disk.
    await until(() => owner.store.leaseCount(snapshotId) === 0);
    const report = await owner.sweep();
    assert.deepEqual(report?.workspaces, [workspaceId]);
    assert.deepEqual(report?.snapshots, []);
    assert.equal(owner.store.binding(first.workspace.workspaceId)?.snapshotId, snapshotId);
    assert.equal(owner.store.binding(workspaceId), undefined);
    assert.equal(await readFile(path.join(worktree, "untracked.txt"), "utf8"), "retain this file\n");
    assert.equal(git("worktree", "list", "--porcelain").toString().includes(worktree), true);
    // Normal first request can return NOT_READY while a verified sibling seed is prepared.
    await symbol(true);
    await until(() => owner.store.binding(workspaceId));
    const after = await symbol();
    assert.equal(after.indexView.snapshotId, snapshotId);
    assert.deepEqual(after.candidates, before.candidates);
    const publications = (await readFile(path.join(owner.store.layout.root, PUBLICATION_HISTORY_FILE), "utf8"))
      .trimEnd().split("\n").map(line => JSON.parse(line) as SnapshotPublication);
    assert.deepEqual(publications.filter(row => row.workspaceId === workspaceId).map(row => row.actualBuildMode), ["none", "none"]);
    t.diagnostic(`48h: unbound=${workspaceId}; retained and rebound snapshot=${snapshotId}; worktree builds=0; JDT started=false`);
  } finally {
    await client.close();
    await server.close();
    await app.close();
  }
  const reopened = await IndexOwner.open({ cacheRoot: cache, assertOwner: assertOwnerLock, gcCycleMs: 3_600_000,
    worktreeIdle: { mode: "observe", isUnpinned: root => registry.isUnpinnedForReclaim(root), now: () => now } });
  try {
    await reopened.sweep();
    now += WORKTREE_IDLE_MS - 1;
    await reopened.sweep();
    assert.deepEqual(reopened.status().worktreeIdle?.lastSweep, []);
    now += 1;
    await reopened.sweep();
    assert.deepEqual(reopened.status().worktreeIdle?.lastSweep, [{ workspaceId, outcome: "eligible" }]);
    assert.equal(reopened.store.binding(workspaceId)?.snapshotId, snapshotId);
  } finally {
    await reopened.stop();
  }
});
