import type { ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type {
  JavaIndexRpcOperation,
  JavaIndexRpcSettlement,
  JavaIndexRpcTelemetrySink,
  JavaIndexWorkerRetireReason
} from "../java-index/java-index-client.js";
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
  /** Task 26: raw repo-contained reference locations processed, capped at maxRawLocations. */
  referenceRawLocations: number;
  /** Distinct files those locations collapsed into, before value-ranking truncation. */
  referenceCollapsedFiles: number;
  /** Files actually turned into candidates after rankReferenceFiles's limitFiles truncation. */
  referenceReturnedFiles: number;
  /** True when raw JDT reference locations exceeded maxRawLocations=5000 for any anchor this request. */
  referenceTruncatedByLimit: boolean;
  /** Time spent collapsing and value-ranking reference locations, across all anchors. */
  referenceRankingMs: number;
};

export type PersistedSemanticMetrics = {
  edgesSeen: number;
  addedCandidates: number;
  elapsedMs: number;
};

export type JavaIndexRpcDurationAggregate = {
  measuredCount: number;
  totalMs: number;
  maxMs: number;
};

export type JavaIndexRpcOperationMetrics = {
  count: number;
  inputJsonBytes: number;
  outputJsonBytes: number;
  outputMeasuredCount: number;
  callerWait: JavaIndexRpcDurationAggregate;
  workerQueue?: JavaIndexRpcDurationAggregate;
  workerProcessing?: JavaIndexRpcDurationAggregate;
  maxWorkerQueueDepth?: number;
  lateResponseWait?: JavaIndexRpcDurationAggregate;
  completed: number;
  cancelled: number;
  deadlineExceeded: number;
  failed: number;
  retired: number;
  lateResponses: number;
  retireReasons: Partial<Record<JavaIndexWorkerRetireReason, number>>;
};

export type JavaIndexRpcMetrics = {
  enabled: true;
  payloadBytes: "JSON_UTF8_ENVELOPE_ESTIMATE";
  operations: Partial<Record<JavaIndexRpcOperation, JavaIndexRpcOperationMetrics>>;
};

/** Request-local diagnostic collector. Sink failures are contained by JavaIndexClient. */
export class JavaIndexRpcTelemetryCollector implements JavaIndexRpcTelemetrySink {
  private readonly operations = new Map<JavaIndexRpcOperation, JavaIndexRpcOperationMetrics>();

  requestStarted(event: { operation: JavaIndexRpcOperation; inputJsonBytes: number }): void {
    const metrics = this.forOperation(event.operation);
    metrics.count += 1;
    metrics.inputJsonBytes += nonNegative(event.inputJsonBytes);
  }

  requestSettled(event: JavaIndexRpcSettlement): void {
    const metrics = this.forOperation(event.operation);
    addDuration(metrics.callerWait, event.callerWaitMs);
    if (event.outputJsonBytes !== undefined) {
      metrics.outputJsonBytes += nonNegative(event.outputJsonBytes);
      metrics.outputMeasuredCount += 1;
    }
    if (event.workerTiming) {
      metrics.workerQueue ??= emptyDuration();
      metrics.workerProcessing ??= emptyDuration();
      addDuration(metrics.workerQueue, event.workerTiming.queueMs);
      addDuration(metrics.workerProcessing, event.workerTiming.processingMs);
      metrics.maxWorkerQueueDepth = Math.max(
        metrics.maxWorkerQueueDepth ?? 0,
        event.workerTiming.queueDepthAtEnqueue
      );
    }
    metrics[event.outcome] += 1;
    if (event.retireReason) {
      metrics.retireReasons[event.retireReason] = (metrics.retireReasons[event.retireReason] ?? 0) + 1;
    }
  }

  lateResponse(event: Omit<JavaIndexRpcSettlement, "outcome">): void {
    const metrics = this.forOperation(event.operation);
    metrics.lateResponses += 1;
    metrics.lateResponseWait ??= emptyDuration();
    addDuration(metrics.lateResponseWait, event.callerWaitMs);
    if (event.outputJsonBytes !== undefined) {
      metrics.outputJsonBytes += nonNegative(event.outputJsonBytes);
      metrics.outputMeasuredCount += 1;
    }
    if (event.workerTiming) {
      metrics.workerQueue ??= emptyDuration();
      metrics.workerProcessing ??= emptyDuration();
      addDuration(metrics.workerQueue, event.workerTiming.queueMs);
      addDuration(metrics.workerProcessing, event.workerTiming.processingMs);
      metrics.maxWorkerQueueDepth = Math.max(
        metrics.maxWorkerQueueDepth ?? 0,
        event.workerTiming.queueDepthAtEnqueue
      );
    }
  }

  snapshot(): JavaIndexRpcMetrics {
    return {
      enabled: true,
      payloadBytes: "JSON_UTF8_ENVELOPE_ESTIMATE",
      operations: Object.fromEntries(
        [...this.operations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([operation, metrics]) => [operation, structuredClone(metrics)])
      )
    };
  }

  private forOperation(operation: JavaIndexRpcOperation): JavaIndexRpcOperationMetrics {
    let metrics = this.operations.get(operation);
    if (!metrics) {
      metrics = {
        count: 0,
        inputJsonBytes: 0,
        outputJsonBytes: 0,
        outputMeasuredCount: 0,
        callerWait: emptyDuration(),
        completed: 0,
        cancelled: 0,
        deadlineExceeded: 0,
        failed: 0,
        retired: 0,
        lateResponses: 0,
        retireReasons: {}
      };
      this.operations.set(operation, metrics);
    }
    return metrics;
  }
}

function emptyDuration(): JavaIndexRpcDurationAggregate {
  return { measuredCount: 0, totalMs: 0, maxMs: 0 };
}

function addDuration(target: JavaIndexRpcDurationAggregate, value: number): void {
  const duration = nonNegative(value);
  target.measuredCount += 1;
  target.totalMs += duration;
  target.maxMs = Math.max(target.maxMs, duration);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

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
    externalLocationsSuppressed: 0,
    referenceRawLocations: 0,
    referenceCollapsedFiles: 0,
    referenceReturnedFiles: 0,
    referenceTruncatedByLimit: false,
    referenceRankingMs: 0
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
