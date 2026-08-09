import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertCleanRepository,
  assertOutputOutsideSource,
  captureCandidatePatch,
  isolatedChildEnvironment,
  toCrossVersionScenarioJsonl,
  validateScenarioSet
} from "./run-three-repo-cold-matrix.mjs";

const exec = promisify(execFile);

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
