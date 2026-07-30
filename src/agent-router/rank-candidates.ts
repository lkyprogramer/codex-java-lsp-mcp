// input: Provider outcomes' legacy CandidateFile fragments (see evidence.ts ProviderOutcome.candidates)
//        plus normalized CandidateEvidence (see evidence-normalizer.ts).
// output: Score-sorted candidates with protected read-plan paths, via family-ranker.ts's family-saturated score.
// pos: Task 25's production cutover - foldProviderCandidates still supplies category/reason/verification
//      metadata (materialize-candidates.ts's legacyCandidates param), but ranking itself comes from
//      family-ranker.ts, not finalizeRank/finalizeScore. See finalize-rank.ts's nonLspReadPlanPaths -
//      that pre-pass is a budget-gating heuristic over phase-one evidence only, deliberately left on the
//      old scorer for this cutover (it never reaches the agent as ranked/readPlan output).
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { candidateFromAnchor } from "./candidate-collectors.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { CandidateEvidence, ProviderOutcome } from "./evidence.js";
import { genericFamilyRankPolicy, rankCandidates as rankByFamily, type RankContext } from "./family-ranker.js";
import { materializeRankedCandidates } from "./materialize-candidates.js";
import { candidateLimit, defaultReadPlanMax, legacyReadPlanSorted, selectReadPlanFiles } from "./read-plan.js";
import { truncateCandidateTail } from "./ranking-signals.js";

/**
 * javaIndex/routingPolicy/generation are deliberately absent: every JavaIndex
 * fact lookup this stage used to make (structural deltas, method relations,
 * confidence deltas) now happens upstream in relationship-provider.ts and
 * lands here as an already-scored EvidenceSignal. Re-adding one of these
 * fields to call a JavaIndex method from inside rankCandidates would be a
 * second, redundant facts-fetch pass - see relationship-provider.ts's own
 * verifiedBy-gated fetch for why that cost matters.
 */
export type RankCandidatesContext = {
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly suppressed: Record<string, number>;
  readonly repoRoot: string;
  readonly extraProtectedPaths?: ReadonlySet<string>;
};

/**
 * Replays every provider's `candidates` fragments through the same
 * `mergeCandidate` fold the legacy single-shared-map pipeline used, in
 * provider order. Each fragment is either a fresh discovery or an untouched
 * zero stub (see providers/shared.ts); either way the fold is equivalent to
 * the old sequential mutation of one map.
 */
export function foldProviderCandidates(
  anchors: readonly ResolvedAnchor[],
  outcomes: readonly ProviderOutcome[],
  normalized: ReadonlyMap<string, CandidateEvidence> = normalizeEvidence(outcomes.flatMap(outcome => outcome.evidence))
): Map<string, CandidateFile> {
  const candidates = new Map<string, CandidateFile>();
  for (const anchor of anchors) {
    mergeCandidate(candidates, candidateFromAnchor(anchor));
  }
  for (const outcome of outcomes) {
    for (const candidate of outcome.candidates) {
      const retainedSignalIds = new Set(normalized.get(candidate.absolutePath)?.signals.map(signal => signal.signalId));
      const contributionSurvivedNormalization = outcome.evidence.some(signal =>
        signal.candidateFile === candidate.absolutePath
        && retainedSignalIds.has(signal.signalId));
      if (!contributionSurvivedNormalization) {
        continue;
      }
      mergeCandidate(candidates, candidate);
    }
  }
  return candidates;
}

export async function rankCandidates(
  normalized: ReadonlyMap<string, CandidateEvidence>,
  outcomes: readonly ProviderOutcome[],
  context: RankCandidatesContext
): Promise<CandidateFile[]> {
  const anchor = context.anchors[0]!;
  // Candidate discovery metadata (categories/reasons/verifiedBy/positions) is
  // not yet fully reconstructable from EvidenceFamily alone (materialize-
  // candidates.ts's FAMILY_TO_CATEGORY gap) - foldProviderCandidates still
  // runs its pure mergeCandidate fold to supply it, but its score is never
  // read; family-ranker.ts computes the score family-ranker.ts owns ranking.
  const legacyCandidates = foldProviderCandidates(context.anchors, outcomes, normalized);

  const evidenceCandidates = [...normalized.values()].filter(candidate => {
    if (candidate.module && context.options.excludeModules.includes(candidate.module)) {
      context.suppressed.excludedModules += 1;
      return false;
    }
    return true;
  });
  // family-ranker.ts's pure math has no suppressed-counter side channel;
  // mirror its own sameModule/crossModulePolicy/testReadMode conditions here
  // so the diagnostic counters in the result payload keep meaning what they
  // meant under finalizeScore, without threading a counter into the ranker.
  for (const candidate of evidenceCandidates) {
    if (candidate.sourceSet === "test" && context.options.testReadMode === "defer") {
      context.suppressed.deferredTests += 1;
    }
    if (
      anchor.module !== undefined
      && candidate.module !== undefined
      && candidate.module !== anchor.module
      && context.options.crossModulePolicy !== "all"
    ) {
      context.suppressed.crossModuleConsumers += 1;
    }
  }

  const rankContext: RankContext = {
    policy: genericFamilyRankPolicy,
    anchorModule: anchor.module,
    crossModulePolicy: context.options.crossModulePolicy,
    testReadMode: context.options.testReadMode
  };
  const familyRanked = rankByFamily(evidenceCandidates, rankContext);
  const ranked = materializeRankedCandidates(familyRanked, context.anchors, context.repoRoot, legacyCandidates);

  const maxItems = context.options.readPlanMaxItems ?? defaultReadPlanMax(context.options.mode);
  const sortedForPlan = legacyReadPlanSorted(ranked, context.options);
  const readPlanCovered = new Set(selectReadPlanFiles({ files: sortedForPlan, options: context.options, maxItems }));
  // An interface implementation is static JavaIndex evidence worth exposing
  // even when its lower score does not earn one of the small read-plan
  // windows. Candidate-tail truncation must not erase that relation; callers
  // can then choose it deliberately without spending read-plan budget.
  for (const file of ranked) {
    if (file.reasons.includes("typeGraph:implementation-lookup")) {
      readPlanCovered.add(file);
    }
  }
  for (const file of ranked) {
    if (context.extraProtectedPaths?.has(file.absolutePath)) {
      readPlanCovered.add(file);
    }
  }
  return truncateCandidateTail(ranked, readPlanCovered, candidateLimit(context.options.mode, anchor.profile));
}
