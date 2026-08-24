import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { leaseFamilyKey, resolveWorktreeIdentity, WorktreeIdentityCache } from "./worktree-identity.js";
import { canonicalPath } from "./path-utils.js";
import { createGitWorktreeFamily } from "./test-support/git-worktree.test.js";

test("a non-Git directory yields repoRoot/repoHash only", async () => {
  const dir = canonicalPath(mkdtempSync(path.join(tmpdir(), "wt-plain-")));
  const identity = await resolveWorktreeIdentity(dir);
  assert.equal(identity.repoRoot, dir);
  assert.equal(typeof identity.repoHash, "string");
  assert.equal(identity.gitCommonDir, undefined);
  assert.equal(identity.familyHash, undefined);
  assert.equal(identity.isLinkedWorktree, false);
});

test("the primary checkout has gitDir === gitCommonDir and is not linked", async () => {
  const fixture = await createGitWorktreeFamily();
  const primary = await resolveWorktreeIdentity(fixture.primary);
  assert.equal(primary.isLinkedWorktree, false);
  assert.equal(primary.gitDir, primary.gitCommonDir);
  assert.equal(typeof primary.familyHash, "string");
});

test("linked worktrees share familyHash but retain distinct repoHash", async () => {
  const fixture = await createGitWorktreeFamily();
  const primary = await resolveWorktreeIdentity(fixture.primary);
  const linked = await resolveWorktreeIdentity(fixture.linked);
  assert.notEqual(primary.repoRoot, linked.repoRoot);
  assert.notEqual(primary.repoHash, linked.repoHash);
  assert.equal(primary.gitCommonDir, linked.gitCommonDir);
  assert.equal(primary.familyHash, linked.familyHash);
  assert.equal(linked.isLinkedWorktree, true);
});

test("leaseFamilyKey falls back to repoHash for a non-Git directory", async () => {
  const dir = canonicalPath(mkdtempSync(path.join(tmpdir(), "wt-plain-")));
  const identity = await resolveWorktreeIdentity(dir);
  assert.equal(leaseFamilyKey(identity), identity.repoHash);
});

test("leaseFamilyKey uses the shared familyHash for linked worktrees, not their distinct repoHash", async () => {
  const fixture = await createGitWorktreeFamily();
  const primary = await resolveWorktreeIdentity(fixture.primary);
  const linked = await resolveWorktreeIdentity(fixture.linked);
  assert.equal(leaseFamilyKey(primary), leaseFamilyKey(linked));
  assert.equal(leaseFamilyKey(primary), primary.familyHash);
  assert.notEqual(leaseFamilyKey(primary), primary.repoHash);
});

test("the identity cache resolves a root once and can be invalidated", async () => {
  const fixture = await createGitWorktreeFamily();
  const cache = new WorktreeIdentityCache();
  const first = cache.resolve(fixture.primary);
  const second = cache.resolve(fixture.primary);
  assert.equal(first, second, "same in-flight promise is shared");
  await first;
  cache.invalidate(fixture.primary);
  const third = cache.resolve(fixture.primary);
  assert.notEqual(first, third, "invalidate forces a fresh resolution");
  assert.equal((await third).repoHash, (await first).repoHash);
});
