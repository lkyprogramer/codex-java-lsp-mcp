#!/usr/bin/env node
// S1 engineering gate, model-free (docs/post-ilv2/s1-implementation-listing.md §3). Compares the C0 rows of a D15-F
// style replay on the S1 build with D15-F's own C0 rows. Thresholds are fixed here, before the run. The replay's
// calibration may legitimately FAIL on S1 (it changes the product); rows.jsonl is written before that check.
// summary.json carries counts only; lost/gained target identities go to a private file under --out. A FAIL still
// exits 0: the verdict is summary.status. The same script also checks the main build against D15-F (§3.2 step 0).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { summarizeConfigs } from "./ilv2-impact-budget-diagnosis.mjs";

export const S1_GATE_SCHEMA = "post-ilv2/s1-gate/v1";
export const S1_THRESHOLDS = Object.freeze({ maxLostTargets: 0, maxReceivedBytesP50Increase: 0.2, recallTolerance: 1e-9 });

const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const pick = summary => ({ meanRecall: summary.meanRecall, fullRecallTasks: summary.fullRecallTasks, creditedTargets: summary.creditedTargets,
  creditedByCategory: summary.creditedByCategory, receivedBytesPerTask: summary.receivedBytesPerTask,
  payloadBytesPerTask: summary.payloadBytesPerTask, impactCallBytes: summary.impactCallBytes, partialCalls: summary.partialCalls,
  coreExceededCalls: summary.coreExceededCalls, calls: summary.calls });

/** Per-target C0 credit changes between two scorings of the same tasks and gold. */
export function targetChanges(baseRows, s1Rows) {
  const s1ByTask = new Map(s1Rows.map(row => [row.taskId, row]));
  requireValue(baseRows.length === s1Rows.length && baseRows.every(row => s1ByTask.has(row.taskId)), "the two runs do not cover the same tasks");
  const lost = [], gained = [];
  for (const base of baseRows) {
    const before = base.configs.C0.targets;
    const after = s1ByTask.get(base.taskId).configs.C0.targets;
    requireValue(before.length === after.length, `task ${base.taskId} has a different target count`);
    before.forEach((target, index) => {
      const row = { taskId: base.taskId, category: base.category, index, kind: target.kind, before: target.label, after: after[index].label };
      if (target.credited && !after[index].credited) lost.push(row);
      if (!target.credited && after[index].credited) gained.push(row);
    });
  }
  return { lost, gained };
}

/** §3 gates over C0. Category recall, coverage and core pressure are reported, not gated. */
export function evaluateGate(baseRows, s1Rows) {
  const base = summarizeConfigs(baseRows, ["C0"]).C0;
  const s1 = summarizeConfigs(s1Rows, ["C0"]).C0;
  const { lost, gained } = targetChanges(baseRows, s1Rows);
  const bytesIncrease = (s1.receivedBytesPerTask.p50 - base.receivedBytesPerTask.p50) / base.receivedBytesPerTask.p50;
  const gates = {
    meanRecallNonInferior: s1.meanRecall >= base.meanRecall - S1_THRESHOLDS.recallTolerance,
    lostTargets: lost.length <= S1_THRESHOLDS.maxLostTargets,
    receivedBytesP50: bytesIncrease <= S1_THRESHOLDS.maxReceivedBytesP50Increase
  };
  const tally = rows => rows.reduce((acc, row) => ({ ...acc, [row.category]: (acc[row.category] ?? 0) + 1 }), {});
  return {
    status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
    gates, thresholds: S1_THRESHOLDS, receivedBytesP50Increase: bytesIncrease,
    baseline: pick(base), s1: pick(s1),
    lostTargets: { count: lost.length, byCategory: tally(lost) },
    gainedTargets: { count: gained.length, byCategory: tally(gained) },
    changes: { lost, gained }
  };
}

export async function runS1Gate({ baselineRowsFile, expectBaselineRowsSha256, rowsFile, out }) {
  const baseBytes = await readFile(baselineRowsFile);
  requireValue(sha256(baseBytes) === expectBaselineRowsSha256, "baseline rows.jsonl is not the recorded D15-F artifact");
  const s1Bytes = await readFile(rowsFile);
  const { changes, ...result } = evaluateGate(jsonl(baseBytes), jsonl(s1Bytes));
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "target-changes.json"), `${JSON.stringify(changes, null, 2)}\n`);
  const summary = { schema: S1_GATE_SCHEMA, identity: { baselineRowsSha256: expectBaselineRowsSha256, rowsSha256: sha256(s1Bytes) }, ...result,
    notClaimed: "C0 retrieval recall and received bytes on the seen dev split; an engineering gate, not a sealed evaluation, and no answer quality." };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const names = ["--baseline-rows", "--expect-baseline-rows-sha256", "--rows", "--out"];
  const options = cliOptions(args, names);
  for (const name of names) requireValue(options[name.slice(2)], `${name} is required`);
  const summary = await runS1Gate({ baselineRowsFile: path.resolve(options["baseline-rows"]), expectBaselineRowsSha256: options["expect-baseline-rows-sha256"],
    rowsFile: path.resolve(options.rows), out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
