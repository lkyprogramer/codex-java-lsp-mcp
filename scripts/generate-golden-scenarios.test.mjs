import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { splitTrainHoldout } from "./generate-commit-tasks.mjs";
import {
  G1_HOLDOUT_RATIO,
  G1_MAX_SCENARIOS,
  G1_MIN_HOLDOUT,
  G1_MIN_SCENARIOS,
  PIN_RUOYI,
  collectCommitTasks,
  generateGoldenScenarios,
  isGeneratedNoisePath,
  javaFilesFromTask,
  qualityReport,
  scenariosToJsonl,
  smokeGoldenScenarios,
  truncateEligible
} from "./generate-golden-scenarios.mjs";

function task(index, files, extra = {}) {
  return {
    commit: `${String(index).padStart(40, "a")}`,
    timestamp: 1_700_000_000 + index,
    task: `feat: change pair ${index} across two java types`,
    files: files.map(file => ({
      path: file.path,
      status: file.status ?? "modify",
      methods: file.methods ?? [{
        name: "run",
        arity: 0,
        range: { start: { line: 2, column: 3 }, end: { line: 4, column: 4 } }
      }]
    })),
    ...extra
  };
}

async function pinRepo(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "g1-pin-"));
  for (const file of files) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "package demo;\npublic class T {\n  public void run() {\n    int x = 1;\n  }\n}\n");
  }
  return root;
}

test("noise filter matches generated-sources and target, not module source", () => {
  assert.equal(isGeneratedNoisePath("yudao-module-mes/src/main/java/A.java"), false);
  assert.equal(isGeneratedNoisePath("yudao-framework/src/main/java/B.java"), false);
  assert.equal(isGeneratedNoisePath("module/target/generated-sources/A.java"), true);
  assert.equal(isGeneratedNoisePath("target/foo.java"), true);
});

test("javaFilesFromTask drops deletes and non-java", () => {
  const files = javaFilesFromTask({
    files: [
      { path: "src/A.java", status: "modify" },
      { path: "src/B.java", status: "delete" },
      { path: "src/C.xml", status: "modify" }
    ]
  });
  assert.deepEqual(files.map(file => file.path), ["src/A.java"]);
});

test("truncateEligible keeps the most recent max scenarios", () => {
  const eligible = Array.from({ length: 45 }, (_, index) => ({ task: { timestamp: index } }));
  const truncated = truncateEligible(eligible, 40);
  assert.equal(truncated.length, 40);
  assert.equal(truncated[0].task.timestamp, 5);
  assert.equal(truncated[39].task.timestamp, 44);
});

test("generateGoldenScenarios uses time-ordered 30% holdout and commit mustHit", async () => {
  const files = [];
  const train = [];
  for (let index = 0; index < 30; index += 1) {
    const a = `mod/src/A${index}.java`;
    const b = `mod/src/B${index}.java`;
    files.push(a, b);
    train.push(task(index, [{ path: a }, { path: b }]));
  }
  const root = await pinRepo(files);
  const payload = { project: "ruoyi-vue-pro", head: "b".repeat(40), train, holdout: [] };
  const result = generateGoldenScenarios(payload, root);
  assert.equal(result.decision, "GO");
  assert.equal(result.scenarios.length, 30);
  assert.ok(result.quality.holdout >= G1_MIN_HOLDOUT);
  const expected = splitTrainHoldout(train, G1_HOLDOUT_RATIO);
  assert.equal(result.quality.holdout, expected.holdout.length);
  assert.equal(result.scenarios[0].evaluationSplit, "tuning");
  assert.equal(result.scenarios.at(-1).evaluationSplit, "holdout");
  assert.deepEqual(result.scenarios[0].golden.mustHit, ["mod/src/A0.java", "mod/src/B0.java"]);
  assert.equal(result.scenarios[0].layoutProfile, "maven-reactor");
  assert.equal(result.scenarios[0].anchor.profile, "auto");
  assert.equal(result.scenarios[0].repoCommit, "b".repeat(40));
  const smoke = smokeGoldenScenarios(result.scenarios, root);
  assert.equal(smoke.passed, true);
  const parsed = scenariosToJsonl(result.scenarios).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(parsed.length, 30);
  assert.equal(parsed[0].sourceCommit, undefined);
});

test("missing pin files and generated noise are dropped, not hand-filled", async () => {
  const root = await pinRepo(["src/A.java", "src/B.java", "src/C.java", "src/D.java"]);
  const payload = {
    project: "fixture",
    head: "c".repeat(40),
    train: [
      task(1, [{ path: "src/A.java" }, { path: "src/B.java" }]),
      task(2, [{ path: "src/missing-1.java" }, { path: "src/missing-2.java" }]),
      task(3, [{ path: "target/generated-sources/X.java" }, { path: "target/generated-sources/Y.java" }]),
      task(4, [{ path: "src/C.java" }, { path: "src/D.java" }])
    ],
    holdout: []
  };
  const result = generateGoldenScenarios(payload, root, { holdoutRatio: 0.5 });
  assert.equal(result.scenarios.length, 2);
  assert.equal(result.dropped.missingAtPin, 1);
  assert.equal(result.dropped.generatedNoise, 1);
  assert.deepEqual(result.scenarios.map(row => row.golden.mustHit[0]).sort(), ["src/A.java", "src/C.java"]);
});

test("a1 neutral filter drops test-file mustHit and keeps clean pairs", async () => {
  const root = await pinRepo([
    "mod/src/A.java",
    "mod/src/B.java",
    "mod/src/test/FooTest.java",
    "mod/src/C.java"
  ]);
  const payload = {
    project: "fixture",
    head: "e".repeat(40),
    train: [
      task(1, [{ path: "mod/src/A.java" }, { path: "mod/src/B.java" }]),
      task(2, [{ path: "mod/src/A.java" }, { path: "mod/src/test/FooTest.java" }])
    ],
    holdout: []
  };
  const filtered = generateGoldenScenarios(payload, root, { a1NeutralFilter: true, holdoutRatio: 0 });
  assert.equal(filtered.dropped.a1Noisy, 1);
  assert.equal(filtered.filterPassed, 1);
  assert.equal(filtered.scenarios.length, 1);
  assert.deepEqual(filtered.scenarios[0].golden.mustHit, ["mod/src/A.java", "mod/src/B.java"]);
  const unfiltered = generateGoldenScenarios(payload, root, { holdoutRatio: 0 });
  assert.equal(unfiltered.scenarios.length, 2);
});

test("quality fail when fewer than 20 surviving scenes", async () => {
  const root = await pinRepo(["src/A.java", "src/B.java"]);
  const payload = {
    project: "fixture",
    head: "d".repeat(40),
    train: [task(1, [{ path: "src/A.java" }, { path: "src/B.java" }])],
    holdout: []
  };
  const result = generateGoldenScenarios(payload, root);
  assert.equal(result.decision, "G1_QUALITY_FAIL");
  assert.equal(result.quality.n < G1_MIN_SCENARIOS, true);
});

test("quality report flags thin mustHit above 30%", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    evaluationSplit: index < 7 ? "tuning" : "holdout",
    golden: { mustHit: index < 4 ? ["only.java"] : ["a.java", "b.java"] }
  }));
  const report = qualityReport(rows);
  assert.equal(report.thinMustHit, 4);
  assert.ok(report.thinOrNoiseRate > 0.3);
  assert.equal(report.failed, true);
});

test("frozen ruoyi jsonl loads through golden-scenario without retuning holdout", async () => {
  const file = path.resolve("golden/ruoyi-vue-pro.scenarios.jsonl");
  const dist = path.resolve("dist/benchmark/golden-scenario.js");
  if (!existsSync(file) || !existsSync(dist)) return;
  const { loadScenarios } = await import(pathToFileURL(dist).href);
  const rows = loadScenarios(file);
  assert.equal(rows.length >= G1_MIN_SCENARIOS, true);
  assert.equal(rows.filter(row => row.evaluationSplit === "holdout").length >= G1_MIN_HOLDOUT, true);
  assert.ok(rows.every(row => row.repoCommit === PIN_RUOYI));
  assert.ok(rows.every(row => (row.golden?.mustHit ?? []).length >= 2));
  assert.equal(JSON.stringify(rows).includes("TaskSuccess"), false);
});

test("generator does not invent TaskSuccess or special-case three-repo holdout ids", async () => {
  const root = await pinRepo(["src/A.java", "src/B.java"]);
  const payload = {
    project: "fixture",
    head: "e".repeat(40),
    train: [task(1, [{ path: "src/A.java" }, { path: "src/B.java" }])],
    holdout: []
  };
  const result = generateGoldenScenarios(payload, root);
  const blob = JSON.stringify(result);
  assert.equal(blob.includes("TaskSuccess"), false);
  assert.equal(blob.includes("exam-score-export"), false);
  assert.equal(blob.includes("paper-task-claim"), false);
  assert.equal(collectCommitTasks(payload).length, 1);
  assert.equal(G1_MAX_SCENARIOS, 40);
  assert.equal(G1_MIN_HOLDOUT, 6);
});
