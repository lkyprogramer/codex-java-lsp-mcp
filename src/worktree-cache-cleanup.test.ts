import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { defaultLeaseClockDeps, FileCrossProcessLeaseStore } from "./cross-process-lease.js";
import type { WorktreeIdentity } from "./worktree-identity.js";

test("cleanupStaleWorktreeCaches removes only stale inactive worktree caches by default", async () => {
  const { cleanupStaleWorktreeCaches } = await import("./worktree-cache-cleanup.js");
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-cache-"));
  const now = Date.parse("2026-06-21T00:00:00.000Z");

  try {
    await writeMeta(cacheBase, "stale-worktree", {
      repoRoot: "/tmp/old-worktree",
      isGitWorktree: true,
      updatedAt: new Date(now - 3 * 86400000).toISOString()
    });
    await writeMeta(cacheBase, "stale-main", {
      repoRoot: "/tmp/main-checkout",
      isGitWorktree: false,
      updatedAt: new Date(now - 3 * 86400000).toISOString()
    });
    await writeMeta(cacheBase, "fresh-worktree", {
      repoRoot: "/tmp/fresh-worktree",
      isGitWorktree: true,
      updatedAt: new Date(now - 86400000).toISOString()
    });
    await writeMeta(cacheBase, "active-worktree", {
      repoRoot: "/tmp/active-worktree",
      isGitWorktree: true,
      jdtlsPid: process.pid,
      updatedAt: new Date(now - 3 * 86400000).toISOString()
    });

    const result = cleanupStaleWorktreeCaches({ cacheBase, now });

    assert.equal(result.removed, 1);
    assert.equal(existsSync(path.join(cacheBase, "stale-worktree")), false);
    assert.equal(existsSync(path.join(cacheBase, "stale-main")), true);
    assert.equal(existsSync(path.join(cacheBase, "fresh-worktree")), true);
    assert.equal(existsSync(path.join(cacheBase, "active-worktree")), true);
  } finally {
    await rm(cacheBase, { recursive: true, force: true });
  }
});

test("cleanupStaleWorktreeCaches ignores legacy source-index metadata", async () => {
  const { cleanupStaleWorktreeCaches } = await import("./worktree-cache-cleanup.js");
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-cache-"));
  const legacyDir = path.join(cacheBase, "legacy-index");

  try {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "source-index.meta.json"), JSON.stringify({
      repoRoot: "/tmp/old-worktree",
      isGitWorktree: true,
      updatedAt: "2026-06-18T00:00:00.000Z"
    }));

    const result = cleanupStaleWorktreeCaches({
      cacheBase,
      now: Date.parse("2026-06-21T00:00:00.000Z")
    });

    assert.equal(result.removed, 0);
    assert.equal(existsSync(legacyDir), true);
  } finally {
    await rm(cacheBase, { recursive: true, force: true });
  }
});

// --- Task 12c: multi-process runtime-lease liveness protection ------------

type JanitorFixture = {
  cacheBase: string;
  leaseBase: string;
  cacheRoot: string;
  identity: WorktreeIdentity;
  leases: FileCrossProcessLeaseStore;
  now: number;
  writeCacheMeta(extra: Record<string, unknown>): Promise<void>;
};

async function cacheJanitorFixture(updatedAtDaysAgo: number): Promise<JanitorFixture> {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-cache-"));
  const leaseBase = await mkdtemp(path.join(tmpdir(), "java-lsp-leases-"));
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  const identity: WorktreeIdentity = {
    repoRoot: "/tmp/fast-only-worktree",
    repoHash: "repohash1",
    familyHash: "familyhash1",
    isLinkedWorktree: true
  };
  const leases = new FileCrossProcessLeaseStore(leaseBase, defaultLeaseClockDeps());
  await leases.open({ jdtSlots: 4, sweepSlots: 1 });
  const cacheRoot = path.join(cacheBase, "fast-only");
  async function writeCacheMeta(extra: Record<string, unknown>): Promise<void> {
    await writeMeta(cacheBase, "fast-only", {
      repoRoot: identity.repoRoot,
      repoHash: identity.repoHash,
      familyHash: identity.familyHash,
      isGitWorktree: true,
      updatedAt: new Date(now - updatedAtDaysAgo * 86400000).toISOString(),
      ...extra
    });
  }
  return { cacheBase, leaseBase, cacheRoot, identity, leases, now, writeCacheMeta };
}

async function cleanupFixture(fixture: JanitorFixture, isAlive?: (pid: number) => boolean) {
  const { cleanupStaleWorktreeCaches } = await import("./worktree-cache-cleanup.js");
  return cleanupStaleWorktreeCaches({
    cacheBase: fixture.cacheBase,
    leaseBase: fixture.leaseBase,
    now: fixture.now,
    ttlDays: 2,
    isAlive
  });
}

async function teardown(fixture: JanitorFixture): Promise<void> {
  await rm(fixture.cacheBase, { recursive: true, force: true });
  await rm(fixture.leaseBase, { recursive: true, force: true });
}

test("janitor does not delete a stale-looking cache owned by a live fast-only runtime", async () => {
  const fixture = await cacheJanitorFixture(10);
  try {
    const runtimeLease = await fixture.leases.acquireRuntime(fixture.identity);
    await fixture.writeCacheMeta({ ownerPid: process.pid, ownerToken: runtimeLease.owner.ownerToken });

    const result = await cleanupFixture(fixture);

    assert.equal(result.removed, 0);
    assert.equal(existsSync(fixture.cacheRoot), true);
    await runtimeLease.release();
  } finally {
    await teardown(fixture);
  }
});

test("janitor removes a stale cache once the runtime lease is released and the recorded owner pid is dead", async () => {
  const fixture = await cacheJanitorFixture(10);
  try {
    const runtimeLease = await fixture.leases.acquireRuntime(fixture.identity);
    await runtimeLease.release();
    await fixture.writeCacheMeta({ ownerPid: 999999, ownerToken: runtimeLease.owner.ownerToken });

    const result = await cleanupFixture(fixture, pid => pid === process.pid);

    assert.equal(result.removed, 1);
    assert.equal(existsSync(fixture.cacheRoot), false);
  } finally {
    await teardown(fixture);
  }
});

test("a live ownerPid fallback protects a cache even with no runtime lease on disk", async () => {
  const fixture = await cacheJanitorFixture(10);
  try {
    await fixture.writeCacheMeta({ ownerPid: process.pid });

    const result = await cleanupFixture(fixture);

    assert.equal(result.removed, 0);
    assert.equal(existsSync(fixture.cacheRoot), true);
  } finally {
    await teardown(fixture);
  }
});

test("a dead ownerPid does not protect a cache once the runtime lease is also gone", async () => {
  const fixture = await cacheJanitorFixture(10);
  try {
    await fixture.writeCacheMeta({ ownerPid: 999999 });

    const result = await cleanupFixture(fixture, pid => pid === process.pid);

    assert.equal(result.removed, 1);
    assert.equal(existsSync(fixture.cacheRoot), false);
  } finally {
    await teardown(fixture);
  }
});

test("a JDT workspace lock file protects a cache regardless of lease/pid state", async () => {
  const fixture = await cacheJanitorFixture(10);
  try {
    await fixture.writeCacheMeta({});
    await mkdir(path.join(fixture.cacheRoot, "workspace", ".metadata"), { recursive: true });
    await writeFile(path.join(fixture.cacheRoot, "workspace", ".metadata", ".lock"), "");

    const result = await cleanupFixture(fixture, pid => pid === process.pid);

    assert.equal(result.removed, 0);
    assert.equal(existsSync(fixture.cacheRoot), true);
  } finally {
    await teardown(fixture);
  }
});

test("touchRepoCache merges independent writers instead of one clobbering the other", async () => {
  const { touchRepoCache } = await import("./worktree-cache-cleanup.js");
  const { repoCacheRoot } = await import("./repo-layout.js");
  const repoRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-touch-"));
  try {
    touchRepoCache(repoRoot, { repoHash: "rh", familyHash: "fh", ownerPid: 111, ownerToken: "tok" });
    touchRepoCache(repoRoot, { jdtlsPid: 222 });
    const meta = JSON.parse(await (await import("node:fs/promises")).readFile(
      path.join(repoCacheRoot(repoRoot), "repo-meta.json"),
      "utf8"
    ));
    assert.equal(meta.repoHash, "rh", "the request-touch fields survive the later JDT-lifecycle touch");
    assert.equal(meta.ownerPid, 111);
    assert.equal(meta.jdtlsPid, 222);

    touchRepoCache(repoRoot, { jdtlsPid: undefined });
    const cleared = JSON.parse(await (await import("node:fs/promises")).readFile(
      path.join(repoCacheRoot(repoRoot), "repo-meta.json"),
      "utf8"
    ));
    assert.equal(cleared.jdtlsPid, undefined, "an explicit undefined clears the field");
    assert.equal(cleared.repoHash, "rh", "unrelated fields are untouched by the clear");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    // touchRepoCache resolves its own cache directory from repoCacheRoot(),
    // independent of the fake repoRoot removed above.
    await rm(repoCacheRoot(repoRoot), { recursive: true, force: true });
  }
});

async function writeMeta(cacheBase: string, name: string, meta: Record<string, unknown>): Promise<void> {
  const dir = path.join(cacheBase, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "repo-meta.json"), `${JSON.stringify({ schemaVersion: 1, ...meta }, null, 2)}\n`);
}
