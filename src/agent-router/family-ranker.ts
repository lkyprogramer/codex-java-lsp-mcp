// input: Normalized CandidateEvidence (one entry per candidate file, deduplicated signals).
// output: Family-saturated final score, replacing bare additive scoring.
// pos: Task 25 production ranking math, consumed by rank-candidates.ts and
//      the pre-semantic read-plan protection path in index.ts.
import type { Confidence } from "../agent-types.js";
import type { CandidateEvidence, EvidenceCompleteness, EvidenceFamily, EvidenceSignal } from "./evidence.js";

export type FamilyRankPolicy = {
  id: "generic-java" | "lishuedu";
  baseScore: number;
  familyCaps: Record<EvidenceFamily, number>;
  diversityBonus: Record<EvidenceFamily, number>;
  completenessFactor: Record<EvidenceCompleteness, number>;
  sourceSetDelta: Record<string, number>;
  sameModuleDelta: number;
  crossModulePenalty: number;
  testDeferPenalty: number;
};

export const genericFamilyRankPolicy: FamilyRankPolicy = {
  id: "generic-java",
  baseScore: 1,
  familyCaps: {
    EXACT_SEMANTIC: 150,
    STATIC_STRUCTURE: 130,
    FRAMEWORK: 120,
    LEXICAL: 70,
    TASK_CONTEXT: 50,
    SUPPORT: 45
  },
  diversityBonus: {
    EXACT_SEMANTIC: 8,
    STATIC_STRUCTURE: 10,
    FRAMEWORK: 8,
    LEXICAL: 4,
    TASK_CONTEXT: 3,
    SUPPORT: 3
  },
  completenessFactor: {
    COMPLETE: 1,
    PARTIAL: 0.55,
    UNKNOWN: 0.35
  },
  sourceSetDelta: { main: 15, test: 0, generated: -5, unknown: 0 },
  sameModuleDelta: 24,
  crossModulePenalty: -18,
  testDeferPenalty: -12
};

/**
 * The lishuedu pack is deliberately an explicit policy selection point even
 * while it shares the calibrated generic saturation values.  Repository
 * specific behavior must enter through tested provider signals, not through
 * a hidden additive score rule at the final ranking boundary.
 */
export const lishueduFamilyRankPolicy: FamilyRankPolicy = {
  ...genericFamilyRankPolicy,
  id: "lishuedu",
  familyCaps: { ...genericFamilyRankPolicy.familyCaps },
  diversityBonus: { ...genericFamilyRankPolicy.diversityBonus },
  completenessFactor: { ...genericFamilyRankPolicy.completenessFactor },
  sourceSetDelta: { ...genericFamilyRankPolicy.sourceSetDelta }
};

/**
 * `signals` may span every provider, not just one. Provider count alone does
 * not increase `independentKinds` - three lexical hits of the same `kind`
 * still count as one independent kind, so duplicated evidence saturates
 * toward `max`, not toward `max * signals.length`.
 */
export function familyContribution(
  signals: readonly EvidenceSignal[],
  family: EvidenceFamily,
  policy: FamilyRankPolicy
): number {
  const selected = signals.filter(signal => signal.family === family);
  if (selected.length === 0) return 0;
  const weighted = selected.map(signal =>
    signal.weight
    * signal.confidence
    * policy.completenessFactor[signal.completeness]);
  const max = Math.max(...weighted);
  const independentKinds = new Set(selected.map(signal => signal.kind)).size;
  const diversity = policy.diversityBonus[family] * Math.log2(1 + independentKinds);
  return Math.min(policy.familyCaps[family], max + diversity);
}

export type RankContext = {
  readonly policy: FamilyRankPolicy;
  readonly anchorModule?: string;
  readonly crossModulePolicy?: "auto" | "focused" | "all";
  readonly testReadMode?: "defer" | "include" | "priority";
};

const ALL_FAMILIES: readonly EvidenceFamily[] = [
  "EXACT_SEMANTIC",
  "STATIC_STRUCTURE",
  "FRAMEWORK",
  "LEXICAL",
  "TASK_CONTEXT",
  "SUPPORT"
];

/** True when at least one signal in `family` was reported COMPLETE, not just numerically high after a PARTIAL/UNKNOWN discount. */
function familyHasCompleteEvidence(signals: readonly EvidenceSignal[], family: EvidenceFamily): boolean {
  return signals.some(signal => signal.family === family && signal.completeness === "COMPLETE");
}

export function confidenceLabel(
  signals: readonly EvidenceSignal[],
  familyScores: Partial<Record<EvidenceFamily, number>>
): Confidence {
  const exactSemantic = familyScores.EXACT_SEMANTIC ?? 0;
  // "complete static/framework >= 100": a PARTIAL/UNKNOWN signal that clears
  // 100 only after being discounted by completenessFactor must not qualify -
  // that would mislabel degraded (e.g. timed-out) evidence as high confidence.
  const completeStaticOrFramework = Math.max(
    familyHasCompleteEvidence(signals, "STATIC_STRUCTURE") ? familyScores.STATIC_STRUCTURE ?? 0 : 0,
    familyHasCompleteEvidence(signals, "FRAMEWORK") ? familyScores.FRAMEWORK ?? 0 : 0
  );
  if (exactSemantic >= 80 || completeStaticOrFramework >= 100) {
    return "high";
  }
  // Lexical evidence never enters this sum - "three lexical matches" must not
  // reach "medium" through LEXICAL alone.
  const totalNonLexical = ALL_FAMILIES
    .filter(family => family !== "LEXICAL")
    .reduce((sum, family) => sum + (familyScores[family] ?? 0), 0);
  if (totalNonLexical >= 60) {
    return "medium";
  }
  return "low";
}

/**
 * Ranks normalized candidates by family-saturated score. Final ranking and
 * pre-semantic read-plan protection call this shared pure function so policy
 * rules cannot affect one path but not the other.
 */
export function rankCandidates(candidates: readonly CandidateEvidence[], context: RankContext): CandidateEvidence[] {
  const policy = context.policy;
  const scored = candidates.map(candidate => {
    const familyScores: Partial<Record<EvidenceFamily, number>> = {};
    for (const family of ALL_FAMILIES) {
      const contribution = familyContribution(candidate.signals, family, policy);
      if (contribution > 0) {
        familyScores[family] = contribution;
      }
    }
    const familySum = ALL_FAMILIES.reduce((sum, family) => sum + (familyScores[family] ?? 0), 0);
    const sourceSetDelta = policy.sourceSetDelta[candidate.sourceSet ?? "unknown"] ?? 0;
    const sameModule = context.anchorModule !== undefined && candidate.module === context.anchorModule;
    // No focus-module exemption here: a focus-module candidate already earns
    // its TASK_CONTEXT family contribution above. Exempting it from this
    // penalty too would score the same signal through two channels - the
    // single-evidence-channel requirement this ranker exists to enforce.
    const crossModulePenalty = context.anchorModule !== undefined
      && candidate.module !== undefined
      && candidate.module !== context.anchorModule
      && context.crossModulePolicy !== "all"
      ? policy.crossModulePenalty
      : 0;
    const testDeferPenalty = candidate.sourceSet === "test" && context.testReadMode === "defer"
      ? policy.testDeferPenalty
      : 0;
    const finalScore = Math.max(
      1,
      policy.baseScore
      + familySum
      + sourceSetDelta
      + (sameModule ? policy.sameModuleDelta : 0)
      + crossModulePenalty
      + testDeferPenalty
    );
    return {
      ...candidate,
      familyScores,
      finalScore,
      confidence: confidenceLabel(candidate.signals, familyScores)
    };
  });
  return scored.sort((left, right) => rankCompare(left, right));
}

function rankCompare(left: CandidateEvidence, right: CandidateEvidence): number {
  if (left.finalScore !== right.finalScore) {
    return right.finalScore - left.finalScore;
  }
  const exactDelta = (right.familyScores.EXACT_SEMANTIC ?? 0) - (left.familyScores.EXACT_SEMANTIC ?? 0);
  if (exactDelta !== 0) {
    return exactDelta;
  }
  const structuralLeft = (left.familyScores.STATIC_STRUCTURE ?? 0) + (left.familyScores.FRAMEWORK ?? 0);
  const structuralRight = (right.familyScores.STATIC_STRUCTURE ?? 0) + (right.familyScores.FRAMEWORK ?? 0);
  if (structuralLeft !== structuralRight) {
    return structuralRight - structuralLeft;
  }
  const confidenceDelta = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }
  // CandidateEvidence.file is a candidate's absolute path (see evidence.ts) -
  // it doubles as the repo-relative tie-break key here since no repo-relative
  // field exists on this type yet.
  return left.file.localeCompare(right.file);
}

function confidenceRank(value: Confidence): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}
