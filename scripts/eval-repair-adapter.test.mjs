// input: a minimal frozen-kit layout (manifest + corpus) and candidate trees in a temporary directory.
// output: post-ILV2 Q01 / 06 §6.2 item 3 controls: edits outside allowed_edits (evaluator tests included)
//         are rejected before any judge or toolchain runs.
// pos: pins existing eval-repair-adapter policy; it adds no second judge.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { REPAIR_STATE, diffCandidateTrees, evaluateRepair } from "./eval-repair-adapter.mjs";

const ALLOWED = "src/main/java/demo/Stock.java";
const TEST_FILE = "src/test/java/demo/StockTest.java";

async function kit(t) {
  const root = await mkdtemp(path.join(tmpdir(), "repair-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kitRoot = path.join(root, "kit");
  const corpus = path.join(kitRoot, "dataset", "corpora", "demo");
  for (const [rel, text] of [[ALLOWED, "class Stock { int n = 1; }\n"], [TEST_FILE, "class StockTest {}\n"]]) {
    mkdirSync(path.dirname(path.join(corpus, rel)), { recursive: true });
    writeFileSync(path.join(corpus, rel), text);
  }
  mkdirSync(path.join(kitRoot, "harness"), { recursive: true });
  writeFileSync(path.join(kitRoot, "harness", "__main__.py"), "raise SystemExit('the judge must not run in a policy rejection')\n");
  mkdirSync(path.join(kitRoot, "dataset", "repairs"), { recursive: true });
  writeFileSync(path.join(kitRoot, "dataset", "repairs", "manifest.json"), JSON.stringify([{ task_id: "R-1", corpus: "demo", allowed_edits: [ALLOWED] }]));
  const candidate = (name) => {
    const dir = path.join(root, name);
    cpSync(corpus, dir, { recursive: true });
    return dir;
  };
  return { root, kitRoot, corpus, candidate };
}

test("an edit to an allowed file passes the policy; edits to evaluator tests or other files do not", async t => {
  const { corpus, candidate } = await kit(t);
  const good = candidate("good");
  writeFileSync(path.join(good, ALLOWED), "class Stock { int n = 2; }\n");
  assert.deepEqual(diffCandidateTrees({ fixtureRoot: corpus, candidateRoot: good, allowedEdits: [ALLOWED] }).violations, []);

  const tampered = candidate("tampered");
  writeFileSync(path.join(tampered, ALLOWED), "class Stock { int n = 2; }\n");
  writeFileSync(path.join(tampered, TEST_FILE), "class StockTest { /* always passes */ }\n");
  writeFileSync(path.join(tampered, "src/main/java/demo/Extra.java"), "class Extra {}\n");
  assert.deepEqual(diffCandidateTrees({ fixtureRoot: corpus, candidateRoot: tampered, allowedEdits: [ALLOWED] }).violations,
    ["src/main/java/demo/Extra.java", TEST_FILE]);

  const deletedTest = candidate("deleted-test");
  unlinkSync(path.join(deletedTest, TEST_FILE));
  const deleted = diffCandidateTrees({ fixtureRoot: corpus, candidateRoot: deletedTest, allowedEdits: [ALLOWED] });
  assert.deepEqual([deleted.removed, deleted.violations], [[TEST_FILE], [TEST_FILE]]);

  const linked = candidate("linked");
  rmSync(path.join(linked, ALLOWED));
  symlinkSync(path.join(corpus, ALLOWED), path.join(linked, ALLOWED));
  assert.deepEqual(diffCandidateTrees({ fixtureRoot: corpus, candidateRoot: linked, allowedEdits: [ALLOWED] }).symlinks, [`candidate:${ALLOWED}(symlink)`]);
});

test("evaluateRepair rejects a candidate that edited an evaluator test before any judge runs", async t => {
  const { root, kitRoot, candidate } = await kit(t);
  const tampered = candidate("tampered");
  writeFileSync(path.join(tampered, TEST_FILE), "class StockTest { /* always passes */ }\n");
  // A judge or toolchain probe would need python/java; reaching neither is part of the contract.
  const verdict = await evaluateRepair({ kitRoot, taskId: "R-1", candidateRoot: tampered, outputRoot: path.join(root, "out"),
    python: "/nonexistent/python", javaHome: "/nonexistent/jdk" });
  assert.equal(verdict.state, REPAIR_STATE.REJECTED_DISALLOWED_EDIT);
  assert.equal(verdict.validatedSuccess, false);
  assert.deepEqual(verdict.policy.violations, [TEST_FILE]);
  const removedAllowed = candidate("removed-allowed");
  unlinkSync(path.join(removedAllowed, ALLOWED));
  const missing = await evaluateRepair({ kitRoot, taskId: "R-1", candidateRoot: removedAllowed, outputRoot: path.join(root, "out2"),
    python: "/nonexistent/python", javaHome: "/nonexistent/jdk" });
  assert.equal(missing.state, REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE, "the pristine copy never stands in for a deleted allowed file");
});
