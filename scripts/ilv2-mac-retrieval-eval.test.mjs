import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { buildSchedule, convertDataset, readJsonl } from "./ilv2-mac-eval-dataset.mjs";
import { FIX_TESTS, evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { DRIVER_KINDS, SLOT_STATUS, aggregate, materializeCorpus, nearestRank, planQueries, runRetrieval, scoreSlot } from "./ilv2-mac-retrieval-eval.mjs";

const RG = process.env.ILV2_RG_BIN ?? "/opt/homebrew/bin/rg";
const text = lines => lines.join("\n");
const receipt = (ordinal, file, startLine, lines, extra = {}) => {
  const body = text(lines);
  return { ordinal, path: file, startLine, endLine: startLine + lines.length - 1, text: body, sha256: sha256(body), bytes: Buffer.byteLength(body), atMs: ordinal * 10, ...extra };
};

test("scoreSlot: credit needs a received range that covers the evidence and hashes to the gold", () => {
  const required = [{ path: "A.java", startLine: 2, endLine: 3, sha256: sha256("b\nc") }, { path: "B.java", startLine: 1, endLine: 1, sha256: sha256("x") }];
  const full = scoreSlot({ status: "COMPLETE", required, receipts: [receipt(1, "Z.java", 1, ["z"]), receipt(2, "A.java", 1, ["a", "b", "c", "d"]), receipt(3, "B.java", 1, ["x"])] });
  assert.deepEqual([full.credited, full.recall, full.firstCorrect.ordinal, full.allRequired.ordinal], [2, 1, 2, 3]);
  assert.equal(full.firstCorrect.bytesThrough, 1 + 7, "bytes received up to the first correct evidence");
  // Missing evidence: B never received.
  assert.equal(scoreSlot({ status: "COMPLETE", required, receipts: [receipt(1, "A.java", 2, ["b", "c"])] }).recall, 0.5);
  // Wrong hash: the right range with other bytes (a stale corpus) earns nothing.
  const stale = scoreSlot({ status: "COMPLETE", required, receipts: [receipt(1, "A.java", 1, ["a", "B", "c"])] });
  assert.deepEqual([stale.credited, stale.wrongHash, stale.firstCorrect], [0, 1, null]);
  // Partial: a window that cuts the evidence is not credit.
  assert.deepEqual(Object.values((({ credited, partial }) => ({ credited, partial }))(scoreSlot({ status: "COMPLETE", required, receipts: [receipt(1, "A.java", 3, ["c", "d"])] }))), [0, 1]);
  // Duplicate candidates: the same range twice counts once and is reported.
  const twice = scoreSlot({ status: "COMPLETE", required, receipts: [receipt(1, "A.java", 2, ["b", "c"]), receipt(2, "A.java", 2, ["b", "c"])] });
  assert.deepEqual([twice.credited, twice.duplicates, twice.bytes], [1, 1, 6]);
  // A missing slot received nothing and keeps its status.
  assert.deepEqual((({ status, recall, receipts }) => ({ status, recall, receipts }))(scoreSlot({ status: "MISSING", required, receipts: [] })), { status: "MISSING", recall: 0, receipts: 0 });
});

test("aggregate: every planned slot is in the denominator; timeouts and missing slots are not zero-latency hits", () => {
  const slot = (driverId, status, recall, firstMs) => ({ driverId, score: { status, recall, required: 2, credited: recall * 2, bytes: 10, duplicates: 0, wrongHash: 0, partial: 0,
    firstCorrect: firstMs == null ? null : { elapsedMs: firstMs, bytesThrough: 5 } } });
  const report = aggregate([slot("p", "COMPLETE", 1, 30), slot("p", "TIMEOUT", 0.5, 90), slot("p", "MISSING", 0, null), slot("p", "ERROR", 0, null)]);
  assert.equal(report.p.planned, 4);
  assert.equal(report.p.meanRecall, 1.5 / 4);
  assert.deepEqual(report.p.status, { COMPLETE: 1, TIMEOUT: 1, MISSING: 1, ERROR: 1 });
  assert.deepEqual([report.p.firstCorrect.n, report.p.firstCorrect.p50Ms, report.p.firstCorrect.maxMs], [2, 30, 90]);
  assert.equal(nearestRank([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(nearestRank([], 0.5), null);
});

test("planQueries reads only the marked identifiers of the agent-visible task: anchors first, then backtick spans, capped", () => {
  const plan = planQueries({ taskId: "T", anchors: ["PriceRule"], prompt: "Which classes implement `PriceRule` and call `OrderService.total` via quoteAmount? A method is written fqcn#methodName. `A1` `B2` `C3` `D4` `E5`" });
  assert.deepEqual(plan.terms, ["PriceRule", "OrderService.total", "A1", "B2", "C3", "D4"]);
  // A pure-symptom report marks nothing: the plan is empty, never mined from prose.
  assert.deepEqual(planQueries({ taskId: "R", anchors: [], prompt: "Uploading an EmptyFile via FileService.upload returns the wrong type." }).terms, []);
});

async function fixtureRun(t, { kinds, mutateGold, deadlineMs = 60000, drivers = [{ id: "native", kind: "native-rg/v1", rg: RG }] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac10-retrieval-"));
  t.after(() => removeTree(root));
  const fixture = await evalFixture(root);
  const datasetDir = path.join(root, `dataset-${Math.random().toString(36).slice(2)}`);
  if (mutateGold) {
    const curation = JSON.parse(await readFile(fixture.curationFile, "utf8"));
    mutateGold(curation);
    await writeFile(fixture.curationFile, `${JSON.stringify(curation)}\n`);
  }
  const manifest = await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  const tasksFile = path.join(datasetDir, "tasks-dev.jsonl");
  const scheduleFile = path.join(root, "schedule.jsonl");
  const rows = buildSchedule({ tasks: await readJsonl(tasksFile), drivers: drivers.map(driver => driver.id), repeats: 1, seed: "s", deadlineMs });
  await writeFile(scheduleFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const driversFile = path.join(root, "drivers.json");
  await writeFile(driversFile, `${JSON.stringify({ schema: "ilv2-mac10-drivers/v1", drivers })}\n`);
  const out = path.join(root, "run");
  const report = await runRetrieval({ datasetFile: path.join(datasetDir, "dataset-manifest.json"), tasksFile, goldFile: path.join(datasetDir, "private/gold-dev.jsonl"),
    scheduleFile, driversFile, inputsFile: fixture.inputsFile, out, driverKinds: { ...DRIVER_KINDS, ...kinds } });
  return { root, fixture, manifest, out, report, scheduleFile, datasetDir };
}

test("native-rg end to end: receipts are real reads of the corpus clone with the repair pre-state overlaid", async t => {
  const { out, report } = await fixtureRun(t);
  assert.equal(report.status, "MEASURED");
  const byTask = Object.fromEntries(report.slots.map(slot => [slot.taskId, slot.score]));
  assert.equal(byTask["FX-CALLERS"].recall, 1);
  assert.equal(byTask["FX-IMPLS"].recall, 1);
  // The repair evidence hash is the pre-state's: credit proves the clone carries the overlay, not the fix.
  assert.equal(byTask["FX-REPAIR"].required, 1);
  // The repair report marks no identifier: an empty plan is counted, not hidden as a zero-recall search.
  assert.equal(report.slots.find(slot => slot.taskId === "FX-REPAIR").planTerms, 0);
  assert.equal(report.byDriver.native.emptyPlanSlots, 1);
  const corpusCalc = await readFile(path.join(out, "corpora/fixture/src/main/java/demo/Calc.java"), "utf8");
  assert.doesNotMatch(corpusCalc, /value > high/);
  // The tests that would reveal the fix are not in the corpus a driver searches; an unrelated test is.
  for (const file of Object.keys(FIX_TESTS).concat("src/testFixtures/java/demo/CalcFixtures.java")) assert.equal(existsSync(path.join(out, "corpora/fixture", file)), false, file);
  assert.ok(existsSync(path.join(out, "corpora/fixture/src/test/java/demo/OrderControllerTest.java")));
  assert.equal(existsSync(path.join(out, "corpora/fixture/.git")), false, "the history that holds the fix is not cloned");
  const calls = await readJsonl(path.join(out, "calls.jsonl"));
  assert.ok(calls.every(call => call.receipts.every(item => item.sha256 === sha256(item.text))));
  const identity = JSON.parse(await readFile(path.join(out, "identity.json"), "utf8"));
  assert.match(identity.driverIdentities.native.rgSha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.planner, "anchor-identifier/v2");
});

test("gold is not an input of the plan or the calls: two golds, identical plans and receipts", async t => {
  const first = await fixtureRun(t);
  const second = await fixtureRun(t, { mutateGold: curation => {
    curation.tasks[1].answer.value.implementations = ["demo.FlatRule"];
    curation.tasks[1].evidence = curation.tasks[1].evidence.slice(0, 1);
  } });
  assert.notEqual(first.report.identity.goldSha256, second.report.identity.goldSha256);
  assert.equal(first.report.identity.planSha256, second.report.identity.planSha256);
  const receipts = async out => (await readJsonl(path.join(out, "calls.jsonl"))).map(call => call.receipts.map(item => [call.slotId, item.path, item.startLine, item.endLine, item.sha256]));
  assert.deepEqual(await receipts(first.out), await receipts(second.out));
});

test("a slot past its deadline is TIMEOUT, a failing driver ERROR, and both stay scored with what they received", async t => {
  const slow = () => ({ identity: async () => ({ kind: "slow" }), open: async () => ({
    query: async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { payloadBytes: 1, receipts: [] }; }, close: async () => {} }) });
  const broken = () => ({ identity: async () => ({ kind: "broken" }), open: async () => ({ query: async () => { throw new Error("tool exploded"); }, close: async () => {} }) });
  const { report } = await fixtureRun(t, { deadlineMs: 150, kinds: { "slow/v1": slow, "broken/v1": broken },
    drivers: [{ id: "slow", kind: "slow/v1" }, { id: "broken", kind: "broken/v1" }] });
  assert.equal(report.status, "INCOMPLETE");
  // FX-REPAIR's agent-visible text names no code identifier: an empty plan has nothing to time out.
  assert.deepEqual(report.byDriver.slow.status, { TIMEOUT: 2, COMPLETE: 1 });
  assert.deepEqual(report.byDriver.broken.status, { ERROR: 2, COMPLETE: 1 });
  assert.equal(report.byDriver.slow.meanRecall, 0);
  assert.ok(report.slots.filter(slot => slot.driverId === "broken" && slot.taskId !== "FX-REPAIR").every(slot => /tool exploded/.test(slot.error)));
});

test("a tasks file or gold that is not a part of the dataset is refused before any slot runs", async t => {
  const { root, fixture, datasetDir, scheduleFile } = await fixtureRun(t);
  const driversFile = path.join(root, "drivers.json");
  const tampered = path.join(root, "gold-other.jsonl");
  await writeFile(tampered, (await readFile(path.join(datasetDir, "private/gold-dev.jsonl"), "utf8")).replace("demo.FlatRule", "demo.Other"));
  await assert.rejects(runRetrieval({ datasetFile: path.join(datasetDir, "dataset-manifest.json"), tasksFile: path.join(datasetDir, "tasks-dev.jsonl"), goldFile: tampered,
    scheduleFile, driversFile, inputsFile: fixture.inputsFile, out: path.join(root, "run-2") }), /not this dataset's dev gold/);
});

test("materializeCorpus refuses an overlay or an evidence file that is not the frozen one", async t => {
  const { root, fixture, datasetDir } = await fixtureRun(t);
  const record = JSON.parse(await readFile(fixture.inputsFile, "utf8")).find(row => row.name === "fixture");
  const corpus = JSON.parse(await readFile(path.join(datasetDir, "corpus-manifest.json"), "utf8")).corpora.find(row => row.corpusId === "fixture");
  const oraclesRoot = path.join(datasetDir, "private/oracles");
  assert.equal(corpus.overlays.length, 1);
  await assert.rejects(materializeCorpus({ record, oraclesRoot, target: path.join(root, "m-1"),
    corpus: { ...corpus, overlays: corpus.overlays.map(row => ({ ...row, preStateSha256: "0".repeat(64) })) } }), /overlay FX-REPAIR changed/);
  await assert.rejects(materializeCorpus({ record, oraclesRoot, target: path.join(root, "m-2"),
    corpus: { ...corpus, evidenceFiles: corpus.evidenceFiles.map(row => row.path === corpus.overlays[0].path ? row : { ...row, sha256: "0".repeat(64) }) } }), /differs from the frozen input/);
  await assert.rejects(materializeCorpus({ record, oraclesRoot, target: path.join(root, "m-3"),
    corpus: { ...corpus, hidden: corpus.hidden.map((row, index) => index === 0 ? { ...row, sha256: "0".repeat(64) } : row) } }), /hidden test .* differs from the frozen input/);
});

test("product-mcp: the candidate's static query locates the evidence through its own isolated owner", { timeout: 300000 }, async t => {
  const serverJs = path.resolve("dist/server.js");
  const { report, out } = await fixtureRun(t, { deadlineMs: 120000, drivers: [{ id: "product", kind: "product-mcp/v1", serverJs, readyTimeoutMs: 120000 }] });
  assert.equal(report.status, "MEASURED", JSON.stringify(report.sessions));
  const byTask = Object.fromEntries(report.slots.map(slot => [slot.taskId, slot.score]));
  const received = (await readJsonl(path.join(out, "calls.jsonl"))).map(call => [call.slotId, call.receipts.map(item => `${item.term}:${item.path}:${item.startLine}`)]);
  assert.equal(byTask["FX-IMPLS"].recall, 1, JSON.stringify(received));
  assert.ok(report.sessions["fixture/product"].readyMs > 0);
});
