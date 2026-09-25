// input:  冻结 repair manifest + 冻结 fixture 语料 + reference 补丁。
// output: RED→GREEN 证据 —— 每个 repair 任务：(a) 未修改的 fixture 编译通过
//         且冻结测试目标断言失败（红线）；(b) 应用 reference-change 后通过
//         （绿线）；(c) 越权编辑被拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgeRepair } from "./repair-judge.mjs";

const KIT = "/Users/luo/Documents/github/codex-java-lsp-mcp/docs/java-specialist-devkit-v1";
const manifest = JSON.parse(readFileSync(path.join(KIT, "dataset/repairs/manifest.json"), "utf8"));
const tasksById = new Map(
  readFileSync(path.join(KIT, "dataset/prompts/locked.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    .concat(readFileSync(path.join(KIT, "dataset/prompts/dev.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)))
    .map(t => [t.id, t])
);

let scratch;
test.before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "repair-judge-"));
});

test("RED: every pristine repair fixture compiles and fails the frozen target assertions", { concurrency: 1 }, async (t) => {
  for (const entry of manifest) {
    await t.test(entry.task_id, async () => {
      const fixtureRoot = path.join(KIT, "dataset/corpora", entry.corpus);
      const candidate = path.join(scratch, `${entry.task_id}-red`);
      cpSync(fixtureRoot, candidate, { recursive: true });
      const report = await judgeRepair({
        task: { id: entry.task_id },
        manifestEntry: entry,
        fixtureRoot,
        candidateRoot: candidate,
        workDir: path.join(scratch, `${entry.task_id}-red-work`),
        javaHome: null,
        testSourceFile: path.join(KIT, "dataset", entry.test_file)
      });
      assert.notEqual(report.status, "REJECTED_UNALLOWED_EDIT", "pristine copy must not be rejected");
      assert.notEqual(report.status, "COMPILE_FAILED", `pristine fixture must compile: ${report.detail}`);
      assert.equal(report.passed, false, "pristine fixture must FAIL the frozen test");
      assert.ok(["TEST_FAILED", "TIMEOUT", "MISSING_RECEIPT"].includes(report.status), report.status);
    });
  }
});

test("GREEN: the reference change makes every frozen test pass", { concurrency: 1 }, async (t) => {
  for (const entry of manifest) {
    await t.test(entry.task_id, async () => {
      const fixtureRoot = path.join(KIT, "dataset/corpora", entry.corpus);
      const candidate = path.join(scratch, `${entry.task_id}-green`);
      cpSync(fixtureRoot, candidate, { recursive: true });
      const ref = JSON.parse(readFileSync(path.join(KIT, "dataset", entry.reference_change), "utf8"));
      const target = path.join(candidate, ref.path);
      const text = readFileSync(target, "utf8");
      const next = text.replace(ref.before, ref.after);
      assert.notEqual(next, text, "reference change must apply");
      writeFileSync(target, next, "utf8");
      const report = await judgeRepair({
        task: { id: entry.task_id },
        manifestEntry: entry,
        fixtureRoot,
        candidateRoot: candidate,
        workDir: path.join(scratch, `${entry.task_id}-green-work`),
        javaHome: null,
        testSourceFile: path.join(KIT, "dataset", entry.test_file)
      });
      assert.equal(report.status, "PASS", report.detail);
      assert.equal(report.passed, true);
    });
  }
});

test("reject: edits outside allowed_edits are refused even if the frozen test would pass", async () => {
  const entry = manifest.find(e => e.task_id === "JSB-LEDGER-03");
  const fixtureRoot = path.join(KIT, "dataset/corpora", entry.corpus);
  const candidate = path.join(scratch, "reject-case");
  cpSync(fixtureRoot, candidate, { recursive: true });
  // 越权编辑：修改 allowed_edits 之外的文件。
  const rogue = path.join(candidate, "src/main/java/lab/ledger", "ledger-rogue.java");
  writeFileSync(rogue, "package lab.ledger;\nclass Rogue {}\n", "utf8");
  const report = await judgeRepair({
    task: { id: entry.task_id },
    manifestEntry: entry,
    fixtureRoot,
    candidateRoot: candidate,
    workDir: path.join(scratch, "reject-case-work"),
    javaHome: null,
    testSourceFile: path.join(KIT, "dataset", entry.test_file)
  });
  assert.equal(report.status, "REJECTED_UNALLOWED_EDIT");
  assert.equal(report.passed, false);
});

test("smoke: task lookup covers all repair entries", () => {
  for (const entry of manifest) {
    const task = tasksById.get(entry.task_id);
    assert.ok(task && task.kind === "repair", `${entry.task_id} must be a repair task in a split file`);
  }
});