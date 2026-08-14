import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { canonicalPath } from "./path-utils.js";
import {
  RepoOwnershipManager,
  processStartIdentityForPid,
  type RepoOwnershipLease
} from "./repo-ownership-lease.js";
import { cleanupStaleWorktreeCaches, touchRepoCache } from "./worktree-cache-cleanup.js";
import { repoCacheRoot } from "./repo-layout.js";

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

test("cleanupStaleWorktreeCaches protects retained roots and live cross-process ownership", async t => {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-protected-"));
  const ownershipBase = path.join(cacheBase, ".ownership");
  const retainedRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-retained-root-"));
  const ownedRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-owned-root-"));
  t.after(() => Promise.all([
    rm(cacheBase, { recursive: true, force: true }),
    rm(retainedRoot, { recursive: true, force: true }),
    rm(ownedRoot, { recursive: true, force: true })
  ]));
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  await writeMeta(cacheBase, "retained", {
    repoRoot: retainedRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  await writeMeta(cacheBase, "owned", {
    repoRoot: ownedRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  const owner = new RepoOwnershipManager({
    baseDir: ownershipBase,
    transport: "streamable_http",
    buildSha: "cleanup-test"
  }).acquire(ownedRoot);

  const protectedResult = cleanupStaleWorktreeCaches({
    cacheBase,
    ownershipBase,
    now,
    protectedRepoRoots: new Set([retainedRoot])
  });
  assert.equal(protectedResult.removed, 0);
  assert.equal(existsSync(path.join(cacheBase, "retained")), true);
  assert.equal(existsSync(path.join(cacheBase, "owned")), true);

  owner.release();
  const releasedResult = cleanupStaleWorktreeCaches({ cacheBase, ownershipBase, now });
  assert.equal(releasedResult.removed, 2);
});

test("cleanupStaleWorktreeCaches honors JAVA_LSP_OWNERSHIP_BASE when cacheBase is explicit", async t => {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-env-owner-cache-"));
  const ownershipBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-env-owner-locks-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-env-owner-root-"));
  const previous = process.env.JAVA_LSP_OWNERSHIP_BASE;
  process.env.JAVA_LSP_OWNERSHIP_BASE = ownershipBase;
  t.after(async () => {
    if (previous === undefined) delete process.env.JAVA_LSP_OWNERSHIP_BASE;
    else process.env.JAVA_LSP_OWNERSHIP_BASE = previous;
    await Promise.all([
      rm(cacheBase, { recursive: true, force: true }),
      rm(ownershipBase, { recursive: true, force: true }),
      rm(repoRoot, { recursive: true, force: true })
    ]);
  });
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  await writeMeta(cacheBase, "owned", {
    repoRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  const owner = new RepoOwnershipManager({
    transport: "streamable_http",
    buildSha: "env-owner-test"
  }).acquire(repoRoot);

  const protectedResult = cleanupStaleWorktreeCaches({ cacheBase, now });
  assert.equal(protectedResult.removed, 0);
  assert.equal(existsSync(path.join(cacheBase, "owned")), true);

  owner.release();
  const releasedResult = cleanupStaleWorktreeCaches({ cacheBase, now });
  assert.equal(releasedResult.removed, 1);
});

test("cleanupStaleWorktreeCaches does not treat a reused PID as a live JDT without matching identity", async t => {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-pid-reuse-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-pid-reuse-root-"));
  t.after(() => Promise.all([
    rm(cacheBase, { recursive: true, force: true }),
    rm(repoRoot, { recursive: true, force: true })
  ]));
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  await writeMeta(cacheBase, "stale-reused-pid", {
    repoRoot,
    isGitWorktree: true,
    jdtlsPid: process.pid,
    jdtlsProcessStartIdentity: "ps:some-other-process-start",
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  await mkdir(path.join(cacheBase, "stale-reused-pid", "workspace", ".metadata"), { recursive: true });
  await writeFile(path.join(cacheBase, "stale-reused-pid", "workspace", ".metadata", ".lock"), "stale\n");

  const result = cleanupStaleWorktreeCaches({ cacheBase, now });
  assert.equal(result.removed, 1);
});

test("cleanupStaleWorktreeCaches reports delete and ownership release failures", async t => {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-failures-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-failure-root-"));
  t.after(() => Promise.all([
    rm(cacheBase, { recursive: true, force: true }),
    rm(repoRoot, { recursive: true, force: true })
  ]));
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  await writeMeta(cacheBase, "stale", {
    repoRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  const failures: Array<{ phase: string; repoRoot: string; cacheRoot: string; lockPath: string }> = [];
  const lease: RepoOwnershipLease = {
    metadata: {
      schemaVersion: 1,
      repoRoot,
      ownerToken: "janitor-test",
      pid: process.pid,
      processStartIdentity: processStartIdentityForPid(process.pid) || `pid-only:${process.pid}`,
      transport: "stdio",
      buildSha: "cache-janitor",
      acquiredAt: new Date().toISOString()
    },
    lockPath: path.join(cacheBase, ".ownership", "test.lock"),
    release() {
      throw new Error("release failed");
    }
  };

  const result = cleanupStaleWorktreeCaches({
    cacheBase,
    now,
    ownership: { acquire: () => lease },
    removeCacheRoot: () => { throw new Error("delete failed"); },
    reportFailure: failure => failures.push(failure)
  });

  assert.equal(result.removed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures, 2);
  assert.deepEqual(failures.map(failure => failure.phase), ["delete", "release"]);
  assert.ok(failures.every(failure => failure.repoRoot === canonicalPath(repoRoot)));
  assert.ok(failures.every(failure => failure.cacheRoot === path.join(cacheBase, "stale")));
  assert.ok(failures.every(failure => failure.lockPath === lease.lockPath));
});

test("cleanupStaleWorktreeCaches reclaims a dead owner but fails closed on unreadable ownership", async t => {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-owner-state-"));
  const ownershipBase = path.join(cacheBase, ".ownership");
  const deadRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-dead-owner-root-"));
  const unknownRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-unknown-owner-root-"));
  t.after(async () => {
    await Promise.all([
      rm(cacheBase, { recursive: true, force: true }),
      rm(deadRoot, { recursive: true, force: true }),
      rm(unknownRoot, { recursive: true, force: true })
    ]);
  });
  const now = Date.parse("2026-06-21T00:00:00.000Z");
  await writeMeta(cacheBase, "dead-owner", {
    repoRoot: deadRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  await writeMeta(cacheBase, "unknown-owner", {
    repoRoot: unknownRoot,
    isGitWorktree: true,
    updatedAt: new Date(now - 3 * 86400000).toISOString()
  });
  new RepoOwnershipManager({
    baseDir: ownershipBase,
    transport: "stdio",
    buildSha: "dead-owner",
    pid: 2147483647,
    processStartIdentity: "ps:dead-owner"
  }).acquire(deadRoot);
  const unknownManager = new RepoOwnershipManager({
    baseDir: ownershipBase,
    transport: "stdio",
    buildSha: "unknown-owner"
  });
  await mkdir(unknownManager.lockPath(unknownRoot), { recursive: true });
  await writeFile(path.join(unknownManager.lockPath(unknownRoot), "owner.json"), "not-json\n");

  const result = cleanupStaleWorktreeCaches({ cacheBase, ownershipBase, now });
  assert.equal(result.removed, 1);
  assert.equal(existsSync(path.join(cacheBase, "dead-owner")), false);
  assert.equal(existsSync(path.join(cacheBase, "unknown-owner")), true);
});

test("touchRepoCache preserves ownership metadata and clears stopped JDT identity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-touch-cache-root-"));
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-touch-cache-base-"));
  const previous = process.env.JAVA_LSP_CACHE_BASE;
  process.env.JAVA_LSP_CACHE_BASE = cacheBase;
  t.after(async () => {
    if (previous === undefined) delete process.env.JAVA_LSP_CACHE_BASE;
    else process.env.JAVA_LSP_CACHE_BASE = previous;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cacheBase, { recursive: true, force: true })
    ]);
  });
  const ownership = {
    schemaVersion: 1 as const,
    repoRoot: root,
    ownerToken: "owner-token",
    pid: process.pid,
    processStartIdentity: processStartIdentityForPid(process.pid) || `pid-only:${process.pid}`,
    transport: "stdio" as const,
    buildSha: "test-build",
    acquiredAt: new Date(0).toISOString()
  };

  touchRepoCache(root, { ownership });
  touchRepoCache(root, {
    jdtlsPid: process.pid,
    jdtlsProcessStartIdentity: processStartIdentityForPid(process.pid)
  });
  touchRepoCache(root, { jdtlsPid: null, jdtlsProcessStartIdentity: null });
  const meta = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(
    path.join(repoCacheRoot(root), "repo-meta.json"),
    "utf8"
  ))) as Record<string, unknown>;

  assert.equal(meta.schemaVersion, 2);
  assert.equal(meta.ownerToken, "owner-token");
  assert.equal("jdtlsPid" in meta, false);
  assert.equal("jdtlsProcessStartIdentity" in meta, false);
});

async function writeMeta(cacheBase: string, name: string, meta: Record<string, unknown>): Promise<void> {
  const dir = path.join(cacheBase, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "repo-meta.json"), `${JSON.stringify({ schemaVersion: 1, ...meta }, null, 2)}\n`);
}
