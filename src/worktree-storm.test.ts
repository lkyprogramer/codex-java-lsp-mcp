import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepoChangeCoordinator } from "./repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { probeLayout, type LayoutContext } from "./layout-probe.js";
import type { LayoutSource } from "./layout-manager.js";
import { canonicalPath } from "./path-utils.js";
import type { WorktreeIdentity } from "./worktree-identity.js";
import { createGitWorktreeFamily } from "./test-support/git-worktree.js";

function repo(): { root: string; layout: LayoutContext } {
  const root = canonicalPath(mkdtempSync(path.join(tmpdir(), "storm-")));
  mkdirSync(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(root, "pom.xml"), "<project></project>\n");
  writeFileSync(path.join(root, "src", "main", "java", "demo", "A.java"), "class A {}\n");
  return { root, layout: probeLayout(root) };
}

function staticLayoutSource(layout: LayoutContext): LayoutSource {
  return { current: () => layout, refresh: () => ({ changed: false, layout }) };
}

function identityFor(root: string, gitCommonDir?: string): WorktreeIdentity {
  return {
    repoRoot: root,
    repoHash: "hash",
    gitCommonDir,
    familyHash: gitCommonDir ? "family" : undefined,
    isLinkedWorktree: false
  };
}

test("a 500-file batch is delivered as one storm with a bounded, non-empty affectedRoots list, and marks the generation dirty", async () => {
  const { root, layout } = repo();
  const clock = new GenerationClock();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const coordinator = new RepoChangeCoordinator(
    root,
    identityFor(root),
    cacheBase,
    clock,
    staticLayoutSource(layout),
    undefined,
    () => 5_000 // a well-established, already-indexed repo
  );
  const batches: RepoChangeBatch[] = [];
  coordinator.onBatch(batch => { batches.push(batch); });

  for (let index = 0; index < 500; index += 1) {
    coordinator.queueForTest({
      kind: "JAVA_CHANGE",
      absolutePath: path.join(root, "src", "main", "java", "demo", `C${index}.java`)
    });
  }
  await coordinator.flushNow();

  assert.equal(batches.length, 1, "one debounce round is delivered as one batch, storm or not");
  assert.equal(batches[0].changes.length, 500);
  assert.equal(batches[0].storm, true);
  assert.equal(clock.snapshot().value, 2, "generation still advances exactly once for the whole storm");
  assert.equal(clock.snapshot().dirty, true, "a storm reuses the existing dirty/reconcile path (Task 11)");
  assert.ok(batches[0].affectedRoots.length > 0, "the affected source root is reported");
  assert.ok(batches[0].affectedRoots.length <= 20, "the affected-root list stays bounded regardless of change count");

  const status = coordinator.status();
  assert.equal(status.lastStorm?.changeCount, 500);
  assert.ok(status.lastStorm?.affectedRoots.length, "diagnostics expose root IDs, not the 500 raw paths");
});

test("a below-threshold batch on the same repo is not treated as a storm", async () => {
  const { root, layout } = repo();
  const clock = new GenerationClock();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const coordinator = new RepoChangeCoordinator(
    root,
    identityFor(root),
    cacheBase,
    clock,
    staticLayoutSource(layout),
    undefined,
    () => 5_000
  );
  const batches: RepoChangeBatch[] = [];
  coordinator.onBatch(batch => { batches.push(batch); });

  coordinator.queueForTest({ kind: "JAVA_CHANGE", absolutePath: path.join(root, "src/main/java/demo/A.java") });
  await coordinator.flushNow();

  assert.equal(batches[0].storm, false);
  assert.deepEqual(batches[0].affectedRoots, []);
  assert.equal(clock.snapshot().dirty, false);
});

test("linked-worktree git metadata never advances Java generation, even under a large burst", async () => {
  const fixture = await createGitWorktreeFamily();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const identity: WorktreeIdentity = {
    repoRoot: fixture.linked,
    repoHash: "linked",
    gitCommonDir: path.join(fixture.primary, ".git"),
    familyHash: "family",
    isLinkedWorktree: true
  };
  const clock = new GenerationClock();
  const layout = probeLayout(fixture.linked);
  const coordinator = new RepoChangeCoordinator(fixture.linked, identity, cacheBase, clock, staticLayoutSource(layout));
  const batches: RepoChangeBatch[] = [];
  coordinator.onBatch(batch => { batches.push(batch); });

  // A rebase/checkout can rewrite hundreds of entries under .git and the
  // shared common-dir; none of them are Java changes and none may leak in.
  coordinator.queueFsPathForTest(path.join(fixture.linked, ".git"), "change");
  for (let index = 0; index < 500; index += 1) {
    coordinator.queueFsPathForTest(path.join(fixture.primary, ".git", "worktrees", "feature", `lock${index}`), "add");
  }
  await coordinator.flushNow();

  assert.equal(batches.length, 0, "no batch is ever produced for purely ignored paths");
  assert.deepEqual(clock.snapshot(), { value: 1, dirty: false });
});
