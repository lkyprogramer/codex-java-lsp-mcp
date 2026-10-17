// input: one request's budget and signal, a workspace root resolver, and the owner.
// output: a RequestView that holds one verified snapshot for the whole request, and a
//         JavaIndexClientApi whose every read runs on that snapshot through the query pool.
// pos: MAC-08A request chain (contract §2.6): budget → resolve → create → prepare
//      (≤ min(1000 ms, remaining)) → one acquire → query workers → hash-checked preview
//      → release. A publish never changes a held view or its labels.
import { AsyncLocalStorage } from "node:async_hooks";
import type { LayoutContext } from "../../layout-probe.js";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import type { DetailedEntitySearchResult, EntityHit, EntitySearchOptions } from "../entity-search.js";
import { ENTITY_SEARCH_DEFAULT_LIMIT } from "../entity-search.js";
import type { EvidenceSourcesResult, JavaIndexClientApi, JavaIndexRequestOptions } from "../java-index-client-api.js";
import { deriveJavaSourceLayout } from "../java-index-file-parse.js";
import type {
  AnchorFacts,
  ContextGraphResult,
  GraphDigest,
  GraphReachable,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  MyBatisResourceByNamespaceBatch,
  StaticEdgeKind
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import type { WorkspaceBinding } from "./binding.js";
import type { IndexOwner, ViewState, WorkspaceIndex } from "./index-owner.js";
import type { QueryOpName, QueryOps, QueryRequest, SnapshotIndexStatus } from "./query-ops.js";
import type { SnapshotLease } from "./snapshot-store.js";

const requestDefaults = new AsyncLocalStorage<JavaIndexRequestOptions>();

/** Snapshot reads made inside `action` without explicit options use this request's budget and signal. */
export function withRequestDefaults<T>(options: JavaIndexRequestOptions, action: () => Promise<T>): Promise<T> {
  return requestDefaults.run(options, action);
}

/** A per-call budget or signal can only narrow the request's: the earlier deadline, either abort. */
function narrowed(request: JavaIndexRequestOptions | undefined, call: JavaIndexRequestOptions | undefined): JavaIndexRequestOptions {
  const budgets = [request?.budget, call?.budget].filter((value): value is DeadlineBudget => value !== undefined);
  const signals = [request?.signal, call?.signal].filter((value): value is AbortSignal => value !== undefined);
  const budget = budgets.sort((left, right) => left.deadlineAtMs - right.deadlineAtMs)[0];
  const signal = signals.length > 1 && signals[0] !== signals[1] ? AbortSignal.any(signals) : signals[0];
  return { ...(budget ? { budget } : {}), ...(signal ? { signal } : {}) };
}

/** What a request froze at its one acquire. */
export type ViewLabels = {
  state: ViewState;
  workspaceId?: string;
  snapshotId?: string;
  bindingVersion?: number;
  coveredThroughSeq?: number;
  trackerEpoch?: string;
};

export class RequestView {
  private released = false;
  private leaseReleased = false;
  private inFlight = 0;
  private statusPromise?: Promise<SnapshotIndexStatus>;

  private constructor(
    readonly owner: IndexOwner,
    readonly canonicalRoot: string,
    readonly labels: Readonly<ViewLabels>,
    readonly budget: DeadlineBudget,
    readonly signal: AbortSignal | undefined,
    private readonly lease: SnapshotLease | undefined,
    readonly binding: WorkspaceBinding | undefined
  ) {}

  /** The request's one acquire. Labels are fixed here; a later publish does not reach this view. */
  static acquire(owner: IndexOwner, workspace: WorkspaceIndex, budget: DeadlineBudget, signal?: AbortSignal): RequestView {
    const held = owner.acquireBound(workspace.workspaceId, "request");
    const state = workspace.viewState(held?.binding);
    const binding = held?.binding;
    const labels: ViewLabels = Object.freeze({ state, workspaceId: workspace.workspaceId,
      ...(binding ? { snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion, coveredThroughSeq: binding.coveredThroughSeq, trackerEpoch: binding.trackerEpoch } : {}) });
    return new RequestView(owner, workspace.canonicalRoot, labels, budget, signal, held?.lease, binding);
  }

  /** A request on a workspace this owner does not run (e.g. status without start): no snapshot. */
  static notReady(owner: IndexOwner, canonicalRoot: string, budget: DeadlineBudget, signal?: AbortSignal): RequestView {
    return new RequestView(owner, canonicalRoot, Object.freeze({ state: "NOT_READY" as const }), budget, signal, undefined, undefined);
  }

  get snapshotId(): string | undefined {
    return this.labels.snapshotId;
  }

  get closed(): boolean {
    return this.released;
  }

  /** One read on the held snapshot through the pool, under this request's deadline and signal. */
  query<K extends QueryOpName>(request: QueryRequest<K>, options: JavaIndexRequestOptions = {}): Promise<QueryOps[K]["result"]> {
    const snapshotId = this.labels.snapshotId;
    if (!snapshotId) return Promise.reject(new JavaIntelligenceError("INDEX_PARTIAL", `NOT_READY: no verified snapshot for ${this.canonicalRoot}`));
    if (this.released) return Promise.reject(new JavaIntelligenceError("INDEX_PARTIAL", "request view already released"));
    const { budget, signal } = narrowed({ budget: this.budget, signal: this.signal }, options);
    this.inFlight += 1;
    const read = this.owner.query(snapshotId, request, budget!, signal);
    void read.finally(() => {
      this.inFlight -= 1;
      this.releaseLeaseWhenIdle();
    }).catch(() => undefined);
    return read;
  }

  /** The held snapshot's own status (immutable, read once per view). */
  snapshotStatus(): Promise<SnapshotIndexStatus> {
    return this.statusPromise ??= this.query({ op: "status", args: {} });
  }

  /** No new reads; the snapshot lease goes once the reads already in the pool have settled. */
  close(): void {
    this.released = true;
    this.releaseLeaseWhenIdle();
  }

  private releaseLeaseWhenIdle(): void {
    if (!this.released || this.inFlight > 0 || this.leaseReleased) return;
    this.leaseReleased = true;
    this.lease?.release();
    void this.owner.reclaim();
  }
}

/**
 * The whole request under one budget. Every stage is raced against the deadline; a stalled shared
 * stage (resolve, create, a round) keeps running for the next caller and is never cancelled by this one.
 * The view closes when the handler settles or when the request returns at its deadline or cancel,
 * whichever is first; its lease then goes as soon as no read of it is still in the pool.
 */
export async function withRequestView<T>(input: {
  owner: IndexOwner;
  budget: DeadlineBudget;
  signal?: AbortSignal;
  resolve: () => Promise<string>;
  /** false: never start a workspace (status-only); an unknown one is NOT_READY. */
  start?: boolean;
  prepare?: boolean;
  handler: (view: RequestView) => Promise<T>;
}): Promise<T> {
  const { owner, budget, signal } = input;
  const guard = <V>(stage: string, operation: Promise<V>): Promise<V> => {
    // The stage may outlive this request (or be abandoned by an early return): its rejection is never unhandled.
    operation.catch(() => undefined);
    if (signal?.aborted) return Promise.reject(new JavaIntelligenceError("CANCELLED", `Cancelled before ${stage}`));
    return budget.race(stage, signal ? abortable(operation, signal, stage) : operation);
  };
  const canonicalRoot = await guard("request.resolve", input.resolve());
  let view: RequestView;
  if (input.start === false) {
    const running = owner.peek(canonicalRoot);
    view = running ? RequestView.acquire(owner, running, budget, signal) : RequestView.notReady(owner, canonicalRoot, budget, signal);
  } else {
    // An expired or cancelled request never starts a workspace it cannot use.
    if (signal?.aborted) throw new JavaIntelligenceError("CANCELLED", "Cancelled before request.create");
    budget.throwIfExpired("request.create");
    const workspace = await guard("request.create", owner.workspace(canonicalRoot));
    if (input.prepare !== false) await guard("request.prepare", workspace.prepare(budget, signal));
    budget.throwIfExpired("request.acquire");
    view = RequestView.acquire(owner, workspace, budget, signal);
  }
  let work: Promise<T>;
  try { work = input.handler(view); }
  catch (error) { view.close(); throw error; }
  void work.finally(() => view.close()).catch(() => undefined);
  try {
    return await guard("request.handler", work);
  } catch (error) {
    // A handler that outlives its deadline or cancel keeps nothing: its reads now reject.
    view.close();
    throw error;
  }
}

function abortable<V>(operation: Promise<V>, signal: AbortSignal, stage: string): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    const abort = () => reject(new JavaIntelligenceError("CANCELLED", `Cancelled during ${stage}`));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function emptyStatus(state: JavaIndexStatus["state"]): JavaIndexStatus {
  return { state, indexedGeneration: 0, files: 0, types: 0, methods: 0, edges: 0, snapshotBytes: 0,
    pendingForeground: 0, pendingBackground: 0, coverage: [], resourceCoverage: [] };
}

/** The JavaIndexStatus of one sealed snapshot: DURABLE, nothing pending, coverage as captured. */
export function snapshotIndexStatus(status: SnapshotIndexStatus, snapshotId: string): JavaIndexStatus {
  return {
    state: status.buildState === "READY" ? "READY" : "DEGRADED",
    indexedGeneration: status.indexedGeneration,
    files: status.files,
    types: status.types,
    methods: status.methods,
    edges: status.edges,
    snapshotBytes: 0,
    snapshot: { state: "DURABLE", durableGeneration: status.indexedGeneration, durableManifestFingerprint: snapshotId },
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: status.coverage,
    resourceCoverage: [],
    ...(status.buildState === "READY" ? {} : { lastError: `snapshot buildState ${status.buildState ?? "unknown"}` })
  };
}

/**
 * JavaIndexClientApi over one sealed snapshot. It never builds or refreshes: freshness is the
 * owner's (prepare before acquire). Each read uses the calling request's budget and signal.
 */
export class SnapshotJavaIndexClient implements JavaIndexClientApi {
  /** The caller's layout (production passes the runtime's shared one): a per-request probe would re-read the tree on the request path. */
  constructor(
    private readonly owner: IndexOwner,
    readonly snapshotId: string,
    private readonly repoRoot: string,
    private readonly snapshot: JavaIndexStatus,
    private readonly layout: LayoutContext
  ) {}

  private run<K extends QueryOpName>(request: QueryRequest<K>, options?: JavaIndexRequestOptions): Promise<QueryOps[K]["result"]> {
    const { budget, signal } = narrowed(requestDefaults.getStore(), options);
    if (!budget) return Promise.reject(new JavaIntelligenceError("INVALID_INPUT", `${request.op} requires a request budget`));
    return this.owner.query(this.snapshotId, request, budget, signal);
  }

  private toRelative(inputPath: string): string | undefined {
    try { return deriveJavaSourceLayout(this.repoRoot, inputPath, this.layout).relativePath; } catch { return undefined; }
  }

  async open(): Promise<JavaIndexStatus> { return this.snapshot; }
  async status(): Promise<JavaIndexStatus> { return this.snapshot; }
  localStatus(): JavaIndexStatus { return this.snapshot; }
  async refresh(): Promise<JavaIndexStatus> { return this.snapshot; }
  async refreshResources(): Promise<JavaIndexStatus> { return this.snapshot; }
  async ensureFresh(): Promise<void> {}
  async reconcile(): Promise<JavaIndexStatus> { return this.snapshot; }
  async awaitPrewarmReady(): Promise<JavaIndexStatus> { return this.snapshot; }
  async flush(): Promise<JavaIndexStatus> { return this.snapshot; }
  async close(): Promise<void> {}

  async queryEvidenceSources(file: string, line: number, column: number, options?: JavaIndexRequestOptions): Promise<EvidenceSourcesResult> {
    return this.run({ op: "evidenceSources", args: { relativePath: this.toRelative(file) ?? "", line, column } }, options);
  }
  async queryAnchor(file: string, line: number, column: number, options?: JavaIndexRequestOptions): Promise<AnchorFacts | undefined> {
    const relativePath = this.toRelative(file);
    return relativePath ? this.run({ op: "anchor", args: { relativePath, line, column } }, options) : undefined;
  }
  async queryType(typeText: string, scopeFile?: string, options?: JavaIndexRequestOptions): Promise<JavaTypeLookupResult> {
    return this.run({ op: "type", args: { typeText, ...(scopeFile ? { scope: this.toRelative(scopeFile) } : {}) } }, options);
  }
  async queryTypes(queries: Array<{ typeText: string; scopeFile?: string }>, options?: JavaIndexRequestOptions): Promise<JavaTypeLookupResult[]> {
    if (queries.length === 0) return [];
    return this.run({ op: "types", args: { queries: queries.map(query => ({ typeText: query.typeText, ...(query.scopeFile ? { scope: this.toRelative(query.scopeFile) } : {}) })) } }, options);
  }
  async queryImplementers(typeId: string, limit: number, options?: JavaIndexRequestOptions): Promise<JavaTypeFacts[]> {
    return this.run({ op: "implementers", args: { typeId, limit } }, options);
  }
  async queryTypeReferencers(typeId: string, edgeKinds: StaticEdgeKind[], limit: number, options?: JavaIndexRequestOptions): Promise<IndexedReference[]> {
    return this.run({ op: "typeReferencers", args: { typeId, edgeKinds, limit } }, options);
  }
  async queryCallers(methodId: string, limit: number, options?: JavaIndexRequestOptions): Promise<IndexedReference[]> {
    return this.run({ op: "callers", args: { methodId, limit } }, options);
  }
  async queryCallees(methodId: string, limit: number, options?: JavaIndexRequestOptions): Promise<IndexedReference[]> {
    return this.run({ op: "callees", args: { methodId, limit } }, options);
  }
  async queryCalleesBatch(methodIds: string[], limit: number, options?: JavaIndexRequestOptions): Promise<Array<{ methodId: string; callees: IndexedReference[] }>> {
    if (methodIds.length === 0) return [];
    return this.run({ op: "calleesBatch", args: { methodIds, limit } }, options);
  }
  async queryMethodsWithParameterTypes(typeIds: string[], limit: number, options?: JavaIndexRequestOptions): Promise<string[]> {
    if (typeIds.length === 0) return [];
    return this.run({ op: "methodsWithParameterTypes", args: { typeIds, limit } }, options);
  }
  async queryFiles(files: string[], options?: JavaIndexRequestOptions): Promise<JavaFileBundle[]> {
    const relativePaths = files.map(file => this.toRelative(file)).filter((value): value is string => value !== undefined);
    return this.run({ op: "files", args: { relativePaths } }, options);
  }
  /** Preview: live bytes are served only when their hash equals the held snapshot's; otherwise an explicit gap. */
  async queryReadRanges(requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>, options?: JavaIndexRequestOptions): Promise<IndexedReadRangeResult[]> {
    if (requests.length === 0) return [];
    return this.run({ op: "readRanges", args: { repoRoot: this.repoRoot, requests: requests.map(request => ({
      file: request.file, relativePath: this.toRelative(request.file) ?? request.file.replaceAll("\\", "/"), positions: request.positions })) } }, options);
  }
  async queryMyBatisResource(relativePath: string, options?: JavaIndexRequestOptions): Promise<MyBatisMapperResourceFacts | undefined> {
    return this.run({ op: "myBatisResource", args: { relativePath: this.toRelative(relativePath) ?? relativePath } }, options);
  }
  async queryMyBatisResourcesByNamespace(namespaces: string[], options?: JavaIndexRequestOptions): Promise<MyBatisResourceByNamespaceBatch> {
    if (namespaces.length === 0) return [];
    return this.run({ op: "myBatisResourcesByNamespace", args: { namespaces } }, options);
  }
  async queryGraphDigest(options?: JavaIndexRequestOptions): Promise<GraphDigest> {
    return this.run({ op: "graphDigest", args: {} }, options);
  }
  async querySearch(task: string, search: EntitySearchOptions = {}, options?: JavaIndexRequestOptions): Promise<DetailedEntitySearchResult> {
    // A caller's own work budget may only shorten the request deadline, never extend it.
    const remaining = search.budget?.remainingMs?.();
    const budget = options?.budget ?? requestDefaults.getStore()?.budget;
    if (budget && remaining !== undefined && Number.isFinite(remaining)) {
      options = { ...options, budget: budget.forStage(Math.max(1, remaining)) };
    }
    return this.run({ op: "search", args: { task, limit: search.limit ?? ENTITY_SEARCH_DEFAULT_LIMIT, mode: search.mode ?? "auto",
      ...(search.scope ? { scope: search.scope } : {}), ...(search.budget?.maxPostings !== undefined ? { maxPostings: search.budget.maxPostings } : {}) } }, options);
  }
  async queryGraphReachable(fromRelativePath: string, maxHops: number, options?: JavaIndexRequestOptions): Promise<GraphReachable> {
    return this.run({ op: "graphReachable", args: { relativePath: this.toRelative(fromRelativePath) ?? fromRelativePath.replaceAll("\\", "/"), maxHops } }, options);
  }
  async queryContextGraph(input: Parameters<JavaIndexClientApi["queryContextGraph"]>[0], options?: JavaIndexRequestOptions): Promise<ContextGraphResult> {
    const fromRelativePath = this.toRelative(input.fromRelativePath) ?? input.fromRelativePath.replaceAll("\\", "/");
    return this.run({ op: "contextGraph", args: { input: { ...input, fromRelativePath } } }, options);
  }
  async queryEntitySearch(task: string, limit = ENTITY_SEARCH_DEFAULT_LIMIT, options?: JavaIndexRequestOptions): Promise<EntityHit[]> {
    return this.run({ op: "entitySearch", args: { task, limit } }, options);
  }
  async queryRepositoryFactMarkers(importPrefixes: string[], annotationPrefixes: string[], options?: JavaIndexRequestOptions): Promise<{ importPrefixFound: boolean; annotationPrefixFound: boolean }> {
    return this.run({ op: "repositoryFactMarkers", args: { importPrefixes, annotationPrefixes } }, options);
  }
}

/** A NOT_READY workspace: status reports it, every read refuses (never another workspace's snapshot). */
export class NotReadyJavaIndexClient implements JavaIndexClientApi {
  private readonly current: JavaIndexStatus;
  constructor(reason = "NOT_READY") {
    this.current = { ...emptyStatus("BUILDING"), lastError: reason };
  }
  private refuse(): never {
    throw new JavaIntelligenceError("INDEX_PARTIAL", "NOT_READY: no verified snapshot for this workspace");
  }
  async open(): Promise<JavaIndexStatus> { return this.current; }
  async status(): Promise<JavaIndexStatus> { return this.current; }
  localStatus(): JavaIndexStatus { return this.current; }
  async refresh(): Promise<JavaIndexStatus> { return this.current; }
  async refreshResources(): Promise<JavaIndexStatus> { return this.current; }
  async ensureFresh(): Promise<void> {}
  async reconcile(): Promise<JavaIndexStatus> { return this.current; }
  async awaitPrewarmReady(): Promise<JavaIndexStatus> { return this.refuse(); }
  async flush(): Promise<JavaIndexStatus> { return this.current; }
  async close(): Promise<void> {}
  async queryEvidenceSources(): Promise<EvidenceSourcesResult> { return this.refuse(); }
  async queryAnchor(): Promise<AnchorFacts | undefined> { return this.refuse(); }
  async queryType(): Promise<JavaTypeLookupResult> { return this.refuse(); }
  async queryTypes(): Promise<JavaTypeLookupResult[]> { return this.refuse(); }
  async queryImplementers(): Promise<JavaTypeFacts[]> { return this.refuse(); }
  async queryTypeReferencers(): Promise<IndexedReference[]> { return this.refuse(); }
  async queryCallers(): Promise<IndexedReference[]> { return this.refuse(); }
  async queryCallees(): Promise<IndexedReference[]> { return this.refuse(); }
  async queryCalleesBatch(): Promise<Array<{ methodId: string; callees: IndexedReference[] }>> { return this.refuse(); }
  async queryMethodsWithParameterTypes(): Promise<string[]> { return this.refuse(); }
  async queryFiles(): Promise<JavaFileBundle[]> { return this.refuse(); }
  async queryReadRanges(): Promise<IndexedReadRangeResult[]> { return this.refuse(); }
  async queryMyBatisResource(): Promise<MyBatisMapperResourceFacts | undefined> { return this.refuse(); }
  async queryMyBatisResourcesByNamespace(): Promise<MyBatisResourceByNamespaceBatch> { return this.refuse(); }
  async queryGraphDigest(): Promise<GraphDigest> { return this.refuse(); }
  async querySearch(): Promise<DetailedEntitySearchResult> { return this.refuse(); }
  async queryGraphReachable(): Promise<GraphReachable> { return this.refuse(); }
  async queryContextGraph(): Promise<ContextGraphResult> { return this.refuse(); }
  async queryEntitySearch(): Promise<EntityHit[]> { return this.refuse(); }
  async queryRepositoryFactMarkers(): Promise<{ importPrefixFound: boolean; annotationPrefixFound: boolean }> { return this.refuse(); }
}
