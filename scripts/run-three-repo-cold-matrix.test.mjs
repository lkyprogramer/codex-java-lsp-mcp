import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertCleanRepository,
  captureCandidatePatch,
  toCrossVersionScenarioJsonl
} from "./run-three-repo-cold-matrix.mjs";

const exec = promisify(execFile);

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
      mustReadRanges: { "Must.java": [{ startLine: 1, endLine: 2 }] }
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

async function git(cwd, ...args) {
  return exec("git", ["-C", cwd, ...args]);
}
