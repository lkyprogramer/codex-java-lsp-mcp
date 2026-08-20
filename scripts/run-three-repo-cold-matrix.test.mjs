import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertCleanRepository,
  assertDisjointRuntimeState,
  assertOutputOutsideSource,
  benchmarkCellArguments,
  captureCandidatePatch,
  isolatedChildEnvironment,
  matrixRuntimeEnvironment,
  parseCli,
  toCrossVersionScenarioJsonl,
  validateScenarioSet
} from "./run-three-repo-cold-matrix.mjs";
import { COMPARISON_POLICY_ENV_LOCKED } from "./verify-three-repo-cold-matrix.mjs";
import { FORMAL_REQUEST_DEADLINE_MS } from "./verify-three-repo-cold-matrix.mjs";

const exec = promisify(execFile);

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("formal matrix child processes cannot inherit Node loader or host output selectors", () => {
  const environment = isolatedChildEnvironment({
    TASK_MARKER: "yes",
    NODE_OPTIONS: "--require=/active/mutator.cjs",
    NODE_PATH: "/active/node_modules",
    NODE_V8_COVERAGE: "/active/coverage",
    NODE_COMPILE_CACHE: "/active/compile-cache",
    NODE_REDIRECT_WARNINGS: "/active/warnings.log"
  });
  assert.equal(environment.TASK_MARKER, "yes");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(environment.NODE_V8_COVERAGE, undefined);
  assert.equal(environment.NODE_COMPILE_CACHE, undefined);
  assert.equal(environment.NODE_REDIRECT_WARNINGS, undefined);
});

test("parseCli rejects removed flag campaigns and continuation", () => {
  const required = [
    "--baseline", "abc",
    "--output-dir", "/tmp/out",
    "--lishuedu", "/tmp/l",
    "--cipherlink", "/tmp/c",
    "--exam-parent-v3", "/tmp/e"
  ];
  assert.throws(
    () => parseCli([...required, "--candidate-env", "JAVA_LSP_EXAMPLE_FLAG=off"]),
    /not allowlisted|env-locked-same-tree/
  );
  assert.throws(
    () => parseCli([
      ...required,
      "--comparison-policy", "env-locked-same-tree",
      "--candidate-continue", "in-pool-fifo"
    ]),
    /removed in JIN N0/
  );
  const jin = parseCli([
    ...required,
    "--comparison-policy", "env-locked-same-tree",
    "--candidate-env", "JAVA_LSP_ENGINE=jin"
  ]);
  assert.equal(jin.newTreatment.env.JAVA_LSP_ENGINE, "jin");
  assert.equal(jin.oldTreatment.env.JAVA_LSP_ENGINE, undefined);
});

test("formal matrix scrubs inherited RPC telemetry and only accepts an explicit cell mode", () => {
  const previous = process.env.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY;
  const previousEngine = process.env.JAVA_LSP_ENGINE;
  process.env.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY = "1";
  try {
    assert.equal(isolatedChildEnvironment({ TASK_MARKER: "standard" }).JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY, undefined);
    assert.equal(
      isolatedChildEnvironment({ JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY: "0" }).JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY,
      "0"
    );
    assert.equal(
      isolatedChildEnvironment({ JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY: "1" }).JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY,
      "1"
    );
    process.env.JAVA_LSP_ENGINE = "jin";
    assert.equal(isolatedChildEnvironment({ TASK_MARKER: "standard" }).JAVA_LSP_ENGINE, undefined);
    assert.equal(isolatedChildEnvironment({ JAVA_LSP_ENGINE: "jin" }).JAVA_LSP_ENGINE, "jin");
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY;
    else process.env.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY = previous;
    if (previousEngine === undefined) delete process.env.JAVA_LSP_ENGINE;
    else process.env.JAVA_LSP_ENGINE = previousEngine;
  }
});

test("formal matrix scrubs inherited benchmark selectors and fixes the request deadline", () => {
  const previousDeadline = process.env.JAVA_LSP_BENCH_DEADLINE_MS;
  const previousPrepare = process.env.JAVA_LSP_BENCH_INDEX_PREPARE_TIMEOUT_MS;
  const previousMode = process.env.JAVA_LSP_BENCH_MODE;
  process.env.JAVA_LSP_BENCH_DEADLINE_MS = "15000";
  process.env.JAVA_LSP_BENCH_INDEX_PREPARE_TIMEOUT_MS = "999999";
  process.env.JAVA_LSP_BENCH_MODE = "recall";
  try {
    const environment = isolatedChildEnvironment({ TASK_MARKER: "formal" });
    assert.equal(environment.JAVA_LSP_BENCH_DEADLINE_MS, undefined);
    assert.equal(environment.JAVA_LSP_BENCH_INDEX_PREPARE_TIMEOUT_MS, undefined);
    assert.equal(environment.JAVA_LSP_BENCH_MODE, undefined);
    assert.equal(FORMAL_REQUEST_DEADLINE_MS, 2_000);
    const args = benchmarkCellArguments({
      runtimeRoot: "/private/runtime",
      repoRoot: "/private/repo",
      project: "lishuedu",
      scenarioFile: "/private/scenarios.jsonl",
      cacheDir: "/private/cache",
      runs: 5,
      verbosity: "standard"
    });
    assert.equal(args[args.indexOf("--deadline-ms") + 1], "2000");
    assert.equal(args[args.indexOf("--mode") + 1], "balanced");
    assert.equal(args[args.indexOf("--semantic-policy") + 1], "fast");
  } finally {
    restoreEnvironment("JAVA_LSP_BENCH_DEADLINE_MS", previousDeadline);
    restoreEnvironment("JAVA_LSP_BENCH_INDEX_PREPARE_TIMEOUT_MS", previousPrepare);
    restoreEnvironment("JAVA_LSP_BENCH_MODE", previousMode);
  }
});

test("standard and diagnostic matrices use disjoint private runtime state", () => {
  const standard = matrixRuntimeEnvironment("/tmp/v32-standard", "0");
  const diagnostic = matrixRuntimeEnvironment("/tmp/v32-diagnostic", "1");
  assert.doesNotThrow(() => assertDisjointRuntimeState(standard, diagnostic));
  assert.equal(standard.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY, "0");
  assert.equal(diagnostic.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY, "1");
  assert.throws(
    () => assertDisjointRuntimeState(standard, { ...diagnostic, JAVA_LSP_CACHE_ROOT: standard.JAVA_LSP_CACHE_ROOT }),
    /runtime state overlap/
  );
});

test("cross-version scenario freeze gives Task0 and V3 the same golden set", () => {
  const source = `${JSON.stringify({
    id: "scenario-a",
    name: "scenario a",
    anchor: { file: "Anchor.java", line: 1, column: 1, profile: "service" },
    golden: {
      mustHit: ["Must.java"],
      taskBlocking: ["Block.java"],
      shouldHit: ["Should.java"],
      support: ["Support.java"],
      mustReadRanges: { "Must.java": [{ startLine: 1, endLine: 2 }] },
      mustReadCoordinateRangesV2: [{ file: "Must.java", start: { line: 1, column: 1 }, end: { line: 2, column: 1 } }]
    },
    goldenMeta: { "Should.java": { note: "keep" } }
  })}\n`;

  const frozen = toCrossVersionScenarioJsonl(source, "fixture.jsonl");
  const row = JSON.parse(frozen.trim());
  const oldSet = new Set([
    ...row.golden.mustHit,
    ...row.golden.shouldHit,
    ...row.golden.side
  ]);
  const newSet = new Set([
    ...row.golden.mustHit,
    ...row.golden.taskBlocking,
    ...row.golden.shouldHit,
    ...row.golden.support
  ]);

  assert.deepEqual([...oldSet].sort(), [...newSet].sort());
  assert.deepEqual(row.golden.shouldHit, ["Block.java", "Should.java"]);
  assert.deepEqual(row.golden.side, ["Support.java"]);
  assert.equal(row.goldenMeta["Block.java"].shouldBlocksTask, true);
  assert.equal(row.goldenMeta["Should.java"].note, "keep");
  assert.deepEqual(row.golden.mustReadRanges, { "Must.java": [{ startLine: 1, endLine: 2 }] });
  assert.deepEqual(row.golden.mustReadCoordinateRangesV2, [{ file: "Must.java", start: { line: 1, column: 1 }, end: { line: 2, column: 1 } }]);
});

test("formal V3.2 scenarios bind 8 tuning and 2 holdout rows to exact isolated source coordinates", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-runner-scenarios-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "A.java"), "class A {\n  void run() {}\n}\n");
  const head = "a".repeat(40);
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `s${index + 1}`,
    repoCommit: head,
    evaluationSplit: index < 8 ? "tuning" : "holdout",
    anchor: { file: "A.java", line: 2, column: 8 },
    golden: {
      mustReadRanges: { "A.java": [{ startLine: 1, endLine: 3 }] },
      mustReadCoordinateRangesV2: [{ file: "A.java", start: { line: 1, column: 1 }, end: { line: 4, column: 1 } }]
    }
  }));
  await assert.doesNotReject(() => validateScenarioSet(rows, { root, head }, "fixture.jsonl"));
  await assert.rejects(
    () => validateScenarioSet(rows.map((row, index) => index === 9 ? { ...row, repoCommit: "short" } : row), { root, head }, "fixture.jsonl"),
    /repoCommit must equal/
  );
  await assert.rejects(
    () => validateScenarioSet(rows.map((row, index) => index === 9
      ? { ...row, golden: { ...row.golden, mustReadRanges: { "A.java": [{ startLine: 1, endLine: 99 }] } } }
      : row), { root, head }, "fixture.jsonl"),
    /invalid line range/
  );
});

test("candidate patch includes hash-bound untracked source inputs", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-runner-patch-"));
  const candidate = path.join(root, "candidate");
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init");
  await git(root, "config", "user.name", "Task36 Test");
  await git(root, "config", "user.email", "task36@example.invalid");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 1;\n");
  await git(root, "add", "src/tracked.ts");
  await git(root, "commit", "-m", "baseline");

  await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2;\n");
  await writeFile(path.join(root, "src", "new.ts"), "export const added = true;\n");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(path.join(root, "artifacts", "noise.json"), "{}\n");

  const snapshot = await captureCandidatePatch(root);
  assert.deepEqual(snapshot.untrackedInputs.map(input => input.path), ["src/new.ts"]);
  assert.match(snapshot.untrackedInputs[0].sha256, /^[a-f0-9]{64}$/);

  await git(root, "worktree", "add", "--detach", candidate, "HEAD");
  const patchFile = path.join(root, "candidate.patch");
  await writeFile(patchFile, snapshot.patch);
  await git(candidate, "apply", "--index", patchFile);
  assert.equal(await readFile(path.join(candidate, "src", "tracked.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(await readFile(path.join(candidate, "src", "new.ts"), "utf8"), "export const added = true;\n");
});

test("formal repository identity rejects a dirty checkout", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-runner-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init");
  await git(root, "config", "user.name", "Task36 Test");
  await git(root, "config", "user.email", "task36@example.invalid");
  await writeFile(path.join(root, "pom.xml"), "<project/>\n");
  await git(root, "add", "pom.xml");
  await git(root, "commit", "-m", "baseline");
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");

  await assert.rejects(() => assertCleanRepository(root, "fixture"), /must be clean/i);
});

test("formal output must resolve outside the candidate checkout", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-runner-output-"));
  const source = path.join(root, "source");
  const outside = path.join(root, "outside");
  const sourceLink = path.join(root, "source-link");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(path.join(source, "artifacts"), { recursive: true }), mkdir(outside)]);
  await symlink(source, sourceLink, "dir");

  await assert.doesNotReject(() => assertOutputOutsideSource(source, path.join(outside, "matrix")));
  await assert.rejects(() => assertOutputOutsideSource(source, path.join(source, "artifacts", "matrix")), /outside/);
  await assert.rejects(() => assertOutputOutsideSource(source, path.join(sourceLink, "matrix")), /outside/);
  await assert.rejects(() => assertOutputOutsideSource(source, path.join(root, "missing", "matrix")), /parent must already exist/);
});

async function git(cwd, ...args) {
  return exec("git", ["-C", cwd, ...args]);
}
