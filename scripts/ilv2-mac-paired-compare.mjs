// MAC-10 paired comparator. It compares two drivers (or arms) of ONE results pack slot by slot, and it
// refuses before reading a score when the dataset, gold, schedule and pack are not the same identity.
// Every scheduled slot is in the denominator; a pack whose outcomes are UNMEASURED (no backend, dry run)
// is reported UNMEASURED with exit 2, never as a model-free PASS.
// Exit 0: compared, every slot complete in both arms; 1: compared, some slot not complete; 2: refused.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireValue, runCli, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { REPORT_SCHEMA } from "./ilv2-mac-retrieval-eval.mjs";

export const COMPARE_SCHEMA = "ilv2-mac10-paired-compare/v1";
const parseJsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Rejections come first: any one of them means no comparison is made. */
export function identityErrors({ manifest, goldBytes, scheduleBytes, pack }) {
  const errors = [];
  const split = ["dev", "holdout"].find(name => manifest.parts[`gold-${name}`].sha256 === sha256(goldBytes));
  if (!split) errors.push("gold is not a part of this dataset");
  const identity = pack.identity ?? {};
  if (identity.datasetDigest !== manifest.datasetDigest) errors.push(`pack dataset ${identity.datasetDigest ?? "missing"} is not ${manifest.datasetDigest}`);
  if (identity.goldSha256 !== sha256(goldBytes)) errors.push("pack was not scored against this gold");
  if (identity.scheduleSha256 !== sha256(scheduleBytes)) errors.push("pack did not run this schedule");
  if (split && identity.split !== split) errors.push(`pack split ${identity.split} is not ${split}`);
  return { errors, split };
}

/** Seeded task-cluster bootstrap of the mean paired delta. */
export function clusterBootstrap(deltas, { resamples = 2000, seed = "mac10" } = {}) {
  if (deltas.length < 2) return null;
  let counter = 0;
  const random = () => createHash("sha256").update(`${seed}\0${counter++}`).digest().readUInt32BE(0) / 2 ** 32;
  const means = [];
  for (let index = 0; index < resamples; index += 1) {
    let sum = 0;
    for (let draw = 0; draw < deltas.length; draw += 1) sum += deltas[Math.floor(random() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * resamples)], means[Math.ceil(0.975 * resamples) - 1]];
}

/** Retrieval slots keep their recall; agent attempts their 0/1 success (null = UNMEASURED). */
function outcomes(pack) {
  if (pack.schema === REPORT_SCHEMA) {
    return pack.slots.map(slot => ({ slotId: slot.slotId, taskId: slot.taskId, corpusId: slot.corpusId, arm: slot.driverId, repeat: slot.repeat,
      value: slot.score.recall ?? 0, complete: slot.score.status === "COMPLETE", status: slot.score.status }));
  }
  requireValue(pack.schemaVersion === "java-devkit-task-eval/v1", "results pack is neither a retrieval report nor an agent results pack");
  return (pack.packs ?? pack.runs ?? []).map(run => ({ slotId: run.slotId ?? `${run.taskId}/${run.arm}/${run.repeat}`, taskId: run.taskId, corpusId: run.corpusId ?? null,
    arm: run.arm, repeat: run.repeat, value: run.taskSuccess === true ? 1 : run.taskSuccess === false ? 0 : null,
    complete: run.taskSuccess === true || run.taskSuccess === false, status: run.taskOutcome ?? (run.taskSuccess == null ? "UNMEASURED" : "MEASURED") }));
}

export function pairedCompare({ manifest, goldBytes, scheduleBytes, pack, baseline, candidate }) {
  const { errors, split } = identityErrors({ manifest, goldBytes, scheduleBytes, pack });
  const schedule = parseJsonl(scheduleBytes);
  const rows = errors.length ? [] : outcomes(pack);
  const bySlot = new Map(rows.map(row => [row.slotId, row]));
  if (!errors.length) {
    for (const slot of schedule) if (!bySlot.has(slot.slotId)) errors.push(`scheduled slot ${slot.slotId} has no result`);
    const scheduled = new Set(schedule.map(slot => slot.slotId));
    for (const row of rows) if (!scheduled.has(row.slotId)) errors.push(`result ${row.slotId} was not scheduled`);
    for (const arm of [baseline, candidate]) if (!schedule.some(slot => slot.driverId === arm)) errors.push(`arm ${arm} is not in the schedule`);
  }
  if (errors.length) return { schema: COMPARE_SCHEMA, status: "REFUSED", errors };
  if (pack.status === "DRY_RUN" || pack.status === "BLOCKED_AUTH" || rows.some(row => row.value === null)) {
    return { schema: COMPARE_SCHEMA, status: "UNMEASURED", reason: `pack status ${pack.status ?? "?"}; ${rows.filter(row => row.value === null).length} outcomes UNMEASURED`, identity: pack.identity };
  }
  const gold = new Map(parseJsonl(goldBytes).map(row => [row.taskId, row]));
  const tasks = new Map();
  for (const slot of schedule.filter(item => item.driverId === baseline || item.driverId === candidate)) {
    const task = tasks.get(slot.taskId) ?? { taskId: slot.taskId, corpusId: slot.corpusId, category: gold.get(slot.taskId)?.category ?? null, baseline: [], candidate: [] };
    task[slot.driverId === baseline ? "baseline" : "candidate"].push(bySlot.get(slot.slotId));
    tasks.set(slot.taskId, task);
  }
  // Repeats of one task are one cluster: average them first.
  const clusters = [...tasks.values()].map(task => ({ ...task, baselineMean: mean(task.baseline.map(row => row.value)), candidateMean: mean(task.candidate.map(row => row.value)) }))
    .map(task => ({ ...task, delta: task.candidateMean - task.baselineMean }));
  const strata = key => Object.fromEntries([...new Set(clusters.map(task => task[key]))].map(value => {
    const members = clusters.filter(task => task[key] === value);
    return [value, { tasks: members.length, meanDelta: mean(members.map(task => task.delta)) }];
  }));
  const incomplete = rows.filter(row => (row.arm === baseline || row.arm === candidate) && !row.complete).map(row => ({ slotId: row.slotId, status: row.status }));
  return { schema: COMPARE_SCHEMA, status: incomplete.length ? "INCOMPLETE" : "COMPARED", split, identity: pack.identity, baseline, candidate,
    metric: pack.schema === REPORT_SCHEMA ? "retrieval recall" : "task success",
    tasks: clusters.length, slots: { baseline: clusters.reduce((sum, task) => sum + task.baseline.length, 0), candidate: clusters.reduce((sum, task) => sum + task.candidate.length, 0) },
    mean: { baseline: mean(clusters.map(task => task.baselineMean)), candidate: mean(clusters.map(task => task.candidateMean)) },
    meanDelta: mean(clusters.map(task => task.delta)), deltaCI95: clusterBootstrap(clusters.map(task => task.delta)),
    wins: clusters.filter(task => task.delta > 0).length, losses: clusters.filter(task => task.delta < 0).length, ties: clusters.filter(task => task.delta === 0).length,
    byCorpus: strata("corpusId"), byCategory: strata("category"), incomplete,
    perTask: clusters.map(task => ({ taskId: task.taskId, corpusId: task.corpusId, category: task.category, baseline: task.baselineMean, candidate: task.candidateMean, delta: task.delta })) };
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--gold", "--schedule", "--results", "--baseline", "--candidate", "--out"]);
  for (const name of ["dataset", "gold", "schedule", "results", "baseline", "candidate", "out"]) requireValue(options[name], `--${name} is required`);
  const { manifest } = await verifyDataset(path.resolve(options.dataset));
  const result = pairedCompare({ manifest, goldBytes: await readFile(options.gold), scheduleBytes: await readFile(options.schedule),
    pack: JSON.parse(await readFile(options.results, "utf8")), baseline: options.baseline, candidate: options.candidate });
  await mkdir(path.resolve(options.out));
  await writeJson(path.join(path.resolve(options.out), "compare.json"), result);
  console.log(JSON.stringify({ status: result.status, errors: result.errors, meanDelta: result.meanDelta, deltaCI95: result.deltaCI95 }, null, 2));
  process.exitCode = result.status === "COMPARED" ? 0 : result.status === "INCOMPLETE" ? 1 : 2;
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
