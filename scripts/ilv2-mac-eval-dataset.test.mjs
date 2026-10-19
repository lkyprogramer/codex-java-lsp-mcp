import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { assignSplits, buildSchedule, convertDataset, leaks, rangeHash, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";

async function withFixture(t, options, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac10-dataset-"));
  t.after(() => removeTree(root));
  const fixture = await evalFixture(root, options);
  const convert = (out = path.join(root, `dataset-${Math.random().toString(36).slice(2)}`)) =>
    convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out }).then(manifest => ({ manifest, out }));
  return body({ ...fixture, convert });
}

test("convert: agent-visible parts carry no gold, private parts are owner-only, every part is in the digest", async t => {
  await withFixture(t, {}, async ({ convert, repoRoot }) => {
    const { manifest, out } = await convert();
    assert.equal(manifest.counts.total, 3);
    assert.deepEqual(manifest.counts.bySplit, { dev: 3 });
    const visible = (await readFile(path.join(out, "tasks-dev.jsonl"), "utf8")) + (await readFile(path.join(out, "answer-contract.json"), "utf8"));
    for (const secret of ["demo.OrderService", "demo.FlatRule", "demo.PercentRule", "OrderService.java", "Calc.java", "ClampOracle", "requiredEvidence"]) {
      assert.equal(visible.includes(secret), false, `agent-visible parts leak ${secret}`);
    }
    for (const file of ["private/gold-dev.jsonl", "private/gold-holdout.jsonl", "private/curation.json", "private/oracles/FX-REPAIR/oracle.json", "private/oracles/FX-REPAIR/ClampOracle.java", "private/oracles/FX-REPAIR/pre-state.java"]) {
      assert.equal((await stat(path.join(out, file))).mode & 0o777, 0o600, `${file} is not owner-only`);
    }
    const gold = await readJsonl(path.join(out, "private/gold-dev.jsonl"));
    const callers = gold.find(row => row.taskId === "FX-CALLERS");
    const service = await readFile(path.join(repoRoot, "src/main/java/demo/OrderService.java"), "utf8");
    assert.equal(callers.requiredEvidence[0].sha256, rangeHash(service, 10, 12));
    // Evidence inside the repair file is hashed on the pre-state the agent sees, not on the fix.
    const repair = gold.find(row => row.taskId === "FX-REPAIR");
    const preState = await readFile(path.join(out, "private/oracles/FX-REPAIR/pre-state.java"), "utf8");
    assert.equal(repair.requiredEvidence[0].sha256, rangeHash(preState, 7, 12));
    assert.match(preState, /return value;\n    }\n}/);
    assert.doesNotMatch(preState, /value > high/);
    // The fix commit's tests and the tests naming the repaired class leave the corpus; an unrelated test stays.
    const [corpus] = JSON.parse(await readFile(path.join(out, "corpus-manifest.json"), "utf8")).corpora;
    assert.deepEqual(corpus.hidden.map(row => [row.path, row.taskIds]), [["src/test/java/demo/CalcTest.java", ["FX-REPAIR"]],
      ["src/test/resources/demo/clamp-cases.txt", ["FX-REPAIR"]], ["src/testFixtures/java/demo/CalcFixtures.java", ["FX-REPAIR"]]]);
    assert.equal(corpus.hidden[0].sha256, sha256(await readFile(path.join(repoRoot, "src/test/java/demo/CalcTest.java"))));
    const verified = await verifyDataset(path.join(out, "dataset-manifest.json"));
    assert.equal(verified.manifest.datasetDigest, manifest.datasetDigest);
    // Any changed byte in any part breaks the identity.
    await writeFile(path.join(out, "private/gold-dev.jsonl"), (await readFile(path.join(out, "private/gold-dev.jsonl"), "utf8")).replace("demo.OrderService", "demo.OrderController"));
    await assert.rejects(verifyDataset(path.join(out, "dataset-manifest.json")), /dataset part gold-dev changed/);
  });
});

test("convert refuses an unverified task, a commit file used as evidence unverified, and leaked gold", async t => {
  await withFixture(t, {}, async fixture => {
    const variants = [
      [task => { delete task.verification.notes; }, /unverified/],
      [task => { delete task.evidence[0].fromCommitFiles; }, /changed file of the source commit/],
      [task => { task.prompt = `${task.prompt} Hint: it is demo.OrderService.`; }, /leaks gold: answer=demo.OrderService/],
      [task => { task.prompt = `${task.prompt} Look in src/main/java/demo/OrderService.java first.`; }, /evidence-path/],
      [task => { task.source.commit = "f".repeat(40); }, /not a jin-commit-tasks\/v1 candidate/]
    ];
    for (const [mutate, message] of variants) {
      const curation = JSON.parse(await readFile(fixture.curationFile, "utf8"));
      mutate(curation.tasks[0]);
      await writeFile(fixture.curationFile, `${JSON.stringify(curation)}\n`);
      await assert.rejects(fixture.convert(), message);
      await writeFile(fixture.curationFile, `${JSON.stringify({ ...curation, tasks: fixture.defaults })}\n`);
    }
  });
});

test("convert refuses QA evidence inside another task's repair overlay", async t => {
  await withFixture(t, {}, async fixture => {
    const curation = JSON.parse(await readFile(fixture.curationFile, "utf8"));
    curation.tasks[1].evidence.push({ path: "src/main/java/demo/Calc.java", startLine: 3, endLine: 5, why: "the clamp holder class", fromCommitFiles: true });
    await writeFile(fixture.curationFile, `${JSON.stringify(curation)}\n`);
    await assert.rejects(fixture.convert(), /overlaid by repair FX-REPAIR/);
  });
});

test("leaks: anchors may be named, the answer and the evidence files may not", () => {
  const task = { prompt: "Who calls `Calc.clamp`?", anchors: ["Calc"], answer: { value: { callers: ["demo.OrderService"] } },
    evidence: [{ path: "src/demo/Calc.java" }, { path: "src/demo/OrderService.java" }] };
  assert.deepEqual(leaks(task), []);
  assert.deepEqual(leaks({ ...task, anchors: [] }).map(item => item.kind), ["evidence-file"]);
  assert.deepEqual(leaks({ ...task, prompt: "Is it OrderService?" }).map(item => item.value), ["OrderService"]);
});

test("holdout: per-stratum 30% by seeded hash, pinned dev tasks never drawn, deterministic", () => {
  const tasks = [];
  for (const repo of ["a", "b"]) for (const category of ["callers", "repair"]) for (let index = 0; index < 10; index += 1) {
    tasks.push({ id: `${repo}-${category}-${index}`, repo, category, pinnedDev: index === 0 });
  }
  const split = assignSplits(tasks, { ratio: 0.3, seed: "s1" });
  for (const repo of ["a", "b"]) for (const category of ["callers", "repair"]) {
    const members = tasks.filter(task => task.repo === repo && task.category === category);
    assert.equal(members.filter(task => split.get(task.id) === "holdout").length, 3);
    assert.equal(split.get(members[0].id), "dev", "a pinned dev task stays dev");
  }
  assert.deepEqual([...assignSplits(tasks, { ratio: 0.3, seed: "s1" })], [...split]);
  assert.notDeepEqual([...assignSplits(tasks, { ratio: 0.3, seed: "s2" })], [...split]);
  assert.throws(() => assignSplits(tasks.map(task => ({ ...task, pinnedDev: true })), { ratio: 0.3, seed: "s1" }), /holdout tasks needed/);
});

test("schedule: every task x driver x repeat once, seeded order, bounded deadline", () => {
  const tasks = [{ taskId: "T1", corpusId: "x" }, { taskId: "T2", corpusId: "x" }, { taskId: "T3", corpusId: "y" }];
  const rows = buildSchedule({ tasks, drivers: ["native", "product"], repeats: 2, seed: "s", deadlineMs: 60000 });
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map(row => row.slotId)).size, 12);
  assert.deepEqual(rows, buildSchedule({ tasks, drivers: ["native", "product"], repeats: 2, seed: "s", deadlineMs: 60000 }));
  assert.equal(sha256(JSON.stringify(rows)) === sha256(JSON.stringify(buildSchedule({ tasks, drivers: ["native", "product"], repeats: 2, seed: "t", deadlineMs: 60000 }))), false);
  assert.throws(() => buildSchedule({ tasks, drivers: ["native"], repeats: 1, seed: "s", deadlineMs: 0 }), /bounded deadline/);
});
