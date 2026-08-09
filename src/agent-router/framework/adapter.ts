// input: FrameworkAdapterContext (bounded FrameworkIndexView + request-scoped anchors/candidates/budget).
// output: The generic contract every framework adapter pack (Spring, later MyBatis/JPA) implements.
// pos: Task 27 Slice C - deliberately has no framework-specific vocabulary; that belongs to
//      the packs implementing this interface (Slice D and Task 28/29), not to the contract itself.
import path from "node:path";
import type { ResolvedAnchor } from "../../agent-types.js";
import type {
  FrameworkFileFacts,
  FrameworkIndexStatus,
  FrameworkIndexView,
  FrameworkRepositoryFactMarkers
} from "../../java-index/framework-index-view.js";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { CandidateEvidence, ProviderOutcome } from "../evidence.js";

export type FrameworkAdapterMetadata = Record<string, unknown>;

export type FrameworkPreflight = {
  status(): Promise<FrameworkIndexStatus>;
  repositoryMarkers(relativePaths: readonly string[]): Promise<Map<string, string>>;
  repositoryFactMarkers(input: {
    importPrefixes: readonly string[];
    annotationPrefixes: readonly string[];
  }): Promise<FrameworkRepositoryFactMarkers>;
  statusUnavailable(): boolean;
  diagnostics(): readonly string[];
};

/**
 * Splits an adapter's output into rankable evidence and everything else.
 * `outcome` is a plain ProviderOutcome so the runner can merge it into
 * index.ts's outcomes array with zero special-casing - it must never carry
 * facts that aren't candidate-worthy (bean definitions, transaction
 * boundaries, endpoint metadata belong in `metadata`, not here). Whether
 * `metadata` is ever externally exposed is Task 31's decision, not this
 * slice's - it exists so an adapter has somewhere to put a fact without
 * being forced to fabricate a low-value EvidenceSignal just to report it.
 */
export type FrameworkCollectResult = {
  outcome: ProviderOutcome;
  metadata: FrameworkAdapterMetadata;
  diagnostics: string[];
};

export type FrameworkAdapterContext = {
  readonly repoRoot: string;
  readonly anchors: readonly ResolvedAnchor[];
  /** Absolute paths already discovered by earlier providers this request - the traversal seed, not a fresh scan. */
  readonly candidateFiles: readonly string[];
  /**
   * Normalized structural evidence from the static provider. Framework packs
   * may expand only an anchor or a file that already has structural support;
   * a lexical-only filename match is not a safe framework traversal seed.
   */
  readonly staticEvidence: readonly CandidateEvidence[];
  readonly frameworkIndex: FrameworkIndexView;
  /**
   * Runner-provided request-local reuse for whole-file framework facts. This
   * is optional so direct adapter callers retain the FrameworkIndexView API.
   */
  readonly requestFrameworkFactsForFiles?: (files: readonly string[], generation?: number) => Promise<FrameworkFileFacts[]>;
  /** Runner-owned lazy request preflight. Direct adapter callers may omit it. */
  readonly preflight?: FrameworkPreflight;
  readonly generation: number;
  readonly budget: DeadlineBudget;
};

/** Uses the runner cache where available, otherwise reads from the stable index view. */
export function frameworkFactsForFiles(
  context: FrameworkAdapterContext,
  files: readonly string[]
): Promise<FrameworkFileFacts[]> {
  return context.requestFrameworkFactsForFiles?.(files, context.generation)
    ?? context.frameworkIndex.frameworkFactsForFiles(files, context.generation);
}

/**
 * Framework adapters run after evidence normalization but before family
 * ranking.  At that point the authoritative structural fact is a signal;
 * familyScores is deliberately still empty until rankCandidates() runs.
 * Keep the score fallback for direct adapter callers that provide already
 * materialized evidence.
 */
export function hasStaticStructureEvidence(candidate: CandidateEvidence): boolean {
  return candidate.signals.some(signal => signal.family === "STATIC_STRUCTURE")
    || (candidate.familyScores.STATIC_STRUCTURE ?? 0) > 0;
}

export function frameworkEvidenceOriginIds(
  context: FrameworkAdapterContext,
  sourceFile: string,
  range?: { start: { line: number }; end: { line: number } }
): string[] {
  const normalizedSource = path.resolve(sourceFile);
  const ids = new Set(context.anchors
    .filter(anchor => path.resolve(anchor.absolutePath) === normalizedSource
      && (!range || (range.start.line <= anchor.line && anchor.line <= range.end.line)))
    .map(anchor => anchor.id));
  // A direct method anchor is more precise than file-level expansion evidence.
  // Only fall back to structural origins when this pending item did not match
  // any request anchor in its own source range.
  if (ids.size === 0) {
    for (const candidate of context.staticEvidence) {
      if (path.resolve(candidate.file) !== normalizedSource) continue;
      for (const signal of candidate.signals) {
        if (signal.family === "STATIC_STRUCTURE" && signal.anchorId) ids.add(signal.anchorId);
      }
    }
  }
  // Legacy/direct adapter fixtures may carry only the materialized family
  // score. The score proves structural reachability but has already lost the
  // originating anchor, so conservatively retain every request anchor instead
  // of silently dropping valid framework evidence in a multi-anchor request.
  if (ids.size === 0 && context.staticEvidence.some(candidate =>
    path.resolve(candidate.file) === normalizedSource
      && (candidate.familyScores.STATIC_STRUCTURE ?? 0) > 0)) {
    for (const anchor of context.anchors) ids.add(anchor.id);
  }
  if (ids.size === 0 && context.anchors.length === 1) ids.add(context.anchors[0]!.id);
  const order = new Map([...context.anchors]
    .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath)
      || left.line - right.line || left.column - right.column || left.id.localeCompare(right.id))
    .map((anchor, index) => [anchor.id, index]));
  return [...ids].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity) || left.localeCompare(right));
}

export interface FrameworkAdapter {
  readonly id: string;
  readonly version: string;
  /**
   * Cheap activation check - e.g. a repositoryMarkers() read of a handful of
   * small build files. Must not perform a full index scan or issue an
   * unbounded query; an adapter for a framework this repo doesn't use should
   * cost close to nothing. Returning false skips collect() entirely.
   */
  isActive(context: FrameworkAdapterContext): Promise<boolean>;
  collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult>;
}
