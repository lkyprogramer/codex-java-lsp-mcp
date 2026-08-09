// input: The production ProviderOutcome[]/CandidateFile[] index.ts already computed for this request.
// output: family-ranker.ts's familyScores/rankWithoutEachFamily/selectedByReadPlan diagnostics, for
//         comparison against production ranked/readPlan without changing either.
// pos: Task 25 item 8 - computes counterfactual diagnostics from the exact
//      production evidence set, gated by index.ts to avoid default payload cost.
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { EvidenceFamily, ProviderOutcome } from "./evidence.js";
import { rankCandidates as rankByFamily, type FamilyRankPolicy, type RankContext } from "./family-ranker.js";

export const ALL_FAMILIES: readonly EvidenceFamily[] = [
  "EXACT_SEMANTIC",
  "STATIC_STRUCTURE",
  "FRAMEWORK",
  "LEXICAL",
  "TASK_CONTEXT",
  "SUPPORT"
];

export type ShadowRankingCandidate = {
  path: string;
  finalScore: number;
  rank: number;
  familyScores: Partial<Record<EvidenceFamily, number>>;
  /** This candidate's rank if that one family's contribution were zeroed - how load-bearing each family is for it. */
  rankWithoutEachFamily: Partial<Record<EvidenceFamily, number>>;
  selectedByReadPlan: boolean;
  /**
   * Task 32 Step 3: whether this candidate would still be read-plan-selected
   * if that one family were ablated. Omitted until an ablation can replay the
   * exact production AST ranges/UTF-8 byte budget without new provider/index
   * I/O; a legacy slot selector is not a measurable substitute.
   */
  selectedByReadPlanWithoutEachFamily?: Partial<Record<EvidenceFamily, boolean>>;
  /** Distinct providerId of every evidence signal this candidate carries - Task 32's real (non-regex) attribution source. */
  providers: string[];
};

export type ShadowRankingDiagnostics = {
  /**
   * The shadow adapter retains the category/reason/verification metadata
   * already discovered by the production provider fold. Its read-plan diff
   * therefore measures family ranking and not a lossy metadata rebuild.
   */
  categoryFidelity: "preserved";
  /**
   * Paths present in production's `ranked` but with no row in `candidates`
   * below (no EvidenceSignal at all in this shadow pass - a legacy collector
   * can still fold a path into production's `ranked` via a
   * `matchCount`/`positions` mutation that a provider's evidence-emission
   * logic did not also turn into a signal). Diffed empirically against a
   * real fixture: the anchor itself is always in this list (anchors carry no
   * evidence signals by design - materialize-candidates.ts injects it
   * separately), so an anchor entry here is expected, not a gap. Any *other*
   * path here is a genuine evidence-coverage gap worth investigating before
   * reading a missing file from a production/shadow diff as a ranking
   * regression.
   */
  productionCandidatesWithoutEvidence: string[];
  /** Exact token/range-aware production buildReadPlan() selection for this request. */
  productionSelectedPaths: string[];
  candidates: ShadowRankingCandidate[];
};

export type BuildShadowRankingInput = {
  readonly repoRoot: string;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly outcomes: readonly ProviderOutcome[];
  readonly ranked: readonly CandidateFile[];
  /** Exact `buildReadPlan().selectedPaths`; shadow attribution must never reselect this base plan. */
  readonly productionSelectedPaths: ReadonlySet<string>;
  readonly familyRankPolicy: FamilyRankPolicy;
};

export async function buildShadowRanking(input: BuildShadowRankingInput): Promise<ShadowRankingDiagnostics> {
  // Production has already normalized these providers, including relationship
  // evidence, before its family ranker runs. Reuse that same evidence set so
  // diagnostics cannot describe a different candidate pipeline.
  const shadowNormalized = [...normalizeEvidence(
    input.outcomes.flatMap(outcome => outcome.evidence),
    input.repoRoot
  ).values()];

  const context: RankContext = {
    policy: input.familyRankPolicy,
    anchorModules: [...new Set(input.anchors.flatMap(anchor =>
      anchor.module === undefined ? [] : [anchor.module]))],
    crossModulePolicy: input.options.crossModulePolicy,
    testReadMode: input.options.testReadMode
  };

  const primary = rankByFamily(shadowNormalized, context);
  const rankByPath = new Map(primary.map((candidate, index) => [candidate.file, index + 1]));

  // Ablation never removes a candidate, only re-scores it. Ranking is fully
  // measurable in memory. Read-plan selection is not: production selection
  // depends on real AST ranges/UTF-8 bytes already queried by buildReadPlan(),
  // so a legacy slot selector would create false attribution and replaying
  // ranges six times would add worker I/O to a diagnostic-only pass.
  const rankWithoutFamily = new Map<EvidenceFamily, Map<string, number>>();
  for (const family of ALL_FAMILIES) {
    const ablated = rankByFamily(shadowNormalized, { ...context, policy: ablatePolicy(context.policy, family) });
    rankWithoutFamily.set(family, new Map(ablated.map((candidate, index) => [candidate.file, index + 1])));
  }

  const candidates: ShadowRankingCandidate[] = primary.map(candidate => {
    const rankWithoutEachFamily: Partial<Record<EvidenceFamily, number>> = {};
    for (const family of ALL_FAMILIES) {
      const rank = rankWithoutFamily.get(family)?.get(candidate.file);
      if (rank !== undefined) {
        rankWithoutEachFamily[family] = rank;
      }
    }
    return {
      path: candidate.file,
      finalScore: candidate.finalScore,
      rank: rankByPath.get(candidate.file)!,
      familyScores: candidate.familyScores,
      rankWithoutEachFamily,
      selectedByReadPlan: input.productionSelectedPaths.has(candidate.file),
      selectedByReadPlanWithoutEachFamily: undefined,
      providers: [...new Set(candidate.signals.map(signal => signal.providerId))]
    };
  });

  const evidencedPaths = new Set(candidates.map(candidate => candidate.path));
  const productionCandidatesWithoutEvidence = input.ranked
    .map(file => file.absolutePath)
    .filter(path => !evidencedPaths.has(path));

  return {
    categoryFidelity: "preserved",
    productionCandidatesWithoutEvidence,
    productionSelectedPaths: [...input.productionSelectedPaths],
    candidates
  };
}

function ablatePolicy(policy: FamilyRankPolicy, family: EvidenceFamily): FamilyRankPolicy {
  return {
    ...policy,
    familyCaps: { ...policy.familyCaps, [family]: 0 },
    diversityBonus: { ...policy.diversityBonus, [family]: 0 }
  };
}
