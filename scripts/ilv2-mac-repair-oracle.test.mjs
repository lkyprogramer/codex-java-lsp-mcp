import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { CLAMP_ORACLE, FIXED_CLAMP, evalFixture, frozenJavaHome, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { ORACLE_STATE, checkOracles, evaluateOracle } from "./ilv2-mac-repair-oracle.mjs";

async function dataset(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac10-oracle-"));
  t.after(() => removeTree(root));
  const fixture = await evalFixture(root);
  const out = path.join(root, "dataset");
  await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out });
  const oracleDir = path.join(out, "private/oracles/FX-REPAIR");
  const oracle = JSON.parse(await readFile(path.join(oracleDir, "oracle.json"), "utf8"));
  return { root, fixture, out, oracle, oracleDir, broken: await readFile(path.join(oracleDir, "pre-state.java"), "utf8"),
    fixed: await readFile(path.join(fixture.repoRoot, "src/main/java/demo/Calc.java"), "utf8") };
}

test("the broken pre-state fails by assertion and the known fix passes, stably on every repeat", async t => {
  const { root, fixture, out } = await dataset(t);
  const report = await checkOracles({ datasetFile: path.join(out, "dataset-manifest.json"), inputsFile: fixture.inputsFile, split: "dev", repeats: 3,
    javaHome: await frozenJavaHome(), out: path.join(root, "check") });
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.tasks.map(task => [task.taskId, task.broken, task.fixed, task.stable]),
    [["FX-REPAIR", ["TEST_FAILED", "TEST_FAILED", "TEST_FAILED"], ["PASS", "PASS", "PASS"], true]]);
  assert.match(report.tasks[0].brokenDetail, /ORACLE FAIL above/);
  assert.match(report.java.javaSha256, /^[0-9a-f]{64}$/);
  // The work directories of every judgement are gone; only the report stays.
  assert.deepEqual(await readdir(path.join(root, "check")), ["oracle-check.json"]);
});

test("a pre-state that already passes is not a stable oracle: the check fails", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac10-oracle-"));
  t.after(() => removeTree(root));
  const fixture = await evalFixture(root);
  // An equivalent rewrite of the fix (convert already refuses a pre-state identical to it).
  const equivalent = FIXED_CLAMP.replace("if (value > high) {", "if (high < value) {");
  assert.notEqual(equivalent, FIXED_CLAMP);
  await writeFile(path.join(fixture.curationDir, "oracles/clamp-pre-state.java"), equivalent);
  const out = path.join(root, "dataset");
  await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out });
  const report = await checkOracles({ datasetFile: path.join(out, "dataset-manifest.json"), inputsFile: fixture.inputsFile, split: "dev", repeats: 2,
    javaHome: await frozenJavaHome(), out: path.join(root, "check") });
  assert.equal(report.status, "FAIL");
  assert.deepEqual(report.tasks.map(task => [task.broken, task.fixed, task.stable]), [[["PASS", "PASS"], ["PASS", "PASS"], false]]);
});

test("oracle states: compile failure, timeout, output flood and a missing file are never a pass", async t => {
  const { root, oracle, fixed } = await dataset(t);
  const javaHome = await frozenJavaHome();
  const judge = (sourceText, testSource = CLAMP_ORACLE, limits = {}) => evaluateOracle({ oracle: { ...oracle, ...limits }, testSource, sourceText, javaHome, workDir: root });
  assert.equal((await judge(fixed.replace("return value;", "return value"))).state, ORACLE_STATE.COMPILE_FAILED);
  // A known fix that also floods its output or never ends is judged by the limit, not by the marker.
  const looping = fixed.replace("return value;\n", "while (high > low) { value++; }\n        return value;\n");
  const started = performance.now();
  assert.equal((await judge(looping, CLAMP_ORACLE, { timeoutMs: 3000 })).state, ORACLE_STATE.TIMEOUT);
  assert.ok(performance.now() - started < 15000, "the timeout bounds the judgement");
  const flood = CLAMP_ORACLE.replace('System.out.println("ORACLE PASS");', 'for (int i = 0; i < 100000; i++) { System.out.println("ORACLE PASS padding padding padding"); }');
  assert.equal((await judge(fixed, flood)).state, ORACLE_STATE.OUTPUT_LIMIT);
  // Exit 0 without the marker is not a pass.
  assert.equal((await judge(fixed, CLAMP_ORACLE.replace('System.out.println("ORACLE PASS");', ""))).state, ORACLE_STATE.TEST_FAILED);
  assert.equal((await judge(undefined)).state, ORACLE_STATE.MISSING_FILE);
  assert.equal((await judge(fixed)).state, ORACLE_STATE.PASS);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith("oracle-")), [], "every judgement removes its own directory");
});

test("a changed oracle test or pre-state is refused before anything runs", async t => {
  const { root, fixture, out, oracleDir } = await dataset(t);
  await writeFile(path.join(oracleDir, "ClampOracle.java"), CLAMP_ORACLE.replace("== 10", "== 11"));
  await assert.rejects(checkOracles({ datasetFile: path.join(out, "dataset-manifest.json"), inputsFile: fixture.inputsFile, split: "dev", repeats: 1,
    javaHome: await frozenJavaHome(), out: path.join(root, "check") }), /dataset part|oracle .* changed|oracle test changed/);
});
