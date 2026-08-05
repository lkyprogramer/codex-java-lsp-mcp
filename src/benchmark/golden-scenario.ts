// input: golden/*.scenarios.jsonl (schema V3, Task 32 Step 1).
// output: Scenario type plus the golden-file accessors every benchmark/attribution module shares.
// pos: Extracted from benchmark-agent-impact.ts so src/benchmark/*.ts can import scenario
//      parsing without importing that script's side-effecting top level.
import { existsSync, readFileSync } from "node:fs";
import type { ImpactOptions } from "../agent-types.js";

export type WarmState = "cold-nolsp" | "cold-lsp" | "warm-auto" | "warm-required";

export type GoldenKind = "must" | "taskBlocking" | "should" | "support";

export type Scenario = {
  id: string;
  name: string;
  projectId?: string;
  layoutProfile?: string;
  repoCommit?: string;
  scenarioVersion?: number;
  warmState?: WarmState;
  skippedProfiles?: string[];
  anchor: {
    file: string;
    line: number;
    column: number;
    profile: ImpactOptions["profile"];
    focusModules?: string[];
    taskKeywords?: string[];
  };
  golden?: {
    mustHit?: string[];
    taskBlocking?: string[];
    shouldHit?: string[];
    support?: string[];
    mustReadRanges?: Record<string, Array<{ startLine: number; endLine: number }>>;
  };
  groundTruth?: string[];
};

export function loadScenarios(file: string): Scenario[] {
  if (!existsSync(file)) {
    throw new Error(`Scenario file does not exist: ${file}`);
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Scenario;
      } catch (error) {
        throw new Error(`Invalid scenario JSON at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function goldenFiles(scenario: Scenario, key: "mustHit" | "taskBlocking" | "shouldHit" | "support"): string[] {
  if (scenario.golden) {
    return scenario.golden[key] || [];
  }
  return key === "mustHit" ? scenario.groundTruth || [] : [];
}

export function goldenEntries(scenario: Scenario): Array<{ file: string; kind: GoldenKind }> {
  return [
    ...goldenFiles(scenario, "mustHit").map(file => ({ file, kind: "must" as const })),
    ...goldenFiles(scenario, "taskBlocking").map(file => ({ file, kind: "taskBlocking" as const })),
    ...goldenFiles(scenario, "shouldHit").map(file => ({ file, kind: "should" as const })),
    ...goldenFiles(scenario, "support").map(file => ({ file, kind: "support" as const }))
  ];
}

/**
 * Task 32 Step 7. `mustHit` and `taskBlocking` both literally block the task
 * if missed - R_task_blocking is the stricter superset of R_read_must that
 * the plan's Iteration D gate compares against Phase 3. Deliberately kept
 * in evaluate()'s standard-verbosity path (not attribution-v3.ts), because a
 * gate metric must exist without JAVA_LSP_SHADOW_RANKING=1.
 */
export function taskBlockingFiles(scenario: Scenario): Set<string> {
  return new Set([...goldenFiles(scenario, "mustHit"), ...goldenFiles(scenario, "taskBlocking")]);
}

const NDCG_RELEVANCE_BY_KIND: Record<GoldenKind, number> = {
  must: 3,
  taskBlocking: 3,
  should: 2,
  support: 1
};

/**
 * Graded NDCG@6 over the read plan's actual selection order (not rank order -
 * a file the planner ranked first but placed second in the plan should be
 * scored where it was actually placed). Golden files absent from the read
 * plan's top 6 contribute 0, matching standard NDCG semantics; IDCG is the
 * best achievable ordering of this scenario's own golden set, not a
 * fixed constant, so a scenario with only 2 golden files can still reach 1.0.
 */
export function ndcgReadAt6(scenario: Scenario, readPlanFilesInOrder: readonly string[]): number {
  const relevanceByFile = new Map<string, number>();
  for (const { file, kind } of goldenEntries(scenario)) {
    const relevance = NDCG_RELEVANCE_BY_KIND[kind];
    const existing = relevanceByFile.get(file);
    if (existing === undefined || relevance > existing) {
      relevanceByFile.set(file, relevance);
    }
  }
  const dcg = readPlanFilesInOrder.slice(0, 6)
    .reduce((sum, file, index) => sum + (relevanceByFile.get(file) ?? 0) / Math.log2(index + 2), 0);
  const idcg = [...relevanceByFile.values()]
    .sort((left, right) => right - left)
    .slice(0, 6)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * 1-indexed position of the first mustHit/taskBlocking file in the ranked
 * candidate order (result.files, standard verbosity - no shadow pass
 * needed). Undefined when none of them ever became a candidate at all;
 * callers must not coerce that into 0 or any other numeric sentinel.
 */
export function firstTaskBlockingRank(scenario: Scenario, rankedFilesInOrder: readonly string[]): number | undefined {
  const blocking = taskBlockingFiles(scenario);
  const index = rankedFilesInOrder.findIndex(file => blocking.has(file));
  return index >= 0 ? index + 1 : undefined;
}

/**
 * Fraction of scenario.golden.mustReadRanges lines actually covered by the
 * selected read-plan ranges. Undefined (not 0) when the scenario carries no
 * mustReadRanges at all - a 0 would misreport "verified zero coverage" for a
 * metric this scenario never opted into.
 */
export function readPlanRangeRecall(
  scenario: Scenario,
  selectedRangesByFile: ReadonlyMap<string, ReadonlyArray<{ startLine: number; endLine: number }>>
): number | undefined {
  const mustReadRanges = scenario.golden?.mustReadRanges;
  if (!mustReadRanges || Object.keys(mustReadRanges).length === 0) {
    return undefined;
  }
  let totalRanges = 0;
  let coveredRanges = 0;
  for (const [file, ranges] of Object.entries(mustReadRanges)) {
    const selected = selectedRangesByFile.get(file) ?? [];
    for (const range of ranges) {
      totalRanges += 1;
      if (selected.some(candidate => candidate.startLine <= range.startLine && candidate.endLine >= range.endLine)) {
        coveredRanges += 1;
      }
    }
  }
  return totalRanges > 0 ? coveredRanges / totalRanges : undefined;
}
