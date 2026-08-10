// input: JavaIndexClient plus router lookup patterns (type name, file, method line).
// output: Async JavaIndex facts for AgentRouter collectors and scoring.
// pos: Task 22 cutover facade between V2 worker queries and router call sites.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { normalizeRepoFile, repoCacheRoot } from "../repo-layout.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import {
  JavaIndexClient,
  type JavaIndexOpenOptions,
  type JavaIndexRequestOptions
} from "./java-index-client.js";
import type {
  AnchorFacts,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  StaticEdgeKind
} from "./index-types.js";
import {
  CALLEES_LIMIT_DEFAULT,
  MAX_FRAMEWORK_CALLEE_METHODS,
  MAX_DECLARATION_IDS_PER_CALL,
  MAX_FRAMEWORK_FACT_FILES,
  MAX_FRAMEWORK_MYBATIS_NAMESPACES,
  bundleToFrameworkFileFacts,
  bundlesToRequestedDeclarations,
  fqnOfTypeId,
  ownerTypeIdOf,
  relativePathOfLocalTypeId,
  type FrameworkCallees,
  type FrameworkDeclarations,
  type FrameworkFileFacts,
  type FrameworkIndexStatus,
  type FrameworkMethodDeclaration,
  type FrameworkRepositoryFactMarkers,
  type FrameworkIndexView
} from "./framework-index-view.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import {
  openSourceFromStatus,
  summarizeCoverage,
  type JavaIndexOpenSource,
  type JavaIndexView
} from "./java-index-view.js";
import {
  anchorToSourceFacts,
  bundleToSourceFacts,
  fallbackSourceFacts,
  MAX_FACTS_FOR_FILES,
  typeFactsToSourceFacts,
  type FactsForFileItem,
  type FactsForFilesResult,
  type JavaMethodFact,
  type JavaSourceFacts
} from "./router-facts.js";

/** Bounds a single marker file read (e.g. pom.xml) - repositoryMarkers is meant for small dependency-declaration files, not arbitrary large sources. */
const REPOSITORY_MARKER_MAX_BYTES = 65_536;

// declarationsById is a bounded, batched lookup, not an arbitrary bulk
// export: an uncapped id list (e.g. every callee of a hot method) could
// resolve to hundreds of distinct files and pull their full bundles across
// the worker IPC boundary in one call. The id cap itself is
// MAX_DECLARATION_IDS_PER_CALL, exported from framework-index-view.ts so a
// batching caller can chunk against the same number instead of duplicating
// it; MAX_DECLARATION_PATHS is a second, independent bound purely internal
// to this method (how many distinct files the bounded ids may still resolve
// into), so it stays local.
const MAX_DECLARATION_PATHS = 64;
/** A cold partial index may have parsed an anchor before its imported module; retry only a small exact-FQN set through conventional source paths. */
const MAX_COLD_DECLARATION_FQN_RETRIES = 16;
const MAX_COLD_DECLARATION_PATH_CHECKS = 512;

const TYPE_REFERENCE_EDGE_KINDS: StaticEdgeKind[] = [
  "FIELD_TYPE",
  "PARAM_TYPE",
  "RETURN_TYPE",
  "THROWS_TYPE",
  "LOCAL_TYPE",
  "CALLS",
  "CONSTRUCTS",
  "METHOD_REFERENCE",
  "ANNOTATED_WITH"
];

const IMPORT_EDGE_KINDS: StaticEdgeKind[] = ["IMPORTS"];
const IMPLEMENTS_EDGE_KINDS: StaticEdgeKind[] = ["IMPLEMENTS", "EXTENDS"];

export type RouterIndexStatus = {
  entries: number;
  hits: number;
  misses: number;
  typeLookupIndexHits: number;
  typeLookupIndexMisses: number;
  javaIndex: JavaIndexStatus;
  openSource: JavaIndexOpenSource;
  coverage: "complete" | "partial" | "degraded";
};

export type RouterTypeLookupOptions = {
  /** Reuse an exact declaration identity already returned by QUERY_TYPES. */
  readonly typeId?: string;
  /** Candidate discovery often needs only stable type/path metadata, not a full source bundle. */
  readonly hydrate?: boolean;
};

/** Router-facing fact surface backed exclusively by JavaIndex V2. */
export interface RouterIndex {
  /** Binds immutable request controls to this async call chain without sharing mutable state across concurrent requests. */
  withRequestOptions?<T>(options: JavaIndexRequestOptions, action: () => Promise<T>): Promise<T>;
  ensureFresh(files: string[], generation: number): Promise<void>;
  queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
  queryReadRanges(
    requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>,
    generation?: number
  ): Promise<IndexedReadRangeResult[]>;
  factsFor(inputFile: string, generation?: number): Promise<JavaSourceFacts>;
  /** Optional for one rollout so the relationship provider can feature-flag the legacy per-file fallback. */
  factsForFiles?(inputFiles: readonly string[], generation?: number): Promise<FactsForFilesResult>;
  methodAt(inputFile: string, line: number, generation?: number): Promise<JavaMethodFact | undefined>;
  findImplementers(
    typeName: string,
    limit?: number,
    scopeFile?: string,
    options?: RouterTypeLookupOptions
  ): Promise<JavaSourceFacts[]>;
  findTypeReferences(typeName: string, limit?: number, options?: RouterTypeLookupOptions): Promise<JavaSourceFacts[]>;
  findImporters(typeName: string, limit?: number, options?: RouterTypeLookupOptions): Promise<JavaSourceFacts[]>;
  findTypeDefinitions(typeNames: readonly string[], limit?: number, hydrate?: boolean): Promise<JavaSourceFacts[]>;
  /**
   * Bounded AST-resolved calls for one anchor method. Optional preserves the
   * V1 compatibility adapter; V2 exposes the same fact through its generic
   * router surface rather than requiring a framework pack.
   */
  resolvedCallees?(methodId: string, limit?: number): Promise<FrameworkCallees>;
  routerStatus(refresh?: boolean): Promise<RouterIndexStatus>;
  /** Request-local counters plus the last worker status, without issuing a STATUS RPC. */
  localRouterStatus?(): RouterIndexStatus;
}

type RequestQueryMemo = {
  readonly queries: Map<string, Promise<unknown>>;
};

type RouterRequestScope = {
  readonly options: JavaIndexRequestOptions;
  readonly memo: RequestQueryMemo;
};

/**
 * High-level async index used by AgentRouter. Wraps JavaIndexClient and maps
 * V2 queries into the fact shapes collectors already understand.
 */
export class RouterJavaIndex implements JavaIndexView, RouterIndex, FrameworkIndexView {
  private readonly requestOptionsScope = new AsyncLocalStorage<RouterRequestScope>();
  private generation = 0;
  private opened = false;
  private openSource: JavaIndexOpenSource = "cold";
  private typeLookupHits = 0;
  private typeLookupMisses = 0;
  private factsHits = 0;
  private factsMisses = 0;
  /** Files known to have completed a foreground refresh at a repo generation. */
  private readonly freshGenerationByPath = new Map<string, number>();
  /** Router facts are immutable for one generation; retain them across ranking phases. */
  private readonly factsByPath = new Map<string, { generation: number; facts: JavaSourceFacts }>();
  /** Framework-view projection cache, generation-scoped like factsByPath - cleared alongside it in refresh/reconcile/close so a Slice C/D adapter never reads stale facts across a generation bump. */
  private readonly frameworkFactsByPath = new Map<string, { generation: number; facts: FrameworkFileFacts }>();
  /** Build/dependency marker files are cached only until the next observed refresh/reconcile. */
  private readonly repositoryMarkerCache = new Map<string, string | null>();
  /** Store-local import/annotation summary, one worker request per key and generation. */
  private readonly repositoryFactMarkerCache = new Map<string, { generation: number; markers: FrameworkRepositoryFactMarkers }>();
  /** Layout-probe source roots are stable through a request and let cold declaration lookup refresh only an exact conventional source path. */
  private readonly conventionalDeclarationRoots: readonly string[];

  constructor(
    private readonly repoRoot: string,
    private readonly client: JavaIndexClient,
    private readonly openOptions: JavaIndexOpenOptions = {}
  ) {
    this.conventionalDeclarationRoots = probeLayout(repoRoot).sourceRoots.map(root => root.relativePath);
  }

  static create(repoRoot: string, cacheDir = repoCacheRoot(repoRoot), openOptions: JavaIndexOpenOptions = {}): RouterJavaIndex {
    return new RouterJavaIndex(repoRoot, new JavaIndexClient(repoRoot, cacheDir), openOptions);
  }

  rawClient(): JavaIndexClient {
    return this.client;
  }

  withRequestOptions<T>(options: JavaIndexRequestOptions, action: () => Promise<T>): Promise<T> {
    const parent = this.requestOptionsScope.getStore();
    const controlBoundaryChanged = parent !== undefined && (
      (Object.hasOwn(options, "budget") && options.budget !== parent.options.budget)
      || (Object.hasOwn(options, "signal") && options.signal !== parent.options.signal)
    );
    const scope: RouterRequestScope = {
      options: Object.freeze({ ...(parent?.options ?? {}), ...options }),
      // A shorter nested deadline/cancellation scope must never hitch-hike on
      // an in-flight RPC owned by its parent. Telemetry-only nested scopes may
      // safely share the request memo.
      memo: parent && !controlBoundaryChanged ? parent.memo : { queries: new Map() }
    };
    return this.requestOptionsScope.run(scope, action);
  }

  private currentRequestOptions(): JavaIndexRequestOptions {
    return this.requestOptionsScope.getStore()?.options ?? {};
  }

  private requestMemoized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const memo = this.requestOptionsScope.getStore()?.memo;
    if (!memo) return action();
    const existing = memo.queries.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = Promise.resolve().then(action);
    memo.queries.set(key, pending);
    void pending.catch(() => {
      if (memo.queries.get(key) === pending) memo.queries.delete(key);
    });
    return pending;
  }

  async open(generation: number, options: JavaIndexOpenOptions = {}): Promise<JavaIndexStatus> {
    const status = await this.client.open(generation, { ...this.openOptions, ...options }, this.currentRequestOptions());
    this.generation = Math.max(this.generation, generation, status.indexedGeneration);
    this.opened = true;
    this.openSource = openSourceFromStatus(status);
    return status;
  }

  /**
   * Foreground-refresh the given files at the request generation so subsequent
   * queries see current AST facts. Opens the worker lazily for unit tests that
   * construct the router without going through RepoRuntimeManager.
   */
  async ensureFresh(files: string[], generation: number): Promise<void> {
    await this.ensureOpened(generation);
    generation = this.effectiveGeneration(generation);
    if (this.isStaleGeneration(generation)) throw staleGenerationError(generation, this.currentGenerationHighWater());
    const absoluteFiles = unique(
      files
        .filter(Boolean)
        .map(file => {
          try {
            return normalizeRepoFile(this.repoRoot, file);
          } catch {
            return undefined;
          }
        })
        .filter((file): file is string => file !== undefined && existsSync(file))
    ).sort((left, right) => left.localeCompare(right));
    return this.requestMemoized(
      queryMemoKey("ENSURE_FRESH", generation, absoluteFiles),
      () => this.ensureFreshCanonical(absoluteFiles, generation)
    );
  }

  private async ensureFreshCanonical(absoluteFiles: readonly string[], generation: number): Promise<void> {
    if (absoluteFiles.length === 0) {
      this.generation = Math.max(this.generation, generation);
      return;
    }
    const staleFiles = absoluteFiles.filter(file => {
      if (this.freshGenerationByPath.get(file) === generation) {
        return false;
      }
      if (this.hasCompleteCoverageAt(file, generation)) {
        this.freshGenerationByPath.set(file, generation);
        return false;
      }
      return true;
    });
    if (staleFiles.length === 0) {
      this.generation = Math.max(this.generation, generation);
      return;
    }
    const status = await this.client.refresh(generation, staleFiles, [], this.currentRequestOptions());
    this.generation = Math.max(this.generation, generation, status.indexedGeneration);
    if (this.isStaleGeneration(generation)) throw staleGenerationError(generation, this.currentGenerationHighWater());
    for (const file of staleFiles) this.freshGenerationByPath.set(file, generation);
  }

  async queryAnchor(file: string, line: number, column: number) {
    await this.ensureOpened(this.generation);
    const absolutePath = normalizeRepoFile(this.repoRoot, file);
    return this.requestMemoized(
      queryMemoKey("QUERY_ANCHOR", this.generation, [absolutePath, line, column]),
      () => this.client.queryAnchor(absolutePath, line, column, this.currentRequestOptions())
    );
  }

  async queryReadRanges(
    requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>,
    generation = this.generation
  ): Promise<IndexedReadRangeResult[]> {
    const files = requests.map(request => normalizeRepoFile(this.repoRoot, request.file));
    await this.ensureOpened(generation);
    return this.client.queryReadRanges(
      requests.map((request, index) => ({ ...request, file: files[index]! })),
      this.currentRequestOptions()
    );
  }

  async queryType(typeText: string, scopeFile?: string) {
    await this.ensureOpened(this.generation);
    const generation = this.generation;
    return this.requestMemoized(
      queryMemoKey("QUERY_TYPE", generation, [typeText, scopeFile ?? null]),
      () => this.client.queryType(typeText, scopeFile, this.currentRequestOptions())
    );
  }

  async queryTypes(queries: Array<{ typeText: string; scopeFile?: string }>) {
    await this.ensureOpened(this.generation);
    const generation = this.generation;
    return this.requestMemoized(
      queryMemoKey("QUERY_TYPES", generation, queries),
      () => this.client.queryTypes(queries, this.currentRequestOptions())
    );
  }

  async queryImplementers(typeId: string, limit: number) {
    await this.ensureOpened(this.generation);
    const generation = this.generation;
    return this.requestMemoized(
      queryMemoKey("QUERY_IMPLEMENTERS", generation, [typeId, limit]),
      () => this.client.queryImplementers(typeId, limit, this.currentRequestOptions())
    );
  }

  async queryTypeReferencers(typeId: string, kinds: StaticEdgeKind[], limit: number) {
    await this.ensureOpened(this.generation);
    const generation = this.generation;
    return this.requestMemoized(
      queryMemoKey("QUERY_TYPE_REFERENCERS", generation, [typeId, kinds, limit]),
      () => this.client.queryTypeReferencers(typeId, kinds, limit, this.currentRequestOptions())
    );
  }

  async queryCallers(methodId: string, limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryCallers(methodId, limit, this.currentRequestOptions());
  }

  async queryCallees(methodId: string, limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryCallees(methodId, limit, this.currentRequestOptions());
  }

  async queryFiles(files: string[]) {
    await this.ensureOpened(this.generation);
    const generation = this.generation;
    const bundles = await this.requestMemoized(
      queryMemoKey("QUERY_FILES", generation, files),
      () => this.client.queryFiles(files, this.currentRequestOptions())
    );
    for (const bundle of bundles) {
      if (bundle.file.generation !== generation) continue;
      try {
        this.cacheBundle(bundle, generation);
      } catch {
        // The caller still receives the validated worker result; an invalid
        // repository-relative identity is simply not admitted to local caches.
      }
    }
    return bundles;
  }

  async status(refresh = false): Promise<JavaIndexStatus> {
    await this.ensureOpened(this.generation);
    const load = async () => {
      const status = await this.client.status(this.currentRequestOptions());
      if (this.openSource === "cold" && status.files > 0) {
        this.openSource = openSourceFromStatus(status);
      }
      return status;
    };
    return refresh
      ? load()
      : this.requestMemoized(queryMemoKey("STATUS", this.generation, null), load);
  }

  async routerStatus(refresh = false): Promise<RouterIndexStatus> {
    let javaIndex: JavaIndexStatus;
    try {
      javaIndex = await this.status(refresh);
    } catch (error) {
      if (error instanceof JavaIntelligenceError
        && (error.code === "DEADLINE_EXCEEDED" || error.code === "CANCELLED")) {
        throw error;
      }
      javaIndex = this.client.localStatus();
    }
    return this.projectRouterStatus(javaIndex);
  }

  localRouterStatus(): RouterIndexStatus {
    return this.projectRouterStatus(this.client.localStatus());
  }

  private projectRouterStatus(javaIndex: JavaIndexStatus): RouterIndexStatus {
    return {
      entries: javaIndex.files,
      hits: this.factsHits,
      misses: this.factsMisses,
      typeLookupIndexHits: this.typeLookupHits,
      typeLookupIndexMisses: this.typeLookupMisses,
      javaIndex,
      openSource: this.openSource,
      coverage: summarizeCoverage(javaIndex)
    };
  }

  localOpenSource(): JavaIndexOpenSource {
    return this.openSource;
  }

  async refresh(generation: number, changed: string[], deleted: string[]): Promise<JavaIndexStatus> {
    await this.ensureOpened(generation);
    generation = this.effectiveGeneration(generation);
    if (this.isStaleGeneration(generation)) return this.client.localStatus();
    const status = await this.client.refresh(generation, changed, deleted, this.currentRequestOptions());
    this.generation = Math.max(this.generation, generation, status.indexedGeneration);
    if (this.isStaleGeneration(generation)) return status;
    for (const file of changed) {
      const absolute = normalizeRepoFile(this.repoRoot, file);
      this.freshGenerationByPath.set(absolute, generation);
      this.factsByPath.delete(absolute);
      this.frameworkFactsByPath.delete(absolute);
    }
    for (const file of deleted) {
      const absolute = normalizeRepoFile(this.repoRoot, file);
      this.freshGenerationByPath.delete(absolute);
      this.factsByPath.delete(absolute);
      this.frameworkFactsByPath.delete(absolute);
    }
    this.repositoryMarkerCache.clear();
    this.repositoryFactMarkerCache.clear();
    return status;
  }

  async reconcile(generation: number): Promise<JavaIndexStatus> {
    await this.ensureOpened(generation);
    generation = this.effectiveGeneration(generation);
    if (this.isStaleGeneration(generation)) return this.client.localStatus();
    const status = await this.client.reconcile(generation, this.currentRequestOptions());
    this.generation = Math.max(this.generation, generation, status.indexedGeneration);
    if (this.isStaleGeneration(generation)) return status;
    this.freshGenerationByPath.clear();
    this.factsByPath.clear();
    this.frameworkFactsByPath.clear();
    this.repositoryMarkerCache.clear();
    this.repositoryFactMarkerCache.clear();
    return status;
  }

  async close(): Promise<void> {
    await this.client.close();
    this.opened = false;
    this.freshGenerationByPath.clear();
    this.factsByPath.clear();
    this.frameworkFactsByPath.clear();
    this.repositoryMarkerCache.clear();
    this.repositoryFactMarkerCache.clear();
  }

  async factsFor(inputFile: string, generation = this.generation): Promise<JavaSourceFacts> {
    const absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Java source file does not exist: ${inputFile}`);
    }
    const result = await this.factsForFiles([absolutePath], generation);
    const item = result.items[0];
    if (item?.state === "FOUND") return item.facts;
    if (item?.state === "DEGRADED"
      && (item.reason === "DEADLINE_EXCEEDED" || item.reason === "CANCELLED")) {
      throw new JavaIntelligenceError(item.reason, item.detail ?? `JavaIndex facts query ${item.reason.toLowerCase()}`);
    }
    // Preserve the legacy fail-soft single-file API while keeping fallback
    // facts out of the authoritative generation cache.
    return fallbackSourceFacts(this.repoRoot, absolutePath);
  }

  async factsForFiles(inputFiles: readonly string[], generation = this.generation): Promise<FactsForFilesResult> {
    await this.ensureOpened(generation);
    generation = this.effectiveGeneration(generation);
    const inputs = [...inputFiles];
    return this.requestMemoized(
      queryMemoKey("FACTS_FOR_FILES", generation, inputs),
      () => this.loadFactsForFiles(inputs, generation, MAX_FACTS_FOR_FILES)
    );
  }

  private async loadFactsForFiles(
    inputFiles: readonly string[],
    generation: number,
    maxFiles: number
  ): Promise<FactsForFilesResult> {
    type PreparedItem =
      | { readonly inputFile: string; readonly absolutePath: string }
      | { readonly item: FactsForFileItem };

    const admittedPaths = new Set<string>();
    let truncated = false;
    const prepared: PreparedItem[] = inputFiles.map(inputFile => {
      let absolutePath: string;
      try {
        absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
      } catch {
        return { item: { inputFile, state: "DEGRADED", reason: "INVALID_PATH" } };
      }
      if (!existsSync(absolutePath)) {
        return { item: { inputFile, absolutePath, state: "MISSING", reason: "FILE_NOT_FOUND" } };
      }
      if (!admittedPaths.has(absolutePath)) {
        if (admittedPaths.size >= maxFiles) {
          truncated = true;
          return { item: { inputFile, absolutePath, state: "DEGRADED", reason: "LIMIT_EXCEEDED" } };
        }
        admittedPaths.add(absolutePath);
      }
      return { inputFile, absolutePath };
    });

    const outcomeByPath = new Map<string, FactsForFileItem>();
    if (this.isStaleGeneration(generation)) {
      for (const absolutePath of admittedPaths) {
        outcomeByPath.set(absolutePath, generationMismatchItem(absolutePath));
      }
      return this.finishFactsForFiles(prepared, outcomeByPath, generation, truncated);
    }
    const uncached: string[] = [];
    for (const absolutePath of admittedPaths) {
      const cached = this.factsByPath.get(absolutePath);
      if (cached?.generation === generation) {
        outcomeByPath.set(absolutePath, {
          inputFile: absolutePath,
          absolutePath,
          state: "FOUND",
          facts: cached.facts
        });
      } else {
        uncached.push(absolutePath);
      }
    }

    if (uncached.length > 0) {
      for (const [absolutePath, outcome] of await this.hydrateFactsForPaths(uncached, generation)) {
        outcomeByPath.set(absolutePath, outcome);
      }
    }
    // A refresh can advance the worker while this batch is hydrating its
    // misses. Never combine cache hits from generation G with late outcomes
    // observed after the index moved to H.
    if (this.isStaleGeneration(generation)) {
      for (const absolutePath of admittedPaths) {
        outcomeByPath.set(absolutePath, generationMismatchItem(absolutePath));
      }
    }
    return this.finishFactsForFiles(prepared, outcomeByPath, generation, truncated);
  }

  private finishFactsForFiles(
    prepared: readonly (
      | { readonly inputFile: string; readonly absolutePath: string }
      | { readonly item: FactsForFileItem }
    )[],
    outcomeByPath: ReadonlyMap<string, FactsForFileItem>,
    generation: number,
    truncated: boolean
  ): FactsForFilesResult {
    const items = prepared.map<FactsForFileItem>(entry => {
      if ("item" in entry) return entry.item;
      const outcome = outcomeByPath.get(entry.absolutePath);
      if (!outcome) {
        return {
          inputFile: entry.inputFile,
          absolutePath: entry.absolutePath,
          state: "DEGRADED",
          reason: "INDEX_INCOMPLETE"
        };
      }
      return { ...outcome, inputFile: entry.inputFile };
    });
    for (const item of items) {
      if (item.state === "FOUND") this.factsHits += 1;
      else this.factsMisses += 1;
    }
    return {
      generation,
      completion: !truncated && items.every(item => item.state === "FOUND") ? "COMPLETE" : "PARTIAL",
      truncated,
      items
    };
  }

  private async hydrateFactsForPaths(
    paths: readonly string[],
    generation: number
  ): Promise<Map<string, FactsForFileItem>> {
    const canonicalPaths = unique([...paths]).sort((left, right) => left.localeCompare(right));
    const memo = this.requestOptionsScope.getStore()?.memo;
    if (!memo) return this.hydrateFactsBatch(canonicalPaths, generation);

    const pending: Array<Promise<[string, FactsForFileItem]>> = [];
    const missing: string[] = [];
    for (const absolutePath of canonicalPaths) {
      const key = queryMemoKey("HYDRATE_FACT", generation, absolutePath);
      const existing = memo.queries.get(key) as Promise<FactsForFileItem> | undefined;
      if (existing) pending.push(existing.then(item => [absolutePath, item]));
      else missing.push(absolutePath);
    }
    if (missing.length > 0) {
      const batch = Promise.resolve().then(() => this.hydrateFactsBatch(missing, generation));
      for (const absolutePath of missing) {
        const key = queryMemoKey("HYDRATE_FACT", generation, absolutePath);
        const item = batch.then(result => result.get(absolutePath) ?? incompleteItem(absolutePath));
        memo.queries.set(key, item);
        void item.catch(() => {
          if (memo.queries.get(key) === item) memo.queries.delete(key);
        });
        pending.push(item.then(value => [absolutePath, value]));
      }
    }
    return new Map(await Promise.all(pending));
  }

  private async hydrateFactsBatch(
    absolutePaths: readonly string[],
    generation: number
  ): Promise<Map<string, FactsForFileItem>> {
    const outcomes = new Map<string, FactsForFileItem>();
    try {
      await this.ensureFresh([...absolutePaths], generation);
      if (this.isStaleGeneration(generation)) {
        for (const absolutePath of absolutePaths) outcomes.set(absolutePath, generationMismatchItem(absolutePath));
        return outcomes;
      }
      const bundles = await this.queryFiles([...absolutePaths]);
      const requested = new Set(absolutePaths);
      const bundleByPath = new Map<string, JavaFileBundle>();
      for (const bundle of bundles) {
        try {
          const absolutePath = normalizeRepoFile(this.repoRoot, bundle.file.relativePath);
          if (requested.has(absolutePath)) bundleByPath.set(absolutePath, bundle);
        } catch {
          // A malformed/outside bundle cannot poison otherwise valid items.
        }
      }
      for (const absolutePath of absolutePaths) {
        const bundle = bundleByPath.get(absolutePath);
        if (!bundle) {
          outcomes.set(absolutePath, incompleteItem(absolutePath));
          continue;
        }
        if (bundle.file.generation !== generation) {
          outcomes.set(absolutePath, generationMismatchItem(absolutePath));
          continue;
        }
        this.cacheBundle(bundle, generation);
        if (bundle.file.parseState !== "COMPLETE") {
          outcomes.set(absolutePath, incompleteItem(absolutePath));
          continue;
        }
        outcomes.set(absolutePath, {
          inputFile: absolutePath,
          absolutePath,
          state: "FOUND",
          facts: this.factsByPath.get(absolutePath)!.facts
        });
      }
    } catch (error) {
      if (this.isStaleGeneration(generation)) {
        for (const absolutePath of absolutePaths) outcomes.set(absolutePath, generationMismatchItem(absolutePath));
        return outcomes;
      }
      const failure = queryFailure(error);
      for (const absolutePath of absolutePaths) {
        outcomes.set(absolutePath, {
          inputFile: absolutePath,
          absolutePath,
          state: "DEGRADED",
          reason: failure.reason,
          detail: failure.detail
        });
      }
    }
    return outcomes;
  }

  private cacheBundle(bundle: JavaFileBundle, generation: number): void {
    const absolutePath = normalizeRepoFile(this.repoRoot, bundle.file.relativePath);
    this.frameworkFactsByPath.set(absolutePath, {
      generation,
      facts: bundleToFrameworkFileFacts(bundle)
    });
    if (bundle.file.parseState === "COMPLETE") {
      this.factsByPath.set(absolutePath, {
        generation,
        facts: bundleToSourceFacts(this.repoRoot, bundle)
      });
    }
  }

  async methodAt(inputFile: string, line: number, generation = this.generation): Promise<JavaMethodFact | undefined> {
    const facts = await this.factsFor(inputFile, generation);
    return [...facts.methods]
      .filter(method => method.line <= line && line <= method.endLine)
      .sort((left, right) => right.line - left.line)[0]
      || [...facts.methods].filter(method => method.line <= line).sort((left, right) => right.line - left.line)[0];
  }

  async findImplementers(
    typeName: string,
    limit = 20,
    scopeFile?: string,
    options: RouterTypeLookupOptions = {}
  ): Promise<JavaSourceFacts[]> {
    const typeId = options.typeId ?? await this.resolveTypeId(typeName, scopeFile);
    if (!typeId) {
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const implementers = await this.queryImplementers(typeId, limit);
    return this.typesToFacts(implementers, false, options.hydrate ?? true);
  }

  async findTypeReferences(
    typeName: string,
    limit = 20,
    options: RouterTypeLookupOptions = {}
  ): Promise<JavaSourceFacts[]> {
    const typeId = options.typeId ?? await this.resolveTypeId(typeName);
    if (!typeId) {
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const refs = await this.queryTypeReferencers(
      typeId,
      TYPE_REFERENCE_EDGE_KINDS,
      limit * 4
    );
    return this.referencesToFacts(refs, limit, options.hydrate ?? true);
  }

  async findImporters(
    typeName: string,
    limit = 20,
    options: RouterTypeLookupOptions = {}
  ): Promise<JavaSourceFacts[]> {
    const typeId = options.typeId ?? await this.resolveTypeId(typeName);
    if (!typeId) {
      // IMPORTS edges target external: nodes for unresolved FQNs; try file-level
      // lookup via simple name definitions when the type is not yet indexed.
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const refs = await this.queryTypeReferencers(
      typeId,
      IMPORT_EDGE_KINDS,
      limit * 2
    );
    return this.referencesToFacts(refs, limit, options.hydrate ?? true);
  }

  async findTypeDefinitions(typeNames: readonly string[], limit = 40, hydrate = true): Promise<JavaSourceFacts[]> {
    const names = unique(typeNames.map(value => value.replace(/<.*>/, "").trim()).filter(Boolean)).slice(0, 64);
    // A request commonly has a method signature plus a handful of imports.
    // Resolve those independent lookups together and hydrate their owning
    // files once.  The former one-type-at-a-time pattern paid a worker IPC
    // round-trip for every definition and then another for every file bundle.
    const lookupResults = await this.queryTypes(names.map(typeText => ({ typeText })));
    const found: JavaTypeFacts[] = [];
    const foundFiles = new Set<string>();
    for (const lookup of lookupResults) {
      if (lookup.state === "RESOLVED") {
        this.typeLookupHits += 1;
        addType(lookup.type, found, foundFiles);
        continue;
      }
      if (lookup.state === "AMBIGUOUS") {
        this.typeLookupHits += 1;
        for (const type of lookup.candidates.slice(0, 4)) {
          addType(type, found, foundFiles);
        }
        continue;
      }
      this.typeLookupMisses += 1;
    }
    // Input order is semantic priority (method signature and direct imports
    // precede wider task-named imports).  Sorting before the limit used to
    // discard a direct interface such as PositionService, which also meant
    // its implementation lookup never ran in a large controller import set.
    return (await this.typesToFacts(found, true, hydrate)).slice(0, limit);
  }

  private async resolveTypeId(typeName: string, scopeFile?: string): Promise<string | undefined> {
    const simple = typeName.slice(typeName.lastIndexOf(".") + 1);
    const lookup = await this.queryType(typeName, scopeFile);
    if (lookup.state === "RESOLVED") return lookup.type.typeId;
    if (lookup.state === "AMBIGUOUS" && lookup.candidates.length > 0) {
      // Prefer an exact simple-name match; otherwise first candidate.
      return lookup.candidates.find(type => type.simpleName === simple)?.typeId
        || lookup.candidates[0]?.typeId;
    }
    if (simple !== typeName) {
      const simpleLookup = await this.queryType(simple, scopeFile);
      if (simpleLookup.state === "RESOLVED") return simpleLookup.type.typeId;
      if (simpleLookup.state === "AMBIGUOUS") return simpleLookup.candidates[0]?.typeId;
    }
    return undefined;
  }

  private async typesToFacts(
    types: readonly JavaTypeFacts[],
    preserveInputOrder = false,
    hydrate = true
  ): Promise<JavaSourceFacts[]> {
    const byPath = new Map<string, JavaTypeFacts>();
    for (const type of types) {
      const relativePath = relativePathOfFileId(type.fileId);
      if (!byPath.has(relativePath)) byPath.set(relativePath, type);
    }
    if (!hydrate) {
      return [...byPath.entries()].map(([relativePath, type]) => typeFactsToSourceFacts(this.repoRoot, {
        ...type,
        fileId: relativePath
      }));
    }
    const absolutePaths = [...byPath.keys()].map(relative => path.resolve(this.repoRoot, relative));
    const bundles = absolutePaths.length > 0
      ? await this.queryFiles(absolutePaths)
      : [];
    const bundleByRelative = new Map(bundles.map(bundle => [bundle.file.relativePath, bundle]));
    const facts: JavaSourceFacts[] = [];
    for (const [relativePath, type] of byPath) {
      const bundle = bundleByRelative.get(relativePath);
      if (bundle) {
        // Definition lookup already paid to transfer the complete bundle.
        // Retain the ordinary file facts as well as returning the
        // type-specific projection, so final ranking does not immediately
        // issue the same QUERY_FILES request again.
        this.cacheBundle(bundle, this.generation);
      }
      facts.push(typeFactsToSourceFacts(this.repoRoot, type, bundle));
    }
    return preserveInputOrder
      ? facts
      : facts.sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  }

  private async referencesToFacts(
    refs: readonly IndexedReference[],
    limit: number,
    hydrate = true
  ): Promise<JavaSourceFacts[]> {
    const relativePaths = unique(refs.map(ref => ref.sourceFile)).slice(0, limit * 2);
    if (relativePaths.length === 0) return [];
    const absolutePaths = relativePaths.map(relative => path.resolve(this.repoRoot, relative));
    if (!hydrate) {
      return absolutePaths
        .map(absolutePath => fallbackSourceFacts(this.repoRoot, absolutePath))
        .sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath))
        .slice(0, limit);
    }
    const bundles = await this.queryFiles(absolutePaths);
    const facts = bundles
      .map(bundle => bundleToSourceFacts(this.repoRoot, bundle));
    for (const fact of facts) {
      this.factsByPath.set(fact.absolutePath, { generation: this.generation, facts: fact });
    }
    return facts
      .sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath))
      .slice(0, limit);
  }

  private async ensureOpened(generation: number): Promise<void> {
    if (this.opened || this.client.localStatus().state === "READY" || this.client.localStatus().state === "DEGRADED") {
      // Client may already have been opened by RepoRuntimeManager.
      if (!this.opened && this.client.localStatus().state !== "NEW" && this.client.localStatus().state !== "CLOSED") {
        this.opened = true;
        this.generation = Math.max(this.generation, this.client.localStatus().indexedGeneration, generation);
        this.openSource = openSourceFromStatus(this.client.localStatus());
      }
      if (this.opened) {
        this.generation = Math.max(this.generation, generation);
        return;
      }
    }
    // Unit-test / benchmark path: open cold without sibling seed options.
    try {
      const status = await this.client.open(generation, this.openOptions, this.currentRequestOptions());
      this.opened = true;
      this.generation = Math.max(this.generation, generation, status.indexedGeneration);
      this.openSource = openSourceFromStatus(status);
    } catch {
      // A second open after runtime already opened is fine; mark opened from local status.
      const local = this.client.localStatus();
      if (local.state !== "NEW" && local.state !== "CLOSED") {
        this.opened = true;
        this.generation = Math.max(this.generation, local.indexedGeneration, generation);
        this.openSource = openSourceFromStatus(local);
        return;
      }
      throw new Error("Java index is unavailable");
    }
  }

  async frameworkFactsFor(inputFile: string, generation = this.generation): Promise<FrameworkFileFacts> {
    const [facts] = await this.frameworkFactsForFiles([inputFile], generation);
    if (!facts) throw new Error(`Java source file does not exist: ${inputFile}`);
    return facts;
  }

  async frameworkFactsForFiles(inputFiles: readonly string[], generation = this.generation): Promise<FrameworkFileFacts[]> {
    await this.ensureOpened(generation);
    generation = this.effectiveGeneration(generation);
    const absolutePaths = unique([...inputFiles]
      .map(file => {
        try {
          return normalizeRepoFile(this.repoRoot, file);
        } catch {
          return undefined;
        }
      })
      .filter((file): file is string => file !== undefined && existsSync(file)))
      .slice(0, MAX_FRAMEWORK_FACT_FILES);
    return this.requestMemoized(
      queryMemoKey("FRAMEWORK_FACTS_FOR_FILES", generation, absolutePaths),
      () => this.loadFrameworkFactsForFiles(absolutePaths, generation)
    );
  }

  private async loadFrameworkFactsForFiles(
    absolutePaths: readonly string[],
    generation: number
  ): Promise<FrameworkFileFacts[]> {
    const uncached = absolutePaths.filter(file => this.frameworkFactsByPath.get(file)?.generation !== generation);
    if (uncached.length > 0) {
      await this.loadFactsForFiles(uncached, generation, MAX_FRAMEWORK_FACT_FILES);
      for (const absolutePath of uncached) {
        if (this.frameworkFactsByPath.get(absolutePath)?.generation === generation) continue;
        this.frameworkFactsByPath.set(absolutePath, {
          generation,
          facts: degradedFrameworkFacts(this.repoRoot, absolutePath)
        });
      }
    }
    return absolutePaths.map(file => {
      const cached = this.frameworkFactsByPath.get(file);
      return cached?.generation === generation
        ? cached.facts
        : degradedFrameworkFacts(this.repoRoot, file);
    });
  }

  /**
   * Batch-hydrates arbitrary type/method/field ids (e.g. resolvedCallees'
   * targetId values) into their declarations. A "type:<fqn>" owner resolves
   * via one batched exact-fqn queryTypes() call (QUALIFIED strategy matches
   * typeIdByFqn directly, so this cannot come back AMBIGUOUS); a
   * "type-local:<path>:.." owner's file is already embedded in the id. Both
   * paths converge on a single batched queryFiles() call, mirroring
   * typesToFacts()'s existing group-by-file-then-hydrate-once pattern.
   *
   * Bounded at both ends: more than MAX_DECLARATION_IDS_PER_CALL ids are never even
   * looked up (reported via `truncated`, not silently accepted), and if the
   * looked-up ids still resolve to more than MAX_DECLARATION_PATHS distinct
   * files, only the first MAX_DECLARATION_PATHS (by id order) are fetched -
   * ids whose file got excluded that way land in `missingIds`, same as a
   * genuinely-absent id, since which specific ids that affects depends on an
   * arbitrary file-count cutoff, not on anything meaningful about those ids.
   */
  async declarationsById(ids: readonly string[]): Promise<FrameworkDeclarations> {
    await this.ensureOpened(this.generation);
    const uniqueIds = unique([...ids]);
    const boundedIds = uniqueIds.slice(0, MAX_DECLARATION_IDS_PER_CALL);
    const relativePaths = new Set<string>();
    const fqnsNeedingLookup = new Set<string>();
    for (const id of boundedIds) {
      const ownerTypeId = ownerTypeIdOf(id);
      if (!ownerTypeId) continue;
      const localPath = relativePathOfLocalTypeId(ownerTypeId);
      if (localPath) {
        relativePaths.add(localPath);
        continue;
      }
      const fqn = fqnOfTypeId(ownerTypeId);
      if (fqn) fqnsNeedingLookup.add(fqn);
    }
    if (fqnsNeedingLookup.size > 0) {
      const fqnLookups = [...fqnsNeedingLookup];
      const lookups = await this.queryTypes(fqnLookups.map(typeText => ({ typeText })));
      for (const lookup of lookups) {
        if (lookup.state === "RESOLVED") relativePaths.add(relativePathOfFileId(lookup.type.fileId));
      }
      // A request may foreground-refresh its mapper/anchor while the initial
      // background reconcile has not reached a dependent module yet. The
      // mapper's import is then visible but its exact FQN declaration is not
      // in the store. Try only the normal top-level Java path under already
      // discovered source roots, refresh files that actually exist, then
      // repeat the exact lookup once. This is deliberately not a name scan
      // and never guesses an arbitrary binding.
      const unresolvedFqns = fqnLookups.filter((_, index) => lookups[index]?.state !== "RESOLVED");
      if (unresolvedFqns.length > 0 && summarizeCoverage(this.client.localStatus()) !== "complete") {
        const candidates = this.conventionalDeclarationCandidates(unresolvedFqns);
        if (candidates.length > 0) {
          await this.ensureFresh(candidates, this.generation);
          const retries = await this.queryTypes(unresolvedFqns.map(typeText => ({ typeText })));
          for (const lookup of retries) {
            if (lookup.state === "RESOLVED") relativePaths.add(relativePathOfFileId(lookup.type.fileId));
          }
        }
      }
    }
    const boundedPaths = [...relativePaths].slice(0, MAX_DECLARATION_PATHS);
    const absolutePaths = boundedPaths.map(relative => path.resolve(this.repoRoot, relative));
    const bundles = absolutePaths.length > 0
      ? await this.queryFiles(absolutePaths)
      : [];
    const result = bundlesToRequestedDeclarations(bundles, boundedIds);
    return {
      ...result,
      missingIds: [...result.missingIds, ...uniqueIds.slice(MAX_DECLARATION_IDS_PER_CALL)],
      truncated: uniqueIds.length > MAX_DECLARATION_IDS_PER_CALL
    };
  }

  /**
   * Requests one more than `limit` so truncation is an exact fact, not a
   * `length === limit` guess - a caller relying on "exactly one resolved
   * call target" (Slice D's SPRING_CALL_PATH rule) must know for certain
   * whether a second callee might exist beyond index-store.ts's own cap.
   */
  async resolvedCallees(methodId: string, limit = CALLEES_LIMIT_DEFAULT): Promise<FrameworkCallees> {
    return (await this.resolvedCalleesFor([methodId], limit)).get(methodId) ?? { callees: [], truncated: false };
  }

  async resolvedCalleesFor(methodIds: readonly string[], limit = CALLEES_LIMIT_DEFAULT): Promise<Map<string, FrameworkCallees>> {
    await this.ensureOpened(this.generation);
    const boundedLimit = Math.max(1, Math.min(CALLEES_LIMIT_DEFAULT, Math.floor(limit)));
    const boundedMethodIds = unique([...methodIds]).slice(0, MAX_FRAMEWORK_CALLEE_METHODS);
    const raw = await this.client.queryCalleesBatch(
      boundedMethodIds,
      boundedLimit + 1,
      this.currentRequestOptions()
    );
    const result = new Map<string, FrameworkCallees>();
    for (const entry of raw) {
      result.set(entry.methodId, {
        callees: entry.callees.slice(0, boundedLimit),
        truncated: entry.callees.length > boundedLimit
      });
    }
    return result;
  }

  /**
   * Small, direct filesystem reads of caller-specified files - no worker
   * round-trip, no directory scan, so an inactive/no-framework repo's cost
   * here is exactly the handful of reads the caller chooses to make (e.g.
   * a Spring pack checking pom.xml/build.gradle for a dependency string).
   */
  async repositoryMarkers(relativePaths: readonly string[]): Promise<Map<string, string>> {
    const requestOptions = this.currentRequestOptions();
    requestOptions.budget?.throwIfExpired("java-index.repository-markers");
    const result = new Map<string, string>();
    for (const relativePath of relativePaths) {
      requestOptions.budget?.throwIfExpired("java-index.repository-markers");
      const cached = this.repositoryMarkerCache.get(relativePath);
      if (cached !== undefined) {
        if (cached !== null) result.set(relativePath, cached);
        continue;
      }
      try {
        const readOperation = readFile(path.resolve(this.repoRoot, relativePath), "utf8");
        const content = requestOptions.budget
          ? await requestOptions.budget.race("java-index.repository-markers", readOperation)
          : await readOperation;
        const bounded = content.length > REPOSITORY_MARKER_MAX_BYTES ? content.slice(0, REPOSITORY_MARKER_MAX_BYTES) : content;
        this.repositoryMarkerCache.set(relativePath, bounded);
        result.set(relativePath, bounded);
      } catch (error) {
        if (error instanceof JavaIntelligenceError) throw error;
        this.repositoryMarkerCache.set(relativePath, null);
      }
    }
    return result;
  }

  async repositoryFactMarkers(input: { importPrefixes: readonly string[]; annotationPrefixes: readonly string[] }): Promise<FrameworkRepositoryFactMarkers> {
    await this.ensureOpened(this.generation);
    const importPrefixes = unique([...input.importPrefixes]).slice(0, 16);
    const annotationPrefixes = unique([...input.annotationPrefixes]).slice(0, 16);
    const key = `${importPrefixes.join("\u0000")}|${annotationPrefixes.join("\u0000")}`;
    const cached = this.repositoryFactMarkerCache.get(key);
    if (cached?.generation === this.generation) return cached.markers;
    const markers = await this.client.queryRepositoryFactMarkers(
      importPrefixes,
      annotationPrefixes,
      this.currentRequestOptions()
    );
    this.repositoryFactMarkerCache.set(key, { generation: this.generation, markers });
    return markers;
  }

  async methodsWithParameterTypes(typeFqns: readonly string[], limit = 32): Promise<FrameworkMethodDeclaration[]> {
    await this.ensureOpened(this.generation);
    const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit)));
    const lookups = await this.queryTypes(
      unique([...typeFqns]).slice(0, boundedLimit).map(typeText => ({ typeText }))
    );
    const typeIds = lookups.filter((lookup): lookup is Extract<typeof lookup, { state: "RESOLVED" }> => lookup.state === "RESOLVED")
      .map(lookup => lookup.type.typeId);
    const methodIds = await this.client.queryMethodsWithParameterTypes(
      typeIds,
      boundedLimit,
      this.currentRequestOptions()
    );
    return (await this.declarationsById(methodIds)).methods;
  }

  async myBatisResourcesByNamespaces(namespaces: readonly string[]): Promise<Map<string, MyBatisMapperResourceFacts>> {
    await this.ensureOpened(this.generation);
    const boundedNamespaces = unique([...namespaces]).slice(0, MAX_FRAMEWORK_MYBATIS_NAMESPACES);
    const raw = await this.client.queryMyBatisResourcesByNamespace(
      boundedNamespaces,
      this.currentRequestOptions()
    );
    const result = new Map<string, MyBatisMapperResourceFacts>();
    for (const entry of raw) {
      if (entry.resource) result.set(entry.namespace, entry.resource);
    }
    return result;
  }

  async frameworkStatus(): Promise<FrameworkIndexStatus> {
    const routerStatus = await this.routerStatus();
    return { coverage: routerStatus.coverage };
  }

  /**
   * A reconciled/snapshot-restored COMPLETE root already contains facts at
   * this generation.  Re-reading it is safe; reparsing every candidate during
   * rank finalization is not.  Dirty/change batches advance coverage or call
   * refresh before a request observes their generation, so this never masks a
   * known mutation.
   */
  private hasCompleteCoverageAt(absolutePath: string, generation: number): boolean {
    const status = this.client.localStatus();
    if (status.indexedGeneration < generation) {
      return false;
    }
    const relativePath = path.relative(this.repoRoot, absolutePath).replace(/\\/g, "/");
    return status.coverage.some(root =>
      root.state === "COMPLETE"
      && root.generation >= generation
      && (relativePath === root.root || relativePath.startsWith(`${root.root}/`))
    );
  }

  private currentGenerationHighWater(): number {
    return Math.max(this.generation, this.client.localStatus().indexedGeneration);
  }

  private isStaleGeneration(generation: number): boolean {
    return generation < this.currentGenerationHighWater();
  }

  private effectiveGeneration(generation: number): number {
    // Generation zero is the documented benchmark/legacy compatibility mode:
    // consume the current worker generation instead of pretending an old
    // snapshot is a stale request that must mutate global state backwards.
    return generation === 0 ? this.currentGenerationHighWater() : generation;
  }

  private conventionalDeclarationCandidates(fqns: readonly string[]): string[] {
    const candidates: string[] = [];
    let pathChecks = 0;
    for (const fqn of fqns.slice(0, MAX_COLD_DECLARATION_FQN_RETRIES)) {
      const topLevelFqn = fqn.split("$")[0] ?? "";
      const segments = topLevelFqn.split(".");
      if (segments.length === 0 || segments.some(segment => !/^[A-Za-z_$][\w$]*$/.test(segment))) {
        continue;
      }
      const suffix = `${segments.join(path.sep)}.java`;
      for (const sourceRoot of this.conventionalDeclarationRoots) {
        if (pathChecks >= MAX_COLD_DECLARATION_PATH_CHECKS) {
          return candidates;
        }
        pathChecks += 1;
        const absolutePath = path.join(this.repoRoot, sourceRoot, suffix);
        if (existsSync(absolutePath)) candidates.push(absolutePath);
      }
    }
    return unique(candidates);
  }
}

function degradedFrameworkFacts(repoRoot: string, absolutePath: string): FrameworkFileFacts {
  return {
    types: [],
    methods: [],
    fields: [],
    missingIds: [],
    truncated: false,
    relativePath: path.relative(repoRoot, absolutePath).replace(/\\/g, "/"),
    module: "",
    sourceSet: "unknown",
    packageName: "",
    imports: [],
    coverage: "DEGRADED"
  };
}

function queryMemoKey(operation: string, generation: number, input: unknown): string {
  return `${operation}:${generation}:${JSON.stringify(input)}`;
}

function queryFailure(error: unknown): {
  reason: "DEADLINE_EXCEEDED" | "CANCELLED" | "QUERY_FAILED";
  detail: string;
} {
  if (error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED") {
    return { reason: "DEADLINE_EXCEEDED", detail: error.code };
  }
  if (error instanceof JavaIntelligenceError && error.code === "CANCELLED") {
    return { reason: "CANCELLED", detail: error.code };
  }
  return {
    reason: "QUERY_FAILED",
    detail: error instanceof JavaIntelligenceError ? error.code : "QUERY_FAILED"
  };
}

function staleGenerationError(requested: number, current: number): JavaIntelligenceError {
  return new JavaIntelligenceError(
    "INDEX_PARTIAL",
    `Java index request generation ${requested} is older than the current generation ${current}`
  );
}

function generationMismatchItem(absolutePath: string): FactsForFileItem {
  return {
    inputFile: absolutePath,
    absolutePath,
    state: "DEGRADED",
    reason: "GENERATION_MISMATCH"
  };
}

function incompleteItem(absolutePath: string): FactsForFileItem {
  return {
    inputFile: absolutePath,
    absolutePath,
    state: "DEGRADED",
    reason: "INDEX_INCOMPLETE"
  };
}

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function addType(type: JavaTypeFacts, found: JavaTypeFacts[], foundFiles: Set<string>): void {
  const relativePath = relativePathOfFileId(type.fileId);
  if (foundFiles.has(relativePath)) {
    return;
  }
  foundFiles.add(relativePath);
  found.push(type);
}
