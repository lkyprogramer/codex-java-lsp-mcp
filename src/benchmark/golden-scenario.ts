// input: golden/*.scenarios.jsonl (schema V3, Task 32 Step 1).
// output: Scenario type plus the golden-file accessors every benchmark/attribution module shares.
// pos: Extracted from benchmark-agent-impact.ts so src/benchmark/*.ts can import scenario
//      parsing without importing that script's side-effecting top level.
import { existsSync, readFileSync } from "node:fs";
import type { ImpactOptions } from "../agent-types.js";
import type { SourcePosition, SourceRange } from "../runtime/source-range.js";

export type WarmState = "cold-nolsp" | "cold-lsp" | "warm-auto" | "warm-required";

export type GoldenKind = "must" | "taskBlocking" | "should" | "support";

export type Scenario = {
  id: string;
  name: string;
  projectId?: string;
  layoutProfile?: string;
  repoCommit?: string;
  evaluationSplit?: "tuning" | "holdout";
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
    mustReadCoordinateRangesV2?: Array<{ file: string } & SourceRange>;
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
        const parsed: unknown = JSON.parse(line);
        validateScenario(parsed, `${file}:${index + 1}`);
        return parsed as Scenario;
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
  const entries = new Map<string, GoldenKind>();
  const add = (files: string[], kind: GoldenKind): void => {
    for (const file of files) {
      if (!entries.has(file)) entries.set(file, kind);
    }
  };
  // Strongest-to-weakest order also de-duplicates the Task36 cross-version
  // aliases (taskBlocking is repeated in legacy shouldHit; support in side).
  add(goldenFiles(scenario, "mustHit"), "must");
  add(goldenFiles(scenario, "taskBlocking"), "taskBlocking");
  add(goldenFiles(scenario, "shouldHit"), "should");
  add(goldenFiles(scenario, "support"), "support");
  return [...entries].map(([file, kind]) => ({ file, kind }));
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

/**
 * Fraction of required exact UTF-16 ranges covered by the union of selected
 * worker ranges. Legacy line-only scenarios are deliberately UNMEASURED.
 */
export function readPlanCoordinateRecall(
  scenario: Scenario,
  selectedRangesByFile: ReadonlyMap<string, readonly SourceRange[]>
): number | undefined {
  const requiredByFile = scenario.golden?.mustReadCoordinateRangesV2;
  if (!requiredByFile || requiredByFile.length === 0) {
    return undefined;
  }
  let totalRanges = 0;
  let coveredRanges = 0;
  for (const required of requiredByFile) {
    const selected = [...(selectedRangesByFile.get(required.file) ?? [])]
      .sort((left, right) => comparePosition(left.start, right.start) || comparePosition(left.end, right.end));
    totalRanges += 1;
    if (rangeCoveredByUnion(required, selected)) coveredRanges += 1;
  }
  return totalRanges > 0 ? coveredRanges / totalRanges : undefined;
}

function rangeCoveredByUnion(required: SourceRange, selected: readonly SourceRange[]): boolean {
  let coveredUntil: SourcePosition | undefined;
  for (const candidate of selected) {
    if (comparePosition(candidate.end, required.start) <= 0) continue;
    if (comparePosition(candidate.start, required.end) >= 0) break;
    if (!coveredUntil) {
      if (comparePosition(candidate.start, required.start) > 0) return false;
      coveredUntil = candidate.end;
    } else if (comparePosition(candidate.start, coveredUntil) <= 0) {
      if (comparePosition(candidate.end, coveredUntil) > 0) coveredUntil = candidate.end;
    } else {
      return false;
    }
    if (comparePosition(coveredUntil, required.end) >= 0) return true;
  }
  return false;
}

function comparePosition(left: SourcePosition, right: SourcePosition): number {
  return left.line - right.line || left.column - right.column;
}

function validateScenario(value: unknown, context: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid scenario at ${context}: expected an object`);
  }
  const scenario = value as Record<string, unknown>;
  if (typeof scenario.id !== "string" || typeof scenario.name !== "string") {
    throw new Error(`Invalid scenario at ${context}: id and name must be strings`);
  }
  if (!scenario.anchor || typeof scenario.anchor !== "object" || Array.isArray(scenario.anchor)) {
    throw new Error(`Invalid scenario at ${context}: anchor must be an object`);
  }
  const anchor = scenario.anchor as Record<string, unknown>;
  if (!validRelativePath(anchor.file)
    || !positiveInteger(anchor.line)
    || !positiveInteger(anchor.column)) {
    throw new Error(`Invalid scenario at ${context}: anchor must use a relative file and positive 1-based coordinates`);
  }
  if (scenario.evaluationSplit !== undefined) {
    if (scenario.evaluationSplit !== "tuning" && scenario.evaluationSplit !== "holdout") {
      throw new Error(`Invalid scenario at ${context}: evaluationSplit must be tuning or holdout`);
    }
    if (typeof scenario.repoCommit !== "string" || !/^[0-9a-f]{40}$/i.test(scenario.repoCommit)) {
      throw new Error(`Invalid scenario at ${context}: split scenarios require a full 40-character repoCommit`);
    }
  }
  if (scenario.golden === undefined) return;
  if (!scenario.golden || typeof scenario.golden !== "object" || Array.isArray(scenario.golden)) {
    throw new Error(`Invalid scenario at ${context}: golden must be an object`);
  }
  const golden = scenario.golden as Record<string, unknown>;
  validateLineRanges(golden.mustReadRanges, `${context}.golden.mustReadRanges`);
  validateCoordinateRanges(golden.mustReadCoordinateRangesV2, `${context}.golden.mustReadCoordinateRangesV2`);
}

function validateLineRanges(value: unknown, context: string): void {
  if (value === undefined) return;
  for (const [file, ranges] of validatedRangeRecord(value, context)) {
    for (const [index, raw] of ranges.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Invalid scenario at ${context}.${file}[${index}]: expected a range object`);
      }
      const range = raw as Record<string, unknown>;
      if (!positiveInteger(range.startLine) || !positiveInteger(range.endLine) || range.endLine < range.startLine) {
        throw new Error(`Invalid scenario at ${context}.${file}[${index}]: expected an inclusive positive line range`);
      }
    }
  }
}

function validateCoordinateRanges(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario at ${context}: expected an array of file ranges`);
  }
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid scenario at ${context}[${index}]: expected a range object`);
    }
    const range = raw as Record<string, unknown>;
    const start = range.start;
    const end = range.end;
    if (!validRelativePath(range.file)
      || !validPosition(start)
      || !validPosition(end)
      || comparePosition(start, end) >= 0) {
      throw new Error(`Invalid scenario at ${context}[${index}]: expected a relative file and positive 1-based end-exclusive UTF-16 range`);
    }
    const key = `${range.file}:${start.line}:${start.column}-${end.line}:${end.column}`;
    if (seen.has(key)) {
      throw new Error(`Invalid scenario at ${context}[${index}]: duplicate coordinate range`);
    }
    seen.add(key);
  }
}

function validatedRangeRecord(value: unknown, context: string): Array<[string, unknown[]]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid scenario at ${context}: expected a file-to-ranges object`);
  }
  return Object.entries(value as Record<string, unknown>).map(([file, ranges]) => {
    if (!validRelativePath(file) || !Array.isArray(ranges)) {
      throw new Error(`Invalid scenario at ${context}.${file}: expected a relative file and range array`);
    }
    return [file, ranges];
  });
}

function validPosition(value: unknown): value is SourcePosition {
  return value !== undefined
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && positiveInteger((value as Record<string, unknown>).line)
    && positiveInteger((value as Record<string, unknown>).column);
}

function validRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
