// input: Real repo roots (CLI flags or env vars) for lishuedu/cipherlink/exam-parent-v3.
// output: A commit-stamped matrix-run directory (raw per-cell JSON + matrix-run-summary.json)
//         plus a rendered phase report Markdown file; nonzero exit on any hard-gate failure.
// pos: Task 32 Step 8. The CLI entrypoint the plan's Step 6 describes ("The CLI preserves a
//      nonzero exit if any hard gate fails") - matrix-runner.ts/phase-report.ts stayed
//      pure/injectable per the plan's own testing requirement, so this is the thin real-I/O
//      wrapper around them. Distinct from scripts/run-three-repo-cold-matrix.mjs (an old-vs-new
//      paired regression gate that DOES work for this iteration - baseline 516006c, right after
//      the V3 golden schema migration, is a valid ancestor; only two specific later commits
//      (86fef13, e1dd73c) predate that migration and can't be used as a baseline. This runner
//      compares HEAD against archived Phase 3 numbers as an *additional* single-arm diagnostic,
//      not because the paired gate is unavailable - see docs/phase-v3/phase4-evidence-framework-token-report.md).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildProviderValueRows,
  readCellPayloads,
  runMatrix,
  type HardGateCheck,
  type ProjectSpec,
  type WarmStateCell
} from "./matrix-runner.js";
import { renderPhaseReport } from "./phase-report.js";
import { spawnCommandRunner } from "./matrix-runner-process.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../..");

type Phase3Baseline = { recall: number; pRead: number };

const PHASE3_BASELINE: Record<string, Phase3Baseline> = {
  lishuedu: { recall: 0.821984, pRead: 0.833333 },
  cipherlink: { recall: 0.826984, pRead: 0.700000 },
  "exam-parent-v3": { recall: 0.900000, pRead: 0.600000 }
};

function parseCli(args: string[]): {
  repositories: Record<string, string>;
  outputDir: string;
  runs: number;
  warmStates: WarmStateCell[];
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key.startsWith("--")) {
      values.set(key, args[index + 1]);
      index += 1;
    }
  }
  const repositories: Record<string, string> = {
    lishuedu: required(values.get("--lishuedu") || process.env.LISHUEDU_ROOT, "--lishuedu or LISHUEDU_ROOT"),
    cipherlink: required(values.get("--cipherlink") || process.env.CIPHERLINK_ROOT, "--cipherlink or CIPHERLINK_ROOT"),
    "exam-parent-v3": required(values.get("--exam-parent-v3") || process.env.EXAM_PARENT_V3_ROOT, "--exam-parent-v3 or EXAM_PARENT_V3_ROOT")
  };
  const warmStatesArg = values.get("--warm-states");
  return {
    repositories,
    outputDir: path.resolve(values.get("--output-dir") || path.join(projectRoot, "artifacts", "v3-phase4", `matrix-${timestamp()}`)),
    runs: values.get("--runs") ? Number(values.get("--runs")) : 5,
    warmStates: (warmStatesArg ? warmStatesArg.split(",") : ["cold-nolsp"]) as WarmStateCell[]
  };
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function gitShortCommit(): string {
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

const phase3RegressionGate: HardGateCheck = summary => summary.projects.flatMap(project => {
  const baseline = PHASE3_BASELINE[project.project];
  if (!baseline) return [];
  return project.warmStates
    .filter(cell => cell.warmState === "cold-nolsp")
    .flatMap(cell => {
      const failures: string[] = [];
      if (cell.rReadMust !== 1) {
        failures.push(`${project.project}/cold-nolsp: R_read_must ${cell.rReadMust.toFixed(4)} !== 1.0000`);
      }
      if (cell.pRead < baseline.pRead - 0.02) {
        failures.push(`${project.project}/cold-nolsp: P_read ${cell.pRead.toFixed(4)} < Phase3 ${baseline.pRead.toFixed(4)} - 0.02`);
      }
      if (cell.recall < baseline.recall) {
        failures.push(`${project.project}/cold-nolsp: recall ${cell.recall.toFixed(4)} < Phase3 ${baseline.recall.toFixed(4)} (NOTE: golden set grew 16->24 scenarios in Step 5, see report for denominator caveat)`);
      }
      return failures;
    });
});

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mkdirSync(cli.outputDir, { recursive: true });

  const projects: ProjectSpec[] = Object.entries(cli.repositories).map(([project, repoRoot]) => ({
    project,
    repoRoot,
    scenarioFile: path.join(projectRoot, "golden", `${project}.scenarios.jsonl`)
  }));

  const summary = await runMatrix({
    projects,
    outputDir: cli.outputDir,
    runtimeCommit: gitShortCommit(),
    benchmarkScript: path.join(projectRoot, "dist", "benchmark-agent-impact.js"),
    runCommand: spawnCommandRunner,
    runs: cli.runs,
    warmStates: cli.warmStates,
    hardGates: [phase3RegressionGate]
  });

  const cells = readCellPayloads(summary.artifactFiles);
  const providerRows = buildProviderValueRows(cells).map(row => ({ ...row, decision: "PENDING" as const }));

  const knownLimits = [
    "R_task_blocking has no Phase 3 baseline (taskBlocking is a new V3 golden-schema bucket) - reported as a new baseline this iteration, not gated as a regression.",
    "estimatedTokens has no Phase 3 baseline (new V3 Step 7 metric) - reported as a new baseline this iteration, not gated as a regression.",
    "recall/P_read comparisons are against the archived Phase 3 figures measured on a 16-scenario golden set; Step 5 expanded the set to 24 scenarios, so this is a denominator-changed comparison, not a strict paired regression.",
    "This run is a single-arm HEAD diagnostic, separate from run-three-repo-cold-matrix.mjs's old-vs-new paired regression gate (that gate DOES work for this iteration using baseline 516006c - see phase4 report section 3.1 for the actual paired-gate evidence); this runner exists for the provider-value/attribution breakdown the paired script's hardcoded JAVA_LSP_SHADOW_RANKING=0 cannot produce.",
    "Shadow-ranking's non-required read-plan selection does not replicate production's buildReadPlan() shortlist bucket-representative guarantee or byte-budget trim, so goldenAttribution.inReadPlan/counterfactual.readPlanHitLost can under-report real production hits (reproduced on lishuedu's audit-order-repository-mapper-rule-type scenario)."
  ];

  const decision = summary.hardGateFailures.length === 0 ? "KEEP" : "FAIL";
  const markdown = renderPhaseReport(
    "Iteration D Gate — Task 32 Step 8",
    decision,
    summary,
    providerRows,
    knownLimits
  );

  writeFileSync(path.join(cli.outputDir, "phase4-gate-report.md"), markdown);
  writeFileSync(path.join(cli.outputDir, "matrix-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(markdown);
  console.log(`\noutputDir: ${cli.outputDir}`);
  if (summary.hardGateFailures.length > 0) {
    console.error(`\nHARD GATE FAILURES:\n${summary.hardGateFailures.join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 2;
});
