import type { ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { ImportGraphMetrics } from "./candidate-collectors.js";
import type { TypeReferenceMetrics } from "./type-reference.js";

export type SemanticMetrics = {
  used: boolean;
  skipped: boolean;
  timeout: boolean;
  verifyUsed: boolean;
  verifySkipped: boolean;
  policy: ImpactOptions["semanticPolicy"];
  timeoutMs: number;
  /** JDT hits dropped because they resolve outside this repository. */
  externalLocationsSuppressed: number;
  /** Classification of the last semantic failure, if any. */
  errorCode?: string;
};

export type PersistedSemanticMetrics = {
  edgesSeen: number;
  addedCandidates: number;
  elapsedMs: number;
};

type SessionCacheSnapshot = {
  entries: number;
  hits: number;
  misses: number;
  invalidations: number;
};

type RgCacheSnapshot = {
  entries: number;
  hits: number;
  misses: number;
  generation: number;
};

type SourceStatusSnapshot = {
  entries: number;
  hits: number;
  misses: number;
  typeLookupIndexHits: number;
  typeLookupIndexMisses: number;
  openSource?: string;
  coverage?: string;
};

export function createSemanticMetrics(options: ImpactOptions): SemanticMetrics {
  return {
    used: false,
    skipped: false,
    timeout: false,
    verifyUsed: false,
    verifySkipped: false,
    policy: options.semanticPolicy,
    timeoutMs: options.semanticTimeoutMs,
    externalLocationsSuppressed: 0
  };
}

export function createTypeReferenceMetrics(): TypeReferenceMetrics {
  return {
    scannedPatterns: 0,
    addedCandidates: 0,
    skippedExisting: 0,
    elapsedMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheMissElapsedMs: 0,
    indexHits: 0,
    indexMisses: 0
  };
}

export function createImportGraphMetrics(): ImportGraphMetrics {
  return {
    scannedAnchors: 0,
    addedCandidates: 0,
    skippedExisting: 0,
    elapsedMs: 0
  };
}

export function createPersistedSemanticMetrics(): PersistedSemanticMetrics {
  return {
    edgesSeen: 0,
    addedCandidates: 0,
    elapsedMs: 0
  };
}

export function updateCollectorElapsed(
  phaseMs: Record<string, number>,
  typeReference: TypeReferenceMetrics,
  importGraph: ImportGraphMetrics,
  persistedSemantic: PersistedSemanticMetrics
): void {
  typeReference.elapsedMs = phaseMs.typeReference || 0;
  importGraph.elapsedMs = phaseMs.importGraph || 0;
  persistedSemantic.elapsedMs = phaseMs.persistedSemantic || 0;
}

export function updateTypeReferenceCacheMetrics(
  metrics: TypeReferenceMetrics,
  before: SourceStatusSnapshot,
  after: SourceStatusSnapshot
): void {
  metrics.cacheHits = after.hits - before.hits;
  metrics.cacheMisses = after.misses - before.misses;
  metrics.cacheMissElapsedMs = 0;
  metrics.indexHits = after.typeLookupIndexHits - before.typeLookupIndexHits;
  metrics.indexMisses = after.typeLookupIndexMisses - before.typeLookupIndexMisses;
}

export function sessionCacheDelta(before: SessionCacheSnapshot, after: SessionCacheSnapshot): Record<string, unknown> {
  return {
    entries: after.entries,
    hitsDelta: after.hits - before.hits,
    missesDelta: after.misses - before.misses,
    invalidationsDelta: after.invalidations - before.invalidations
  };
}

export function rgCacheDelta(before: RgCacheSnapshot, after: RgCacheSnapshot): Record<string, unknown> {
  return {
    entries: after.entries,
    hitsDelta: after.hits - before.hits,
    missesDelta: after.misses - before.misses,
    generation: after.generation
  };
}

export function sourceFactsDelta(
  before: SourceStatusSnapshot,
  after: SourceStatusSnapshot,
  anchors: readonly ResolvedAnchor[]
): Record<string, unknown> {
  return {
    entries: after.entries,
    hitsDelta: after.hits - before.hits,
    missesDelta: after.misses - before.misses,
    typeLookupIndexHitsDelta: after.typeLookupIndexHits - before.typeLookupIndexHits,
    typeLookupIndexMissesDelta: after.typeLookupIndexMisses - before.typeLookupIndexMisses,
    anchorFactSource: anchors[0]?.factSource,
    openSource: after.openSource,
    coverage: after.coverage
  };
}
