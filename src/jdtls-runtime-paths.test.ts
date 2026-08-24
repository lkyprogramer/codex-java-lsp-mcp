import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveJdtlsRuntimePaths } from "./jdtls-session.js";
import { repoHash } from "./path-utils.js";
import { createGitWorktreeFamily } from "./test-support/git-worktree.test.js";

test("sibling worktrees receive independent JDT dataDir and logDir paths", async () => {
  const fixture = await createGitWorktreeFamily();
  const env = {
    HOME: "/tmp/v4-09-home",
    JAVA_LSP_CACHE_ROOT: "/tmp/v4-09-cache"
  };
  const primary = resolveJdtlsRuntimePaths(fixture.primary, "stdio", env);
  const linked = resolveJdtlsRuntimePaths(fixture.linked, "stdio", env);

  assert.notEqual(primary.dataDir, linked.dataDir);
  assert.notEqual(primary.logDir, linked.logDir);
  assert.notEqual(primary.cacheRoot, linked.cacheRoot);
  assert.equal(primary.dataDir.endsWith(path.join(repoHash(fixture.primary), "workspace")), true);
  assert.equal(linked.dataDir.endsWith(path.join(repoHash(fixture.linked), "workspace")), true);
});

test("an explicit JDTLS_DATA_DIR still suffixes each worktree hash so workspaces cannot be reused across siblings", async () => {
  const fixture = await createGitWorktreeFamily();
  const env = {
    HOME: "/tmp/v4-09-home",
    JDTLS_DATA_DIR: "/tmp/v4-09-shared-jdt"
  };
  const primary = resolveJdtlsRuntimePaths(fixture.primary, "stdio", env);
  const linked = resolveJdtlsRuntimePaths(fixture.linked, "stdio", env);

  assert.equal(primary.dataDir, path.join("/tmp/v4-09-shared-jdt", repoHash(fixture.primary)));
  assert.equal(linked.dataDir, path.join("/tmp/v4-09-shared-jdt", repoHash(fixture.linked)));
  assert.notEqual(primary.dataDir, linked.dataDir);
});

test("the dataDir key is the worktree cache identity, not a JDT version or build fingerprint", () => {
  const env = {
    HOME: "/tmp/v4-09-home",
    JAVA_LSP_CACHE_ROOT: "/tmp/v4-09-cache"
  };
  const first = resolveJdtlsRuntimePaths("/repo/one", "stdio", env);
  const second = resolveJdtlsRuntimePaths("/repo/one", "stdio", {
    ...env,
    JDTLS_BIN: "/opt/other/jdtls-1.99.0"
  });
  assert.equal(first.dataDir, second.dataDir);
  assert.equal(first.dataDir.includes("1.99.0"), false);
});
