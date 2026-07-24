// input: java_impact tool arguments, source facts, optional JDT LS context, and rg output.
// output: Compact v5 impact map, read plan, and evidence gaps.
// pos: Single agent-grade semantic router for lishuedu Java navigation.
import { availableParallelism } from "node:os";
import { JdtlsSession } from "../jdtls-session.js";
import { SourceIndex } from "../source-index.js";
import { EdgeStore } from "../edge-store.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { resolveRoutingPolicy, type RoutingPolicy } from "../routing-policy.js";
import { resolveAnchor } from "./anchor.js";
import {
  candidateFromAnchor,
  collectImportGraphCandidates,
  collectPersistedSemanticCandidates,
  collectTypeGraphCandidates,
  type ImportGraphMetrics
} from "./candidate-collectors.js";
import { buildReadPlan } from "./read-plan.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { evidenceGaps } from "./evidence-gaps.js";
import { finalizeRank, nonLspReadPlanPaths } from "./finalize-rank.js";
import { buildImpactResult } from "./format.js";
import {
  createImportGraphMetrics,
  createPersistedSemanticMetrics,
  createSemanticMetrics,
  createTypeReferenceMetrics,
  rgCacheDelta,
  sessionCacheDelta,
  sourceFactsDelta,
  updateCollectorElapsed,
  updateTypeReferenceCacheMetrics
} from "./impact-metrics.js";
import { collectNamingRecall } from "./naming-recall.js";
import { runRgSection } from "./rg-execution.js";
import { summaryFromSearchResult, type RgCommandSummary } from "./rg-plan.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { RepoChangeBatch } from "../repo-generation.js";
import type { RequestContext } from "../runtime/request-context.js";
import { GenerationRgCache } from "../search/rg-cache.js";
import { RgRunner } from "../search/rg-runner.js";
import type { SearchResult } from "../search/search-types.js";
import { positiveInteger, timed } from "./runtime.js";
import { collectSemanticSeed, semanticVerify } from "./semantic.js";
import { collectTypeReferenceCandidates } from "./type-reference.js";
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

const RG_CACHE_TTL_MS = positiveInteger(process.env.AGENT_RG_CACHE_TTL_MS, 300000);
const RG_CONCURRENCY = positiveInteger(process.env.JAVA_LSP_RG_CONCURRENCY, Math.min(4, availableParallelism()));
// Used only when a caller does not supply the request budget (benchmarks, tests).
const DEFAULT_ROUTER_DEADLINE_MS = positiveInteger(process.env.JAVA_LSP_ROUTER_DEADLINE_MS, 15000);

export class AgentRouter {
  private readonly rgCache = new GenerationRgCache(RG_CACHE_TTL_MS);
  private rgHits = 0;
  private rgMisses = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly session: JdtlsSession,
    private readonly sourceIndex: SourceIndex,
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
      freshnessMode: "NORMAL" as const
    };
    const startedAt = Date.now();
    const phaseMs: Record<string, number> = {};
    const sourceBefore = await timed(phaseMs, "sourceStatusBefore", async () => this.sourceIndex.status());
    const cacheBefore = await timed(phaseMs, "sessionCacheBefore", async () => this.session.cacheStatus());
    const rgBefore = await timed(phaseMs, "rgCacheBefore", async () => this.rgCacheStatus());
    const semantic = createSemanticMetrics(options);
    const typeReference = createTypeReferenceMetrics();
    const importGraph = createImportGraphMetrics();
    const persistedSemantic = createPersistedSemanticMetrics();
    const anchors = await timed(phaseMs, "resolveAnchors", async () => options.anchors.map((anchor, index) => resolveAnchor({
      repoRoot: this.repoRoot,
      sourceIndex: this.sourceIndex,
      input: anchor,
      requested: options.profile,
      id: `A${index + 1}`
    })));
    const candidates = new Map<string, CandidateFile>();
    for (const anchor of anchors) {
      mergeCandidate(candidates, candidateFromAnchor(anchor));
    }

    await timed(phaseMs, "persistedSemantic", async () => collectPersistedSemanticCandidates({
      candidates,
      anchors,
      options,
      repoRoot: this.repoRoot,
      routingPolicy: this.routingPolicy,
      edgeStore: this.edgeStore,
      metrics: persistedSemantic
    }));
    await timed(phaseMs, "typeGraph", async () => collectTypeGraphCandidates({
      candidates,
      anchors,
      options,
      sourceIndex: this.sourceIndex,
      routingPolicy: this.routingPolicy
    }));
    await timed(phaseMs, "importGraph", async () => collectImportGraphCandidates({
      candidates,
      anchors,
      options,
      sourceIndex: this.sourceIndex,
      routingPolicy: this.routingPolicy,
      metrics: importGraph
    }));
    const rgExecution = await collectNamingRecall({
      candidates,
      anchors,
      options,
      phaseMs,
      repoRoot: this.repoRoot,
      layoutContext: this.layoutContext,
      concurrency: RG_CONCURRENCY,
      loadSummary: (section, currentOptions, currentAnchors) => this.rgSummary(section, currentOptions, currentAnchors, budget, freshness)
    });
    const typeReferenceBefore = this.sourceIndex.status();
    await timed(phaseMs, "typeReference", async () => collectTypeReferenceCandidates({
      candidates,
      anchors,
      options,
      metrics: typeReference,
      sourceIndex: this.sourceIndex,
      routingPolicy: this.routingPolicy
    }));
    const typeReferenceAfter = this.sourceIndex.status();
    updateCollectorElapsed(phaseMs, typeReference, importGraph, persistedSemantic);
    const protectedReadPlanPaths = await timed(phaseMs, "nonLspReadPlan", async () => nonLspReadPlanPaths({
      candidates,
      anchor: anchors[0],
      options,
      sourceIndex: this.sourceIndex,
      routingPolicy: this.routingPolicy
    }));

    await collectSemanticSeed({
      candidates,
      anchors,
      options,
      semantic,
      phaseMs,
      repoRoot: this.repoRoot,
      session: this.session,
      routingPolicy: this.routingPolicy,
      budget
    });
    await semanticVerify({
      candidates,
      anchors,
      options,
      semantic,
      phaseMs,
      repoRoot: this.repoRoot,
      session: this.session,
      routingPolicy: this.routingPolicy,
      edgeStore: this.edgeStore,
      budget
    });

    const suppressed = {
      deferredTests: 0,
      crossModuleConsumers: 0,
      excludedModules: 0
    };
    const ranked = await timed(phaseMs, "finalizeRank", async () => finalizeRank({
      candidates,
      anchor: anchors[0],
      options,
      suppressed,
      extraProtectedPaths: protectedReadPlanPaths,
      sourceIndex: this.sourceIndex,
      routingPolicy: this.routingPolicy
    }));
    const idByPath = new Map(ranked.map((file, index) => [file.absolutePath, `F${index + 1}`]));
    const readPlan = await timed(phaseMs, "buildReadPlan", async () => buildReadPlan({
      files: ranked,
      ids: idByPath,
      options,
      sourceIndex: this.sourceIndex,
      protectedPaths: protectedReadPlanPaths
    }));
    const cacheAfter = await timed(phaseMs, "sessionCacheAfter", async () => this.session.cacheStatus());
    const rgAfter = await timed(phaseMs, "rgCacheAfter", async () => this.rgCacheStatus());
    const sourceAfter = await timed(phaseMs, "sourceStatusAfter", async () => this.sourceIndex.status());
    updateTypeReferenceCacheMetrics(typeReference, typeReferenceBefore, typeReferenceAfter);

    return buildImpactResult({
      startedAt,
      phaseMs,
      anchors,
      options,
      ranked,
      readPlan,
      rgExecution,
      suppressed,
      evidenceGaps: evidenceGaps(anchors, options, semantic),
      metrics: {
        semantic,
        typeReference,
        importGraph,
        persistedSemantic,
        cache: sessionCacheDelta(cacheBefore, cacheAfter),
        rgCache: rgCacheDelta(rgBefore, rgAfter),
        sourceFacts: sourceFactsDelta(sourceBefore, sourceAfter, anchors),
        freshness: {
          requestGeneration: freshness.generation,
          freshnessMode: freshness.freshnessMode,
          cacheReadAllowed: freshness.cacheReadAllowed,
          cacheWriteAllowed: freshness.cacheWriteAllowed
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
};
