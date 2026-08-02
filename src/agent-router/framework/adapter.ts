// input: FrameworkAdapterContext (bounded FrameworkIndexView + request-scoped anchors/candidates/budget).
// output: The generic contract every framework adapter pack (Spring, later MyBatis/JPA) implements.
// pos: Task 27 Slice C - deliberately has no framework-specific vocabulary; that belongs to
//      the packs implementing this interface (Slice D and Task 28/29), not to the contract itself.
import type { ResolvedAnchor } from "../../agent-types.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { CandidateEvidence, ProviderOutcome } from "../evidence.js";

export type FrameworkAdapterMetadata = Record<string, unknown>;

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
  readonly generation: number;
  readonly budget: DeadlineBudget;
};

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
