import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertProgressiveCanonicalPaths,
  assertProgressivePaths,
  parseProgressiveCli,
  selectProgressiveScenario
} from "./run-progressive-index.mjs";

test("progressive CLI requires isolated state paths and exact inputs", () => {
  const cli = parseProgressiveCli([
    "--repo-root", "/tmp/repo",
    "--project-id", "demo",
    "--scenario-lock", "/tmp/scenarios.json",
    "--index-cache-dir", "/tmp/state/cache",
    "--output", "/tmp/state/result.json"
  ]);
  assert.equal(cli.projectId, "demo");
  assertProgressivePaths("/tmp/repo", "/tmp/state/cache", "/tmp/state/result.json");
  assert.throws(() => assertProgressivePaths("/tmp/repo", "/tmp/repo/.cache", "/tmp/state/result.json"));
  assert.throws(() => assertProgressivePaths("/tmp/repo", "/tmp/state", "/tmp/state/result.json"));
  assert.throws(() => parseProgressiveCli(["--repo-root", "/tmp/repo"]));
});

test("progressive canonical paths reject an external symlink into the Java repository", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progressive-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await Promise.all([mkdir(path.join(repo, "hidden-cache"), { recursive: true }), mkdir(state)]);
  await symlink(path.join(repo, "hidden-cache"), path.join(state, "cache-link"));
  await assert.rejects(
    () => assertProgressiveCanonicalPaths(repo, path.join(state, "cache-link"), path.join(state, "result.json")),
    /resolves inside/
  );
});

test("scenario lock selects exactly one exact-commit project contract", () => {
  const scenario = {
    projectId: "demo",
    repoCommit: "a".repeat(40),
    anchorScenarioId: "anchor",
    anchor: { file: "src/A.java", line: 1, column: 1 },
    requiredTypeDefinitions: [{ typeText: "demo.B", expectedFile: "src/B.java" }],
    missingTypeFqn: "missing.Type"
  };
  assert.equal(selectProgressiveScenario({ schemaVersion: 1, scenarios: [scenario] }, "demo"), scenario);
  assert.throws(() => selectProgressiveScenario({ schemaVersion: 1, scenarios: [] }, "demo"));
  assert.throws(() => selectProgressiveScenario({
    schemaVersion: 1,
    scenarios: [{ ...scenario, repoCommit: "HEAD" }]
  }, "demo"));
});
