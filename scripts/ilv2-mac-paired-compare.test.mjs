import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { buildSchedule, convertDataset, readJsonl } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { clusterBootstrap, pairedCompare } from "./ilv2-mac-paired-compare.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac10-compare-"));
  t.after(() => removeTree(root));
  const fixture = await evalFixture(root);
  const out = path.join(root, "dataset");
  const manifest = await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out });
  const goldBytes = await readFile(path.join(out, "private/gold-dev.jsonl"));
  const tasks = await readJsonl(path.join(out, "tasks-dev.jsonl"));
  const schedule = buildSchedule({ tasks, drivers: ["native", "product"], repeats: 2, seed: "s", deadlineMs: 60000 });
  const scheduleBytes = Buffer.from(schedule.map(row => JSON.stringify(row)).join("\n") + "\n");
  const recall = { native: { "FX-CALLERS": 1, "FX-IMPLS": 0.5, "FX-REPAIR": 0 }, product: { "FX-CALLERS": 1, "FX-IMPLS": 1, "FX-REPAIR": 1 } };
  const pack = { schema: "ilv2-mac10-retrieval-report/v1", status: "MEASURED",
    identity: { datasetDigest: manifest.datasetDigest, split: "dev", goldSha256: sha256(goldBytes), scheduleSha256: sha256(scheduleBytes) },
    slots: schedule.map(slot => ({ slotId: slot.slotId, taskId: slot.taskId, corpusId: slot.corpusId, driverId: slot.driverId, repeat: slot.repeat,
      score: { status: "COMPLETE", recall: recall[slot.driverId][slot.taskId] } })) };
  return { manifest, goldBytes, scheduleBytes, schedule, pack, compare: (overrides = {}) => pairedCompare({ manifest, goldBytes, scheduleBytes, pack, baseline: "native", candidate: "product", ...overrides }) };
}

test("paired compare: task clusters, every slot in the denominator, per-corpus and per-category deltas", async t => {
  const { compare } = await setup(t);
  const result = compare();
  assert.equal(result.status, "COMPARED");
  assert.deepEqual([result.tasks, result.slots.baseline, result.slots.candidate], [3, 6, 6]);
  assert.equal(result.mean.baseline, 0.5);
  assert.equal(result.mean.candidate, 1);
  assert.equal(result.meanDelta, 0.5);
  assert.deepEqual([result.wins, result.losses, result.ties], [2, 0, 1]);
  assert.equal(result.byCategory.repair.meanDelta, 1);
  assert.ok(result.deltaCI95[0] <= 0.5 && result.deltaCI95[1] >= 0.5);
});

test("dataset, gold or schedule mismatch refuses the comparison before any score is read", async t => {
  const { compare, pack, goldBytes, scheduleBytes } = await setup(t);
  assert.match(compare({ pack: { ...pack, identity: { ...pack.identity, datasetDigest: "0".repeat(64) } } }).errors.join(), /pack dataset/);
  assert.match(compare({ goldBytes: Buffer.from(goldBytes.toString().replace("demo.FlatRule", "demo.X")) }).errors.join(), /gold is not a part of this dataset/);
  // The dataset's own gold, but the pack says it was scored against another one (or another split).
  assert.match(compare({ pack: { ...pack, identity: { ...pack.identity, goldSha256: "0".repeat(64) } } }).errors.join(), /not scored against this gold/);
  assert.match(compare({ pack: { ...pack, identity: { ...pack.identity, split: "holdout" } } }).errors.join(), /pack split holdout is not dev/);
  assert.match(compare({ scheduleBytes: Buffer.from(scheduleBytes.toString().split("\n").slice(1).join("\n")) }).errors.join(), /did not run this schedule/);
  // A pack that lost a scheduled slot is refused, not compared over the slots it kept.
  const lost = compare({ pack: { ...pack, slots: pack.slots.slice(1) } });
  assert.equal(lost.status, "REFUSED");
  assert.match(lost.errors.join(), /has no result/);
  assert.match(compare({ candidate: "jdt" }).errors.join(), /arm jdt is not in the schedule/);
});

test("an unmeasured agent pack stays UNMEASURED; incomplete slots make the comparison INCOMPLETE", async t => {
  const { compare, pack, schedule } = await setup(t);
  const agent = { schemaVersion: "java-devkit-task-eval/v1", status: "BLOCKED_AUTH", identity: pack.identity,
    packs: schedule.map(slot => ({ slotId: slot.slotId, taskId: slot.taskId, arm: slot.driverId, repeat: slot.repeat, taskOutcome: "UNMEASURED", taskSuccess: null })) };
  const unmeasured = compare({ pack: agent });
  assert.equal(unmeasured.status, "UNMEASURED");
  // A pack that claims MEASURED while holding an unmeasured outcome is still not compared.
  assert.equal(compare({ pack: { ...agent, status: "MEASURED" } }).status, "UNMEASURED");
  assert.equal(unmeasured.meanDelta, undefined, "no number is produced from unmeasured outcomes");
  const timedOut = { ...pack, slots: pack.slots.map((slot, index) => index === 0 ? { ...slot, score: { status: "TIMEOUT", recall: 0 } } : slot) };
  const result = compare({ pack: timedOut });
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.incomplete, [{ slotId: pack.slots[0].slotId, status: "TIMEOUT" }]);
});

test("clusterBootstrap is seeded and needs two clusters", () => {
  assert.deepEqual(clusterBootstrap([0, 1, 1, 0]), clusterBootstrap([0, 1, 1, 0]));
  assert.equal(clusterBootstrap([1]), null);
});
