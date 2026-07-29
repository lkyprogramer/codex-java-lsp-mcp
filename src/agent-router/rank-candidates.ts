// input: Provider outcomes' legacy CandidateFile fragments (see evidence.ts ProviderOutcome.candidates).
// output: Score-sorted candidates with protected read-plan paths, via the unchanged finalizeRank pipeline.
// pos: Task 24 Step 8 - the "rankCandidates" stage; adapts old scoring rather than replacing it (plan line 7283).
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { RoutingPolicy } from "../routing-policy.js";
import { candidateFromAnchor } from "./candidate-collectors.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { CandidateEvidence, ProviderOutcome } from "./evidence.js";
import { finalizeRank } from "./finalize-rank.js";

export type RankCandidatesContext = {
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly suppressed: Record<string, number>;
  readonly javaIndex: RouterIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly generation: number;
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
  const candidates = foldProviderCandidates(context.anchors, outcomes, normalized);
  return finalizeRank({
    candidates,
    anchor: context.anchors[0]!,
    options: context.options,
    suppressed: context.suppressed,
    extraProtectedPaths: context.extraProtectedPaths,
    javaIndex: context.javaIndex,
    routingPolicy: context.routingPolicy,
    generation: context.generation
  });
}
