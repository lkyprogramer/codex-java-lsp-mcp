// input: Repo-contained JDT reference locations, already containment-filtered and path-classified by the caller.
// output: Value-ranked, file-collapsed reference candidates, truncated to a budget - not server order.
// pos: Task 26 - pure: no JDT/JavaIndex/file-system access, so the truncation decision this module makes is
//      unit-testable without session/JavaIndex fixtures, mirroring family-ranker.ts's pure-math/adapter split.
import type { ImpactMode } from "../agent-types.js";
import { matchesAny } from "./candidate-helpers.js";

/** Plan Step 4's default limitFiles by mode - mirrors read-plan.ts's defaultReadPlanMax/candidateLimit shape. */
export function referenceFileLimit(mode: ImpactMode): number {
  if (mode === "minimal") {
    return 12;
  }
  if (mode === "precision") {
    return 40;
  }
  if (mode === "recall") {
    return 60;
  }
  return 24;
}

export type ReferenceLocation = {
  readonly absolutePath: string;
  readonly line: number;
  readonly column: number;
  readonly module?: string;
  readonly layer?: string;
  readonly sourceSet?: string;
};

export type CollapsedReferenceFile = {
  path: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  totalReferences: number;
  /**
   * Every raw reference to this file, in encounter order - not yet reduced
   * to "first method-body / first type-level / first remaining". That
   * reduction needs a JavaIndex range lookup per position (plan Step 2),
   * which this pure function cannot afford to run before truncation: a
   * popular anchor can be referenced from hundreds of files, and only
   * `limitFiles` of them survive ranking. The caller performs that lookup,
   * bounded, only on this truncated result's positions.
   */
  positions: Array<{ line: number; column: number }>;
  valueScore: number;
};

export type RankReferenceFilesContext = {
  readonly anchorModule?: string;
  readonly focusModules: readonly string[];
  readonly taskKeywords: readonly string[];
  readonly testReadMode: "defer" | "include" | "priority";
  readonly limitFiles: number;
};

// Conventional annotation-processing output roots (matches
// repo-change-coordinator.ts's GENERATED_ROOT_CANDIDATES) - a generic
// build-tool convention, not a repo-specific path.
const GENERATED_PATH_MARKERS = [
  "target/generated-sources",
  "target/generated-test-sources",
  "build/generated"
];

// A filename-suffix proxy for "this file plays a framework main role",
// deliberately not an annotation/stereotype lookup: computing valueScore
// for every collapsed file (pre-truncation) cannot afford a JavaIndex
// facts fetch per file. Mirrors the same suffix convention relationship-
// deltas.ts's isDirectTypeName already uses for cheap role inference.
const FRAMEWORK_MAIN_ROLE_SUFFIXES = ["Controller", "Service", "AppService", "Repository", "Mapper", "Component"];

/**
 * Collapses raw per-occurrence reference locations into one entry per file,
 * scores each by Agent value (plan Step 3), and truncates to `limitFiles` -
 * before this, `references.items.slice(0, N)` truncated in whatever order
 * the LSP server returned locations, which can silently drop a same-module
 * main-source file behind hundreds of low-value test hits.
 */
export function rankReferenceFiles(
  locations: readonly ReferenceLocation[],
  context: RankReferenceFilesContext
): CollapsedReferenceFile[] {
  const byPath = new Map<string, {
    module?: string;
    layer?: string;
    sourceSet?: string;
    positions: Array<{ line: number; column: number }>;
  }>();
  for (const location of locations) {
    let entry = byPath.get(location.absolutePath);
    if (!entry) {
      entry = { module: location.module, layer: location.layer, sourceSet: location.sourceSet, positions: [] };
      byPath.set(location.absolutePath, entry);
    }
    entry.positions.push({ line: location.line, column: location.column });
  }

  const scored: CollapsedReferenceFile[] = [...byPath.entries()].map(([path, entry]) => ({
    path,
    module: entry.module,
    layer: entry.layer,
    sourceSet: entry.sourceSet,
    totalReferences: entry.positions.length,
    positions: entry.positions,
    valueScore: valueScore(path, entry, context)
  }));

  scored.sort((left, right) =>
    right.valueScore - left.valueScore
    || right.totalReferences - left.totalReferences
    || left.path.localeCompare(right.path));

  return scored.slice(0, Math.max(0, context.limitFiles));
}

function valueScore(
  path: string,
  entry: { module?: string; sourceSet?: string; positions: Array<{ line: number; column: number }> },
  context: RankReferenceFilesContext
): number {
  const mainSource = entry.sourceSet === "main";
  const sameModule = context.anchorModule !== undefined && entry.module === context.anchorModule;
  const focusModule = entry.module !== undefined && context.focusModules.includes(entry.module);
  const taskKeyword = matchesAny(path, [...context.taskKeywords]);
  const frameworkMainRole = FRAMEWORK_MAIN_ROLE_SUFFIXES.some(suffix => path.replace(/\.java$/, "").endsWith(suffix));
  const deferredTest = entry.sourceSet === "test" && context.testReadMode === "defer";
  const generated = GENERATED_PATH_MARKERS.some(marker => path.includes(marker));

  let value = 0;
  value += mainSource ? 35 : 0;
  value += sameModule ? 30 : 0;
  value += focusModule ? 25 : 0;
  value += taskKeyword ? 20 : 0;
  value += frameworkMainRole ? 20 : 0;
  // Capped: a file with 1,000 references cannot out-rank structural/module value.
  value += Math.min(15, Math.log2(1 + entry.positions.length) * 4);
  value -= deferredTest ? 25 : 0;
  value -= generated ? 10 : 0;
  return value;
}
