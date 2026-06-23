import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";

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

async function writeMeta(cacheBase: string, name: string, meta: Record<string, unknown>): Promise<void> {
  const dir = path.join(cacheBase, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "repo-meta.json"), `${JSON.stringify({ schemaVersion: 1, ...meta }, null, 2)}\n`);
}
