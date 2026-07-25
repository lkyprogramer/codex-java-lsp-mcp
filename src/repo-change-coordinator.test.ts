import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRepoWatchPlan,
  isIgnoredRepoPath,
  RepoChangeCoordinator
} from "./repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { probeLayout, type LayoutContext } from "./layout-probe.js";
import { LayoutManager, type LayoutSource } from "./layout-manager.js";
import { canonicalPath } from "./path-utils.js";
import type { WorktreeIdentity } from "./worktree-identity.js";
import { createGitWorktreeFamily } from "./test-support/git-worktree.js";

function repo(): { root: string; layout: LayoutContext } {
  const root = canonicalPath(mkdtempSync(path.join(tmpdir(), "coord-")));
  mkdirSync(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  mkdirSync(path.join(root, "src", "main", "resources"), { recursive: true });
  mkdirSync(path.join(root, "target", "generated-sources", "annotations", "demo"), { recursive: true });
  writeFileSync(path.join(root, "pom.xml"), "<project></project>\n");
  writeFileSync(path.join(root, "src", "main", "java", "demo", "A.java"), "class A {}\n");
  return { root, layout: probeLayout(root) };
}

function staticLayoutSource(layout: LayoutContext): LayoutSource {
  return {
    current: () => layout,
    refresh: () => ({ changed: false, layout })
  };
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

test("watch plan unions source/resource/generated roots and exact build markers", () => {
  const { root, layout } = repo();
  const plan = buildRepoWatchPlan(root, layout);
  assert.ok(plan.sourceRoots.some(item => item.endsWith(path.join("src", "main", "java"))));
  assert.ok(plan.resourceRoots.some(item => item.endsWith(path.join("src", "main", "resources"))));
  assert.ok(plan.generatedRoots.some(item => item.endsWith(path.join("target", "generated-sources", "annotations"))));
  assert.ok(plan.buildFiles.includes(path.join(root, "pom.xml")));
  assert.equal(plan.targets.length, new Set(plan.targets).size, "targets are unique");
});

test("ignore contract suppresses git/cache/build-output but not an allowlisted generated root", () => {
  const { root } = repo();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const generated = path.join(root, "target", "generated-sources", "annotations");
  const identity = identityFor(root, path.join(root, ".git"));

  assert.equal(isIgnoredRepoPath(path.join(root, ".git"), identity, cacheBase, [generated]), true);
  assert.equal(isIgnoredRepoPath(path.join(root, ".git", "HEAD"), identity, cacheBase, [generated]), true);
  assert.equal(isIgnoredRepoPath(path.join(cacheBase, "x"), identity, cacheBase, [generated]), true);
  for (const segment of [".gradle", "build", "target", "out", "bin", "node_modules", "dist"]) {
    assert.equal(
      isIgnoredRepoPath(path.join(root, segment, "X.java"), identity, cacheBase, []),
      true,
      `${segment} must be ignored`
    );
  }
  // A generated file under the allowlisted root is NOT ignored even though
  // "target" is normally an ignored segment.
  assert.equal(
    isIgnoredRepoPath(path.join(generated, "demo", "Gen.java"), identity, cacheBase, [generated]),
    false
  );
});

test("a linked-worktree .git file and common-dir are ignored", async () => {
  const fixture = await createGitWorktreeFamily();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const identity: WorktreeIdentity = {
    repoRoot: fixture.linked,
    repoHash: "linked",
    gitCommonDir: path.join(fixture.primary, ".git"),
    familyHash: "family",
    isLinkedWorktree: true
  };
  assert.equal(isIgnoredRepoPath(path.join(fixture.linked, ".git"), identity, cacheBase, []), true);
  assert.equal(isIgnoredRepoPath(path.join(fixture.primary, ".git", "worktrees"), identity, cacheBase, []), true);
});

async function coordinatorFor(): Promise<{ coordinator: RepoChangeCoordinator; clock: GenerationClock; root: string; batches: RepoChangeBatch[] }> {
  const { root, layout } = repo();
  const clock = new GenerationClock();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const coordinator = new RepoChangeCoordinator(root, identityFor(root), cacheBase, clock, staticLayoutSource(layout));
  const batches: RepoChangeBatch[] = [];
  coordinator.onBatch(batch => { batches.push(batch); });
  return { coordinator, clock, root, batches };
}

test("a queued event stays debounced until flushNow advances the generation once", async () => {
  const { coordinator, clock, root, batches } = await coordinatorFor();
  coordinator.queueForTest({ kind: "JAVA_CHANGE", absolutePath: path.join(root, "src/main/java/demo/A.java") });
  assert.equal(clock.snapshot().value, 1, "still debounced");
  await coordinator.flushNow();
  assert.equal(clock.snapshot().value, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].changes.length, 1);
});

test("classification maps java/resource/build events and ignores the rest", async () => {
  const { coordinator, clock, root, batches } = await coordinatorFor();
  coordinator.queueFsPathForTest(path.join(root, "src/main/java/demo/A.java"), "add");
  coordinator.queueFsPathForTest(path.join(root, "src/main/resources/mapper.xml"), "change");
  coordinator.queueFsPathForTest(path.join(root, "pom.xml"), "change");
  coordinator.queueFsPathForTest(path.join(root, "README.md"), "change");
  coordinator.queueFsPathForTest(path.join(root, "build", "out.java"), "add");
  await coordinator.flushNow();
  assert.equal(batches.length, 1);
  const kinds = batches[0].changes.map(change => change.kind).sort();
  assert.deepEqual(kinds, ["BUILD_CHANGE", "JAVA_ADD", "RESOURCE_CHANGE"]);
});

test("a listener exception marks the clock dirty and still runs later listeners", async () => {
  const { coordinator, clock, root } = await coordinatorFor();
  let secondRan = false;
  coordinator.onBatch(() => { throw new Error("listener boom"); });
  coordinator.onBatch(() => { secondRan = true; });
  coordinator.queueForTest({ kind: "JAVA_CHANGE", absolutePath: path.join(root, "src/main/java/demo/A.java") });
  await coordinator.flushNow();
  assert.equal(secondRan, true);
  assert.equal(clock.snapshot().dirty, true);
});

test("a BUILD_CHANGE reconfigures the watch plan so a newly added module's source root is recognized", async () => {
  const { root } = repo();
  const clock = new GenerationClock();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const layoutManager = new LayoutManager(root);
  const coordinator = new RepoChangeCoordinator(root, identityFor(root), cacheBase, clock, layoutManager);
  const batches: RepoChangeBatch[] = [];
  coordinator.onBatch(batch => { batches.push(batch); });

  const moduleDir = path.join(root, "moduleA");
  mkdirSync(path.join(moduleDir, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(moduleDir, "pom.xml"), "<project></project>\n");
  const newJavaFile = path.join(moduleDir, "src", "main", "java", "demo", "New.java");
  writeFileSync(newJavaFile, "package demo;\nclass New {}\n");

  // Classified against the still-stale (pre-module) plan in the same round as
  // the BUILD_CHANGE: the reconfigure runs during this flush, too late for an
  // event that was already classified at queue time.
  coordinator.queueFsPathForTest(newJavaFile, "add");
  coordinator.queueForTest({ kind: "BUILD_CHANGE", absolutePath: path.join(root, "pom.xml") });
  await coordinator.flushNow();
  assert.equal(batches.length, 1);
  assert.equal(
    batches[0].changes.some(change => change.absolutePath === newJavaFile),
    false,
    "not classified yet under the stale plan"
  );
  assert.equal(clock.snapshot().dirty, true, "a layout-changing build event marks the runtime dirty for reconcile");

  // A fresh event after the reconfigure now classifies under the new plan.
  coordinator.queueFsPathForTest(newJavaFile, "add");
  await coordinator.flushNow();
  assert.equal(batches.length, 2);
  assert.ok(
    batches[1].changes.some(change => change.kind === "JAVA_ADD" && change.absolutePath === newJavaFile),
    "after reconfigure, the new module's source root is watched"
  );
});

test("the coordinator watches real edits and advances generation without JDT", async () => {
  const { root, layout } = repo();
  const clock = new GenerationClock();
  const cacheBase = canonicalPath(mkdtempSync(path.join(tmpdir(), "cache-")));
  const coordinator = new RepoChangeCoordinator(root, identityFor(root), cacheBase, clock, staticLayoutSource(layout), 20);
  await coordinator.start();
  const target = path.join(root, "src/main/java/demo/B.java");
  try {
    // macOS fsevents can miss an edit that lands in the brief window after
    // "ready" but before the backend is fully armed. Re-touch until observed.
    const deadline = Date.now() + 5000;
    let attempt = 0;
    while (clock.snapshot().value === 1 && Date.now() < deadline) {
      writeFileSync(target, `class B { int v = ${attempt}; }\n`);
      attempt += 1;
      await new Promise(resolve => setTimeout(resolve, 150));
      await coordinator.flushNow();
    }
    assert.ok(clock.snapshot().value > 1, "a real edit advanced the generation");
  } finally {
    await coordinator.close();
  }
});
