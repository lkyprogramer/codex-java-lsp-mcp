// MAC-10 full chain on the frozen dataset named by ILV2_MAC10_DATASET (a dataset-manifest.json in the work root):
// identity, oracle stability, the pinned dev tasks through both retrieval drivers on the real product, and the
// paired comparison. Only aggregates and digests reach ILV2_EVIDENCE_ROOT; tasks, gold and receipts stay private.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { buildSchedule, leaks, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { frozenJavaHome, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { pairedCompare } from "./ilv2-mac-paired-compare.mjs";
import { checkOracles } from "./ilv2-mac-repair-oracle.mjs";
import { planQueries, runRetrieval } from "./ilv2-mac-retrieval-eval.mjs";

const DATASET = process.env.ILV2_MAC10_DATASET;
const INPUTS = process.env.ILV2_MAC10_INPUTS;
const RG = process.env.ILV2_RG_BIN ?? "/opt/homebrew/bin/rg";
const jsonl = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const visibleStrings = value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(visibleStrings)
  : value && typeof value === "object" ? Object.values(value).flatMap(visibleStrings) : [];

test("MAC-10 chain: frozen dataset, stable oracles, six pinned dev tasks through native and product, paired compare", { skip: !DATASET && "ILV2_MAC10_DATASET is not set" }, async t => {
  assert.ok(INPUTS, "ILV2_MAC10_INPUTS is required with ILV2_MAC10_DATASET");
  assert.ok(process.env.ILV2_EVIDENCE_ROOT, "ILV2_EVIDENCE_ROOT is required");
  const { root, manifest } = await verifyDataset(DATASET);
  const curation = JSON.parse(await readFile(path.join(root, "private/curation.json"), "utf8"));
  assert.equal(sha256(await readFile(path.join(root, "private/curation.json"))), manifest.createdFrom.curationSha256, "private curation is the one the dataset was built from");
  const tasksBytes = await readFile(path.join(root, manifest.parts["tasks-dev"].file));
  const goldBytes = await readFile(path.join(root, manifest.parts["gold-dev"].file));
  const devTasks = await readJsonl(path.join(root, manifest.parts["tasks-dev"].file));
  const allTasks = [...devTasks, ...await readJsonl(path.join(root, manifest.parts["tasks-holdout"].file))];
  const gold = [...await readJsonl(path.join(root, manifest.parts["gold-dev"].file)), ...await readJsonl(path.join(root, manifest.parts["gold-holdout"].file))];

  // Gold never reaches the agent: no agent-visible part names an answer, an evidence path or an oracle file.
  const visible = [await readFile(path.join(root, manifest.parts["tasks-dev"].file), "utf8"), await readFile(path.join(root, manifest.parts["tasks-holdout"].file), "utf8"),
    await readFile(path.join(root, manifest.parts["answer-contract"].file), "utf8")].join("\n");
  const anchors = new Set(allTasks.flatMap(task => task.anchors));
  for (const row of gold) {
    for (const value of visibleStrings(row.answer ?? {})) if (value.length >= 3 && !anchors.has(value)) assert.equal(visible.includes(value), false, `${row.taskId} answer is agent-visible`);
    for (const item of row.requiredEvidence) assert.equal(visible.includes(item.path), false, `${row.taskId} evidence path is agent-visible`);
  }
  assert.equal(/requiredEvidence|repairOracle|private\//.test(visible), false, "agent-visible parts reference private parts");
  for (const task of curation.tasks) assert.deepEqual(leaks(task), [], `${task.id} leaks gold`);
  const plans = allTasks.map(task => planQueries(task));
  for (const [index, plan] of plans.entries()) {
    const row = gold.find(item => item.taskId === allTasks[index].taskId);
    for (const term of plan.terms) {
      assert.equal(visibleStrings(row.answer ?? {}).some(value => value.length >= 3 && value === term && !anchors.has(value)), false, `${row.taskId} query plan carries an answer`);
    }
  }

  const work = await mkdtemp(path.join(os.tmpdir(), "mac10-chain-"));
  t.after(() => removeTree(work));
  // Repair oracles: broken pre-state fails by assertion, the frozen fix passes, three times each, within the limit.
  const oracleReport = await checkOracles({ datasetFile: DATASET, inputsFile: INPUTS, split: "all", repeats: 3, javaHome: await frozenJavaHome(), out: path.join(work, "oracle") });
  assert.equal(oracleReport.status, "PASS");
  assert.equal(oracleReport.tasks.length, manifest.counts.byKind.repair);

  // The six pinned dev tasks: one QA and one repair per corpus, through both drivers.
  const pinned = new Set(curation.tasks.filter(task => task.pinnedDev).map(task => task.id));
  const chainTasks = devTasks.filter(task => pinned.has(task.taskId));
  assert.equal(chainTasks.length, 6);
  for (const corpusId of new Set(allTasks.map(task => task.corpusId))) {
    assert.deepEqual(chainTasks.filter(task => task.corpusId === corpusId).map(task => task.kind).sort(), ["qa", "repair"], `${corpusId} pinned tasks`);
  }
  const schedule = buildSchedule({ tasks: chainTasks, drivers: ["native", "product"], repeats: 1, seed: "mac10-chain", deadlineMs: 120000 });
  const scheduleBytes = jsonl(schedule);
  const scheduleFile = path.join(work, "schedule.jsonl");
  await writeFile(scheduleFile, scheduleBytes);
  const driversFile = path.join(work, "drivers.json");
  await writeFile(driversFile, `${JSON.stringify({ schema: "ilv2-mac10-drivers/v1", drivers: [{ id: "native", kind: "native-rg/v1", rg: RG },
    { id: "product", kind: "product-mcp/v1", serverJs: path.resolve("dist/server.js"), readyTimeoutMs: 900000 }] })}\n`);
  const tasksFile = path.join(root, manifest.parts["tasks-dev"].file);
  const goldFile = path.join(root, manifest.parts["gold-dev"].file);
  const report = await runRetrieval({ datasetFile: DATASET, tasksFile, goldFile, scheduleFile, driversFile, inputsFile: INPUTS, out: path.join(work, "retrieval") });
  assert.equal(report.identity.datasetDigest, manifest.datasetDigest);
  assert.equal(report.identity.goldSha256, sha256(goldBytes));
  assert.equal(report.identity.tasksSha256, sha256(tasksBytes));
  assert.equal(report.slots.length, 12);
  assert.equal(report.status, "MEASURED", `every slot completes: ${report.slots.filter(slot => slot.score.status !== "COMPLETE").map(slot => `${slot.slotId}=${slot.score.status}`).join(", ")}`);

  const compare = pairedCompare({ manifest, goldBytes, scheduleBytes, pack: report, baseline: "native", candidate: "product" });
  assert.equal(compare.status, "COMPARED");
  assert.equal(compare.tasks, 6);
  // A schedule the pack did not run is refused before any score is read.
  const refused = pairedCompare({ manifest, goldBytes, scheduleBytes: jsonl(schedule.slice(1)), pack: report, baseline: "native", candidate: "product" });
  assert.equal(refused.status, "REFUSED");

  const evidence = { schema: "ilv2-mac10-chain-evidence/v1", datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, counts: manifest.counts,
    split: manifest.split, chainTasks: chainTasks.map(task => ({ taskId: task.taskId, corpusId: task.corpusId, kind: task.kind, category: task.category })),
    oracles: { status: oracleReport.status, repeats: oracleReport.repeats, java: { javaSha256: oracleReport.java.javaSha256, version: oracleReport.java.version },
      tasks: oracleReport.tasks.map(task => ({ taskId: task.taskId, split: task.split, broken: task.broken, fixed: task.fixed, stable: task.stable, maxCompileMs: task.maxCompileMs, maxRunMs: task.maxRunMs, timeoutMs: task.timeoutMs })) },
    retrieval: { status: report.status, identity: { ...report.identity, driverIdentities: Object.fromEntries(Object.entries(report.identity.driverIdentities).map(([id, value]) => [id, { kind: value.kind, gitSha: value.gitSha ?? null, rgSha256: value.rgSha256 ?? null, dist: value.dist ?? null }])) },
      sessions: report.sessions, byDriver: report.byDriver,
      slots: report.slots.map(slot => ({ slotId: slot.slotId, status: slot.score.status, recall: slot.score.recall, allRequired: slot.score.allRequired, wrongHash: slot.score.wrongHash, duplicates: slot.score.duplicates, bytes: slot.score.bytes, payloadBytes: slot.payloadBytes, elapsedMs: slot.elapsedMs })) },
    compare: { status: compare.status, tasks: compare.tasks, mean: compare.mean, meanDelta: compare.meanDelta, deltaCI95: compare.deltaCI95, wins: compare.wins, losses: compare.losses, ties: compare.ties, byCorpus: compare.byCorpus, byCategory: compare.byCategory },
    refusedOnScheduleMismatch: refused.status === "REFUSED",
    notClaimed: "Retrieval recall on six pinned dev tasks with a model-free planner; no agent answer, repair success or holdout result is measured or read." };
  await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, "mac10-chain.json"), `${JSON.stringify(evidence, null, 2)}\n`);
});
