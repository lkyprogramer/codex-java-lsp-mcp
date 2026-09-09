import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adjudicateRuoyiObservation,
  assertIndexCachePopulated,
  F1_INDEX_SNAPSHOT,
  F1_INDEX_SQLITE,
  F1_TOKEN_DROP_GATE,
  f1BenchmarkEnvironment,
  indexStatusSummary,
  inspectIndexCache,
  materializeRuntimeWithNodeModules,
  metricsFromBenchmark,
  prepareIndexCacheDir,
  qualityIdentity,
  tokenDrop,
  writeTuningScenarioJsonl
} from "./run-f1-ruoyi-observation.mjs";

test("F1 ruoyi observation drops holdout rows unread", () => {
  const jsonl = [
    JSON.stringify({ id: "tune-1", evaluationSplit: "tuning", golden: { mustHit: ["a.java"] } }),
    JSON.stringify({ id: "hold-secret", evaluationSplit: "holdout", golden: { mustHit: ["secret.java"] } }),
    JSON.stringify({ id: "tune-2", evaluationSplit: "tuning", golden: { mustHit: ["b.java"] } })
  ].join("\n");
  const filtered = writeTuningScenarioJsonl(jsonl);
  assert.equal(filtered.tuningCount, 2);
  assert.equal(filtered.holdoutSkipped, 1);
  assert.equal(filtered.jsonl.includes("hold-secret"), false);
  assert.equal(filtered.jsonl.includes("secret.java"), false);
});

test("quality identity is bit-identical and treats missing old RangeLineRecall as unmeasured", () => {
  const oldMetrics = { recall: 0.5, pRead: 0.4, rReadMust: 0.6, RangeLineRecall: null };
  const newMetrics = { recall: 0.5, pRead: 0.4, rReadMust: 0.6, RangeLineRecall: 0.9 };
  const identity = qualityIdentity(oldMetrics, newMetrics);
  assert.equal(identity.identical, true);
  assert.deepEqual(identity.unmeasured, ["RangeLineRecall"]);
  assert.equal(qualityIdentity({ ...oldMetrics, recall: 0.51 }, newMetrics).identical, false);
});

test("token drop gate is 20% relative", () => {
  assert.equal(F1_TOKEN_DROP_GATE, 0.2);
  assert.equal(tokenDrop(1000, 800).pass, true);
  assert.equal(tokenDrop(1000, 801).pass, false);
  assert.equal(tokenDrop(0, 0).pass, false);
});

test("adjudication prefers the identity sentinel over token", () => {
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: false, diffs: [{ metric: "recall", old: 1, new: 0.9 }] },
    token: { pass: true }
  }), "QUALITY_IDENTITY_FAIL");
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: true, diffs: [] },
    token: { pass: false }
  }), "TOKEN_FAIL");
  assert.equal(adjudicateRuoyiObservation({
    identity: { identical: true, diffs: [] },
    token: { pass: true }
  }), "GO");
});

test("metricsFromBenchmark reads totals and does not invent TaskSuccess", () => {
  const metrics = metricsFromBenchmark({
    totals: { recall: 0.7, pRead: 0.5, rReadMust: 0.8, RangeLineRecall: 0.9, estimatedTokensP50: 1200 },
    rows: [{ id: "a" }, { id: "b" }]
  });
  assert.equal(metrics.scenarios, 2);
  assert.equal(metrics.estimatedTokensP50, 1200);
  assert.equal(metrics.recall, 0.7);
});

test("index cache helpers mkdir and refuse an empty old/new cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f1-index-cache-"));
  const cacheDir = path.join(root, "old-cache");
  await prepareIndexCacheDir(cacheDir);
  const empty = await inspectIndexCache(cacheDir);
  assert.equal(empty.populated, false);
  assert.equal(empty.sqliteBytes, 0);
  assert.equal(empty.snapshotBytes, 0);
  assert.throws(() => assertIndexCachePopulated(empty, "old"), /old --index-cache-dir is empty/);

  await writeFile(path.join(cacheDir, F1_INDEX_SNAPSHOT), "gz");
  const snapshot = await inspectIndexCache(cacheDir);
  assert.equal(snapshot.populated, true);
  assert.equal(snapshot.snapshotBytes, 2);
  assert.equal(assertIndexCachePopulated(snapshot, "old"), snapshot);

  const sqlDir = path.join(root, "new-cache");
  await mkdir(sqlDir, { recursive: true });
  await writeFile(path.join(sqlDir, F1_INDEX_SQLITE), "db");
  const sqlite = await inspectIndexCache(sqlDir);
  assert.equal(sqlite.populated, true);
  assert.equal(sqlite.sqliteBytes, 2);
});

test("old F1 arm enables the heap cold-build child; new arm does not", () => {
  const env = { JAVA_LSP_ISOLATED_VALIDATION: "1" };
  assert.equal(f1BenchmarkEnvironment("old", env).JAVA_LSP_COLD_BUILD_CHILD, "1");
  assert.equal(f1BenchmarkEnvironment("new", env).JAVA_LSP_COLD_BUILD_CHILD, undefined);
});

test("materializeRuntimeWithNodeModules copies dist and binds isolated node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f1-runtime-overlay-"));
  const runtimeRoot = path.join(root, "old-runtime");
  const modules = path.join(root, "isolated-modules");
  const dest = path.join(root, "overlay");
  await mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "node_modules", "tree-sitter"), { recursive: true });
  await mkdir(path.join(runtimeRoot, ".git"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "dist", "benchmark.js"), "ok");
  await writeFile(path.join(runtimeRoot, "node_modules", "tree-sitter", "missing-native"), "bad");
  await writeFile(path.join(runtimeRoot, ".git", "HEAD"), "ref");
  await mkdir(path.join(modules, "tree-sitter", "build"), { recursive: true });
  await writeFile(path.join(modules, "tree-sitter", "build", "Release.node"), "native");
  const materialized = await materializeRuntimeWithNodeModules(runtimeRoot, modules, dest);
  assert.equal(materialized, dest);
  const linked = await lstat(path.join(dest, "node_modules"));
  assert.equal(linked.isSymbolicLink(), true);
  assert.equal(path.resolve(dest, await readlink(path.join(dest, "node_modules"))), modules);
  assert.equal(await readFile(path.join(dest, "dist", "benchmark.js"), "utf8"), "ok");
  await assert.rejects(() => lstat(path.join(dest, ".git")), { code: "ENOENT" });
  await assert.rejects(() => lstat(path.join(dest, "node_modules", "tree-sitter", "missing-native")), { code: "ENOENT" });
});

test("indexStatusSummary reads prepareJavaIndexStatus without inventing files", () => {
  assert.equal(indexStatusSummary({}), null);
  const summary = indexStatusSummary({
    metadata: {
      prepareJavaIndexStatus: {
        state: "READY",
        files: 12,
        snapshotBytes: 4096,
        coverage: [{ root: "a" }, { root: "b" }],
        pendingBackground: 0
      }
    }
  });
  assert.equal(summary.state, "READY");
  assert.equal(summary.files, 12);
  assert.equal(summary.snapshotBytes, 4096);
  assert.equal(summary.coverageRoots, 2);
});
