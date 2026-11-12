import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { CORE_EXCEEDED_GAP, IMPACT_CONFIGS, compactSpanKeys, diagnosticSpanKeys, labelTarget, observeTask, projectionMismatches, runImpactDiagnosis } from "./ilv2-impact-budget-diagnosis.mjs";

const coreGap = `${CORE_EXCEEDED_GAP}; lower-value core files were omitted.`;
const impact = ({ selected, pool, gaps = [] }) => ({
  compact: { contexts: selected.map(([file, s, e]) => ({ path: file, role: "IMP", spans: [{ s, e, b: 1 }] })), freshness: { coverage: "COMPLETE" }, semantic: { completion: "COMPLETE" } },
  compactBytes: 10,
  diagnostic: {
    files: pool.map(([file, role, reasons = []], index) => ({ id: `F${index + 1}`, path: file, role, reasons })),
    readPlan: selected.map(([file, s, e]) => ({ fileId: `F${pool.findIndex(([name]) => name === file) + 1}`, ranges: [{ startLine: s, endLine: e }] })),
    evidenceGaps: gaps, freshness: { coverage: "COMPLETE" }, semantic: { completion: "COMPLETE" }, status: null
  }
});

test("compact and diagnostic projections are compared span by span", () => {
  const call = impact({ selected: [["A.java", 3, 9]], pool: [["A.java", "IMP"], ["B.java", "COL"]] });
  assert.deepEqual(compactSpanKeys(call.compact), ["A.java:3-9"]);
  assert.deepEqual(diagnosticSpanKeys(call.diagnostic), ["A.java:3-9"]);
  assert.equal(projectionMismatches([{ terms: [{ impacts: { C0: call } }] }]), 0);
  const drifted = { ...call, compact: { contexts: [{ path: "A.java", spans: [{ s: 3, e: 8 }] }] } };
  assert.equal(projectionMismatches([{ terms: [{ impacts: { C0: call, C1: drifted } }] }]), 1);
});

test("labelTarget separates received, range miss, unselected (with the core cap) and pool absence", () => {
  const item = { path: "B.java", startLine: 10, endLine: 20 };
  const observation = calls => ({ terms: [{ impacts: calls }] });
  assert.deepEqual(labelTarget({ item, credited: true, receipts: [{ path: "B.java", startLine: 1, endLine: 30, source: "symbol" }], observation: observation({}), configName: "C0" }), { label: "SYMBOL_WINDOW" });
  assert.deepEqual(labelTarget({ item, credited: true, receipts: [{ path: "B.java", startLine: 10, endLine: 20, source: "impact" }], observation: observation({}), configName: "C0" }), { label: "IMPACT_SPAN" });
  assert.deepEqual(labelTarget({ item, credited: false, receipts: [], observation: { terms: [{ impacts: {} }] }, configName: "C0" }), { label: "NO_IMPACT_CALL" });
  const pool = [["A.java", "TGT"], ["B.java", "IMP"]];
  assert.deepEqual(labelTarget({ item, credited: false, receipts: [], observation: observation({ C0: impact({ selected: [["A.java", 1, 2]], pool, gaps: [coreGap] }) }), configName: "C0" }),
    { label: "UNSELECTED", role: "IMP", coreExceeded: true, protectedReason: false, coreCapped: false }, "a call-level gap alone does not blame the core cap");
  assert.deepEqual(labelTarget({ item, credited: false, receipts: [], observation: observation({ C0: impact({ selected: [["A.java", 1, 2]], pool: [["A.java", "TGT"], ["B.java", "IMP", ["IMPLEMENTS"]]], gaps: [coreGap] }) }), configName: "C0" }),
    { label: "UNSELECTED", role: "IMP", coreExceeded: true, protectedReason: true, coreCapped: true });
  assert.deepEqual(labelTarget({ item, credited: false, receipts: [], observation: observation({ C0: impact({ selected: [["B.java", 10, 12]], pool }) }), configName: "C0" }),
    { label: "SELECTED_RANGE_MISS", overlapping: true });
  assert.deepEqual(labelTarget({ item, credited: false, receipts: [], observation: observation({ C0: impact({ selected: [["A.java", 1, 2]], pool: [["A.java", "TGT"]] }) }), configName: "C0" }), { label: "POOL_ABSENT" });
});

test("observeTask issues the driver's calls: java_symbol at limit 8, then java_impact at the first candidate per configuration, compact and diagnostic", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, ...args });
    if (name === "java_symbol") return { value: args.query === "Calc" ? { exact: "match", candidates: [{ declaration: { relativePath: "C.java", selection: { line: 3, column: 14 } } }] } : { candidates: [] }, bytes: 5 };
    return { value: { contexts: [], files: [], readPlan: [] }, bytes: 7 };
  };
  const observation = await observeTask({ task: { taskId: "T", anchors: ["Calc", "nothing here"], prompt: "" }, call });
  assert.deepEqual(calls.filter(item => item.name === "java_symbol").map(item => [item.query, item.limit, item.preview]), [["Calc", 8, "none"], ["nothing here", 8, "none"]]);
  const impacts = calls.filter(item => item.name === "java_impact");
  assert.equal(impacts.length, Object.keys(IMPACT_CONFIGS).length * 2, "no impact call without a candidate");
  assert.deepEqual(impacts.slice(0, 2).map(item => [item.file, item.line, item.column, item.mode, item.readPlanMaxItems, item.semanticPolicy, item.verbosity, item.deadlineMs]),
    [["C.java", 3, 14, "balanced", undefined, "fast", "compact", 15000], ["C.java", 3, 14, "balanced", undefined, "fast", "diagnostic", 15000]]);
  assert.deepEqual(impacts.filter(item => item.verbosity === "compact").map(item => [item.mode, item.readPlanMaxItems]), [["balanced", undefined], ["balanced", 12], ["balanced", 20], ["recall", undefined]]);
  assert.equal(observation.terms[0].exact, "match");
  assert.deepEqual(observation.terms[1].impacts, {});
});

async function copyMaterialize({ record, corpus, oraclesRoot, target }) {
  cpSync(record.repoRoot, target, { recursive: true, filter: src => !path.relative(record.repoRoot, src).split(path.sep).includes(".git") });
  for (const overlay of corpus.overlays) {
    const text = await readFile(path.join(oraclesRoot, overlay.taskId, "pre-state.java"), "utf8");
    assert.equal(sha256(text), overlay.preStateSha256);
    await writeFile(path.join(target, overlay.path), text);
  }
  for (const file of corpus.hidden ?? []) await rm(path.join(target, file.path));
  return target;
}

test("runImpactDiagnosis scores every configuration with the runner's reader, calibrates C0 first and keeps the summary counts-only", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "impact-budget-"));
  t.after(() => removeTree(dir));
  const fixture = await evalFixture(dir);
  const datasetDir = path.join(dir, "dataset");
  await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  const datasetFile = path.join(datasetDir, "dataset-manifest.json");
  const tasksFile = path.join(datasetDir, "tasks-dev.jsonl");
  const goldFile = path.join(datasetDir, "private/gold-dev.jsonl");
  const tasks = readFileSync(tasksFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const gold = new Map(readFileSync(goldFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).map(row => [row.taskId, row.requiredEvidence]));
  const dist = path.join(dir, "dist");
  await mkdir(dist);
  await writeFile(path.join(dist, "build-stamp.json"), JSON.stringify({ gitSha: "fixture" }));
  const decoy = "src/main/java/demo/OrderController.java";
  // C0 keeps the decoy only and reports the core cap; C1 adds the first gold range, C2 every gold range; C3 selects the gold files with a one-line span.
  let current = null;
  const callRaw = async (name, args) => {
    if (name === "java_symbol") {
      current = tasks.find(task => (task.anchors ?? []).includes(args.query) || String(task.prompt).includes(`\`${args.query}\``));
      return { value: { exact: "match", candidates: [{ declaration: { relativePath: decoy, selection: { line: 1, column: 1 } } }] }, bytes: 50 };
    }
    const evidence = gold.get(current.taskId);
    const config = args.mode === "recall" ? "C3" : args.readPlanMaxItems === 12 ? "C1" : args.readPlanMaxItems === 20 ? "C2" : "C0";
    const chosen = { C0: [], C1: evidence.slice(0, 1), C2: evidence, C3: evidence.map(item => ({ ...item, endLine: item.startLine })) }[config];
    const call = impact({ selected: [[decoy, 1, 2], ...chosen.map(item => [item.path, item.startLine, item.endLine])],
      pool: [[decoy, "TGT"], ...evidence.map(item => [item.path, "IMP", ["IMPLEMENTS"]])], gaps: config === "C0" ? [coreGap] : [] });
    return args.verbosity === "compact" ? { value: call.compact, bytes: 100 } : { value: call.diagnostic, bytes: 400 };
  };
  const openSession = async () => ({ readyMs: 1, callRaw, call: async (name, args) => (await callRaw(name, args)).value, close: async () => {} });
  const base = { datasetFile, tasksFile, goldFile, inputsFile: fixture.inputsFile, serverJs: path.join(dist, "server.js"), openSession, materialize: copyMaterialize };
  const taskIds = tasks.map(task => task.taskId);
  await assert.rejects(runImpactDiagnosis({ ...base, out: path.join(dir, "bad"), calibration: { taskIds, meanRecall: 0.5, fullRecallTasks: 0 } }), /does not reproduce W2/);
  const failed = JSON.parse(readFileSync(path.join(dir, "bad/summary.json"), "utf8"));
  assert.equal(failed.calibration.status, "FAIL");
  assert.equal(failed.dev, undefined, "no configuration numbers after a failed calibration");
  const summary = await runImpactDiagnosis({ ...base, out: path.join(dir, "out"), calibration: { taskIds, meanRecall: 0, fullRecallTasks: 0 } });
  assert.equal(summary.calibration.status, "PASS");
  const { C0, C1, C2, C3 } = summary.dev;
  const planned = tasks.filter(task => (task.anchors ?? []).length > 0);
  const plannedTargets = planned.reduce((sum, task) => sum + gold.get(task.taskId).length, 0);
  assert.equal(C0.creditedTargets, 0);
  assert.equal(C0.labels.UNSELECTED, plannedTargets);
  assert.equal(C0.unselectedWithCoreExceeded, plannedTargets);
  assert.equal(C0.unselectedCoreCappedJava, plannedTargets);
  assert.equal(C0.uncreditedJava, C0.targets);
  assert.equal(C0.partialCalls, 0);
  assert.deepEqual(C0.callsByAnchorExact, { match: C0.calls });
  assert.equal(readFileSync(path.join(dir, "out/responses.jsonl"), "utf8").trim().split("\n").length, tasks.length);
  assert.deepEqual(C0.unselectedByRole, { IMP: plannedTargets });
  assert.equal(C0.labels.NO_IMPACT_CALL, C0.targets - plannedTargets, "the unplanned repair task makes no impact call");
  assert.equal(C0.coreExceededCalls, C0.calls);
  assert.equal(C1.creditedTargets, planned.length);
  assert.equal(C1.labels.IMPACT_SPAN, planned.length);
  assert.equal(C2.creditedTargets, plannedTargets);
  assert.equal(C2.gainedVsC0, plannedTargets);
  assert.equal(C2.lostVsC0, 0);
  assert.equal(C2.fullRecallTasks, planned.length);
  assert.ok(Math.abs(C2.meanRecall - planned.length / tasks.length) < 1e-9);
  assert.equal(C3.labels.SELECTED_RANGE_MISS, plannedTargets);
  assert.equal(C3.selectedRangeMissOverlapping, plannedTargets);
  assert.equal(C0.impactCallBytes.p50, 100, "the driver's compact wire bytes");
  assert.ok(C2.receivedBytesPerTask.mean > C0.receivedBytesPerTask.mean);
  const serialized = readFileSync(path.join(dir, "out/summary.json"), "utf8");
  for (const task of tasks) assert.ok(!serialized.includes(task.taskId));
  for (const items of gold.values()) for (const item of items) assert.ok(!serialized.includes(item.path));
  await assert.rejects(runImpactDiagnosis({ ...base, goldFile: path.join(datasetDir, "private/gold-holdout.jsonl"), out: path.join(dir, "h"), calibration: { taskIds, meanRecall: 0, fullRecallTasks: 0 } }), /not this dataset's dev gold/);
});
