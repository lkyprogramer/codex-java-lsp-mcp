// input: java_impact tool arguments, JavaIndex facts, optional JDT LS context, and rg output.
// output: Compact v5 impact map, read plan, and evidence gaps.
// pos: Single agent-grade semantic router for Java navigation (Task 22: JavaIndex V2).
import { availableParallelism } from "node:os";
import { JdtlsSession } from "../jdtls-session.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { FrameworkIndexView } from "../java-index/framework-index-view.js";
import { EdgeStore } from "../edge-store.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { resolveFamilyRankPolicy, resolveRoutingPolicy, type RoutingPolicy } from "../routing-policy.js";
import { resolveAnchor } from "./anchor.js";
import { buildReadPlan } from "./read-plan.js";
import { evidenceGaps } from "./evidence-gaps.js";
import {
  baselineReadPlanSafePaths,
  familyReadPlanProtectedPaths,
  foldProviderCandidates,
  rankCandidatePool,
  truncateRankedCandidatePool,
  type RankCandidatesContext
} from "./rank-candidates.js";
import { buildImpactResult } from "./format.js";
import {
  createImportGraphMetrics,
  createPersistedSemanticMetrics,
  createSemanticMetrics,
  createTypeReferenceMetrics,
  rgCacheDelta,
  sessionCacheDelta,
  sourceFactsDelta,
  updateCollectorElapsed
} from "./impact-metrics.js";
import { runRgSection } from "./rg-execution.js";
import { summaryFromSearchResult, type RgCommandSummary } from "./rg-plan.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { RepoChangeBatch } from "../repo-generation.js";
import type { RequestContext } from "../runtime/request-context.js";
import { GenerationRgCache } from "../search/rg-cache.js";
import { RgRunner } from "../search/rg-runner.js";
import type { SearchResult } from "../search/search-types.js";
import { positiveInteger, timed } from "./runtime.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { ProviderInput, ProviderOutcome } from "./evidence.js";
import {
  collectStaticStructureEvidence,
  collectTypeReferenceEvidence
} from "./providers/static-provider.js";
import { collectLexicalEvidence } from "./providers/lexical-provider.js";
import { collectLiveSemanticEvidence, collectPersistedSemanticEvidence } from "./providers/semantic-provider.js";
import { collectSupportEvidence } from "./providers/support-provider.js";
import { collectRelationshipEvidence } from "./providers/relationship-provider.js";
import { collectFrameworkEvidence, FRAMEWORK_ADAPTERS } from "./providers/framework-provider.js";
import { lombokCompleteness } from "./framework/lombok-adapter.js";
import { buildShadowRanking } from "./shadow-ranking.js";
import {
  type CandidateFile,
  type ImpactOptions,
  type ImpactResult,
  type ResolvedAnchor,
  type RgPlanSection
} from "../agent-types.js";

type RouterStatus = {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
  generation: number;
  ttlMs: number;
};

/**
 * Task 25 item 6: an explicit opt-in, independent of `verbosity`. The family
 * diagnostics calculate counterfactual attribution from the outcomes and
 * ranked candidates already produced by this request. Keeping it opt-in
 * still avoids the payload and CPU cost of per-family ablations on ordinary
 * diagnostic requests. The P95 gate defaults to verbosity=standard
 * (src/benchmark-agent-impact.ts), so this flag remains an independent
 * safety net on top of the verbosity gate below.
 *
 * Read live per request, not cached at module load: this toggle exists to be
 * flipped on a running process for a comparison window and back off again,
 * not to be fixed for the process lifetime like RG_CACHE_TTL_MS below.
 */
function shadowRankingEnabled(): boolean {
  return process.env.JAVA_LSP_SHADOW_RANKING === "1";
}
const RG_CACHE_TTL_MS = positiveInteger(process.env.AGENT_RG_CACHE_TTL_MS, 300000);
const RG_CONCURRENCY = positiveInteger(process.env.JAVA_LSP_RG_CONCURRENCY, Math.min(4, availableParallelism()));
// Used only when a caller does not supply the request budget (benchmarks, tests).
const DEFAULT_ROUTER_DEADLINE_MS = positiveInteger(process.env.JAVA_LSP_ROUTER_DEADLINE_MS, 15000);

/**
 * Carries only the legacy planner's already-selected high-confidence exact
 * facts into V6's bounded protected core. This is deliberately a union, not
 * a second ranking path: buildReadPlan still applies its normal file and byte
 * limits when choosing which protected files can fit.
 */
export function readPlanProtectedPaths(
  rankedPool: readonly CandidateFile[],
  familyProtectedPaths: ReadonlySet<string>,
  context: RankCandidatesContext
): ReadonlySet<string> {
  return new Set([...familyProtectedPaths, ...baselineReadPlanSafePaths(rankedPool, context)]);
}

export class AgentRouter {
  private readonly rgCache = new GenerationRgCache(RG_CACHE_TTL_MS);
  private rgHits = 0;
  private rgMisses = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly session: JdtlsSession,
    // Every real caller passes a RouterJavaIndex, which implements both -
    // a separate constructor param for the same underlying object would
    // just be two names for one instance. See evidence.ts's ProviderInput
    // comment for why providers still see these as two distinct fields.
    private readonly javaIndex: RouterIndex & FrameworkIndexView,
    private readonly layoutContext: LayoutContext = probeLayout(repoRoot),
    private readonly edgeStore: EdgeStore = new EdgeStore(repoRoot),
    private readonly routingPolicy: RoutingPolicy = resolveRoutingPolicy(repoRoot),
    private readonly rgRunner: RgRunner = new RgRunner()
  ) {}

  rgCacheStatus(): RouterStatus {
    this.rgCache.evictExpired();
    return {
      enabled: RG_CACHE_TTL_MS > 0,
      entries: this.rgCache.size,
      hits: this.rgHits,
      misses: this.rgMisses,
      generation: this.session.cacheStatus().invalidations,
      ttlMs: RG_CACHE_TTL_MS
    };
  }

  clearRgCache(): void {
    this.rgCache.clear();
  }

  /** Drop cache entries taken before the current generation. */
  invalidateGeneration(generation: number): void {
    this.rgCache.invalidateBefore(generation);
  }

  /**
   * Applies a coordinator change batch: the rg cache is invalidated below the
   * new generation, and any Java or build change clears the semantic edge store.
   * Iteration B keeps this deliberately coarse; Task 33 adds selective eviction.
   */
  onRepoChanged(batch: RepoChangeBatch): void {
    this.rgCache.invalidateBefore(batch.generation);
    const semantic = batch.changes.some(change =>
      change.kind === "JAVA_ADD"
      || change.kind === "JAVA_CHANGE"
      || change.kind === "JAVA_DELETE"
      || change.kind === "BUILD_CHANGE");
    if (semantic) this.edgeStore.invalidateAll();
  }

  async impact(
    options: ImpactOptions,
    request?: RequestContext
  ): Promise<ImpactResult> {
    const budget = request?.budget ?? DeadlineBudget.fromTimeout(DEFAULT_ROUTER_DEADLINE_MS);
    // A generation of 0 with reads/writes allowed reproduces the pre-freshness
    // behavior for callers (benchmarks/tests) that do not build a RequestContext.
    const freshness = request ?? {
      generation: 0,
      cacheReadAllowed: true,
      cacheWriteAllowed: true,
      freshnessMode: "NORMAL" as const,
      indexOpenSource: undefined as RequestContext["indexOpenSource"]
    };
    const generation = freshness.generation;
    const startedAt = Date.now();
    const phaseMs: Record<string, number> = {};
    const sourceBefore = await timed(phaseMs, "sourceStatusBefore", async () => this.javaIndex.routerStatus());
    const cacheBefore = await timed(phaseMs, "sessionCacheBefore", async () => this.session.cacheStatus());
    const rgBefore = await timed(phaseMs, "rgCacheBefore", async () => this.rgCacheStatus());
    const semantic = createSemanticMetrics(options);
    const typeReference = createTypeReferenceMetrics();
    const importGraph = createImportGraphMetrics();
    const persistedSemantic = createPersistedSemanticMetrics();
    const anchors = await timed(phaseMs, "resolveAnchors", async () => Promise.all(options.anchors.map((anchor, index) => resolveAnchor({
      repoRoot: this.repoRoot,
      javaIndex: this.javaIndex,
      input: anchor,
      requested: options.profile,
      id: `A${index + 1}`,
      generation
    }))));

    const providerInputBase: Omit<ProviderInput, "existingCandidatePaths"> = {
      repoRoot: this.repoRoot,
      anchors,
      options,
      javaIndex: this.javaIndex,
      frameworkIndex: this.javaIndex,
      routingPolicy: this.routingPolicy,
      layoutContext: this.layoutContext,
      generation,
      budget,
      phaseMs,
      session: this.session,
      edgeStore: this.edgeStore,
      concurrency: RG_CONCURRENCY,
      loadRgSummary: (section, currentOptions, currentAnchors) => this.rgSummary(section, currentOptions, currentAnchors, budget, freshness),
      metrics: { typeReference, importGraph, persistedSemantic, semantic }
    };
    const anchorPaths = anchors.map(anchor => anchor.absolutePath);

    // Provider order matters: type-reference reinforcement reads the paths
    // naming recall has already nominated. Keep the pre-Task-24 shared-map
    // sequence exactly: persistedSemantic -> typeGraph -> importGraph ->
    // naming recall -> typeReference.
    const persistedOutcome = await collectPersistedSemanticEvidence({ ...providerInputBase, existingCandidatePaths: anchorPaths });
    const afterPersistedPaths = unionPaths(anchorPaths, persistedOutcome);
    const staticStructureOutcome = await collectStaticStructureEvidence({ ...providerInputBase, existingCandidatePaths: afterPersistedPaths });
    const afterStaticStructurePaths = unionPaths(afterPersistedPaths, staticStructureOutcome);
    const lexicalOutcome = await collectLexicalEvidence({ ...providerInputBase, existingCandidatePaths: afterStaticStructurePaths });
    const afterLexicalPaths = unionPaths(afterStaticStructurePaths, lexicalOutcome);
    const typeReferenceOutcome = await collectTypeReferenceEvidence({ ...providerInputBase, existingCandidatePaths: afterLexicalPaths });
    const afterStaticPaths = unionPaths(afterLexicalPaths, typeReferenceOutcome);
    updateCollectorElapsed(phaseMs, typeReference, importGraph, persistedSemantic);

    // A framework adapter may only expand an anchor or a candidate that the
    // static provider has already connected structurally.  Passing the
    // normalized static surface (rather than all lexical recall) prevents an
    // unrelated Spring bean found by name-search from displacing a task's
    // established read-plan candidates.
    const normalizedStaticEvidence = normalizeEvidence(
      [...staticStructureOutcome.evidence, ...typeReferenceOutcome.evidence],
      this.repoRoot
    );

    // Task 27 Slice C: an empty adapter registry until Slice D registers the
    // Spring pack, so this is inert scaffolding today - see
    // providers/framework-provider.ts. metadata/diagnostics are a
    // request-scoped side channel, not yet threaded into ImpactResult
    // (Task 31 decides external exposure); only `outcome` joins ranking.
    const frameworkResult = await timed(phaseMs, "frameworkEvidence", async () => collectFrameworkEvidence({
      ...providerInputBase,
      existingCandidatePaths: afterStaticPaths
    }, FRAMEWORK_ADAPTERS, [...normalizedStaticEvidence.values()]));
    const frameworkOutcome = frameworkResult.outcome;
    const afterFrameworkPaths = unionPaths(afterStaticPaths, frameworkOutcome);

    const preRelationshipOutcomes: ProviderOutcome[] = [persistedOutcome, staticStructureOutcome, lexicalOutcome, typeReferenceOutcome, frameworkOutcome];
    // Relationship evidence depends only on the anchor and the static
    // candidate surface. Collect it before the live semantic phase so exact
    // CALLS/METHOD_RELATION facts can participate in the protected read-plan
    // set that governs that later budget. Re-running it after live semantic
    // was both redundant and too late for Task 30's protected-core contract.
    const relationshipCandidates = [...foldProviderCandidates(anchors, preRelationshipOutcomes).values()];
    const relationshipOutcome = await timed(phaseMs, "relationshipEvidence", async () => collectRelationshipEvidence({
      ...providerInputBase,
      existingCandidatePaths: relationshipCandidates.map(candidate => candidate.absolutePath),
      allCandidates: relationshipCandidates,
      staticVerifiedCandidates: relationshipCandidates.filter(candidate =>
        (candidate.verifiedBy || []).some(source => source === "typeGraph" || source === "typeReference"))
    }));
    const phaseOneOutcomes: ProviderOutcome[] = [...preRelationshipOutcomes, relationshipOutcome];
    const familyRankPolicy = resolveFamilyRankPolicy(this.routingPolicy);
    const phaseOneNormalized = normalizeEvidence(phaseOneOutcomes.flatMap(outcome => outcome.evidence), this.repoRoot);
    const protectedReadPlanPaths = await timed(phaseMs, "nonLspReadPlan", async () => familyReadPlanProtectedPaths(
      phaseOneNormalized,
      phaseOneOutcomes,
      {
        anchors,
        options,
        suppressed: { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 },
        repoRoot: this.repoRoot,
        familyRankPolicy
      }
    ));

    // Live JDT budget is spent only after the protected read-plan paths are
    // already pinned from cheaper evidence, matching the pre-Task-24 order.
    const liveSemanticOutcome = await collectLiveSemanticEvidence({ ...providerInputBase, existingCandidatePaths: afterFrameworkPaths });
    const afterSemanticPaths = unionPaths(afterFrameworkPaths, liveSemanticOutcome);
    const supportOutcome = await collectSupportEvidence({ ...providerInputBase, existingCandidatePaths: afterSemanticPaths });

    const outcomes: ProviderOutcome[] = [...phaseOneOutcomes, liveSemanticOutcome, supportOutcome];
    // Steps 1-4's normalizer validates and dedupes the typed evidence surface;
    // family-ranker.ts scores directly from it (Task 25 cutover). repoRoot is
    // required here - it populates module/layer/sourceSet via classifyPath,
    // which family-ranker.ts's sameModule/crossModule/sourceSet terms need.
    const normalized = normalizeEvidence(outcomes.flatMap(outcome => outcome.evidence), this.repoRoot);

    const suppressed = {
      deferredTests: 0,
      crossModuleConsumers: 0,
      excludedModules: 0
    };
    const rankContext = {
      anchors,
      options,
      suppressed,
      repoRoot: this.repoRoot,
      familyRankPolicy
    };
    const rankedPool = await timed(phaseMs, "familyRank", async () => rankCandidatePool(normalized, outcomes, rankContext));
    const plannerProtectedPaths = readPlanProtectedPaths(rankedPool, protectedReadPlanPaths, rankContext);
    const poolIdByPath = new Map(rankedPool.map((file, index) => [file.absolutePath, `P${index + 1}`]));
    const readPlanResult = await timed(phaseMs, "buildReadPlan", async () => buildReadPlan({
      files: rankedPool,
      ids: poolIdByPath,
      options,
      javaIndex: this.javaIndex,
      protectedPaths: plannerProtectedPaths,
      generation
    }));
    const ranked = truncateRankedCandidatePool(rankedPool, rankContext, new Set(readPlanResult.selectedPaths));
    const idByPath = new Map(ranked.map((file, index) => [file.absolutePath, `F${index + 1}`]));
    const pathById = new Map([...idByPath].map(([absolutePath, id]) => [id, absolutePath]));
    const readPlan = readPlanResult.items.map((item, index) => ({
      ...item,
      fileId: idByPath.get(readPlanResult.selectedPaths[index]!) || "F?"
    }));
    const cacheAfter = await timed(phaseMs, "sessionCacheAfter", async () => this.session.cacheStatus());
    const rgAfter = await timed(phaseMs, "rgCacheAfter", async () => this.rgCacheStatus());
    const sourceAfter = await timed(phaseMs, "sourceStatusAfter", async () => this.javaIndex.routerStatus());
    // One status() call shared by the Lombok gap and semantic.readiness below -
    // both want the same JDT session snapshot, and status() is not free.
    const sessionStatus = this.session.status();
    // The result-level Lombok gap is about the files this request will expose
    // to the agent, not only the anchor declaration.  A service can call a
    // Lombok-generated getter on a selected DTO/entity without carrying any
    // Lombok annotation itself.
    const lombokScopePaths = [...new Set([
      ...anchorPaths,
      ...readPlan.map(item => pathById.get(item.fileId)).filter((item): item is string => item !== undefined)
    ])];
    const lombok = await timed(phaseMs, "lombokCompleteness", async () =>
      lombokCompleteness(sessionStatus.generatedCode, lombokScopePaths, this.javaIndex, generation, budget));

    // Diagnostic only: production ranking above has already used the same
    // normalized outcomes. Shadow output adds counterfactual attribution; it
    // must never cause a second provider/facts collection pass.
    const shadowRanking = shadowRankingEnabled() && options.verbosity === "diagnostic"
      ? await timed(phaseMs, "shadowRanking", async () => buildShadowRanking({
        repoRoot: this.repoRoot,
        anchors,
        options,
        javaIndex: this.javaIndex,
        generation,
        outcomes,
        ranked,
        protectedReadPlanPaths,
        familyRankPolicy
      }))
      : undefined;

    return buildImpactResult({
      startedAt,
      phaseMs,
      anchors,
      options,
      ranked,
      readPlan,
      rgExecution: lexicalOutcome.rgExecution,
      suppressed,
      evidenceGaps: [
        ...evidenceGaps(anchors, options, { ...semantic, lombokIncomplete: lombok.taskGapDetected }),
        ...readPlanResult.evidenceGaps
      ],
      shadowRanking,
      freshness: {
        requestGeneration: freshness.generation,
        indexedGeneration: sourceAfter.javaIndex.indexedGeneration,
        coverage: coverageV6(sourceAfter.coverage),
        changedDuringRequest: sourceAfter.javaIndex.indexedGeneration !== sourceBefore.javaIndex.indexedGeneration
      },
      semanticCompletion: liveSemanticOutcome.completion,
      semanticReadiness: sessionStatus.state,
      metrics: {
        semantic,
        typeReference,
        importGraph,
        persistedSemantic,
        cache: sessionCacheDelta(cacheBefore, cacheAfter),
        rgCache: rgCacheDelta(rgBefore, rgAfter),
        sourceFacts: sourceFactsDelta(sourceBefore, sourceAfter, anchors),
        javaIndex: {
          state: sourceAfter.javaIndex.state,
          files: sourceAfter.javaIndex.files,
          coverage: sourceAfter.coverage,
          openSource: sourceAfter.openSource
        },
        readPlan: readPlanResult,
        framework: {
          metadata: frameworkResult.metadata,
          diagnostics: frameworkResult.diagnostics,
          completion: frameworkOutcome.completion,
          generatedCode: { semantics: lombok.semantics, taskGapDetected: lombok.taskGapDetected }
        }
      }
    });
  }

  private async rgSummary(
    section: RgPlanSection,
    options: ImpactOptions,
    anchors: readonly ResolvedAnchor[],
    budget: DeadlineBudget,
    freshness: RouterFreshness
  ): Promise<RgCommandSummary> {
    this.rgCache.evictExpired();
    // The request's repo generation is the single cache key dimension. The old
    // session.cacheStatus().invalidations source was 0 on the fast path, so an
    // edit never invalidated an rg result (C-03).
    const generation = freshness.generation;
    const key = JSON.stringify({ repoRoot: this.repoRoot, section, focusModules: options.focusModules, excludeModules: options.excludeModules });
    const score = (result: SearchResult): RgCommandSummary => summaryFromSearchResult({
      policy: this.routingPolicy,
      repoRoot: this.repoRoot,
      section,
      result,
      anchors,
      options
    });

    const cached = freshness.cacheReadAllowed ? this.rgCache.get(key, generation) : undefined;
    if (cached) {
      this.rgHits += 1;
      return { ...score(cached), cacheHit: true };
    }
    this.rgMisses += 1;
    const result = await runRgSection({
      repoRoot: this.repoRoot,
      section,
      budget,
      runner: this.rgRunner
    });
    // GenerationRgCache drops anything that is not COMPLETE; a dirty/degraded
    // request additionally forbids writes so a stale generation is never stored.
    if (freshness.cacheWriteAllowed) {
      this.rgCache.set(key, generation, result);
    }
    return score(result);
  }
}

type RouterFreshness = {
  generation: number;
  cacheReadAllowed: boolean;
  cacheWriteAllowed: boolean;
  freshnessMode: RequestContext["freshnessMode"];
  indexOpenSource?: RequestContext["indexOpenSource"];
};

function unionPaths(known: readonly string[], outcome: ProviderOutcome): string[] {
  return [...new Set([...known, ...outcome.candidates.map(candidate => candidate.absolutePath)])];
}

function coverageV6(coverage: "complete" | "partial" | "degraded"): "COMPLETE" | "PARTIAL" | "DEGRADED" {
  return coverage.toUpperCase() as "COMPLETE" | "PARTIAL" | "DEGRADED";
}
