import { existsSync } from "node:fs";
import path from "node:path";
import type { CandidateFile, ImpactOptions, ResolvedAnchor, RgPlanSection, RgSectionSummary } from "../agent-types.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { Completion } from "../runtime/completion.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { summaryFromSearchResult, type RgCommandSummary } from "./rg-plan.js";

/** Upper bound on any single section; the request deadline is the real bound. */
const RG_SECTION_CAP_MS = 15000;

const DEFAULT_EXCLUDE_GLOBS = [
  "!**/README.md",
  "!docs/superpowers/plans/**",
  "!**/{build,.gradle,node_modules,dist}/**"
];

export type RgExecutionResult = {
  files: CandidateFile[];
  /** Full, non-rendered match attribution used by the lexical evidence provider. */
  evidenceMatches: Array<{ file: CandidateFile; anchorId: string; category: RgPlanSection["category"] }>;
  sections: RgSectionSummary[];
  rawBytes: number;
  totalMatches: number;
  commandCount: number;
  completion: Completion;
  suppressed: Record<string, unknown>;
};

type ExecuteRgPlanInput = {
  readonly plan: readonly RgPlanSection[];
  readonly options: ImpactOptions;
  readonly anchors: readonly ResolvedAnchor[];
  readonly concurrency: number;
  readonly loadSummary: (
    section: RgPlanSection,
    options: ImpactOptions,
    anchors: readonly ResolvedAnchor[]
  ) => Promise<RgCommandSummary>;
};

type RunRgSectionInput = {
  readonly repoRoot: string;
  readonly section: RgPlanSection;
  readonly budget: DeadlineBudget;
  readonly runner: RgRunner;
};

export async function executeRgPlan(input: ExecuteRgPlanInput): Promise<RgExecutionResult> {
  const fileMap = new Map<string, CandidateFile>();
  const evidenceMatches: RgExecutionResult["evidenceMatches"] = [];
  const sections: RgSectionSummary[] = [];
  let rawBytes = 0;
  let totalMatches = 0;
  let commandCount = 0;
  const completions: Completion[] = [];
  const results = await mapConcurrent(input.plan, input.concurrency, async item => ({
    item,
    summary: await input.loadSummary(item, input.options, input.anchors)
  }));
  for (const { item, summary } of results) {
    commandCount += 1;
    rawBytes += summary.rawBytes;
    totalMatches += summary.totalMatches;
    completions.push(summary.completion);
    for (const file of summary.files) {
      mergeCandidate(fileMap, file);
      evidenceMatches.push({
        file,
        anchorId: item.anchorId ?? input.anchors[0]?.id ?? "A1",
        category: item.category
      });
    }
    sections.push({
      category: item.category,
      reason: item.reason,
      commandCount: 1,
      matchedFiles: summary.files.length,
      totalMatches: summary.totalMatches,
      rawBytes: summary.rawBytes,
      cacheHits: summary.cacheHit ? 1 : 0,
      completion: summary.completion,
      files: summary.files
        .sort((left, right) => right.score - left.score)
        .slice(0, 6)
        .map(file => ({
          path: file.path,
          module: file.module,
          layer: file.layer,
          sourceSet: file.sourceSet,
          score: Math.round(file.score),
          matchCount: file.matchCount
        }))
    });
  }
  return {
    files: [...fileMap.values()],
    evidenceMatches,
    sections,
    rawBytes,
    totalMatches,
    commandCount,
    completion: worstCompletion(completions),
    suppressed: {
      rawBytes,
      note: "raw rg stdout is summarized inside MCP and not returned to the agent"
    }
  };
}

/**
 * The plan's completion is the weakest of its sections: one truncated section
 * means the lexical evidence as a whole is incomplete.
 */
export function worstCompletion(values: readonly Completion[]): Completion {
  const rank: Record<Completion, number> = {
    COMPLETE: 0,
    PARTIAL_LIMIT: 1,
    PARTIAL_TIMEOUT: 2,
    CANCELLED: 3,
    FAILED: 4
  };
  return values.reduce<Completion>(
    (worst, value) => (rank[value] > rank[worst] ? value : worst),
    "COMPLETE"
  );
}

/**
 * Runs one plan section and returns the raw search result. Scoring is applied
 * per request by `summaryFromSearchResult`, so a cached result is re-scored for
 * the current anchors instead of replaying stale scores.
 */
export async function runRgSection(input: RunRgSectionInput): Promise<SearchResult> {
  const paths = input.section.paths.filter(item => existsSync(path.resolve(input.repoRoot, item)));
  if (paths.length === 0) {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
  const query: RgQuery = {
    pattern: input.section.pattern,
    roots: paths,
    globs: [...input.section.globs, ...DEFAULT_EXCLUDE_GLOBS],
    cwd: input.repoRoot
  };
  // RgRunner reads `budget.remainingMs()`, so the per-section cap is applied by
  // handing it a budget that is never longer than the cap or the request's
  // remaining time, whichever is smaller.
  const sectionBudget = DeadlineBudget.fromTimeout(
    Math.max(1, input.budget.remainingMs(RG_SECTION_CAP_MS))
  );
  return input.runner.run(query, sectionBudget);
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
