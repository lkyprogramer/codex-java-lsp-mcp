import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { probeLayout } from "../../layout-probe.js";
import type { LayoutContext } from "../../layout-probe.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { deriveJavaSourceLayout } from "../java-index-file-parse.js";
import type { JavaIndexClientApi } from "../java-index-client-api.js";
import type {
  JavaIndexOpenOptions,
  JavaIndexPrewarmReadyOptions,
  JavaIndexRequestOptions
} from "../java-index-client-api.js";
import { ENTITY_SEARCH_DEFAULT_LIMIT, type EntityHit } from "../entity-search.js";
import type {
  AnchorFacts,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  SourceRootCoverage,
  StaticEdgeKind
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import type {
  ContextGraphResult,
  GraphDigest,
  GraphReachable,
  JavaIndexRefreshPriority,
  MyBatisResourceByNamespaceBatch
} from "../worker-protocol.js";
import {
  validateAnchorFacts,
  validateFileBundleArray,
  validateIndexedReferenceArray,
  validateIndexedReferenceBatch,
  validateJavaIndexStatus,
  validateMyBatisMapperResourceFacts,
  validateMyBatisResourceByNamespaceBatch,
  validateRepositoryFactMarkers,
  validateStringArray,
  validateTypeFactsArray,
  validateTypeLookup,
  validateTypeLookupArray,
  validateContextGraphResult,
  validateEntitySearchHits,
  validateGraphDigest,
  validateGraphReachable,
  validateIndexedReadRangeResults
} from "../worker-protocol.js";
import { readIndexCounts, readMeta } from "../builder/progress.js";
import { BuilderSupervisor, type BuilderSupervisorJob } from "../builder-supervisor.js";
import { close as closeDb, DEFAULT_SQLITE_CACHE_KB, openIndexDb, prepareCached, type IndexDatabase } from "./driver.js";
import { SqlEntitySearch } from "./entity-search.js";
import { SqlFactsStore } from "./facts-store.js";
import { SqlKnowledgeGraph } from "./knowledge-graph.js";
import {
  queryContextGraph as runContextGraph,
  queryEntitySearch as runEntitySearch,
  queryGraphDigest as runGraphDigest,
  queryGraphReachable as runGraphReachable,
  queryReadRanges as runReadRanges,
  type SqlQueryDeps
} from "./sql-queries.js";

function notImplemented(method: string): never {
  const error = new Error(`${method} is not implemented until P2`);
  error.name = "NOT_IMPLEMENTED";
  throw error;
}

function emptyStatus(state: JavaIndexStatus["state"] = "NEW"): JavaIndexStatus {
  return {
    state,
    indexedGeneration: 0,
    files: 0,
    types: 0,
    methods: 0,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [],
    resourceCoverage: [],
    factsHydrated: true,
    hibernated: false
  };
}

export class SqlJavaIndexClient implements JavaIndexClientApi {
  private db: IndexDatabase | undefined;
  private store: SqlFactsStore | undefined;
  private graph: SqlKnowledgeGraph | undefined;
  private search: SqlEntitySearch | undefined;
  private layout: LayoutContext | undefined;
  private lastStatus: JavaIndexStatus = emptyStatus();
  private opened = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly connIdleMs: number;

  constructor(
    private readonly repoRoot: string,
    private readonly dbPath: string,
    private readonly supervisor?: BuilderSupervisor,
    connIdleMs?: number
  ) {
    const fromEnv = Number(process.env.JAVA_LSP_CONN_IDLE_MS);
    this.connIdleMs = connIdleMs && connIdleMs > 0
      ? Math.floor(connIdleMs)
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? Math.floor(fromEnv)
        : 600_000;
  }

  async open(generation: number, options?: JavaIndexOpenOptions, _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    if (this.opened) {
      throw new JavaIntelligenceError("INDEX_PARTIAL", `Java index client cannot open from state ${this.lastStatus.state}`);
    }
    this.opened = true;
    this.layout = probeLayout(this.repoRoot);
    if (!existsSync(this.dbPath)) {
      if (options?.siblingDbPath && existsSync(options.siblingDbPath)) {
        this.copySibling(options.siblingDbPath);
        this.reload();
        void this.supervisor?.submit({ kind: "reconcile", generation, changed: [], deleted: [] }).then(() => this.reloadIfOpen());
        return this.lastStatus;
      }
      if (this.supervisor) {
        const builder = this.supervisor.status();
        this.lastStatus = { ...emptyStatus("BUILDING"), builder, pendingBackground: builder.queued };
        void this.supervisor.coldBuild().then(() => this.reloadIfOpen()).catch(() => undefined);
        return this.lastStatus;
      }
      this.lastStatus = emptyStatus("DEGRADED");
      this.lastStatus.lastError = "EMPTY";
      return this.lastStatus;
    }
    this.reload();
    return this.lastStatus;
  }

  async status(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    if (!this.opened) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    this.ensureConn();
    if (!this.db) {
      if (this.supervisor) {
        const builder = this.supervisor.status();
        this.lastStatus = { ...this.lastStatus, builder, pendingBackground: builder.queued };
      }
      return this.lastStatus;
    }
    this.lastStatus = this.assembleStatus();
    return this.lastStatus;
  }

  localStatus(): JavaIndexStatus {
    return this.lastStatus;
  }

  async close(): Promise<void> {
    if (this.lastStatus.state === "CLOSED") return;
    this.clearIdle();
    if (this.db) closeDb(this.db);
    this.db = undefined;
    this.store = undefined;
    this.graph = undefined;
    this.search = undefined;
    this.lastStatus = { ...this.lastStatus, state: "CLOSED" };
    await this.supervisor?.stop().catch(() => undefined);
  }

  async refresh(
    generation: number,
    changed: string[],
    deleted: string[],
    _requestOptions?: JavaIndexRequestOptions,
    _priority?: JavaIndexRefreshPriority
  ): Promise<JavaIndexStatus> {
    return this.runBuilderJob({ kind: "refresh", generation, changed, deleted });
  }
  async refreshResources(generation: number, paths: string[], _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return this.runBuilderJob({ kind: "resources", generation, changed: paths, deleted: [] });
  }
  async ensureFresh(files: string[], generation: number, _requestOptions?: JavaIndexRequestOptions): Promise<void> {
    this.requireSupervisor("ensureFresh");
    this.reloadIfOpen();
    const indexed = Number(readMeta(this.requireDb(), "indexedGeneration") ?? "0") || 0;
    if (indexed >= generation) return;
    const stale = files.some(file => this.fileGeneration(file) < generation);
    if (!stale) return;
    await this.refresh(generation, files, []);
  }
  async reconcile(generation: number, _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return this.runBuilderJob({ kind: "reconcile", generation, changed: [], deleted: [] });
  }
  async awaitPrewarmReady(requestOptions?: JavaIndexRequestOptions & JavaIndexPrewarmReadyOptions): Promise<JavaIndexStatus> {
    this.requireSupervisor("awaitPrewarmReady");
    for (;;) {
      requestOptions?.budget?.throwIfExpired("awaitPrewarmReady");
      this.reloadIfOpen();
      if (existsSync(this.dbPath) && !this.db) this.reload();
      if (this.db && readMeta(this.db, "buildState") === "READY") {
        this.lastStatus = this.assembleStatus();
        return this.lastStatus;
      }
      const waitMs = Math.min(250, requestOptions?.budget?.remainingMs(250) ?? 250);
      if (waitMs <= 0) requestOptions?.budget?.throwIfExpired("awaitPrewarmReady");
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  async flush(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return this.db ? this.assembleStatus() : this.lastStatus;
  }
  async hibernate(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return this.db ? this.assembleStatus() : this.lastStatus;
  }
  async recycle(_requestOptions?: JavaIndexRequestOptions): Promise<void> {}
  async queryReadRanges(
    requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>,
    _requestOptions?: JavaIndexRequestOptions
  ): Promise<IndexedReadRangeResult[]> {
    if (requests.length === 0) return [];
    return validateIndexedReadRangeResults(await runReadRanges(this.queryDeps(), requests));
  }
  async queryGraphDigest(_requestOptions?: JavaIndexRequestOptions): Promise<GraphDigest> {
    return validateGraphDigest(runGraphDigest(this.queryDeps()));
  }
  async queryGraphReachable(
    fromRelativePath: string,
    maxHops: number,
    _requestOptions?: JavaIndexRequestOptions
  ): Promise<GraphReachable> {
    return validateGraphReachable(runGraphReachable(this.queryDeps(), fromRelativePath, maxHops));
  }
  async queryContextGraph(
    input: Parameters<JavaIndexClientApi["queryContextGraph"]>[0],
    _requestOptions?: JavaIndexRequestOptions
  ): Promise<ContextGraphResult> {
    return validateContextGraphResult(runContextGraph(this.queryDeps(), input));
  }
  async queryEntitySearch(task: string, limit = ENTITY_SEARCH_DEFAULT_LIMIT, _requestOptions?: JavaIndexRequestOptions): Promise<EntityHit[]> {
    return validateEntitySearchHits(runEntitySearch(this.queryDeps(), task, limit));
  }

  async queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined> {
    const relative = this.toRelative(file);
    const anchor = relative ? this.requireStore().anchor(relative, line, column) : undefined;
    const generation = this.lastStatus.indexedGeneration;
    const value = anchor
      ? { ...anchor, coverage: this.coverageStateFor(anchor.file.sourceRoot, generation) }
      : undefined;
    return validateAnchorFacts(value);
  }

  async queryType(typeText: string, scopeFile?: string): Promise<JavaTypeLookupResult> {
    const scope = scopeFile ? this.toRelative(scopeFile) : undefined;
    const result = this.requireStore().typeLookup(typeText, scope);
    const value = result.state === "UNRESOLVED"
      ? { ...result, coverage: this.worstTypeLookupCoverage(this.lastStatus.indexedGeneration) }
      : result;
    return validateTypeLookup(value);
  }

  async queryTypes(queries: Array<{ typeText: string; scopeFile?: string }>): Promise<JavaTypeLookupResult[]> {
    if (queries.length === 0) return [];
    const generation = this.lastStatus.indexedGeneration;
    const store = this.requireStore();
    const value = queries.map(query => {
      const scope = query.scopeFile ? this.toRelative(query.scopeFile) : undefined;
      const result = store.typeLookup(query.typeText, scope);
      return result.state === "UNRESOLVED"
        ? { ...result, coverage: this.worstTypeLookupCoverage(generation) }
        : result;
    });
    return validateTypeLookupArray(value);
  }

  async queryImplementers(typeId: string, limit: number): Promise<JavaTypeFacts[]> {
    return validateTypeFactsArray(this.requireStore().implementers(typeId, limit));
  }

  async queryTypeReferencers(typeId: string, edgeKinds: StaticEdgeKind[], limit: number): Promise<IndexedReference[]> {
    return validateIndexedReferenceArray(this.requireStore().typeReferencers(typeId, new Set(edgeKinds), limit));
  }

  async queryCallers(methodId: string, limit: number): Promise<IndexedReference[]> {
    return validateIndexedReferenceArray(this.requireStore().callers(methodId, limit));
  }

  async queryCallees(methodId: string, limit: number): Promise<IndexedReference[]> {
    return validateIndexedReferenceArray(this.requireStore().callees(methodId, limit));
  }

  async queryCalleesBatch(methodIds: string[], limit: number): Promise<Array<{ methodId: string; callees: IndexedReference[] }>> {
    if (methodIds.length === 0) return [];
    const store = this.requireStore();
    return validateIndexedReferenceBatch(
      methodIds.map(methodId => ({ methodId, callees: store.callees(methodId, limit) }))
    );
  }

  async queryMethodsWithParameterTypes(typeIds: string[], limit: number): Promise<string[]> {
    if (typeIds.length === 0) return [];
    return validateStringArray(this.requireStore().methodsWithParameterTypes(typeIds, limit));
  }

  async queryFiles(files: string[]): Promise<JavaFileBundle[]> {
    const relative = files.map(file => this.toRelative(file)).filter((path): path is string => path !== undefined);
    return validateFileBundleArray(this.requireStore().files(relative));
  }

  async queryMyBatisResource(relativePath: string): Promise<MyBatisMapperResourceFacts | undefined> {
    const relative = this.toRelative(relativePath) ?? relativePath;
    return validateMyBatisMapperResourceFacts(this.requireStore().myBatisResource(relative));
  }

  async queryMyBatisResourcesByNamespace(namespaces: string[]): Promise<MyBatisResourceByNamespaceBatch> {
    if (namespaces.length === 0) return [];
    const store = this.requireStore();
    return validateMyBatisResourceByNamespaceBatch(
      namespaces.map(namespace => {
        const resource = store.myBatisResourceForNamespace(namespace);
        return resource ? { namespace, resource } : { namespace };
      })
    );
  }

  async queryRepositoryFactMarkers(
    importPrefixes: string[],
    annotationPrefixes: string[]
  ): Promise<{ importPrefixFound: boolean; annotationPrefixFound: boolean }> {
    return validateRepositoryFactMarkers(
      this.requireStore().repositoryFactMarkers(importPrefixes, annotationPrefixes)
    );
  }

  private requireSupervisor(method: string): BuilderSupervisor {
    if (!this.supervisor) notImplemented(method);
    return this.supervisor;
  }

  private requireDb(): IndexDatabase {
    if (!this.db) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    return this.db;
  }

  private async runBuilderJob(job: BuilderSupervisorJob): Promise<JavaIndexStatus> {
    const result = await this.requireSupervisor(job.kind).submit(job);
    if (!result.ok) throw new JavaIntelligenceError("INDEX_PARTIAL", result.error ?? "builder failed");
    this.reload();
    return this.lastStatus;
  }

  private reloadIfOpen(): void {
    if (this.db) this.reload();
  }

  private reload(): void {
    if (this.db) closeDb(this.db);
    this.db = undefined;
    this.store = undefined;
    this.graph = undefined;
    this.search = undefined;
    if (!existsSync(this.dbPath)) {
      if (this.lastStatus.state !== "BUILDING") this.lastStatus = emptyStatus("DEGRADED");
      return;
    }
    this.db = openIndexDb(this.dbPath, { readOnly: true });
    this.store = new SqlFactsStore(this.db);
    this.graph = new SqlKnowledgeGraph(this.db);
    this.graph.prefetch();
    this.search = new SqlEntitySearch(this.db);
    this.lastStatus = this.assembleStatus();
    this.touch();
  }

  private ensureConn(): void {
    if (!this.opened) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    if (!this.db && existsSync(this.dbPath)) this.reload();
    else this.touch();
  }

  private touch(): void {
    this.clearIdle();
    if (!this.db || this.connIdleMs <= 0) return;
    this.idleTimer = setTimeout(() => this.dropConn(), this.connIdleMs);
  }

  private dropConn(): void {
    this.clearIdle();
    if (!this.db) return;
    closeDb(this.db);
    this.db = undefined;
    this.store = undefined;
    this.graph = undefined;
    this.search = undefined;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private copySibling(fromPath: string): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const source = openIndexDb(fromPath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${this.dbPath.replaceAll("'", "''")}'`);
    } finally {
      closeDb(source);
    }
  }

  private fileGeneration(inputPath: string): number {
    if (!this.db) return 0;
    const relative = this.toRelative(inputPath) ?? inputPath.split("\\").join("/");
    const row = prepareCached(this.db, "SELECT generation AS generation FROM file WHERE path=?").get(relative) as
      | { generation?: number | bigint }
      | undefined;
    if (row?.generation === undefined) return 0;
    return typeof row.generation === "bigint" ? Number(row.generation) : Number(row.generation);
  }

  private requireStore(): SqlFactsStore {
    this.ensureConn();
    if (!this.store) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    return this.store;
  }

  private queryDeps(): SqlQueryDeps {
    this.ensureConn();
    if (!this.graph || !this.search) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    return {
      store: this.requireStore(),
      graph: this.graph,
      search: this.search,
      indexedGeneration: this.lastStatus.indexedGeneration,
      repoRoot: this.repoRoot,
      toRelative: inputPath => this.toRelative(inputPath) ?? inputPath.replaceAll("\\", "/")
    };
  }

  private toRelative(inputPath: string): string | undefined {
    if (!this.layout) this.layout = probeLayout(this.repoRoot);
    try {
      return deriveJavaSourceLayout(this.repoRoot, inputPath, this.layout).relativePath;
    } catch {
      return undefined;
    }
  }

  private coverageRows(): SourceRootCoverage[] {
    if (!this.db) return [];
    const rows = prepareCached(this.db, "SELECT root AS root, state AS state, generation AS generation FROM source_root_coverage").all() as Array<{
      root: string;
      state: string;
      generation: number | bigint;
    }>;
    return rows.map(row => ({
      root: row.root,
      generation: typeof row.generation === "bigint" ? Number(row.generation) : Number(row.generation),
      state: row.state as SourceRootCoverage["state"],
      discoveredFiles: 0,
      indexedFiles: 0,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: ""
    }));
  }

  private coverageStateFor(root: string, generation: number): SourceRootCoverage["state"] {
    const entry = this.coverageRows().find(candidate => candidate.root === root);
    if (!entry) return "UNKNOWN";
    if (entry.state === "COMPLETE" && entry.generation !== generation) return "DEGRADED";
    return entry.state;
  }

  private worstTypeLookupCoverage(generation: number): "COMPLETE" | "PARTIAL" | "DEGRADED" {
    const rank = (state: "COMPLETE" | "PARTIAL" | "DEGRADED"): number =>
      state === "COMPLETE" ? 0 : state === "PARTIAL" ? 1 : 2;
    const entries = this.coverageRows();
    let worst: "COMPLETE" | "PARTIAL" | "DEGRADED" = entries.length === 0 ? "DEGRADED" : "COMPLETE";
    for (const entry of entries) {
      const mapped: "COMPLETE" | "PARTIAL" | "DEGRADED" = entry.generation !== generation
        ? "DEGRADED"
        : entry.state === "COMPLETE"
          ? "COMPLETE"
          : entry.state === "BUILDING"
            ? "PARTIAL"
            : "DEGRADED";
      if (rank(mapped) > rank(worst)) worst = mapped;
    }
    return worst;
  }

  private assembleStatus(): JavaIndexStatus {
    if (!this.db) return emptyStatus("DEGRADED");
    const counts = readIndexCounts(this.db) ?? { files: 0, types: 0, methods: 0, edges: 0 };
    const indexedGeneration = Number(readMeta(this.db, "indexedGeneration") ?? "0") || 0;
    const buildState = readMeta(this.db, "buildState");
    const builder = this.supervisor?.status();
    const bytes = existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;
    const cacheKb = Number(process.env.JAVA_LSP_SQLITE_CACHE_KB);
    const status: JavaIndexStatus = {
      state: buildState === "READY" ? "READY" : this.lastStatus.state === "BUILDING" ? "BUILDING" : "DEGRADED",
      indexedGeneration,
      files: counts.files,
      types: counts.types,
      methods: counts.methods,
      edges: counts.edges,
      snapshotBytes: 0,
      pendingForeground: 0,
      pendingBackground: builder?.queued ?? 0,
      coverage: this.coverageRows(),
      resourceCoverage: [],
      factsHydrated: true,
      hibernated: false,
      db: {
        bytes,
        cacheKb: Number.isFinite(cacheKb) && cacheKb > 0 ? Math.floor(cacheKb) : DEFAULT_SQLITE_CACHE_KB
      },
      ...(builder ? { builder } : {})
    };
    return validateJavaIndexStatus(status);
  }
}
