import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  classifyDiffEntries,
  extractMethods,
  generateCommitTasks,
  isExcludedJavaSet,
  methodGold,
  parseNameStatus,
  taskFromCommit
} from "./generate-commit-tasks.mjs";

const execFile = promisify(execFileCb);

async function git(repo, ...args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "jin",
    GIT_AUTHOR_EMAIL: "jin@example.test",
    GIT_COMMITTER_NAME: "jin",
    GIT_COMMITTER_EMAIL: "jin@example.test"
  };
  const { stdout } = await execFile("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { env, encoding: "utf8" });
  return stdout.trim();
}

async function commit(repo, message) {
  await git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

async function writeJava(repo, relative, body) {
  const full = path.join(repo, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

function typeSource(name, methods) {
  const body = methods.map(method => `  public void ${method.name}() {\n    ${method.body}\n  }\n`).join("\n");
  return `package demo;\npublic class ${name} {\n${body}}\n`;
}

async function fixtureRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "jin-commit-tasks-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "jin@example.test");
  await git(repo, "config", "user.name", "jin");
  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 1;" }]));
  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 1;" }]));
  await git(repo, "add", ".");
  await commit(repo, "initial two types with baseline methods");

  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 2;" }]));
  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 2;" }]));
  await git(repo, "add", ".");
  const changeTwo = await commit(repo, "change run and save bodies together now");

  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 2;" }, { name: "load", body: "return;" }]));
  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 21;" }]));
  await git(repo, "add", ".");
  const addMethod = await commit(repo, "add load method next to a retouched save");

  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 2;" }]));
  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 22;" }]));
  await git(repo, "add", ".");
  const deleteMethod = await commit(repo, "remove load method from type A file");

  await writeJava(repo, "src/C.java", typeSource("C", [{ name: "extra", body: "int z = 1;" }]));
  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 3;" }]));
  await git(repo, "add", ".");
  const threeFiles = await commit(repo, "touch A and introduce C as a third type");

  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 3;" }, { name: "flush", body: "return;" }]));
  await writeJava(repo, "src/C.java", typeSource("C", [{ name: "extra", body: "int z = 2;" }]));
  await git(repo, "add", ".");
  const twoMethods = await commit(repo, "change B.save, add B.flush, and retouch C");

  await writeJava(repo, "src/A.java", typeSource("A", [{ name: "run", body: "int x = 4;" }]));
  await writeJava(repo, "src/B.java", typeSource("B", [{ name: "save", body: "int y = 4;" }, { name: "flush", body: "return;" }]));
  await git(repo, "add", ".");
  const shortMessage = await commit(repo, "tiny");

  await writeJava(repo, "src/D.java", typeSource("D", [{ name: "solo", body: "int s = 1;" }]));
  await git(repo, "add", ".");
  const oneFile = await commit(repo, "add a single java file only here");

  await writeJava(repo, "src/F.java", typeSource("F", [{ name: "other", body: "int f = 1;" }]));
  await git(repo, "add", ".");
  await commit(repo, "add F.java so a later pair of renames stays in range");
  await git(repo, "mv", "src/D.java", "src/DRenamed.java");
  await git(repo, "mv", "src/F.java", "src/FRenamed.java");
  await git(repo, "add", "-A");
  const renameOnly = await commit(repo, "rename D.java and F.java without changing any method body");

  await writeJava(repo, "src/A.java", "package demo;\n\npublic class A {\n  public void run() {\n    int x = 4;\n  }\n}\n");
  await writeJava(repo, "src/B.java", "package demo;\n\npublic class B {\n  public void save() {\n    int y = 4;\n  }\n\n  public void flush() {\n    return;\n  }\n}\n");
  await git(repo, "add", ".");
  const formatOnly = await commit(repo, "reformat A.java and B.java whitespace without method edits");

  await git(repo, "checkout", "-qb", "topic");
  await writeJava(repo, "src/E.java", typeSource("E", [{ name: "topic", body: "int t = 1;" }]));
  await writeJava(repo, "src/C.java", typeSource("C", [{ name: "extra", body: "int z = 3;" }]));
  await git(repo, "add", ".");
  await commit(repo, "topic branch changes two java files for merge");
  await git(repo, "checkout", "-q", "main");
  await git(repo, "merge", "-q", "--no-ff", "-m", "merge topic branch with two java files changed", "topic");
  const merge = await git(repo, "rev-parse", "HEAD");

  return {
    repo,
    changeTwo,
    addMethod,
    deleteMethod,
    threeFiles,
    twoMethods,
    shortMessage,
    oneFile,
    renameOnly,
    formatOnly,
    merge
  };
}

test("parseNameStatus keeps rename similarity and java-count exclusions", () => {
  const entries = parseNameStatus("M\tsrc/A.java\nR100\tsrc/D.java\tsrc/DRenamed.java\n");
  const java = classifyDiffEntries(entries);
  assert.equal(java.length, 2);
  assert.equal(java[1].renameOnly, true);
  assert.equal(isExcludedJavaSet([
    { path: "src/DRenamed.java", renameOnly: true },
    { path: "src/FRenamed.java", renameOnly: true }
  ]), "rename-only");
  assert.equal(isExcludedJavaSet([{ path: "src/A.java", renameOnly: false }]), "java-count");
});

test("extractMethods and methodGold see added, changed, and deleted methods", () => {
  const parent = typeSource("A", [{ name: "run", body: "int x = 1;" }, { name: "load", body: "return;" }]);
  const child = typeSource("A", [{ name: "run", body: "int x = 2;" }]);
  const methods = extractMethods(child);
  assert.ok(methods.some(method => method.name === "run"));
  const gold = methodGold(parent, child);
  assert.ok(gold.some(item => item.name === "run" && !item.deleted));
  assert.ok(gold.some(item => item.name === "load" && item.deleted));
});

test("five hand-checked fixture commits extract the expected gold methods", async () => {
  const fx = await fixtureRepo();
  const changeTwo = await taskFromCommit(fx.repo, fx.changeTwo);
  assert.equal(changeTwo.excluded, undefined, JSON.stringify(changeTwo));
  assert.deepEqual(changeTwo.files.map(file => file.path).sort(), ["src/A.java", "src/B.java"]);
  assert.ok(changeTwo.files.find(file => file.path === "src/A.java").methods.some(method => method.name === "run"));
  assert.ok(changeTwo.files.find(file => file.path === "src/B.java").methods.some(method => method.name === "save"));

  const addMethod = await taskFromCommit(fx.repo, fx.addMethod);
  assert.ok(addMethod.files.find(file => file.path === "src/A.java").methods.some(method => method.name === "load" && !method.deleted));

  const deleteMethod = await taskFromCommit(fx.repo, fx.deleteMethod);
  assert.ok(deleteMethod.files.find(file => file.path === "src/A.java").methods.some(method => method.name === "load" && method.deleted));

  const threeFiles = await taskFromCommit(fx.repo, fx.threeFiles);
  assert.equal(threeFiles.files.length, 2);
  assert.ok(threeFiles.files.some(file => file.path === "src/C.java" && file.status === "add"));

  const twoMethods = await taskFromCommit(fx.repo, fx.twoMethods);
  const b = twoMethods.files.find(file => file.path === "src/B.java");
  assert.ok(b.methods.some(method => method.name === "save"));
  assert.ok(b.methods.some(method => method.name === "flush"));
});

test("merge, short message, single file, rename-only, and format-only commits are excluded", async () => {
  const fx = await fixtureRepo();
  assert.equal((await taskFromCommit(fx.repo, fx.shortMessage)).excluded, "short-message");
  assert.equal((await taskFromCommit(fx.repo, fx.oneFile)).excluded, "java-count");
  assert.equal((await taskFromCommit(fx.repo, fx.renameOnly)).excluded, "rename-only");
  assert.equal((await taskFromCommit(fx.repo, fx.formatOnly)).excluded, "format-or-rename");
  assert.equal((await taskFromCommit(fx.repo, fx.merge)).excluded, "merge-or-root");
});

test("generateCommitTasks splits time-ordered train/holdout and keeps valid tasks", async () => {
  const fx = await fixtureRepo();
  const payload = await generateCommitTasks(fx.repo, { project: "fixture", minTasks: 30, fallbackMinTasks: 3, holdoutRatio: 0.3 });
  assert.ok(payload.counts.kept >= 5, JSON.stringify(payload.counts));
  assert.equal(payload.train.length + payload.holdout.length, payload.counts.kept);
  assert.ok(payload.train[0].timestamp <= payload.holdout[0].timestamp);
});
