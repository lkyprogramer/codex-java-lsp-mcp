import { classifyPath } from "../repo-layout.js";
import { normalizeRepoLocation } from "../semantic-location.js";
import { classifySemanticError, isExpectedSemanticOutcome } from "../runtime/intelligence-error.js";
import type { JdtlsSession, LspLocation, LspLocationLink } from "../jdtls-session.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import {
  mapSemanticEdgeForPersistence,
  type RawSemanticEdgeCandidate,
  type SemanticEdgeStoreV2,
  type SymbolAnchorResolver
} from "../semantic-edge-store.js";
import type { CandidateFile, ImpactMode, ImpactOptions, ResolvedAnchor, SemanticPolicy } from "../agent-types.js";
import { breakdown, mergeCandidate, scoreBase } from "./candidate-helpers.js";
import { rankReferenceFiles, referenceFileLimit, type ReferenceLocation } from "./reference-ranking.js";

type SemanticSuppressed = {
  /** Locations JDT returned that resolve outside this repository. */
  externalLocations: number;
};

export type SemanticStageResult = {
  failedAnchors: readonly string[];
  cancelledAnchors: readonly string[];
  timeoutAnchors: readonly string[];
  limitedAnchors: readonly string[];
};

type SemanticFailureKind = "timeout" | "cancelled" | "failed";

type SemanticSeedState = {
  used: boolean;
  skipped: boolean;
  timeout: boolean;
  errorCode?: string;
  externalLocationsSuppressed: number;
};

type SemanticVerifyState = {
  used: boolean;
  verifyUsed: boolean;
  verifySkipped: boolean;
  timeout: boolean;
  errorCode?: string;
  externalLocationsSuppressed: number;
  referenceRawLocations: number;
  referenceCollapsedFiles: number;
  referenceReturnedFiles: number;
  referenceTruncatedByLimit: boolean;
  referenceRankingMs: number;
};

type SemanticInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly candidateMapForAnchor?: (anchor: ResolvedAnchor) => Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly phaseMs: Record<string, number>;
  readonly repoRoot: string;
  readonly session: JdtlsSession;
  readonly routingPolicy: RoutingPolicy;
  readonly budget: DeadlineBudget;
};

type SemanticSeedInput = SemanticInput & {
  readonly semantic: SemanticSeedState;
};

type SemanticVerifyInput = SemanticInput & {
  readonly semantic: SemanticVerifyState;
  /**
   * Task 33 Step 8/9 (see semantic-edge-store.ts): resolves a location to a
   * stable JavaIndex symbol ID and persists COMPLETE, repo-contained edges
   * into SemanticEdgeStoreV2 - the sole persisted-semantic store since the
   * legacy file-path-keyed edge-store's read path was retired. `javaIndex`
   * is the same underlying RouterIndex every other provider already sees
   * via ProviderInput.
   */
  readonly javaIndex: RouterIndex;
  readonly edgeStoreV2: SemanticEdgeStoreV2;
  /** Cached once per repo-runtime by the caller (see AgentRouter) - never recomputed per request. */
  readonly buildFingerprint: string;
  /** The RepoChangeBatch-derived freshness clock (ProviderInput.generation), distinct from JdtlsSession's own internal cacheGeneration. */
  readonly generation: number;
};

type LocationCandidateInput = {
  readonly location: LspLocation | LspLocationLink;
  readonly reason: string;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly repoRoot: string;
  readonly routingPolicy: RoutingPolicy;
  readonly suppressed: SemanticSuppressed;
};

export async function collectSemanticSeed(input: SemanticSeedInput): Promise<SemanticStageResult> {
  if (!shouldUseSemantic(input.options.semanticPolicy, input.options.mode, input.anchors)) {
    input.semantic.skipped = true;
    return semanticStageResult();
  }
  input.semantic.used = true;
  const suppressed: SemanticSuppressed = { externalLocations: 0 };
  const failedAnchors: string[] = [];
  const cancelledAnchors: string[] = [];
  const timeoutAnchors: string[] = [];
  await timed(input.phaseMs, "semantic", async () => {
    for (let anchorIndex = 0; anchorIndex < input.anchors.length; anchorIndex += 1) {
      const anchor = input.anchors[anchorIndex]!;
      if (input.budget.expired()) {
        recordSemanticBudgetExpiry(input.semantic);
        timeoutAnchors.push(...input.anchors.slice(anchorIndex).map(candidate => candidate.id));
        break;
      }
      try {
        const context = await input.session.semanticLocations(
          anchor.absolutePath,
          anchor.line,
          anchor.column,
          input.budget,
          shouldIncludeImplementations(anchor)
        );
        if (input.budget.expired()) {
          recordSemanticBudgetExpiry(input.semantic);
          timeoutAnchors.push(anchor.id);
        }
        for (const location of [...context.definitions, ...context.implementations]) {
          const described = locationCandidate({
            location,
            reason: context.implementations.includes(location) ? "implementation" : "definition",
            anchor,
            options: input.options,
            repoRoot: input.repoRoot,
            routingPolicy: input.routingPolicy,
            suppressed
          });
          if (described) {
            mergeCandidate(input.candidateMapForAnchor?.(anchor) ?? input.candidates, described);
          }
        }
      } catch (error) {
        // Semantic evidence is an enhancement. A backed-off, misconfigured or
        // still-starting JDT must degrade this stage, not fail the request.
        const failure = recordSemanticFailure(input.semantic, error);
        if (failure === "timeout") timeoutAnchors.push(anchor.id);
        else if (failure === "cancelled") cancelledAnchors.push(anchor.id);
        else failedAnchors.push(anchor.id);
      }
    }
  });
  input.semantic.externalLocationsSuppressed += suppressed.externalLocations;
  return semanticStageResult({ failedAnchors, cancelledAnchors, timeoutAnchors });
}

function recordSemanticFailure(
  state: { timeout: boolean; errorCode?: string },
  error: unknown
): SemanticFailureKind {
  const classified = classifySemanticError(error);
  state.errorCode = classified.code;
  state.timeout ||= classified.code === "DEADLINE_EXCEEDED";
  if (!isExpectedSemanticOutcome(classified.code)) {
    console.error(`[codex-java-lsp] semantic stage failed code=${classified.code} ${classified.message}`);
  }
  if (classified.code === "DEADLINE_EXCEEDED") return "timeout";
  if (classified.code === "CANCELLED") return "cancelled";
  return "failed";
}

function recordSemanticBudgetExpiry(state: { timeout: boolean; errorCode?: string }): void {
  state.timeout = true;
  state.errorCode ??= "DEADLINE_EXCEEDED";
}

export async function semanticVerify(input: SemanticVerifyInput): Promise<SemanticStageResult> {
  if (!shouldUseSemanticVerify(input.options, input.semantic, input.session)) {
    input.semantic.verifySkipped = true;
    return semanticStageResult();
  }
  if (input.budget.expired()) {
    input.semantic.verifySkipped = true;
    recordSemanticBudgetExpiry(input.semantic);
    // The seed stage has already recorded the anchors whose work exhausted
    // the shared request budget. Verification never started, so attributing
    // this request-level timeout to every anchor would downgrade seed evidence
    // that completed before another anchor consumed the remaining budget.
    return semanticStageResult();
  }
  input.semantic.verifyUsed = true;
  const suppressed: SemanticSuppressed = { externalLocations: 0 };
  const failedAnchors: string[] = [];
  const cancelledAnchors: string[] = [];
  const timeoutAnchors: string[] = [];
  const limitedAnchors: string[] = [];
  // Shared across every anchor in this call: mapSemanticEdgeForPersistence
  // resolves both endpoints of every candidate edge, but every edge from one
  // anchor shares that anchor's source position - memoizing collapses what
  // would otherwise be one JavaIndex worker round-trip per edge into one per
  // distinct (file,line,column), matching the openDocument lesson from the
  // gateway cutover (see v3-iteration-e-status memory).
  const resolveAnchorSymbol = createMemoizedAnchorResolver(input.javaIndex);
  await timed(input.phaseMs, "semanticVerify", async () => {
    for (let anchorIndex = 0; anchorIndex < input.anchors.length; anchorIndex += 1) {
      const anchor = input.anchors[anchorIndex]!;
      if (input.budget.expired()) {
        recordSemanticBudgetExpiry(input.semantic);
        timeoutAnchors.push(...input.anchors.slice(anchorIndex).map(candidate => candidate.id));
        break;
      }
      const edgeCandidatesForPersistence: RawSemanticEdgeCandidate[] = [];
      try {
        const references = await input.session.references(
          anchor.absolutePath,
          anchor.line,
          anchor.column,
          false,
          input.budget
        );
        if (input.budget.expired()) {
          recordSemanticBudgetExpiry(input.semantic);
          timeoutAnchors.push(anchor.id);
        }
        const referenceRankingStarted = Date.now();
        const rawLocations: ReferenceLocation[] = [];
        const rawItems = references.items.slice(0, MAX_RAW_REFERENCE_LOCATIONS);
        const truncatedRaw = references.items.length > MAX_RAW_REFERENCE_LOCATIONS;
        for (const location of rawItems) {
          const normalized = containedReferenceLocation(input.repoRoot, location, suppressed);
          if (normalized) {
            rawLocations.push(normalized);
          }
        }
        const rankedFiles = rankReferenceFiles(rawLocations, {
          anchorModule: anchor.module,
          focusModules: input.options.focusModules,
          taskKeywords: input.options.taskKeywords,
          testReadMode: input.options.testReadMode,
          limitFiles: referenceFileLimit(input.options.mode)
        });
        input.semantic.referenceRawLocations += rawItems.length;
        input.semantic.referenceCollapsedFiles += new Set(rawLocations.map(location => location.absolutePath)).size;
        input.semantic.referenceReturnedFiles += rankedFiles.length;
        input.semantic.referenceTruncatedByLimit ||= truncatedRaw;
        if (truncatedRaw) limitedAnchors.push(anchor.id);
        input.semantic.referenceRankingMs += Date.now() - referenceRankingStarted;
        for (const file of rankedFiles) {
          const candidate = candidateFromRankedReference(file, anchor, input.options, input.repoRoot, input.routingPolicy);
          candidate.confidence = "high";
          candidate.verifiedBy = ["reference"];
          mergeCandidate(input.candidateMapForAnchor?.(anchor) ?? input.candidates, candidate);
          // maxRawLocations truncation means this outcome did not see every
          // reference JDT has - persisting it as a complete edge would let a
          // later request trust an incomplete reference set from cache.
          if (!truncatedRaw && candidate.absolutePath !== anchor.absolutePath) {
            const line = candidate.positions[0]?.line || 1;
            const column = candidate.positions[0]?.column || 1;
            // references() throws on any non-COMPLETE outcome (Task 33 cutover),
            // so reaching here already proves this batch was COMPLETE.
            edgeCandidatesForPersistence.push({
              sourceFile: anchor.absolutePath,
              sourceLine: anchor.line,
              sourceColumn: anchor.column,
              targetFile: candidate.absolutePath,
              targetLine: line,
              targetColumn: column,
              targetRanges: [{ start: { line, column }, end: { line, column } }],
              relation: "JDT_REFERENCE",
              completion: "COMPLETE",
              buildFingerprint: input.buildFingerprint,
              generation: input.generation
            });
          }
        }
        if (shouldUseTypeHierarchyVerify(anchor, input.options)) {
          // The hierarchy walk shares the request budget instead of falling back
          // to its own 120s default.
          const hierarchy = await input.session.typeHierarchy(
            anchor.absolutePath,
            anchor.line,
            anchor.column,
            "subtypes",
            2,
            40,
            input.budget
          );
          if (hierarchy.completion === "PARTIAL_TIMEOUT") {
            input.semantic.timeout = true;
            timeoutAnchors.push(anchor.id);
          } else if (hierarchy.completion === "PARTIAL_LIMIT") {
            limitedAnchors.push(anchor.id);
          } else if (hierarchy.completion === "CANCELLED") {
            cancelledAnchors.push(anchor.id);
          } else if (hierarchy.completion === "FAILED") {
            failedAnchors.push(anchor.id);
          }
          for (const edge of hierarchy.edges.slice(0, 40)) {
            const location = hierarchyItemLocation(edge.from);
            const candidate = location ? locationCandidate({ location, reason: "typeHierarchy", anchor, options: input.options, repoRoot: input.repoRoot, routingPolicy: input.routingPolicy, suppressed }) : undefined;
            if (candidate) {
              candidate.confidence = "high";
              candidate.verifiedBy = ["typeHierarchy"];
              mergeCandidate(input.candidateMapForAnchor?.(anchor) ?? input.candidates, candidate);
              if (candidate.absolutePath !== anchor.absolutePath) {
                const line = candidate.positions[0]?.line || 1;
                const column = candidate.positions[0]?.column || 1;
                // Unlike references() above, typeHierarchy() resolves (never
                // throws) on a caller-deadline timeout, so completion varies
                // per anchor - mapSemanticEdgeForPersistence itself rejects
                // anything but COMPLETE.
                edgeCandidatesForPersistence.push({
                  sourceFile: anchor.absolutePath,
                  sourceLine: anchor.line,
                  sourceColumn: anchor.column,
                  targetFile: candidate.absolutePath,
                  targetLine: line,
                  targetColumn: column,
                  targetRanges: [{ start: { line, column }, end: { line, column } }],
                  relation: "JDT_TYPE_HIERARCHY",
                  completion: hierarchy.completion,
                  buildFingerprint: input.buildFingerprint,
                  generation: input.generation
                });
              }
            }
          }
        }
      } catch (error) {
        const failure = recordSemanticFailure(input.semantic, error);
        if (failure === "timeout") timeoutAnchors.push(anchor.id);
        else if (failure === "cancelled") cancelledAnchors.push(anchor.id);
        else failedAnchors.push(anchor.id);
      }
      if (edgeCandidatesForPersistence.length > 0 && !input.budget.expired()) {
        try {
          const bounded = edgeCandidatesForPersistence.slice(0, MAX_PERSISTED_EDGES_PER_ANCHOR);
          const mapped = await Promise.all(
            bounded.map(candidate => mapSemanticEdgeForPersistence(candidate, input.repoRoot, resolveAnchorSymbol))
          );
          const persistable = mapped.filter((edge): edge is NonNullable<typeof edge> => edge !== undefined);
          if (persistable.length > 0) {
            await input.edgeStoreV2.putComplete(persistable, input.generation);
          }
        } catch {
          // A persistence failure must never affect this anchor's candidates.
        }
      }
    }
  });
  input.semantic.externalLocationsSuppressed += suppressed.externalLocations;
  return semanticStageResult({ failedAnchors, cancelledAnchors, timeoutAnchors, limitedAnchors });
}

function semanticStageResult(input: {
  failedAnchors?: readonly string[];
  cancelledAnchors?: readonly string[];
  timeoutAnchors?: readonly string[];
  limitedAnchors?: readonly string[];
} = {}): SemanticStageResult {
  return {
    failedAnchors: [...new Set(input.failedAnchors ?? [])],
    cancelledAnchors: [...new Set(input.cancelledAnchors ?? [])],
    timeoutAnchors: [...new Set(input.timeoutAnchors ?? [])],
    limitedAnchors: [...new Set(input.limitedAnchors ?? [])]
  };
}

function shouldUseSemantic(policy: SemanticPolicy, mode: ImpactMode, anchors: readonly ResolvedAnchor[]): boolean {
  if (policy === "fast") {
    return false;
  }
  if (policy === "required" || mode === "precision" || mode === "recall") {
    return true;
  }
  return anchors.some(anchor => anchor.profile === "service");
}

function shouldUseTypeHierarchyVerify(anchor: ResolvedAnchor, options: ImpactOptions): boolean {
  return options.semanticPolicy === "required" && (anchor.kind === "interface" || new Set(["port", "repository", "service"]).has(anchor.profile));
}

function shouldUseSemanticVerify(options: ImpactOptions, semantic: { used: boolean }, session: JdtlsSession): boolean {
  if (options.semanticPolicy === "fast") {
    return false;
  }
  if (options.semanticPolicy === "required" || options.mode === "precision" || options.mode === "recall") {
    return true;
  }
  if (options.semanticPolicy === "auto" && !semantic.used) {
    return false;
  }
  const status = session.status();
  return Boolean(status.started && status.progress?.active === 0);
}

function locationCandidate(input: LocationCandidateInput): CandidateFile | undefined {
  // JDT resolves definitions into ~/.m2 jars and JDK sources. Those are real
  // answers but they are not this repository, and they must never reach output.
  const normalized = normalizeRepoLocation(input.repoRoot, input.location);
  if (!normalized) {
    input.suppressed.externalLocations += 1;
    return undefined;
  }
  const context = classifyPath(input.repoRoot, normalized.absolutePath);
  const range = normalized.range;
  const score = scoreBase(input.routingPolicy, "semantic", context, input.anchor, input.options) + (input.reason === "implementation" ? 120 : input.reason === "typeHierarchy" ? 110 : 80);
  return {
    absolutePath: normalized.absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score,
    matchCount: 0,
    positions: [{ line: range.start.line, column: range.start.column }],
    categories: ["semantic"],
    reasons: [input.reason],
    confidence: "high",
    verifiedBy: [semanticVerifiedBy(input.reason)],
    scoreBreakdown: [breakdown(`semantic.${input.reason}`, "semantic-seed", score, input.reason)]
  };
}

/**
 * Task 26 Step 4's resource guard: a request pathologically referenced from
 * thousands of locations must not spend unbounded collapse/rank time or
 * memory. This is separate from `referenceFileLimit` - that is the value
 * truncation every request hits; this is a rare safety cap that also voids
 * this outcome's persisted-edge writes (see the `truncatedRaw` check at the
 * call site) because a result built from a truncated raw set cannot be
 * trusted as a complete reference edge for later cache reuse.
 */
const MAX_RAW_REFERENCE_LOCATIONS = 5000;

/**
 * Task 33 Step 8's own bound on top of MAX_RAW_REFERENCE_LOCATIONS: each
 * persisted-edge candidate costs a JavaIndex worker round-trip to resolve
 * its target symbol ID (source-side is deduped via the shared memoized
 * resolver, but targets are not). referenceFileLimit(mode) alone already
 * reaches 60 in recall mode, plus up to 40 typeHierarchy edges - capping
 * here keeps the dual-write's added request-path cost bounded regardless of
 * mode. A partial persisted set is fine: every edge is independently valid,
 * and putComplete is additive across requests.
 */
const MAX_PERSISTED_EDGES_PER_ANCHOR = 30;

/** Shared per semanticVerify() call: every edge from one anchor shares that anchor's source position. */
function createMemoizedAnchorResolver(javaIndex: RouterIndex): SymbolAnchorResolver {
  const cache = new Map<string, Promise<{ symbolId: string } | undefined>>();
  return (file, line, column) => {
    const key = `${file}\0${line}\0${column}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = javaIndex.queryAnchor(file, line, column).then(anchor => anchor ? { symbolId: anchor.symbolId } : undefined);
      cache.set(key, pending);
    }
    return pending;
  };
}

/** The containment-check half of locationCandidate, without its scoring - reference ranking scores by file, not by raw location. */
function containedReferenceLocation(
  repoRoot: string,
  location: LspLocation | LspLocationLink,
  suppressed: SemanticSuppressed
): ReferenceLocation | undefined {
  const normalized = normalizeRepoLocation(repoRoot, location);
  if (!normalized) {
    suppressed.externalLocations += 1;
    return undefined;
  }
  const context = classifyPath(repoRoot, normalized.absolutePath);
  return {
    absolutePath: normalized.absolutePath,
    line: normalized.range.start.line,
    column: normalized.range.start.column,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet
  };
}

/**
 * Positions keep every raw occurrence in encounter order, capped by
 * candidate-helpers' downstream MAX_POSITIONS truncation - not yet the
 * "first method-body / first type-level / first remaining" preference plan
 * Step 2 describes. That preference needs a JavaIndex range lookup per
 * position; doing it before this file already survived value-ranking would
 * spend it on the hundreds of low-value files rankReferenceFiles is about to
 * discard. Deferred rather than threading a new JavaIndex dependency into
 * this JDT-only module for a display-order refinement.
 */
function candidateFromRankedReference(
  file: { path: string; module?: string; layer?: string; sourceSet?: string; totalReferences: number; positions: Array<{ line: number; column: number }> },
  anchor: ResolvedAnchor,
  options: ImpactOptions,
  repoRoot: string,
  routingPolicy: RoutingPolicy
): CandidateFile {
  const context = classifyPath(repoRoot, file.path);
  const score = scoreBase(routingPolicy, "semantic", context, anchor, options) + 80;
  return {
    absolutePath: file.path,
    path: context.relativePath,
    module: context.module ?? file.module,
    layer: context.layer ?? file.layer,
    sourceSet: context.sourceSet ?? file.sourceSet,
    score,
    matchCount: file.totalReferences,
    // Plan Step 2: up to 3 representative positions per file.
    positions: file.positions.slice(0, 3).map(position => ({ line: position.line, column: position.column })),
    categories: ["semantic"],
    reasons: ["reference"],
    confidence: "high",
    verifiedBy: [semanticVerifiedBy("reference")],
    scoreBreakdown: [breakdown("semantic.reference", "semantic-seed", score, "reference")]
  };
}

function shouldIncludeImplementations(anchor: ResolvedAnchor): boolean {
  return anchor.kind === "interface" || new Set(["port", "service", "repository"]).has(anchor.profile);
}

function hierarchyItemLocation(item: unknown): LspLocation | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as { uri?: unknown; range?: unknown; selectionRange?: unknown };
  const range = isLspRange(record.range) ? record.range : isLspRange(record.selectionRange) ? record.selectionRange : undefined;
  return typeof record.uri === "string" && range ? { uri: record.uri, range } : undefined;
}

function isLspRange(value: unknown): value is LspLocation["range"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { start?: unknown; end?: unknown };
  return isLspPosition(record.start) && isLspPosition(record.end);
}

function isLspPosition(value: unknown): value is LspLocation["range"]["start"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { line?: unknown; character?: unknown };
  return typeof record.line === "number" && typeof record.character === "number";
}

function semanticVerifiedBy(reason: string): string {
  return reason === "reference" || reason === "typeHierarchy" ? reason : `semantic-${reason}`;
}

async function timed<T>(phases: Record<string, number>, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    phases[name] = (phases[name] || 0) + Date.now() - startedAt;
  }
}
