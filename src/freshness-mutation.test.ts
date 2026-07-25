import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import { SourceIndex } from "./source-index.js";
import { probeLayout } from "./layout-probe.js";
import { canonicalPath } from "./path-utils.js";
import type { RepoChangeBatch } from "./repo-generation.js";
import type { ImpactOptions } from "./agent-types.js";

function buildRepo(): { root: string; anchor: string; oldFile: string } {
  const root = canonicalPath(mkdtempSync(path.join(tmpdir(), "freshness-mut-")));
  const javaDir = path.join(root, "src", "main", "java", "demo");
  mkdirSync(javaDir, { recursive: true });
  writeFileSync(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(javaDir, "DemoController.java");
  const oldFile = path.join(javaDir, "OldService.java");
  writeFileSync(anchor, [
    "package demo;",
    "public class DemoController {",
    "  private OldService service;",
    "}"
  ].join("\n"));
  writeFileSync(oldFile, "package demo;\npublic class OldService {}\n");
  return { root, anchor, oldFile };
}

function fakeSession() {
  return {
    cacheStatus: () => ({ enabled: true, entries: 0, hits: 0, misses: 0, invalidations: 0 }),
    status: () => ({ state: "NEW", started: false, progress: { active: 0 } }),
    drainPhaseMetrics: () => ({}),
    ensureStarted: async () => {},
    invalidateForRepoChanges: () => {}
  };
}

function impactOptions(root: string, anchor: string): ImpactOptions {
  return {
    anchors: [{ file: path.relative(root, anchor), line: 2, column: 14 }],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1000,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    verbosity: "diagnostic"
  };
}

/**
 * These two are regression guards: Task 10's onBatch wiring
 * (SourceIndex.applyChanges -> removeFiles for JAVA_DELETE) already made
 * rename/delete eviction work end to end. They stay red if that wiring
 * regresses.
 */
test("a rename evicts the old path so the router stops surfacing it", async () => {
  const { root, anchor, oldFile } = buildRepo();
  const sourceIndex = new SourceIndex(root);
  const router = new AgentRouter(root, fakeSession() as never, sourceIndex);
  sourceIndex.factsFor(anchor);
  sourceIndex.factsFor(oldFile);

  const newFile = oldFile.replace("OldService", "NewService");
  renameSync(oldFile, newFile);
  writeFileSync(newFile, "package demo;\npublic class NewService {}\n");

  const batch: RepoChangeBatch = {
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [
      { kind: "JAVA_DELETE", absolutePath: oldFile },
      { kind: "JAVA_ADD", absolutePath: newFile }
    ],
    storm: false,
    affectedRoots: []
  };
  sourceIndex.applyChanges(batch);
  router.onRepoChanged(batch);

  assert.equal(sourceIndex.findTypeDefinitions(["OldService"]).length, 0, "the old type is unindexed");
  const result = await router.impact(impactOptions(root, anchor));
  assert.equal(
    JSON.stringify(result).includes("OldService.java"),
    false,
    "the renamed-away path no longer appears in impact output"
  );
});

test("a delete evicts the old path from the type index", async () => {
  const { root, oldFile } = buildRepo();
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(oldFile);
  assert.equal(sourceIndex.findTypeDefinitions(["OldService"]).length, 1, "indexed before deletion");

  rmSync(oldFile);
  const batch: RepoChangeBatch = {
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [{ kind: "JAVA_DELETE", absolutePath: oldFile }],
    storm: false,
    affectedRoots: []
  };
  sourceIndex.applyChanges(batch);

  assert.equal(sourceIndex.findTypeDefinitions(["OldService"]).length, 0, "the deleted file's own definition is unindexed");
});

/**
 * The genuinely new coverage: a delete that lands while the watcher is down
 * (WATCHER_DEGRADED, or simply before start()) never produces a batch, so
 * nothing ever calls removeFiles. The type-name/index lookups do not check
 * existsSync, so the ghost entry survives reads until reconcile() runs.
 */
test("reconcile evicts a file deleted while no batch was ever delivered", async () => {
  const { root, oldFile } = buildRepo();
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(oldFile);
  assert.equal(sourceIndex.findTypeDefinitions(["OldService"]).length, 1, "indexed before deletion");

  rmSync(oldFile);

  assert.equal(
    sourceIndex.findTypeDefinitions(["OldService"]).length,
    1,
    "a stale index entry survives an unreported delete until reconcile runs"
  );

  await sourceIndex.reconcile(probeLayout(root), 1);

  assert.equal(
    sourceIndex.findTypeDefinitions(["OldService"]).length,
    0,
    "reconcile evicts the ghost entry"
  );
});

test("reconcile does not evict entries when the repo has no detected source roots", async () => {
  // A flat-layout repo (no src/main/java) must not have its whole index wiped
  // by the out-of-root eviction rule; only !existsSync eviction applies.
  const root = canonicalPath(mkdtempSync(path.join(tmpdir(), "freshness-mut-flat-")));
  writeFileSync(path.join(root, "Solo.java"), "public class Solo {}\n");
  const sourceIndex = new SourceIndex(root);
  const solo = path.join(root, "Solo.java");
  sourceIndex.factsFor(solo);
  const layout = probeLayout(root);
  assert.equal(layout.sourceRoots.length, 0, "flat-layers repo detects no source roots");

  await sourceIndex.reconcile(layout, 1);

  assert.equal(sourceIndex.findTypeDefinitions(["Solo"]).length, 1, "the still-existing file survives reconcile");
});
