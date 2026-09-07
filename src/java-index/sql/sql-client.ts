import { existsSync } from "node:fs";
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
import { close as closeDb, openIndexDb, prepareCached, type IndexDatabase } from "./driver.js";
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

  constructor(
    private readonly repoRoot: string,
    private readonly dbPath: string
  ) {}

  async open(_generation: number, _options?: JavaIndexOpenOptions, _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    if (this.opened) {
      throw new JavaIntelligenceError("INDEX_PARTIAL", `Java index client cannot open from state ${this.lastStatus.state}`);
    }
    this.opened = true;
    if (!existsSync(this.dbPath)) {
      this.lastStatus = emptyStatus("DEGRADED");
      this.lastStatus.lastError = "EMPTY";
      return this.lastStatus;
    }
    this.db = openIndexDb(this.dbPath, { readOnly: true });
    this.store = new SqlFactsStore(this.db);
    this.graph = new SqlKnowledgeGraph(this.db);
    this.graph.prefetch();
    this.search = new SqlEntitySearch(this.db);
    this.layout = probeLayout(this.repoRoot);
    this.lastStatus = this.assembleStatus();
    return this.lastStatus;
  }

  async status(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    if (!this.db) {
      if (this.opened) return this.lastStatus;
      throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    }
    this.lastStatus = this.assembleStatus();
    return this.lastStatus;
  }

  localStatus(): JavaIndexStatus {
    return this.lastStatus;
  }

  async close(): Promise<void> {
    if (this.lastStatus.state === "CLOSED") return;
    if (this.db) closeDb(this.db);
    this.db = undefined;
    this.store = undefined;
    this.graph = undefined;
    this.search = undefined;
    this.lastStatus = { ...this.lastStatus, state: "CLOSED" };
  }

  async refresh(
    _generation: number,
    _changed: string[],
    _deleted: string[],
    _requestOptions?: JavaIndexRequestOptions,
    _priority?: JavaIndexRefreshPriority
  ): Promise<JavaIndexStatus> { return notImplemented("refresh"); }
  async refreshResources(_generation: number, _paths: string[], _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return notImplemented("refreshResources");
  }
  async ensureFresh(_files: string[], _generation: number, _requestOptions?: JavaIndexRequestOptions): Promise<void> {
    notImplemented("ensureFresh");
  }
  async reconcile(_generation: number, _requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> {
    return notImplemented("reconcile");
  }
  async awaitPrewarmReady(_requestOptions?: JavaIndexRequestOptions & JavaIndexPrewarmReadyOptions): Promise<JavaIndexStatus> {
    return notImplemented("awaitPrewarmReady");
  }
  async flush(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> { return notImplemented("flush"); }
  async hibernate(_requestOptions?: JavaIndexRequestOptions): Promise<JavaIndexStatus> { return notImplemented("hibernate"); }
  async recycle(_requestOptions?: JavaIndexRequestOptions): Promise<void> { notImplemented("recycle"); }
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

  private requireStore(): SqlFactsStore {
    if (!this.store) throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is not open");
    return this.store;
  }

  private queryDeps(): SqlQueryDeps {
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
    const status: JavaIndexStatus = {
      state: buildState === "READY" ? "READY" : "DEGRADED",
      indexedGeneration,
      files: counts.files,
      types: counts.types,
      methods: counts.methods,
      edges: counts.edges,
      snapshotBytes: 0,
      pendingForeground: 0,
      pendingBackground: 0,
      coverage: this.coverageRows(),
      resourceCoverage: [],
      factsHydrated: true,
      hibernated: false
    };
    return validateJavaIndexStatus(status);
  }
}
