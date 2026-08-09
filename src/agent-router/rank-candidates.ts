// input: Normalized CandidateEvidence (see evidence-normalizer.ts).
// output: Score-sorted candidates with protected read-plan paths, via family-ranker.ts's family-saturated score.
// pos: Task 25's production cutover. Ranking and candidate metadata both come
//      from typed evidence; no additive CandidateFile fold remains. The same
//      family path also derives the pre-semantic protected read-plan paths.
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { CandidateEvidence } from "./evidence.js";
import { genericFamilyRankPolicy, rankCandidates as rankByFamily, type FamilyRankPolicy, type RankContext } from "./family-ranker.js";
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
  readonly familyRankPolicy?: FamilyRankPolicy;
};

export async function rankCandidates(
  normalized: ReadonlyMap<string, CandidateEvidence>,
  context: RankCandidatesContext
): Promise<CandidateFile[]> {
  const ranked = await rankCandidatePool(normalized, context);
  return truncateRankedCandidatePool(ranked, context);
}

/**
 * Materializes the complete family-ranked pool. Task 30's byte-aware planner
 * consumes this pool before candidate-tail truncation so a low-byte, diverse
 * candidate cannot disappear through the legacy file-slot selector.
 */
export async function rankCandidatePool(
  normalized: ReadonlyMap<string, CandidateEvidence>,
  context: RankCandidatesContext
): Promise<CandidateFile[]> {
  const anchor = context.anchors[0]!;
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
  // meant under the prior final scorer, without threading a counter into the ranker.
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
    policy: context.familyRankPolicy ?? genericFamilyRankPolicy,
    anchorModule: anchor.module,
    crossModulePolicy: context.options.crossModulePolicy,
    testReadMode: context.options.testReadMode
  };
  const familyRanked = rankByFamily(evidenceCandidates, rankContext);
  return materializeRankedCandidates(familyRanked, context.anchors, context.repoRoot);
}

/** Applies the output candidate cap only after Task 30 has chosen its plan. */
export function truncateRankedCandidatePool(
  ranked: CandidateFile[],
  context: RankCandidatesContext,
  requiredPaths: ReadonlySet<string> = new Set<string>()
): CandidateFile[] {
  const anchor = context.anchors[0]!;
  // Preserve Task 29's public candidate-tail contract independently of the
  // V6 byte planner. The legacy file-slot selector is used only to decide
  // which CandidateFile records survive the output cap; it does not feed the
  // V6 shortlist, buckets, utility, or byte budget.
  const readPlanCovered = new Set(baselineReadPlanCoverage(ranked, context));
  for (const file of ranked) {
    if (requiredPaths.has(file.absolutePath)
      || file.reasons.includes("typeGraph:implementation-lookup")) {
      readPlanCovered.add(file);
    }
  }
  const limit = candidateLimit(context.options.mode, anchor.profile);
  for (const file of focusModuleRepresentatives(ranked, context.options.focusModules, limit, readPlanCovered)) {
    readPlanCovered.add(file);
  }
  return truncateCandidateTail(ranked, readPlanCovered, limit);
}

/**
 * Seed file-slot coverage is retained only at the public CandidateFile tail.
 * V6 uses the filtered high-confidence subset below as safe slots.
 */
function baselineReadPlanCoverage(
  ranked: readonly CandidateFile[],
  context: RankCandidatesContext
): CandidateFile[] {
  const maxItems = context.options.readPlanMaxItems ?? defaultReadPlanMax(context.options.mode);
  return selectReadPlanFiles({
    files: legacyReadPlanSorted(ranked, context.options),
    options: context.options,
    maxItems
  });
}

export function baselineReadPlanSafePaths(
  ranked: readonly CandidateFile[],
  context: RankCandidatesContext
): ReadonlySet<string> {
  return new Set(baselineReadPlanCoverage(ranked, context)
    .filter(file => isBaselineSafeCore(file, context.options))
    .map(file => file.absolutePath));
}

function isBaselineSafeCore(file: CandidateFile, options: ImpactOptions): boolean {
  if (file.reasons.includes("target")) return true;
  if (file.sourceSet === "test" && options.testReadMode === "defer") return false;
  if ((file.verifiedBy || []).some(source => source === "typeHierarchy"
    || source === "semantic-definition"
    || source === "semantic-implementation"
    || source === "persisted-reference"
    || source === "persisted-implementation"
    || source === "persisted-typeHierarchy")) return true;
  if (file.reasons.some(reason => reason === "typeGraph:implementation-lookup"
    || reason === "implementation"
    || reason === "SPRING_INJECTION"
    || reason === "SPRING_CALL_PATH"
    || reason === "MYBATIS_STATEMENT_METHOD")) return true;
  return (file.scoreBreakdown || []).some(item => item.delta > 0 && (
    item.id === "finalize.type-relation"
    || item.id === "finalize.method-relation"
  ));
}

const FOCUS_MODULE_REPRESENTATIVES = 3;

/**
 * Candidate-tail truncation must not erase an entire module the caller
 * explicitly named in `focusModules`. Preserve a small, round-robin set of
 * its highest-ranked main-source candidates for candidate recall only; these
 * representatives do not become protected read-plan slots.
 */
function focusModuleRepresentatives(
  ranked: readonly CandidateFile[],
  focusModules: readonly string[],
  limit: number,
  alreadyCovered: ReadonlySet<CandidateFile>
): CandidateFile[] {
  const modules = [...new Set(focusModules.filter(module => module.length > 0))];
  const capacity = Math.max(0, limit - alreadyCovered.size);
  if (modules.length === 0 || capacity === 0) {
    return [];
  }
  const byModule = new Map(modules.map(module => [module, ranked.filter(file =>
    file.module === module
    && file.sourceSet === "main"
    && !alreadyCovered.has(file)
  )]));
  const result: CandidateFile[] = [];
  for (let offset = 0; offset < FOCUS_MODULE_REPRESENTATIVES && result.length < capacity; offset += 1) {
    for (const module of modules) {
      if (result.length >= capacity) {
        break;
      }
      const file = byModule.get(module)?.[offset];
      if (file) {
        result.push(file);
      }
    }
  }
  return result;
}

/**
 * Selects the non-LSP protection set from the same family-ranked candidates
 * production will later return. This replaces the retired additive
 * pre-pass, whose result previously leaked legacy policy scores back into
 * the real tail and read-plan selection.
 */
export async function familyReadPlanProtectedPaths(
  normalized: ReadonlyMap<string, CandidateEvidence>,
  context: RankCandidatesContext
): Promise<ReadonlySet<string>> {
  return new Set([...normalized.values()]
    // Deferred tests remain available to candidate discovery, but they cannot
    // consume a read-plan slot. Do not let a pre-semantic signal reserve one
    // of the bounded range-query shortlist entries for a file the planner
    // will necessarily omit later.
    .filter(candidate => candidate.sourceSet !== "test" || context.options.testReadMode !== "defer")
    .filter(candidate => candidate.signals.some(signal => isPreSemanticProtectedSignal(signal, context.anchors)))
    .map(candidate => candidate.file));
}

/** Framework evidence kinds strong enough to protect a pre-semantic read-plan slot. */
const FRAMEWORK_PRE_SEMANTIC_PROTECTED_KINDS = new Set([
  "SPRING_CALL_PATH",
  "MYBATIS_NAMESPACE",
  "MYBATIS_STATEMENT_METHOD"
]);

function isPreSemanticProtectedSignal(
  signal: CandidateEvidence["signals"][number],
  anchors: readonly ResolvedAnchor[]
): boolean {
  if (signal.family === "FRAMEWORK") {
    if (!FRAMEWORK_PRE_SEMANTIC_PROTECTED_KINDS.has(signal.kind)) return false;
    // A call path emitted while a framework adapter expands a structural seed
    // remains valid framework evidence, but only a call originating at this
    // request's anchor can reserve a pre-semantic core slot.
    return signal.kind !== "SPRING_CALL_PATH"
      || anchors.some(anchor => anchor.absolutePath === signal.sourceFile);
  }
  if (signal.family === "EXACT_SEMANTIC") {
    return signal.kind === "DEFINITION" || signal.kind === "IMPLEMENTATION" || signal.kind === "TYPEHIERARCHY";
  }
  return signal.family === "STATIC_STRUCTURE"
    && (signal.kind === "IMPLEMENTS"
      || signal.kind === "METHOD_RELATION"
      || signal.kind === "TYPE_RELATION"
      || signal.kind === "TYPE_SYMMETRIC"
      || signal.kind === "IMPLEMENTATION_METHOD_TYPE"
      || (signal.kind === "CALLS" && (signal.callDepth ?? Infinity) <= 1));
}
