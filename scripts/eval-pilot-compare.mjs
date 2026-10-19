#!/usr/bin/env node
// input:  A finished agent results pack (scripts/evaluate-java-task.mjs) whose
//         QA was scored by the frozen kit, two arm names, and every identity
//         it is compared under, given explicitly (MAC-10): the kit root, the
//         task file the pack ran, its gold, and the pre-registered pilot ids.
// output: <out>/<name>-compare.json (kit `compare` on the pilot rows only) and
//         <out>/<name>-evidence.json: per-arm success (every scheduled attempt
//         in the denominator), the QA delta with its cluster bootstrap CI and
//         the prompt-token medians and ratio.
// pos:    The native-vs-A2 primary control is reproducible from committed
//         code (moved here from the removed dense experiment package).
//
// node scripts/eval-pilot-compare.mjs --pack <results-pack.json> --kit-root <kit> \
//   --tasks <tasks.jsonl> --gold <gold.jsonl> --pilot-ids <experiment.json> \
//   --baseline control --candidate product --name native-vs-a2 [--out <dir>]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Refusals before any score is read; an empty list means the pack is comparable under these identities. */
export function packIdentityErrors(pack, { tasksSha256, goldSha256 }) {
  const errors = [];
  if (pack.status !== "MEASURED") errors.push(`pack status ${pack.status}: nothing was measured`);
  if (pack.scorer?.kind !== "frozen-kit") errors.push(`QA was not scored by the frozen kit (${pack.scorer?.kind})`);
  if (pack.datasetHash !== goldSha256) errors.push("pack was not scored against this gold");
  if (pack.identity && pack.identity.tasksSha256 !== tasksSha256) errors.push("pack did not run this task file");
  if (!pack.identity) errors.push("pack carries no task/schedule identity");
  return errors;
}

/** successRate = successes / every scheduled attempt of the arm (R02 denominator rule). */
export function summarizeArm(runs, arm) {
  const subset = runs.filter(run => run.arm === arm);
  const measured = subset.filter(run => run.taskSuccess === true || run.taskSuccess === false);
  const successes = subset.filter(run => run.taskSuccess === true).length;
  const byKind = kind => {
    const rows = subset.filter(run => (run.kind ?? "qa") === kind);
    if (rows.length === 0) return null;
    const ok = rows.filter(run => run.taskSuccess === true).length;
    const scored = rows.filter(run => run.taskSuccess === true || run.taskSuccess === false).length;
    return { scheduled: rows.length, successes: ok, successRate: ok / rows.length, measured: scored, conditionalAccuracy: scored ? ok / scored : null };
  };
  return {
    arm,
    scheduled: subset.length,
    successes,
    successRate: subset.length ? successes / subset.length : null,
    measured: measured.length,
    conditionalAccuracy: measured.length ? successes / measured.length : null,
    unmeasured: subset.length - measured.length,
    qa: byKind("qa"),
    repair: byKind("repair")
  };
}

/** Median of the per-attempt prompt tokens; null when any attempt lacks usage. */
export function medianPromptTokens(runs) {
  const values = runs.map(run => run.usage?.promptTokens ?? run.usage?.inputTokens);
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pilot rows only: tasks outside the pilot would be MISSING in both arms (zero deltas). */
export function pilotReport(report, pilotIds) {
  const { summary: _wholeSplit, ...rest } = report;
  return { ...rest, rows: report.rows.filter(row => pilotIds.includes(row.task_id)) };
}

/** `harness compare` (paired, cluster bootstrap) of the two arms' kit reports on the pilot rows. */
export function comparePilotReports({ kitRoot, baselineReportPath, candidateReportPath, pilotIds, outputDir, name, python = process.env.JSB_PYTHON ?? "python3" }) {
  const filtered = (reportPath, label) => {
    const target = path.join(outputDir, `${name}-${label}-pilot-report.json`);
    writeFileSync(target, `${JSON.stringify(pilotReport(JSON.parse(readFileSync(reportPath, "utf8")), pilotIds), null, 1)}\n`);
    return target;
  };
  const outputPath = path.join(outputDir, `${name}-compare.json`);
  const run = spawnSync(python, ["-B", "-m", "harness", "--dataset", path.join(kitRoot, "dataset"), "compare",
    "--baseline", filtered(baselineReportPath, "baseline"), "--candidate", filtered(candidateReportPath, "candidate"), "--output", outputPath], {
    cwd: kitRoot,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  });
  if (run.status !== 0) throw new Error(`kit compare failed: ${(run.error?.message ?? run.stderr ?? "").slice(0, 400)}`);
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

function main() {
  const arg = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const packPath = arg("--pack");
  const kitRoot = arg("--kit-root");
  const tasksFile = arg("--tasks");
  const goldFile = arg("--gold");
  const pilotFile = arg("--pilot-ids");
  const baseline = arg("--baseline");
  const candidate = arg("--candidate");
  const name = arg("--name");
  if (!packPath || !kitRoot || !tasksFile || !goldFile || !pilotFile || !baseline || !candidate || !name) {
    process.stderr.write("usage: eval-pilot-compare.mjs --pack <results-pack.json> --kit-root <kit> --tasks <tasks.jsonl> --gold <gold.jsonl> --pilot-ids <experiment.json> --baseline <arm> --candidate <arm> --name <label> [--out <dir>]\n");
    process.exit(2);
  }
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  const errors = packIdentityErrors(pack, { tasksSha256: digest(tasksFile), goldSha256: digest(goldFile) });
  if (errors.length) {
    process.stderr.write(`${packPath}: refused: ${errors.join("; ")}\n`);
    process.exit(2);
  }
  const runs = pack.runs ?? pack.packs;
  if (!Array.isArray(runs)) throw new Error(`${packPath}: no attempt rows`);
  const pilotIds = JSON.parse(readFileSync(pilotFile, "utf8")).pilot.task_ids;
  const outputDir = path.resolve(arg("--out") ?? path.join(path.dirname(packPath), "frozen-score"));
  mkdirSync(outputDir, { recursive: true });
  const comparison = comparePilotReports({
    kitRoot,
    baselineReportPath: pack.scorer.reports[baseline].reportPath,
    candidateReportPath: pack.scorer.reports[candidate].reportPath,
    pilotIds,
    outputDir,
    name
  });
  const kinds = new Map(readFileSync(tasksFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).map(task => [task.id, task.kind]));
  const medians = Object.fromEntries([baseline, candidate].map(arm => [arm, medianPromptTokens(runs.filter(run => run.arm === arm))]));
  const qa = comparison.metrics?.qa_contract_pass ?? null;
  const evidence = {
    pack: path.resolve(packPath),
    evalProtocol: pack.evalProtocol ?? null,
    identity: { kitRoot: path.resolve(kitRoot), tasksSha256: digest(tasksFile), goldSha256: digest(goldFile), pilotIdsSha256: digest(pilotFile), scheduleSha256: pack.identity.scheduleSha256 },
    baseline,
    candidate,
    pilotIds,
    summary: [baseline, candidate].map(arm => summarizeArm(runs.map(run => ({ kind: run.kind ?? kinds.get(run.taskId) ?? "qa", ...run })), arm)),
    qaDelta: qa?.cluster_macro_delta ?? null,
    qaDeltaCI: qa?.cluster_bootstrap_95 ?? null,
    qaDeltaLower: qa?.cluster_bootstrap_95?.[0] ?? null,
    qaClusters: qa?.clusters ?? null,
    receivedLineRecall: comparison.metrics?.received_line_recall ?? null,
    promptTokenMedians: medians,
    tokenMedianRatio: medians[baseline] && medians[candidate] != null ? medians[candidate] / medians[baseline] : null,
    note: "kit compare covers QA rows; repair success is the frozen judge's, summarized per arm"
  };
  writeFileSync(path.join(outputDir, `${name}-evidence.json`), `${JSON.stringify(evidence, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
