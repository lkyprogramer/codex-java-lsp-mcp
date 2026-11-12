import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { predictedIntent, runDiagnosis } from "./ilv2-ranking-diagnosis.mjs";
import { STRATEGIES, bestRank, candidateKey, checkAgainstRows, responseBytes, runSimulation, simulate } from "./ilv2-merge-simulation.mjs";

const cand = (relativePath, line, name = "x") => ({ declaration: { id: `${relativePath}#${name}@${line}`, relativePath, name, fqn: `demo.${name}`, kind: "method", selection: { line, column: 5 } }, matchedBy: ["exact"] });
const at = file => `src/main/java/demo/${file}.java`;
const target = (file, line) => ({ path: at(file), startLine: line, endLine: line + 2 });

const hit = cand(at("Order"), 10, "Order");
const responses = {
  Order: { auto: { exact: "match", candidates: [hit] }, text: { candidates: [hit, cand(at("Caller"), 30), cand(at("Impl"), 50)] } },
  Ledger: { auto: { exact: "miss", candidates: [] }, text: { candidates: [cand(at("Noise"), 5), cand(at("Ledger"), 20)] } },
  "refund flow": { auto: { candidates: [cand(at("Flow"), 40)] } }
};
const plan = { terms: ["Order", "Ledger", "refund flow"] };

test("strategies: the exact hit stays first, text fills without duplicates, a miss stays empty unless fillAlways", () => {
  const paths = list => list.map(item => item.declaration.relativePath);
  assert.deepEqual(paths(STRATEGIES.baseline(responses.Order)), [at("Order")]);
  assert.deepEqual(paths(STRATEGIES.fillAfterHit(responses.Order)), [at("Order"), at("Caller"), at("Impl")], "the exact hit reappearing in text is de-duplicated");
  assert.deepEqual(STRATEGIES.fillAfterHit(responses.Ledger), [], "R07: a miss never falls back");
  assert.deepEqual(paths(STRATEGIES.fillAlways(responses.Ledger)), [at("Noise"), at("Ledger")]);
  assert.deepEqual(paths(STRATEGIES.interleaveAlways({ auto: { exact: "ambiguous", candidates: [cand(at("A"), 1), cand(at("B"), 1)] }, text: { candidates: [cand(at("C"), 1), cand(at("A"), 1)] } })),
    [at("A"), at("C"), at("B")]);
  for (const strategy of Object.values(STRATEGIES)) assert.deepEqual(strategy(responses["refund flow"]), responses["refund flow"].auto.candidates, "text-route terms are never changed");
  assert.notEqual(candidateKey(cand(at("M"), 3)), candidateKey({ ...cand(at("M"), 3), evidenceRange: { relativePath: "m.xml", startLine: 9 } }), "an XML evidence source is its own candidate");
});

test("simulate: gains are attributed to the route outcome, no strategy beats best-of-both, counts only", () => {
  const tasks = [{ taskId: "T1", category: "callers", plan, responses, targets: [target("Order", 10), target("Caller", 30), target("Ledger", 20), target("Flow", 40), { path: "m.xml", startLine: 1, endLine: 2 }] }];
  const summary = simulate(tasks);
  assert.deepEqual(summary.termsByOutcome, { match: 1, ambiguous: 0, miss: 1, text: 1 });
  assert.deepEqual(summary.bestOfBothHitAt, { 1: 2, 3: 4, 5: 4, 8: 4, 20: 4 });
  assert.deepEqual(summary.strategies.baseline.hitAt, { 1: 2, 3: 2, 5: 2, 8: 2, 20: 2 });
  assert.deepEqual(summary.strategies.fillAfterHit.gainedVsBaseline[3], { match: 1, ambiguous: 0, miss: 0, text: 0 });
  assert.deepEqual(summary.strategies.fillAlways.gainedVsBaseline[3], { match: 1, ambiguous: 0, miss: 1, text: 0 });
  assert.equal(summary.strategies.fillAlways.lostVsBaseline[3], 0);
  assert.deepEqual(summary.strategies.fillAlways.hitAtByKind.other, { 1: 0, 3: 0, 5: 0, 8: 0, 20: 0 });
  assert.equal(summary.strategies.fillAlways.fullRecallTasks[8], 0, "the XML target is unreachable");
  for (const item of Object.values(summary.strategies)) assert.equal(item.exceedsBestOfBoth, false);
  const exact8 = summary.strategies.fillAfterHit.perLimit[8];
  assert.deepEqual([exact8.candidatesPerExactTerm.p50, exact8.candidatesPerExactTerm.max], [0, 3]);
  assert.equal(summary.strategies.fillAfterHit.perLimit[3].distinctFilesPerTask.p50, 4);
  assert.ok(summary.strategies.fillAfterHit.perLimit[8].locatorBytesPerExactTerm.max > summary.strategies.baseline.perLimit[8].locatorBytesPerExactTerm.max);
  assert.equal(summary.strategies.baseline.perLimit[8].headPreviewBoundBytesPerTerm.max, 1024);
  assert.equal(responseBytes(responses.Order, STRATEGIES.baseline(responses.Order), 8), Buffer.byteLength(JSON.stringify(responses.Order.auto)));
  assert.doesNotMatch(JSON.stringify(summary), /demo|Order|Ledger|T1/);
});

test("checkAgainstRows refuses a rank that differs from W1", () => {
  const tasks = [{ taskId: "T1", plan, responses, targets: [target("Order", 10), target("Ledger", 20)] }];
  const row = rank => ({ taskId: "T1", targets: [{ rank: 1, counterfactual: { textRoute: 1 } }, { rank, counterfactual: { textRoute: 2 } }] });
  assert.equal(checkAgainstRows({ tasks, rows: [row(null)] }), 0);
  assert.equal(checkAgainstRows({ tasks, rows: [row(2)] }), 1);
  assert.equal(checkAgainstRows({ tasks, rows: [row(null), { taskId: "T9", targets: [] }] }), 1, "a W1 row without responses");
  assert.equal(bestRank(plan, responses, target("Ledger", 20), STRATEGIES.fillAlways).outcome, "miss");
});

async function copyMaterialize({ record, corpus, oraclesRoot, target: out }) {
  cpSync(record.repoRoot, out, { recursive: true, filter: src => !path.relative(record.repoRoot, src).split(path.sep).includes(".git") });
  for (const overlay of corpus.overlays) {
    const text = await readFile(path.join(oraclesRoot, overlay.taskId, "pre-state.java"), "utf8");
    assert.equal(sha256(text), overlay.preStateSha256);
    await writeFile(path.join(out, overlay.path), text);
  }
  for (const file of corpus.hidden ?? []) await rm(path.join(out, file.path));
  return out;
}

test("runSimulation replays real W1 output: self-check passes, tampered rows and holdout gold are refused", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "merge-simulation-"));
  t.after(() => removeTree(dir));
  const fixture = await evalFixture(dir);
  const datasetDir = path.join(dir, "dataset");
  await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  const datasetFile = path.join(datasetDir, "dataset-manifest.json");
  const goldFile = path.join(datasetDir, "private/gold-dev.jsonl");
  const tasksFile = path.join(datasetDir, "tasks-dev.jsonl");
  const gold = readFileSync(goldFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const firstEvidence = new Map(gold.map(row => [row.taskId, row.requiredEvidence[0]]));
  const tasks = readFileSync(tasksFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const dist = path.join(dir, "dist");
  await mkdir(dist);
  await writeFile(path.join(dist, "build-stamp.json"), JSON.stringify({ gitSha: "fixture" }));
  // Exact-shaped terms answer with a decoy only; their text route carries the task's first evidence at rank 2.
  const openSession = async () => ({
    readyMs: 1,
    call: async (_name, args) => {
      const task = tasks.find(item => (item.anchors ?? []).includes(args.query) || String(item.prompt).includes(`\`${args.query}\``));
      const evidence = task && firstEvidence.get(task.taskId);
      const decoy = cand("decoy/Decoy.java", 1, "Decoy");
      if (predictedIntent(args.query) === "exact" && !args.searchMode && !args.terms) return { exact: "match", candidates: [decoy] };
      return { candidates: [cand("noise/Noise.java", 1, "Noise"), ...(evidence ? [cand(evidence.path, evidence.startLine, "Goal")] : [])] };
    },
    close: async () => {}
  });
  const w1 = path.join(dir, "w1");
  await runDiagnosis({ datasetFile, tasksFile, goldFile, inputsFile: fixture.inputsFile, serverJs: path.join(dist, "server.js"), out: w1, openSession, materialize: copyMaterialize });
  const args = { datasetFile, goldFile, responsesFile: path.join(w1, "responses.jsonl"), rowsFile: path.join(w1, "rows.jsonl") };
  const report = await runSimulation({ ...args, out: path.join(dir, "sim") });
  assert.equal(report.selfCheck.mismatches, 0);
  const planned = tasks.filter(task => (task.anchors ?? []).some(anchor => predictedIntent(anchor) === "exact")).length;
  assert.ok(planned > 0);
  assert.equal(report.strategies.baseline.hitAt[20], 0, "exact answers carry only the decoy");
  assert.equal(report.strategies.fillAfterHit.hitAt[3], planned, "decoy, noise, goal: the first evidence lands at rank 3");
  assert.equal(report.strategies.fillAfterHit.hitAt[1], 0);
  assert.deepEqual(report.strategies.fillAfterHit.hitAt, report.strategies.fillAlways.hitAt, "every exact term matched");
  const serialized = readFileSync(path.join(dir, "sim/summary.json"), "utf8");
  for (const task of tasks) assert.ok(!serialized.includes(task.taskId));
  for (const row of gold) for (const item of row.requiredEvidence) assert.ok(!serialized.includes(item.path));
  const rows = readFileSync(args.rowsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const tampered = rows.map(row => ({ ...row, targets: row.targets.map(item => ({ ...item, rank: item.rank === null ? 1 : null })) }));
  const tamperedFile = path.join(dir, "rows-tampered.jsonl");
  await writeFile(tamperedFile, tampered.map(row => JSON.stringify(row)).join("\n") + "\n");
  await assert.rejects(runSimulation({ ...args, rowsFile: tamperedFile, out: path.join(dir, "sim2") }), /differ from W1 rows\.jsonl/);
  await assert.rejects(runSimulation({ ...args, goldFile: path.join(datasetDir, "private/gold-holdout.jsonl"), out: path.join(dir, "sim3") }), /never reads holdout gold/);
});
