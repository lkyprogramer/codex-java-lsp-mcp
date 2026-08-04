// input: A scenario's golden files plus the shadow-ranking diagnostics AgentRouter.impact()
//        already computed for the same request (Task 25 item 6 counterfactual pass).
// output: Typed GoldenAttributionV3 rows sourced from real provider/family evidence.
// pos: Task 32 Step 2 - replaces V2's regex-based goldenAttributionRow for the "impact"
//      strategy. Every field here traces to a concrete diagnostic (familyScores, providers,
//      rank, coverage state, semantic completion) rather than a reread-and-guess heuristic.
import { existsSync } from "node:fs";
import path from "node:path";
import type { ImpactMode } from "../agent-types.js";
import type { EvidenceFamily } from "../agent-router/evidence.js";
import { candidateLimit } from "../agent-router/read-plan.js";
import { ALL_FAMILIES, type ShadowRankingDiagnostics } from "../agent-router/shadow-ranking.js";
import type { SourceRootCoverage } from "../java-index/index-types.js";
import { goldenEntries, type GoldenKind, type Scenario } from "./golden-scenario.js";

export type GoldenBlockedByV3 = "hit" | "readplan-budget" | "candidate-limit" | "absent";

export type GoldenAbsentReasonV3 =
  | "coverage-partial"
  | "no-static-edge"
  | "semantic-not-used"
  | "semantic-timeout"
  | "golden-stale-or-low-value";

export type GoldenAttributionV3 = {
  scenarioId: string;
  file: string;
  kind: GoldenKind;
  inCandidates: boolean;
  inReadPlan: boolean;
  firstRank?: number;
  sourceFamilies: EvidenceFamily[];
  providers: string[];
  blockedBy: GoldenBlockedByV3;
  absentReason?: GoldenAbsentReasonV3;
};

export type AttributionV3Context = {
  readonly repoRoot: string;
  readonly mode: ImpactMode;
  readonly profile?: string;
  readonly semanticUsed: boolean;
  readonly semanticTimeout: boolean;
  readonly coverage: readonly SourceRootCoverage[];
};

/**
 * `shadowRanking` must come from the same request this scenario just ran
 * (Task 25 item 6 shadow-mode diagnostics, gated behind
 * `JAVA_LSP_SHADOW_RANKING=1` + verbosity=diagnostic) - it carries the only
 * real per-file family/provider evidence available without re-running the
 * router. Callers without a shadow pass have no V3 attribution to build.
 */
export function buildGoldenAttributionV3(
  scenario: Scenario,
  shadowRanking: ShadowRankingDiagnostics,
  context: AttributionV3Context
): GoldenAttributionV3[] {
  const candidateByPath = new Map(shadowRanking.candidates.map(candidate => [candidate.path, candidate]));
  const limit = candidateLimit(context.mode, resolvedProfile(context.profile));
  return goldenEntries(scenario).map(({ file, kind }) => {
    const absolutePath = path.join(context.repoRoot, file);
    const candidate = candidateByPath.get(absolutePath);
    const inCandidates = candidate !== undefined;
    const inReadPlan = candidate?.selectedByReadPlan === true;
    const blockedBy = resolveBlockedBy(inReadPlan, candidate?.rank, limit);
    const sourceFamilies = candidate
      ? (Object.keys(candidate.familyScores) as EvidenceFamily[]).filter(family => (candidate.familyScores[family] ?? 0) > 0)
      : [];
    return {
      scenarioId: scenario.id,
      file,
      kind,
      inCandidates,
      inReadPlan,
      firstRank: candidate?.rank,
      sourceFamilies,
      providers: candidate?.providers ?? [],
      blockedBy,
      absentReason: blockedBy === "absent" ? absentReason(scenario, file, kind, absolutePath, context) : undefined
    };
  });
}

function resolvedProfile(profile: string | undefined): Parameters<typeof candidateLimit>[1] {
  return profile && profile !== "auto" ? (profile as Parameters<typeof candidateLimit>[1]) : undefined;
}

function resolveBlockedBy(inReadPlan: boolean, rank: number | undefined, limit: number): GoldenBlockedByV3 {
  if (inReadPlan) return "hit";
  if (rank === undefined) return "absent";
  return rank <= limit ? "readplan-budget" : "candidate-limit";
}

/**
 * Ordered most-certain-first: a file can satisfy several of these at once
 * (e.g. missing on disk and also uncovered), and the strongest real signal
 * should win rather than the first one checked incidentally matching.
 * `ambiguous-type`, `framework-not-detected`, and `lexical-miss` are not
 * reachable here on purpose - once a file has zero candidate evidence its
 * familyScores are empty by construction, so nothing distinguishes those
 * three from plain `no-static-edge` without re-querying the index per file.
 */
function absentReason(
  scenario: Scenario,
  file: string,
  kind: GoldenKind,
  absolutePath: string,
  context: AttributionV3Context
): GoldenAbsentReasonV3 {
  if (!existsSync(absolutePath) || kind === "support") {
    return "golden-stale-or-low-value";
  }
  if (context.semanticTimeout) {
    return "semantic-timeout";
  }
  if (!context.semanticUsed) {
    return "semantic-not-used";
  }
  const root = context.coverage.find(entry => file.startsWith(`${entry.root}/`) || file === entry.root);
  if (root && root.state !== "COMPLETE") {
    return "coverage-partial";
  }
  return "no-static-edge";
}

/**
 * Task 32 Step 3. `candidateHitLost`/`readPlanHitLost` are the golden files
 * whose status flips from "counted" to "lost" once this one family is
 * ablated - never a rank delta by itself, since a rank change that never
 * crosses the candidateLimit/read-plan boundary changed nothing a caller can
 * observe. `readPlanHitLost` is the metric Step 8's "framework provider must
 * produce at least one real-repo counterfactual gain" gate reads: a
 * provider that only ever reorders candidates without ever being the
 * difference between a golden file being read or not contributes no
 * measured gain.
 */
export type CounterfactualResult = {
  candidateHitLost: string[];
  readPlanHitLost: string[];
  /** False when this request skipped read-plan ablation (semanticPolicy=required); readPlanHitLost is then always empty and must not be read as "no gain". */
  measured: boolean;
};

export type GoldenCounterfactualV3 = {
  withoutExactSemantic: CounterfactualResult;
  withoutStaticStructure: CounterfactualResult;
  withoutFramework: CounterfactualResult;
  withoutLexical: CounterfactualResult;
  withoutTaskContext: CounterfactualResult;
  withoutSupport: CounterfactualResult;
};

const COUNTERFACTUAL_KEY_BY_FAMILY: Record<EvidenceFamily, keyof GoldenCounterfactualV3> = {
  EXACT_SEMANTIC: "withoutExactSemantic",
  STATIC_STRUCTURE: "withoutStaticStructure",
  FRAMEWORK: "withoutFramework",
  LEXICAL: "withoutLexical",
  TASK_CONTEXT: "withoutTaskContext",
  SUPPORT: "withoutSupport"
};

export function buildGoldenCounterfactualV3(
  scenario: Scenario,
  shadowRanking: ShadowRankingDiagnostics,
  context: Pick<AttributionV3Context, "repoRoot" | "mode" | "profile">
): GoldenCounterfactualV3 {
  const candidateByPath = new Map(shadowRanking.candidates.map(candidate => [candidate.path, candidate]));
  const limit = candidateLimit(context.mode, resolvedProfile(context.profile));
  const entries = goldenEntries(scenario);
  const measured = shadowRanking.candidates.some(candidate => candidate.selectedByReadPlanWithoutEachFamily !== undefined);

  const results = {} as GoldenCounterfactualV3;
  for (const family of ALL_FAMILIES) {
    const candidateHitLost: string[] = [];
    const readPlanHitLost: string[] = [];
    for (const { file } of entries) {
      const candidate = candidateByPath.get(path.join(context.repoRoot, file));
      if (!candidate) continue;

      const wasCandidateHit = candidate.rank <= limit;
      const ablatedRank = candidate.rankWithoutEachFamily[family];
      const isCandidateHitAblated = ablatedRank !== undefined && ablatedRank <= limit;
      if (wasCandidateHit && !isCandidateHitAblated) {
        candidateHitLost.push(file);
      }

      if (candidate.selectedByReadPlan && candidate.selectedByReadPlanWithoutEachFamily?.[family] === false) {
        readPlanHitLost.push(file);
      }
    }
    results[COUNTERFACTUAL_KEY_BY_FAMILY[family]] = { candidateHitLost, readPlanHitLost, measured };
  }
  return results;
}
