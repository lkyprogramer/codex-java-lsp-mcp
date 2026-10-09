// input:  冻结 repair manifest + 冻结 fixture 语料 + reference 补丁 + 合成语料。
// output: RED→GREEN 证据与判定器边界 —— (a) 未修改的 fixture 编译通过且冻结测试
//         目标断言失败（红线）；(b) reference-change 通过（绿线，validated_success
//         只来自原 Python frozen judge）；(c) 越权编辑、被删除的 allowed 文件、
//         symlink 均被拒绝且绝不恢复原文件；(d) 缺编译器 = BLOCKED_ENV，
//         恶意 stdout / 挂死子进程受 128KiB 与 timeout 界限并清理进程树。
// pos:    R04 的可搬运测试：kit 根来自 JSB_KIT_ROOT 或 import.meta.url 相对定位，
//         scratch 目录含空格，任何个人绝对路径都会让本文件失败。
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeRepair } from "./repair-judge.mjs";
import { REPAIR_STATE, evaluateRepair, stageCandidateTree, walkTree } from "../../scripts/eval-repair-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const KIT = path.resolve(process.env.JSB_KIT_ROOT ?? path.join(REPO_ROOT, "docs/java-specialist-release-audit-v1.1/baseline-kit"));
const manifest = JSON.parse(readFileSync(path.join(KIT, "dataset/repairs/manifest.json"), "utf8"));
const tasksById = new Map(
  ["locked.jsonl", "dev.jsonl"]
    .flatMap(name => readFileSync(path.join(KIT, "dataset/prompts", name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))
    .map(task => [task.id, task])
);

// 含空格且与仓库不同的目录：证明判定器不依赖路径形态或当前工作目录。
const scratch = mkdtempSync(path.join(tmpdir(), "repair judge with spaces "));
const treeHashes = root => Object.fromEntries([...walkTree(root).entries()].map(([rel, meta]) => [rel, meta.hash ?? meta.kind]));
const fixtureLedger = path.join(KIT, "dataset/corpora", "ledger");
const ledgerFixtureBefore = treeHashes(fixtureLedger);

function candidateCopy(name, sourceRoot = fixtureLedger) {
  const dest = path.join(scratch, `candidate ${name}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(sourceRoot, dest, { recursive: true });
  return dest;
}

function judgeArgs(entry, candidateRoot, workName) {
  return {
    task: { id: entry.task_id },
    manifestEntry: entry,
    fixtureRoot: path.join(KIT, "dataset/corpora", entry.corpus),
    candidateRoot,
    workDir: path.join(scratch, `work ${workName}`),
    javaHome: null,
    testSourceFile: path.join(KIT, "dataset", entry.test_file)
  };
}

/** 合成语料：只用于判定器自身的边界（回执/输出上限/超时），不参与任何统计任务。 */
function syntheticFixture(name, { source, testSource, testClass = "FrozenTest", timeoutSeconds = 3 }) {
  const root = path.join(scratch, `synthetic ${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "A.java"), source, "utf8");
  const testSourceFile = path.join(root, `${testClass}.java`);
  writeFileSync(testSourceFile, testSource, "utf8");
  const fixtureRoot = path.join(root, "original");
  mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
  cpSync(path.join(root, "src", "A.java"), path.join(fixtureRoot, "src", "A.java"));
  return {
    fixtureRoot,
    testSourceFile,
    manifestEntry: {
      task_id: name,
      allowed_edits: ["src/A.java"],
      test_class: testClass,
      java_release: 8,
      timeout_seconds: timeoutSeconds,
      source_roots: ["src"]
    }
  };
}

test("portable: repair judge, adapter and A/B drivers carry no personal absolute paths", () => {
  const sources = [
    "experiments/semantic-discovery/repair-judge.mjs",
    "experiments/semantic-discovery/repair-judge.test.mjs",
    "experiments/semantic-discovery/agent-ab.mjs",
    "experiments/semantic-discovery/compare.mjs",
    "scripts/eval-repair-adapter.mjs"
  ];
  for (const rel of sources) {
    const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.ok(!/\/Users\/[a-z0-9_.-]+\//.test(text), `${rel} hardcodes a macOS home path`);
    assert.ok(!/\/home\/[a-z0-9_.-]+\//.test(text), `${rel} hardcodes a Linux home path`);
  }
  assert.ok(existsKit(), `frozen kit not found at ${KIT}: pass JSB_KIT_ROOT`);
});

function existsKit() {
  return walkTree(path.join(KIT, "dataset/repairs")).size > 0;
}

test("frozen judge RED/GREEN: pristine fixtures fail the target assertion, reference change passes", { concurrency: 1 }, async t => {
  for (const entry of manifest) {
    await t.test(entry.task_id, async () => {
      const baseline = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "baseline", outputRoot: path.join(scratch, `baseline ${entry.task_id}`) });
      const pristine = baseline.judgeArtifact;
      assert.equal(baseline.state, REPAIR_STATE.TEST_FAILED, baseline.reason);
      assert.equal(baseline.validatedSuccess, false);
      assert.equal(pristine.compile.exit_code, 0, `pristine fixture must compile: ${pristine.compile.stderr}`);
      assert.ok(pristine.run.stderr.includes("AssertionError"), `pristine run must fail the frozen assertion: ${pristine.run.stderr}`);
      assert.equal(pristine.frozen_test_completed, false);

      const referenceRun = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "reference", outputRoot: path.join(scratch, `reference ${entry.task_id}`) });
      const reference = referenceRun.judgeArtifact;
      assert.equal(referenceRun.state, REPAIR_STATE.VALIDATED_SUCCESS, referenceRun.reason);
      assert.equal(reference.validated_success, true);
      assert.equal(reference.frozen_test_completed, true);
      assert.equal(reference.frozen_test_sha256, pristine.frozen_test_sha256, "frozen test must not drift between arms");
    });
  }
});

test("candidate that deletes an allowed source file is rejected and never restored", async () => {
  const entry = manifest.find(item => item.task_id === "JSB-LEDGER-03");
  const allowed = entry.allowed_edits[0];
  const candidateRoot = candidateCopy("deleted-allowed");
  rmSync(path.join(candidateRoot, allowed));

  const deletedAllowedFile = await judgeRepair(judgeArgs(entry, candidateRoot, "deleted-allowed"));
  assert.equal(deletedAllowedFile.passed, false);
  assert.equal(deletedAllowedFile.status, REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE, deletedAllowedFile.detail);
  assert.deepEqual(deletedAllowedFile.policy.missingAllowed, [allowed]);

  // 候选物化必须把删除传播到 judge 工作区，而不是把 pristine 文件复制回去。
  const staged = stageCandidateTree({
    fixtureRoot: path.join(KIT, "dataset/corpora", entry.corpus),
    candidateRoot,
    allowedEdits: entry.allowed_edits,
    dest: path.join(scratch, "staged deleted-allowed")
  });
  const judgeWorkspace = { containsRestoredDeletedFile: staged.files.includes(allowed) };
  assert.equal(judgeWorkspace.containsRestoredDeletedFile, false);
  assert.deepEqual(staged.deleted, [allowed]);

  const bridged = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "candidate", candidateRoot, outputRoot: path.join(scratch, "bridge deleted-allowed") });
  assert.equal(bridged.state, REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE);
  assert.equal(bridged.validatedSuccess, false);
  assert.equal(bridged.judgeArtifact, null, "a rejected candidate must not be presented as a judged run");
});

test("reject: edits outside allowed_edits are refused even if the frozen test would pass", async () => {
  const entry = manifest.find(item => item.task_id === "JSB-LEDGER-03");
  const candidateRoot = candidateCopy("rogue");
  writeFileSync(path.join(candidateRoot, "src/main/java/lab/ledger", "ledger-rogue.java"), "package lab.ledger;\nclass Rogue {}\n", "utf8");
  const report = await judgeRepair(judgeArgs(entry, candidateRoot, "rogue"));
  assert.equal(report.status, REPAIR_STATE.REJECTED_DISALLOWED_EDIT);
  assert.equal(report.passed, false);

  const bridged = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "candidate", candidateRoot, outputRoot: path.join(scratch, "bridge rogue") });
  assert.equal(bridged.state, REPAIR_STATE.REJECTED_DISALLOWED_EDIT);
  assert.equal(bridged.validatedSuccess, false);
});

test("reject: symlink inside the candidate is refused, never followed", async () => {
  const entry = manifest.find(item => item.task_id === "JSB-LEDGER-03");
  const candidateRoot = candidateCopy("symlink");
  symlinkSync("/etc/hosts", path.join(candidateRoot, "src/main/java/lab/ledger/Evil.java"));
  const report = await judgeRepair(judgeArgs(entry, candidateRoot, "symlink"));
  assert.equal(report.status, REPAIR_STATE.REJECTED_UNSAFE_PATH, report.detail);
  assert.equal(report.passed, false);

  const bridged = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "candidate", candidateRoot, outputRoot: path.join(scratch, "bridge symlink") });
  assert.equal(bridged.state, REPAIR_STATE.REJECTED_UNSAFE_PATH);
  assert.equal(bridged.validatedSuccess, false);
});

test("missing compiler is BLOCKED_ENV, never a business RED or COMPILE_FAILED", async () => {
  const entry = manifest.find(item => item.task_id === "JSB-LEDGER-03");
  const candidateRoot = candidateCopy("no-jdk");
  const report = await judgeRepair({ ...judgeArgs(entry, candidateRoot, "no-jdk"), javaHome: path.join(scratch, "no-jdk-here") });
  assert.equal(report.status, REPAIR_STATE.BLOCKED_ENV, report.detail);
  assert.equal(report.passed, false);
  assert.equal(report.compile, undefined, "no compile attempt may be recorded when the toolchain is missing");

  const bridged = await evaluateRepair({
    kitRoot: KIT,
    taskId: entry.task_id,
    mode: "candidate",
    candidateRoot,
    outputRoot: path.join(scratch, "bridge no-jdk"),
    javaHome: path.join(scratch, "no-jdk-here")
  });
  assert.equal(bridged.state, REPAIR_STATE.BLOCKED_ENV);
  assert.equal(bridged.validatedSuccess, false);
});

test("JVM exit 0 without a completion receipt fails", async () => {
  const fixture = syntheticFixture("halt-zero", {
    source: "public class A { public static int value(){ return 9; } }\n",
    testSource: "public class FrozenTest { public static void main(String[] a) { Runtime.getRuntime().halt(0); } }\n"
  });
  const candidateRoot = candidateCopy("halt-zero", fixture.fixtureRoot);
  const report = await judgeRepair({
    task: { id: "halt-zero" },
    manifestEntry: fixture.manifestEntry,
    fixtureRoot: fixture.fixtureRoot,
    candidateRoot,
    workDir: path.join(scratch, "work halt-zero"),
    javaHome: null,
    testSourceFile: fixture.testSourceFile
  });
  assert.equal(report.run.exit_code, 0);
  assert.equal(report.frozenTestCompleted, false);
  assert.equal(report.status, REPAIR_STATE.MISSING_RECEIPT);
  assert.equal(report.passed, false);
});

test("runaway stdout is bounded and cannot pass", async () => {
  const fixture = syntheticFixture("spam-stdout", {
    source: "public class A { public static int value(){ return 9; } }\n",
    testSource: "public class FrozenTest { public static void main(String[] a) { char[] c = new char[8192]; java.util.Arrays.fill(c, 'x'); String chunk = new String(c); StringBuilder b = new StringBuilder(); for (int i = 0; i < 64; i++) b.append(chunk); System.out.print(b); } }\n"
  });
  const candidateRoot = candidateCopy("spam-stdout", fixture.fixtureRoot);
  const report = await judgeRepair({
    task: { id: "spam-stdout" },
    manifestEntry: fixture.manifestEntry,
    fixtureRoot: fixture.fixtureRoot,
    candidateRoot,
    workDir: path.join(scratch, "work spam-stdout"),
    javaHome: null,
    testSourceFile: fixture.testSourceFile
  });
  assert.equal(report.status, REPAIR_STATE.OUTPUT_LIMIT, report.detail);
  assert.equal(report.passed, false);
  assert.ok(Buffer.byteLength(report.run.stdout ?? "", "utf8") <= 128 * 1024, "captured stdout must stay inside the bound");
});

test("timeout kills the whole process tree, not just the launcher", async () => {
  const marker = "work timeout-tree";
  const fixture = syntheticFixture("hang-forever", {
    source: "public class A { public static int value(){ return 9; } }\n",
    testSource:
      "public class FrozenTest { public static void main(String[] a) throws Exception { Thread worker = new Thread(() -> { while (true) { try { Thread.sleep(1000); } catch (InterruptedException e) { return; } } }); worker.setDaemon(true); worker.start(); while (true) Thread.sleep(1000); } }\n",
    timeoutSeconds: 2
  });
  const candidateRoot = candidateCopy("hang-forever", fixture.fixtureRoot);
  const report = await judgeRepair({
    task: { id: "hang-forever" },
    manifestEntry: fixture.manifestEntry,
    fixtureRoot: fixture.fixtureRoot,
    candidateRoot,
    workDir: path.join(scratch, marker),
    javaHome: null,
    testSourceFile: fixture.testSourceFile
  });
  assert.equal(report.status, REPAIR_STATE.TIMEOUT, report.detail);
  assert.equal(report.passed, false);
  const survivors = spawnSync("pgrep", ["-f", path.join(scratch, marker)], { encoding: "utf8" });
  assert.equal(survivors.stdout.trim(), "", `java processes survived the timeout kill: ${survivors.stdout}`);
});

test("frozen fixture corpora stay byte-identical through every judgement", () => {
  assert.deepEqual(treeHashes(fixtureLedger), ledgerFixtureBefore, "the judge must never write into the frozen fixture");
});

test("smoke: task lookup covers all repair entries", () => {
  for (const entry of manifest) {
    const task = tasksById.get(entry.task_id);
    assert.ok(task && task.kind === "repair", `${entry.task_id} must be a repair task in a split file`);
  }
});

test.after(() => {
  if (!process.env.JSB_KEEP_SCRATCH) rmSync(scratch, { recursive: true, force: true });
});

test("javaHome: the probed JDK is the JDK the frozen judge runs (it is first on PATH)", async t => {
  // Resolve the JDK that `javac` on PATH belongs to, then hide every java
  // directory from PATH: the judge must still compile through javaHome.
  const probe = spawnSync("java", ["-XshowSettings:properties", "-version"], { encoding: "utf8" });
  const homeLine = `${probe.stderr}${probe.stdout}`.split("\n").find(line => line.trim().startsWith("java.home ="));
  if (!homeLine) {
    t.skip("javac unavailable (BLOCKED_ENV)");
    return;
  }
  const javaHome = homeLine.split("=")[1].trim();
  const entry = manifest.find(row => row.task_id === "JSB-PAYMENTS-03");
  const savedPath = process.env.PATH;
  process.env.PATH = savedPath.split(path.delimiter)
    .filter(dir => spawnSync("sh", ["-c", `test -x "${dir}/javac" || test -x "${dir}/java"`]).status !== 0)
    .join(path.delimiter);
  try {
    assert.notEqual(spawnSync("sh", ["-c", "command -v javac"]).status, 0, "test setup: javac must be hidden from PATH");
    const result = await evaluateRepair({ kitRoot: KIT, taskId: entry.task_id, mode: "reference", outputRoot: path.join(scratch, "java home on path"), javaHome });
    assert.equal(result.state, REPAIR_STATE.VALIDATED_SUCCESS, result.reason ?? result.python?.stderr);
    assert.equal(result.toolchain.javac, path.join(javaHome, "bin", "javac"));
  } finally {
    process.env.PATH = savedPath;
  }
});
