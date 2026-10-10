// input:  A finished agent results pack (scripts/evaluate-java-task.mjs or
//         agent-ab.mjs) whose QA was scored by the frozen kit, two arm names and
//         the pre-registered pilot task ids (configs/experiment.json).
// output: <out>/<name>-compare.json (kit `compare` on the pilot rows only) and
//         <out>/<name>-evidence.json: per-arm success, the QA delta with its
//         cluster bootstrap CI and the prompt-token medians and ratio.
// pos:    R11 review P2-2: the native-vs-A2 primary control and the agent
//         A2/A3 evidence are reproducible from committed code.
//
// node experiments/semantic-discovery/pilot-compare.mjs --pack <results-pack.json> \
//   --baseline control --candidate product --name native-vs-a2 [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePilotReports, medianPromptTokens } from "./budget.mjs";
import { summarizeArm } from "./ab-summary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const KIT = path.join(REPO_ROOT, "docs/java-specialist-release-audit-v1.1/baseline-kit");
const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const packPath = arg("--pack");
const baseline = arg("--baseline");
const candidate = arg("--candidate");
const name = arg("--name");
if (!packPath || !baseline || !candidate || !name) {
  process.stderr.write("usage: pilot-compare.mjs --pack <results-pack.json> --baseline <arm> --candidate <arm> --name <label> [--out <dir>]\n");
  process.exit(2);
}
const pack = JSON.parse(readFileSync(packPath, "utf8"));
if (pack.scorer?.kind !== "frozen-kit") throw new Error(`${packPath}: QA was not scored by the frozen kit (${pack.scorer?.kind})`);
const runs = pack.runs ?? pack.packs;
if (!Array.isArray(runs)) throw new Error(`${packPath}: no attempt rows`);
const pilotIds = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/java-specialist-devkit-v1/configs/experiment.json"), "utf8")).pilot.task_ids;
const outputDir = path.resolve(arg("--out") ?? path.join(path.dirname(packPath), "frozen-score"));
mkdirSync(outputDir, { recursive: true });

const comparison = comparePilotReports({
  kitRoot: KIT,
  baselineReportPath: pack.scorer.reports[baseline].reportPath,
  candidateReportPath: pack.scorer.reports[candidate].reportPath,
  pilotIds,
  outputDir,
  name
});
const medians = Object.fromEntries([baseline, candidate].map(arm => [arm, medianPromptTokens(runs.filter(run => run.arm === arm))]));
const qa = comparison.metrics?.qa_contract_pass ?? null;
const evidence = {
  pack: path.resolve(packPath),
  baseline,
  candidate,
  pilotIds,
  summary: [baseline, candidate].map(arm => summarizeArm(runs.map(run => ({ kind: run.kind ?? kindOf(run.taskId), ...run })), arm)),
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

function kindOf(taskId) {
  const tasks = readFileSync(path.join(KIT, "dataset/prompts/dev.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return tasks.find(task => task.id === taskId)?.kind ?? "qa";
}
