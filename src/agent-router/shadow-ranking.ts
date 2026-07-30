// input: The production ProviderOutcome[]/CandidateFile[] index.ts already computed for this request.
// output: family-ranker.ts's familyScores/rankWithoutEachFamily/selectedByReadPlan diagnostics, for
//         comparison against production ranked/readPlan without changing either.
// pos: Task 25 item 6 - the family-saturating ranker (family-ranker.ts), the relationship-evidence
//      provider (providers/relationship-provider.ts), and the CandidateFile adapter
//      (materialize-candidates.ts) are all still absent from production scoring; this module is the
//      one place that runs them, gated by index.ts to only fire when explicitly requested (see the
//      JAVA_LSP_SHADOW_RANKING/verbosity double gate in index.ts's caller) so it never touches the
//      P95 benchmark path, which defaults to verbosity "standard" (src/benchmark-agent-impact.ts).
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import { buildReadPlan, defaultReadPlanMax, selectReadPlanFiles } from "./read-plan.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { EvidenceFamily, ProviderOutcome } from "./evidence.js";
import { collectRelationshipEvidence, type RelationshipProviderInput } from "./providers/relationship-provider.js";
import { genericFamilyRankPolicy, rankCandidates as rankByFamily, type FamilyRankPolicy, type RankContext } from "./family-ranker.js";
import { materializeRankedCandidates } from "./materialize-candidates.js";

const ALL_FAMILIES: readonly EvidenceFamily[] = [
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
  candidates: ShadowRankingCandidate[];
};

export type BuildShadowRankingInput = {
  readonly repoRoot: string;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  readonly generation?: number;
  readonly outcomes: readonly ProviderOutcome[];
  readonly ranked: readonly CandidateFile[];
  readonly protectedReadPlanPaths: ReadonlySet<string>;
  readonly relationshipProviderInput: Omit<RelationshipProviderInput, "allCandidates" | "staticVerifiedCandidates">;
};

export async function buildShadowRanking(input: BuildShadowRankingInput): Promise<ShadowRankingDiagnostics> {
  const staticVerifiedCandidates = input.ranked.filter(candidate =>
    (candidate.verifiedBy || []).some(source => source === "typeGraph" || source === "typeReference"));
  const relationshipOutcome = await collectRelationshipEvidence({
    ...input.relationshipProviderInput,
    allCandidates: input.ranked,
    staticVerifiedCandidates
  });
  // A separate normalization run, over the production outcomes plus this
  // provider's evidence - production's own `normalized`/`rankCandidates` call
  // in index.ts is untouched. evidenceIdentity() includes providerId, so
  // relationship-provider's signals cannot collide with any other provider's
  // identity even though they share this pool.
  const shadowNormalized = [...normalizeEvidence(
    [...input.outcomes, relationshipOutcome].flatMap(outcome => outcome.evidence),
    input.repoRoot
  ).values()];

  const anchor = input.anchors[0];
  const context: RankContext = {
    policy: genericFamilyRankPolicy,
    anchorModule: anchor?.module,
    crossModulePolicy: input.options.crossModulePolicy,
    testReadMode: input.options.testReadMode
  };

  const primary = rankByFamily(shadowNormalized, context);
  const rankByPath = new Map(primary.map((candidate, index) => [candidate.file, index + 1]));

  const rankWithoutFamily = new Map<EvidenceFamily, Map<string, number>>();
  for (const family of ALL_FAMILIES) {
    const ablated = rankByFamily(shadowNormalized, { ...context, policy: ablatePolicy(context.policy, family) });
    rankWithoutFamily.set(family, new Map(ablated.map((candidate, index) => [candidate.file, index + 1])));
  }

  const materialized = materializeRankedCandidates(
    primary,
    input.anchors,
    input.repoRoot,
    new Map(input.ranked.map(candidate => [candidate.absolutePath, candidate]))
  );
  const selectedShadowPaths = await selectedReadPlanPaths(materialized, input);

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
      selectedByReadPlan: selectedShadowPaths.has(candidate.file)
    };
  });

  const evidencedPaths = new Set(candidates.map(candidate => candidate.path));
  const productionCandidatesWithoutEvidence = input.ranked
    .map(file => file.absolutePath)
    .filter(path => !evidencedPaths.has(path));

  return { categoryFidelity: "preserved", productionCandidatesWithoutEvidence, candidates };
}

async function selectedReadPlanPaths(
  files: readonly CandidateFile[],
  input: BuildShadowRankingInput
): Promise<Set<string>> {
  if (input.options.semanticPolicy !== "required") {
    return new Set(selectReadPlanFiles({
      files,
      options: input.options,
      maxItems: input.options.readPlanMaxItems ?? defaultReadPlanMax(input.options.mode),
      protectedPaths: input.protectedReadPlanPaths
    }).map(file => file.absolutePath));
  }

  // `required` retains buildReadPlan's legacy selection branch. The normal
  // cold/fast shadow path above needs only selected paths, not AST windows.
  const ids = new Map(files.map((file, index) => [file.absolutePath, `S${index + 1}`]));
  const pathsById = new Map([...ids].map(([path, id]) => [id, path]));
  const plan = await buildReadPlan({
    files,
    ids,
    options: input.options,
    javaIndex: input.javaIndex,
    protectedPaths: input.protectedReadPlanPaths,
    generation: input.generation
  });
  return new Set(plan.map(item => pathsById.get(item.fileId)).filter((path): path is string => Boolean(path)));
}

function ablatePolicy(policy: FamilyRankPolicy, family: EvidenceFamily): FamilyRankPolicy {
  return {
    ...policy,
    familyCaps: { ...policy.familyCaps, [family]: 0 },
    diversityBonus: { ...policy.diversityBonus, [family]: 0 }
  };
}
