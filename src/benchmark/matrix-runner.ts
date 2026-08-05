// input: benchmark-agent-impact.js CLI output, one invocation per (project x warm state) cell,
//        run through an injectable command runner.
// output: raw per-cell JSON written under a commit-stamped directory plus a typed MatrixRunSummary.
// pos: Task 32 Step 6. Distinct from scripts/run-three-repo-cold-matrix.mjs: that script is an
//      old-vs-new code regression gate (worktree isolation, AB/BA/AB rounds, JDTLS_BIN stubbed
//      to /usr/bin/false, JAVA_LSP_SHADOW_RANKING=0). This tool tests warm-state coverage of the
//      single code version already built at HEAD - there is no baseline/candidate axis, so none
//      of that script's worktree/freeze/preflight machinery applies, and warm-auto/warm-required
//      cells need a real JDT LS. Shadow ranking is always enabled here (JAVA_LSP_SHADOW_RANKING=1)
//      because this tool is also the source of the counterfactual-gain evidence Step 9's report
//      table reads, which run-three-repo-cold-matrix.mjs never produces.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GoldenAttributionV3, GoldenCounterfactualV3 } from "./attribution-v3.js";

export type WarmStateCell = "cold-nolsp" | "warm-auto" | "warm-required";

export type CommandOutcome = { stdout: string; stderr: string; exitCode: number };

/** Injectable so matrix-runner.test.ts never spawns a real process or needs a real repo/JDT. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
) => Promise<CommandOutcome>;

export type ProjectSpec = {
  readonly project: string;
  readonly repoRoot: string;
  readonly scenarioFile: string;
};

export type HardGateCheck = (summary: MatrixRunSummary) => readonly string[];

export type MatrixRunOptions = {
  readonly projects: readonly ProjectSpec[];
  readonly outputDir: string;
  readonly runtimeCommit: string;
  readonly benchmarkScript: string;
  readonly runCommand: CommandRunner;
  readonly runs?: number;
  readonly warmStates?: readonly WarmStateCell[];
  readonly nodeBin?: string;
  readonly cacheRootFor?: (project: string, warmState: WarmStateCell) => string;
  /** Evaluated once against the completed summary; only Step 8/9 callers know the Phase 3 baseline this compares against. */
  readonly hardGates?: readonly HardGateCheck[];
};

export type WarmStateCellSummary = {
  readonly warmState: WarmStateCell;
  readonly runs: number;
  readonly recall: number;
  readonly pRead: number;
  readonly rReadMust: number;
  readonly rTaskBlocking: number;
  readonly estimatedTokensP50: number;
  readonly estimatedTokensP95: number;
  readonly elapsedMsP50: number;
  readonly elapsedMsP95: number;
  readonly artifactFile: string;
};

export type ProjectMatrixSummary = {
  readonly project: string;
  readonly repoRoot: string;
  readonly warmStates: readonly WarmStateCellSummary[];
};

export type MatrixRunSummary = {
  generatedAt: string;
  runtimeCommit: string;
  projects: ProjectMatrixSummary[];
  hardGateFailures: string[];
  artifactFiles: string[];
};

export type RawCellAttempt = {
  elapsedMs?: number;
  goldenAttribution?: GoldenAttributionV3[];
  counterfactual?: GoldenCounterfactualV3;
  timing?: { phaseMs?: Record<string, number> };
};

export type RawCellPayload = {
  metadata: { projectId: string; warmState: string };
  totals: Record<string, number>;
  rows: Array<{ id: string; attempts: RawCellAttempt[] }>;
};

const DEFAULT_RUNS = 5;
const DEFAULT_WARM_STATES: readonly WarmStateCell[] = ["cold-nolsp", "warm-auto"];
const TOTALS_KEYS = [
  "recall",
  "pRead",
  "rReadMust",
  "rTaskBlocking",
  "estimatedTokensP50",
  "estimatedTokensP95",
  "elapsedMsP50",
  "elapsedMsP95"
] as const;

export async function runMatrix(options: MatrixRunOptions): Promise<MatrixRunSummary> {
  const runs = options.runs ?? DEFAULT_RUNS;
  const warmStates = options.warmStates ?? DEFAULT_WARM_STATES;
  mkdirSync(options.outputDir, { recursive: true });

  const projects: ProjectMatrixSummary[] = [];
  const artifactFiles: string[] = [];

  for (const project of options.projects) {
    const warmStateSummaries: WarmStateCellSummary[] = [];
    for (const warmState of warmStates) {
      const cellSummary = await runCell(options, project, warmState, runs);
      warmStateSummaries.push(cellSummary);
      artifactFiles.push(cellSummary.artifactFile);
    }
    projects.push({ project: project.project, repoRoot: project.repoRoot, warmStates: warmStateSummaries });
  }

  const summary: MatrixRunSummary = {
    generatedAt: new Date().toISOString(),
    runtimeCommit: options.runtimeCommit,
    projects,
    hardGateFailures: [],
    artifactFiles
  };
  summary.hardGateFailures = (options.hardGates ?? []).flatMap(check => [...check(summary)]);

  writeFileSync(path.join(options.outputDir, "matrix-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function runCell(
  options: MatrixRunOptions,
  project: ProjectSpec,
  warmState: WarmStateCell,
  runs: number
): Promise<WarmStateCellSummary> {
  const cacheDir = options.cacheRootFor
    ? options.cacheRootFor(project.project, warmState)
    : path.join(options.outputDir, "cache", `${project.project}-${warmState}`);
  mkdirSync(cacheDir, { recursive: true });
  const matrixDir = path.join(options.outputDir, "matrix");
  mkdirSync(matrixDir, { recursive: true });
  const artifactFile = path.join(matrixDir, `${project.project}-${warmState}.json`);

  const args = [
    options.benchmarkScript,
    "--repo-root", project.repoRoot,
    "--project-id", project.project,
    "--scenarios", project.scenarioFile,
    "--warm-state", warmState,
    "--strategy", "impact",
    "--runs", String(runs),
    "--verbosity", "diagnostic",
    "--index-cache-dir", cacheDir
  ];
  // JAVA_LSP_FILE_WATCH=0: no interactive editor session exists to benefit from
  // file-watch invalidation during a scripted matrix run. JAVA_LSP_SHADOW_RANKING
  // must stay "1" (never "0") - see file-level pos note.
  const env: Record<string, string | undefined> = {
    JAVA_LSP_SHADOW_RANKING: "1",
    JAVA_LSP_FILE_WATCH: "0"
  };

  const outcome = await options.runCommand(options.nodeBin ?? process.execPath, args, env);
  if (outcome.exitCode !== 0) {
    throw new Error(`matrix cell ${project.project}/${warmState} exited with ${outcome.exitCode}: ${outcome.stderr}`);
  }

  writeFileSync(artifactFile, outcome.stdout);
  if (outcome.stderr.length > 0) {
    writeFileSync(`${artifactFile}.stderr`, outcome.stderr);
  }

  const payload = JSON.parse(outcome.stdout) as RawCellPayload;
  const totals: Record<string, number> = {};
  for (const key of TOTALS_KEYS) {
    totals[key] = requireFiniteNumber(payload.totals, key, `${project.project}/${warmState}`);
  }
  return {
    warmState,
    runs,
    recall: totals.recall,
    pRead: totals.pRead,
    rReadMust: totals.rReadMust,
    rTaskBlocking: totals.rTaskBlocking,
    estimatedTokensP50: totals.estimatedTokensP50,
    estimatedTokensP95: totals.estimatedTokensP95,
    elapsedMsP50: totals.elapsedMsP50,
    elapsedMsP95: totals.elapsedMsP95,
    artifactFile
  };
}

function requireFiniteNumber(totals: Record<string, number>, key: string, context: string): number {
  const value = totals[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`matrix cell ${context}: totals.${key} is missing or not a finite number`);
  }
  return value;
}

export function readCellPayloads(artifactFiles: readonly string[]): RawCellPayload[] {
  return artifactFiles.map(file => JSON.parse(readFileSync(file, "utf8")) as RawCellPayload);
}

export type ProviderValueRow = {
  provider: string;
  added: number;
  selected: number;
  goldenHits: number;
  counterfactualGain: number;
  costP50Ms?: number;
  costP95Ms?: number;
  decision: "KEEP" | "REJECT" | "MODIFY" | "PENDING";
};

const COUNTERFACTUAL_KEYS: ReadonlyArray<keyof GoldenCounterfactualV3> = [
  "withoutExactSemantic",
  "withoutStaticStructure",
  "withoutFramework",
  "withoutLexical",
  "withoutTaskContext",
  "withoutSupport"
];

/** Only "framework" and "relationship" get a discrete phase timer (agent-router/index.ts's frameworkEvidence/relationshipEvidence phases); static/semantic/lexical/support share untimed phases, so their cost is left undefined rather than a fabricated number. */
const PROVIDER_PHASE_MS_KEY: Readonly<Record<string, string>> = {
  framework: "frameworkEvidence",
  relationship: "relationshipEvidence"
};

/**
 * Approximate by construction: a counterfactual result is keyed by evidence
 * FAMILY (six families - see agent-router/evidence.ts's EvidenceFamily),
 * while a provider is one of six narrower ids (static/relationship/semantic/
 * lexical/support/framework) and several providers can emit the same family
 * (static and relationship both emit STATIC_STRUCTURE; support emits both
 * SUPPORT and TASK_CONTEXT). A golden file's readPlanHitLost under one family
 * is credited to every provider goldenAttribution recorded for that file,
 * since the real signal mix that earned its read-plan slot isn't separable
 * further without re-querying providers individually per ablation.
 */
export function buildProviderValueRows(cells: readonly RawCellPayload[]): ProviderValueRow[] {
  const added = new Map<string, number>();
  const selected = new Map<string, number>();
  const goldenHits = new Map<string, number>();
  const gain = new Map<string, number>();
  const phaseMsByProvider = new Map<string, number[]>();

  for (const cell of cells) {
    for (const row of cell.rows) {
      for (const attempt of row.attempts) {
        const providersByFile = new Map<string, readonly string[]>();
        for (const entry of attempt.goldenAttribution ?? []) {
          providersByFile.set(entry.file, entry.providers);
          for (const provider of entry.providers) {
            increment(added, provider);
            if (entry.inReadPlan) increment(selected, provider);
            if (entry.blockedBy === "hit") increment(goldenHits, provider);
          }
        }
        for (const key of COUNTERFACTUAL_KEYS) {
          const result = attempt.counterfactual?.[key];
          if (!result) continue;
          for (const file of result.readPlanHitLost) {
            for (const provider of providersByFile.get(file) ?? []) {
              increment(gain, provider);
            }
          }
        }
        for (const [provider, phaseKey] of Object.entries(PROVIDER_PHASE_MS_KEY)) {
          const value = attempt.timing?.phaseMs?.[phaseKey];
          if (typeof value === "number" && Number.isFinite(value)) {
            const values = phaseMsByProvider.get(provider) ?? [];
            values.push(value);
            phaseMsByProvider.set(provider, values);
          }
        }
      }
    }
  }

  const providers = new Set([...added.keys(), ...selected.keys(), ...goldenHits.keys(), ...gain.keys(), ...phaseMsByProvider.keys()]);
  return [...providers].sort().map(provider => {
    const phaseValues = phaseMsByProvider.get(provider);
    const sortedPhase = phaseValues && phaseValues.length > 0 ? [...phaseValues].sort((left, right) => left - right) : undefined;
    return {
      provider,
      added: added.get(provider) ?? 0,
      selected: selected.get(provider) ?? 0,
      goldenHits: goldenHits.get(provider) ?? 0,
      counterfactualGain: gain.get(provider) ?? 0,
      costP50Ms: sortedPhase ? percentile(sortedPhase, 0.5) : undefined,
      costP95Ms: sortedPhase ? percentile(sortedPhase, 0.95) : undefined,
      decision: "PENDING"
    };
  });
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return sortedValues[index];
}
