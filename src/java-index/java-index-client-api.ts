import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { EntityHit } from "./entity-search.js";
import type {
  AnchorFacts,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  StaticEdgeKind
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import type {
  ContextGraphResult,
  GraphDigest,
  GraphReachable,
  JavaIndexCommand,
  JavaIndexRefreshPriority,
  JavaIndexWorktreeIdentity,
  JavaIndexWorkerTiming,
  MyBatisResourceByNamespaceBatch
} from "./worker-protocol.js";

export type JavaIndexOpenOptions = {
  leaseRoot?: string;
  worktree?: JavaIndexWorktreeIdentity;
  siblingCacheBase?: string;
  siblingDbPath?: string;
};

export type JavaIndexRequestOptions = {
  budget?: DeadlineBudget;
  signal?: AbortSignal;
  telemetry?: JavaIndexRpcTelemetrySink;
};

export type JavaIndexRpcOperation = JavaIndexCommand["type"];
export type JavaIndexRpcOutcome = "completed" | "cancelled" | "deadlineExceeded" | "failed" | "retired";
export type JavaIndexWorkerRetireReason =
  | "DEADLINE_EXCEEDED"
  | "MALFORMED_RESPONSE"
  | "WORKER_ERROR"
  | "WORKER_EXIT"
  | "OPEN_FAILURE";
export type JavaIndexRpcSettlement = {
  operation: JavaIndexRpcOperation;
  outcome: JavaIndexRpcOutcome;
  callerWaitMs: number;
  outputJsonBytes?: number;
  workerTiming?: JavaIndexWorkerTiming;
  retireReason?: JavaIndexWorkerRetireReason;
};
export interface JavaIndexRpcTelemetrySink {
  requestStarted(event: { operation: JavaIndexRpcOperation; inputJsonBytes: number }): void;
  requestSettled(event: JavaIndexRpcSettlement): void;
  lateResponse(event: Omit<JavaIndexRpcSettlement, "outcome">): void;
};

export function isJavaIndexPrewarmReady(status: JavaIndexStatus): boolean {
  if (status.pendingBackground > 0) return false;
  if (status.snapshot?.state === "DURABLE") return true;
  return status.files > 0
    && status.coverage.length > 0
    && status.coverage.every(entry => entry.state === "COMPLETE" && entry.generation === status.indexedGeneration);
}

export interface JavaIndexClientApi {
  open(generation: number, options?: JavaIndexOpenOptions, requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  status(requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  refresh(
    generation: number,
    changed: string[],
    deleted: string[],
    requestOptions?: JavaIndexRequestOptions,
    priority?: JavaIndexRefreshPriority
  ): Promise<JavaIndexStatus>;
  refreshResources(generation: number, paths: string[], requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  ensureFresh(files: string[], generation: number, requestOptions?: JavaIndexRequestOptions): Promise<void>;
  reconcile(generation: number, requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  awaitPrewarmReady(requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  flush(requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus>;
  queryAnchor(file: string, line: number, column: number, requestOptions?: JavaIndexRequestOptions): Promise<AnchorFacts | undefined>;
  queryType(typeText: string, scopeFile?: string, requestOptions?: JavaIndexRequestOptions): Promise<JavaTypeLookupResult>;
  queryTypes(
    queries: Array<{ typeText: string; scopeFile?: string }>,
    requestOptions?: JavaIndexRequestOptions
  ): Promise<JavaTypeLookupResult[]>;
  queryImplementers(typeId: string, limit: number, requestOptions?: JavaIndexRequestOptions): Promise<JavaTypeFacts[]>;
  queryTypeReferencers(
    typeId: string,
    edgeKinds: StaticEdgeKind[],
    limit: number,
    requestOptions?: JavaIndexRequestOptions
  ): Promise<IndexedReference[]>;
  queryCallers(methodId: string, limit: number, requestOptions?: JavaIndexRequestOptions): Promise<IndexedReference[]>;
  queryCallees(methodId: string, limit: number, requestOptions?: JavaIndexRequestOptions): Promise<IndexedReference[]>;
  queryCalleesBatch(
    methodIds: string[],
    limit: number,
    requestOptions?: JavaIndexRequestOptions
  ): Promise<Array<{ methodId: string; callees: IndexedReference[] }>>;
  queryMethodsWithParameterTypes(typeIds: string[], limit: number, requestOptions?: JavaIndexRequestOptions): Promise<string[]>;
  queryFiles(files: string[], requestOptions?: JavaIndexRequestOptions): Promise<JavaFileBundle[]>;
  queryReadRanges(
    requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>,
    requestOptions?: JavaIndexRequestOptions
  ): Promise<IndexedReadRangeResult[]>;
  queryMyBatisResource(relativePath: string, requestOptions?: JavaIndexRequestOptions): Promise<MyBatisMapperResourceFacts | undefined>;
  queryMyBatisResourcesByNamespace(
    namespaces: string[],
    requestOptions?: JavaIndexRequestOptions
  ): Promise<MyBatisResourceByNamespaceBatch>;
  queryGraphDigest(requestOptions?: JavaIndexRequestOptions): Promise<GraphDigest>;
  queryGraphReachable(
    fromRelativePath: string,
    maxHops: number,
    requestOptions?: JavaIndexRequestOptions
  ): Promise<GraphReachable>;
  queryContextGraph(
    input: {
      fromRelativePath: string;
      intent: string;
      mode?: "search" | "navigate";
      direction?: "callers" | "callees";
      closure?: "persistence" | "framework";
      maxHops?: number;
      maxExpansions?: number;
      tokenBudget?: number;
      taskText?: string;
      profile?: string;
      plan?: boolean;
      includeSource?: boolean;
      anchorLine?: number;
      anchorColumn?: number;
      sessionId?: string;
      generation?: number;
      repoHash?: string;
    },
    requestOptions?: JavaIndexRequestOptions
  ): Promise<ContextGraphResult>;
  queryEntitySearch(task: string, limit?: number, requestOptions?: JavaIndexRequestOptions): Promise<EntityHit[]>;
  queryRepositoryFactMarkers(
    importPrefixes: string[],
    annotationPrefixes: string[],
    requestOptions?: JavaIndexRequestOptions
  ): Promise<{ importPrefixFound: boolean; annotationPrefixFound: boolean }>;
  close(): Promise<void>;
  localStatus(): JavaIndexStatus;
}

export type { DeadlineBudget };
