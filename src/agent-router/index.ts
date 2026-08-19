// input: java_impact tool arguments, JavaIndex facts, optional JDT LS context, and rg output.
// output: Compact V6 impact map, read plan, and evidence gaps.
// pos: Single agent-grade semantic router for Java navigation (Task 22: JavaIndex V2).
import { availableParallelism } from "node:os";
import { JdtlsSession } from "../jdtls-session.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { FrameworkIndexView } from "../java-index/framework-index-view.js";
import { FileSemanticEdgeStoreV2, type SemanticEdgeStoreV2 } from "../semantic-edge-store.js";
import { computeBuildFingerprint } from "../java-index/build-fingerprint.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { resolveFamilyRankPolicy, resolveRoutingPolicy, type RoutingPolicy } from "../routing-policy.js";
import { resolveAnchor } from "./anchor.js";
import { buildReadPlan } from "./read-plan.js";
import type { FrontierShadowReport } from "./retrieval/retrieval-types.js";
import { evidenceGaps } from "./evidence-gaps.js";
import {
  baselineReadPlanSafePaths,
  familyReadPlanProtectedPaths,
  rankCandidatePool,
  truncateRankedCandidatePool,
  type RankCandidatesContext
} from "./rank-candidates.js";
import { buildImpactResult } from "./format.js";
import {
  createImportGraphMetrics,
  JavaIndexRpcTelemetryCollector,
  relationshipRpcSummary,
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
import type { SourceRange } from "../runtime/source-range.js";
import { GenerationRgCache } from "../search/rg-cache.js";
import { RgRunner } from "../search/rg-runner.js";
import type { SearchResult } from "../search/search-types.js";
import { positiveInteger, timed } from "./runtime.js";
import type { CandidateEvidence, ProviderInput } from "./evidence.js";
import { EvidenceLedger } from "./evidence-ledger.js";
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

/** Request-local benchmark observer. It is intentionally absent from ImpactResultV6. */
export type ImpactInternalObserver = {
  readPlanCoordinates?(rangesByAbsolutePath: ReadonlyMap<string, readonly SourceRange[]>): void;
  productionRanking?(
    ranked: readonly CandidateEvidence[],
    selectedPaths: readonly string[]
  ): void;
  frontierShadow?(report: FrontierShadowReport | undefined): void;
};
const RG_CACHE_TTL_MS = positiveInteger(process.env.JAVA_LSP_RG_CACHE_TTL_MS, 300000);
const RG_CONCURRENCY = positiveInteger(process.env.JAVA_LSP_RG_CONCURRENCY, Math.min(4, availableParallelism()));
// Used only when a caller does not supply the request budget (benchmarks, tests).
const DEFAULT_ROUTER_DEADLINE_MS = positiveInteger(process.env.JAVA_LSP_ROUTER_DEADLINE_MS, 15000);
// Live JDT is optional enrichment. Preserve enough of the caller's absolute
// budget for the mandatory AST range batch, final freshness sample and result
// assembly; the child budget can expire without extending the parent request.
const FINALIZATION_RESERVE_MS = 500;

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
    private readonly routingPolicy: RoutingPolicy = resolveRoutingPolicy(repoRoot),
    private readonly rgRunner: RgRunner = new RgRunner(),
    // Appended last (not inserted among the params above) so every existing
    // positional call site - several tests pass rgRunner positionally with
    // `undefined` placeholders before it - keeps working unchanged.
    private readonly edgeStoreV2: SemanticEdgeStoreV2 = new FileSemanticEdgeStoreV2(repoRoot),
    // V3.2-29 benchmark-only ablation override; production callers never pass this.
    private readonly frameworkAdapters: typeof FRAMEWORK_ADAPTERS = FRAMEWORK_ADAPTERS
  ) {}

  /**
   * Computed once per AgentRouter instance (i.e. once per repo-runtime) and
   * cached - computeBuildFingerprint() does real file I/O, so this must
   * never run per request. Reset to undefined only by a BUILD_CHANGE batch
   * in onRepoChanged().
   */
  private buildFingerprintCache: Promise<string> | undefined;

  private buildFingerprint(): Promise<string> {
    if (!this.buildFingerprintCache) {
      this.buildFingerprintCache = computeBuildFingerprint(this.repoRoot, this.layoutContext);
    }
    return this.buildFingerprintCache;
  }

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

  dispose(): void {
    this.clearRgCache();
  }

  /**
   * SemanticEdgeStoreV2's writes are debounced in-memory (see
   * semantic-edge-store.ts's scheduleFlush) - this forces the pending gzip
   * write immediately, for repo-runtime shutdown. A failed flush must never
   * fail shutdown; callers are expected to `.catch()` this like the
   * neighboring javaIndexClient?.close() call.
   */
  async flushSemanticEdgeStore(): Promise<void> {
    await this.edgeStoreV2.flush();
  }

  /** Drop cache entries taken before the current generation. */
  invalidateGeneration(generation: number): void {
    this.rgCache.invalidateBefore(generation);
  }

  /**
   * Applies a coordinator change batch: the rg cache is invalidated below the
   * new generation, and SemanticEdgeStoreV2 is invalidated to match. A
   * BUILD_CHANGE anywhere in the batch treats the whole batch as a build
   * change (every prior buildFingerprint is suspect, so a full wipe via
   * clearForBuildChange matches putComplete()'s own per-edge fingerprint
   * semantics) and also invalidates the cached buildFingerprint so the next
   * request recomputes it; otherwise applyChanges() does dependency-based
   * selective invalidation instead of a full wipe.
   */
  onRepoChanged(batch: RepoChangeBatch): void {
    this.rgCache.invalidateBefore(batch.generation);
    if (batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
      this.edgeStoreV2.clearForBuildChange(batch.generation);
      this.buildFingerprintCache = undefined;
    } else {
      this.edgeStoreV2.applyChanges(batch);
    }
  }

  async impact(
    options: ImpactOptions,
    request?: RequestContext,
    internalObserver?: ImpactInternalObserver
  ): Promise<ImpactResult> {
    const budget = request?.budget ?? DeadlineBudget.fromTimeout(DEFAULT_ROUTER_DEADLINE_MS);
    const javaIndexTelemetry = options.verbosity === "diagnostic"
      && process.env.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY !== "0"
      ? new JavaIndexRpcTelemetryCollector()
      : undefined;
    const execute = () => this.impactWithinRequest(options, request, budget, javaIndexTelemetry, internalObserver);
    return this.javaIndex.withRequestOptions
      ? this.javaIndex.withRequestOptions({ budget, telemetry: javaIndexTelemetry }, execute)
      : execute();
  }

  private async impactWithinRequest(
    options: ImpactOptions,
    request: RequestContext | undefined,
    budget: DeadlineBudget,
    javaIndexTelemetry?: JavaIndexRpcTelemetryCollector,
    internalObserver?: ImpactInternalObserver
  ): Promise<ImpactResult> {
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
    const buildFingerprint = await this.buildFingerprint();
    const anchors = await timed(phaseMs, "resolveAnchors", async () => Promise.all(options.anchors.map((anchor, index) => resolveAnchor({
      repoRoot: this.repoRoot,
      javaIndex: this.javaIndex,
      input: anchor,
      requested: options.profile,
      id: `A${index + 1}`,
      primary: index === 0,
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
      edgeStoreV2: this.edgeStoreV2,
      buildFingerprint,
      concurrency: RG_CONCURRENCY,
      loadRgSummary: (section, currentOptions, currentAnchors) => this.rgSummary(section, currentOptions, currentAnchors, budget, freshness),
      metrics: { typeReference, importGraph, persistedSemantic, semantic }
    };
    const anchorPaths = anchors.map(anchor => anchor.absolutePath);
    const evidenceLedger = new EvidenceLedger(this.repoRoot, anchorPaths);

    // Provider order matters: type-reference reinforcement reads the paths
    // naming recall has already nominated. Keep the pre-Task-24 shared-map
    // sequence exactly: persistedSemantic -> typeGraph -> importGraph ->
    // naming recall -> typeReference.
    const persistedOutcome = await collectPersistedSemanticEvidence({ ...providerInputBase, existingCandidatePaths: anchorPaths });
    evidenceLedger.append(persistedOutcome);
    const staticStructureOutcome = await collectStaticStructureEvidence({ ...providerInputBase, existingCandidatePaths: evidenceLedger.paths() });
    evidenceLedger.append(staticStructureOutcome);
    const lexicalOutcome = await collectLexicalEvidence({ ...providerInputBase, existingCandidatePaths: evidenceLedger.paths() });
    evidenceLedger.append(lexicalOutcome);
    const typeReferenceOutcome = await collectTypeReferenceEvidence({ ...providerInputBase, existingCandidatePaths: evidenceLedger.paths() });
    evidenceLedger.append(typeReferenceOutcome);
    updateCollectorElapsed(phaseMs, typeReference, importGraph, persistedSemantic);

    // A framework adapter may only expand an anchor or a candidate that the
    // static provider has already connected structurally.  Passing the
    // normalized static surface (rather than all lexical recall) prevents an
    // unrelated Spring bean found by name-search from displacing a task's
    // established read-plan candidates.
    const normalizedStaticEvidence = new Map([...evidenceLedger.normalized()]
      .filter(([, candidate]) => candidate.signals.some(signal => signal.family === "STATIC_STRUCTURE")));

    // Task 27 Slice C: an empty adapter registry until Slice D registers the
    // Spring pack, so this is inert scaffolding today - see
    // providers/framework-provider.ts. metadata/diagnostics are a
    // request-scoped side channel, not yet threaded into ImpactResult
    // (Task 31 decides external exposure); only `outcome` joins ranking.
    const frameworkResult = await timed(phaseMs, "frameworkEvidence", async () => collectFrameworkEvidence({
      ...providerInputBase,
      existingCandidatePaths: evidenceLedger.paths()
    }, this.frameworkAdapters, [...normalizedStaticEvidence.values()]));
    const frameworkOutcome = frameworkResult.outcome;
    evidenceLedger.append(frameworkOutcome);

    const familyRankPolicy = resolveFamilyRankPolicy(this.routingPolicy);
    // Relationship evidence depends only on the anchor and the static
    // candidate surface. Collect it before the live semantic phase so exact
    // CALLS/METHOD_RELATION facts can participate in the protected read-plan
    // set that governs that later budget. Re-running it after live semantic
    // was both redundant and too late for Task 30's protected-core contract.
    const relationshipCandidates = await rankCandidatePool(evidenceLedger.normalized(), {
      anchors,
      options,
      suppressed: { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 },
      repoRoot: this.repoRoot,
      familyRankPolicy
    });
    const relationshipOutcome = await timed(phaseMs, "relationshipEvidence", async () => collectRelationshipEvidence({
      ...providerInputBase,
      existingCandidatePaths: relationshipCandidates.map(candidate => candidate.absolutePath),
      allCandidates: relationshipCandidates,
      staticVerifiedCandidates: relationshipCandidates.filter(candidate =>
        (candidate.verifiedBy || []).some(source => source === "typeGraph" || source === "typeReference"))
    }));
    evidenceLedger.append(relationshipOutcome);
    const protectedReadPlanPaths = await timed(phaseMs, "nonLspReadPlan", async () => familyReadPlanProtectedPaths(
      evidenceLedger.normalized(),
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
    // Both seed and verification consume this one child deadline. The nested
    // JavaIndex binding also prevents optional edge-persistence lookups from
    // borrowing the finalization reserve through the outer request scope.
    const liveSemanticBudget = budget.forStage(options.semanticTimeoutMs, FINALIZATION_RESERVE_MS);
    const collectLiveSemantic = () => collectLiveSemanticEvidence({
      ...providerInputBase,
      budget: liveSemanticBudget,
      existingCandidatePaths: evidenceLedger.paths()
    });
    const liveSemanticOutcome = await (this.javaIndex.withRequestOptions
      ? this.javaIndex.withRequestOptions({ budget: liveSemanticBudget }, collectLiveSemantic)
      : collectLiveSemantic());
    evidenceLedger.append(liveSemanticOutcome);
    const supportOutcome = await collectSupportEvidence({ ...providerInputBase, existingCandidatePaths: evidenceLedger.paths() });
    evidenceLedger.append(supportOutcome);

    // Steps 1-4's normalizer validates and dedupes the typed evidence surface;
    // family-ranker.ts scores directly from it (Task 25 cutover). repoRoot is
    // required here - it populates module/layer/sourceSet via classifyPath,
    // which family-ranker.ts's sameModule/crossModule/sourceSet terms need.
    const normalized = evidenceLedger.normalized();

    const suppressed = {
      deferredTests: 0,
      crossModuleConsumers: 0,
      excludedModules: 0
    };
    let productionRankedEvidence: readonly CandidateEvidence[] = [];
    const rankContext: RankCandidatesContext = {
      anchors,
      options,
      suppressed,
      repoRoot: this.repoRoot,
      familyRankPolicy,
      onRankedEvidence(rankedEvidence) {
        productionRankedEvidence = rankedEvidence;
      }
    };
    const rankedPool = await timed(phaseMs, "familyRank", async () => rankCandidatePool(normalized, rankContext));
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
    internalObserver?.readPlanCoordinates?.(readPlanResult.selectedCoordinateRangesByPath);
    internalObserver?.productionRanking?.(productionRankedEvidence, readPlanResult.selectedPaths);
    internalObserver?.frontierShadow?.(readPlanResult.frontierShadow);
    const { selectedCoordinateRangesByPath: _selectedCoordinateRangesByPath, ...publicReadPlanMetrics } = readPlanResult;
    const ranked = truncateRankedCandidatePool(rankedPool, rankContext, new Set(readPlanResult.selectedPaths));
    const idByPath = new Map(ranked.map((file, index) => [file.absolutePath, `F${index + 1}`]));
    const pathById = new Map([...idByPath].map(([absolutePath, id]) => [id, absolutePath]));
    const readPlan = readPlanResult.items.map((item, index) => ({
      ...item,
      fileId: idByPath.get(readPlanResult.selectedPaths[index]!) || "F?"
    }));
    const cacheAfter = await timed(phaseMs, "sessionCacheAfter", async () => this.session.cacheStatus());
    const rgAfter = await timed(phaseMs, "rgCacheAfter", async () => this.rgCacheStatus());
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
    // Earlier request-scoped status consumers share sourceBefore. Force the
    // final probe after every request-time JavaIndex consumer (including
    // Lombok completeness) so generation/coverage changes remain observable.
    const sourceAfter = await timed(phaseMs, "sourceStatusAfter", async () => this.javaIndex.routerStatus(true));

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
          openSource: sourceAfter.openSource,
          ...(javaIndexTelemetry ? {
            rpc: javaIndexTelemetry.snapshot(),
            relationshipRpc: relationshipRpcSummary(javaIndexTelemetry.snapshot(), anchors.length)
          } : {})
        },
        readPlan: publicReadPlanMetrics,
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

function coverageV6(coverage: "complete" | "partial" | "degraded"): "COMPLETE" | "PARTIAL" | "DEGRADED" {
  return coverage.toUpperCase() as "COMPLETE" | "PARTIAL" | "DEGRADED";
}
