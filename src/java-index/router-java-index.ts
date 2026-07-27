// input: JavaIndexClient plus router lookup patterns (type name, file, method line).
// output: Async SourceIndex-compatible facts for AgentRouter collectors and scoring.
// pos: Task 22 cutover facade between V2 worker queries and router call sites.
import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeRepoFile, repoCacheRoot } from "../repo-layout.js";
import { JavaIndexClient, type JavaIndexOpenOptions } from "./java-index-client.js";
import type {
  AnchorFacts,
  IndexedReference,
  JavaIndexStatus,
  JavaTypeFacts,
  StaticEdgeKind
} from "./index-types.js";
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
  typeFactsToSourceFacts,
  type JavaMethodFact,
  type JavaSourceFacts
} from "./router-facts.js";

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
  regexFacts: number;
  documentSymbolFacts: number;
  snapshotAgeMs?: number;
  dirtyCount: number;
  warmIndexPending: number;
  warmIndexFailed: number;
  scanCacheHits: number;
  scanCacheMisses: number;
  scanCacheMissElapsedMs: number;
  scanCacheEntries: number;
  typeLookupIndexHits: number;
  typeLookupIndexMisses: number;
  typeLookupIndexEntries: number;
  javaIndex: JavaIndexStatus;
  openSource: JavaIndexOpenSource;
  coverage: "complete" | "partial" | "degraded";
};

/**
 * Router-facing fact surface shared by both index backends (Step 7 of Task
 * 22 keeps V1 and V2 wired side by side behind JAVA_LSP_INDEX_BACKEND until
 * the benchmark gate passes). `RouterJavaIndex` implements this directly;
 * `wrapSourceIndex` (source-index-router-adapter.ts) adapts V1's sync
 * `SourceIndex` to it.
 */
export interface RouterIndex {
  ensureFresh(files: string[], generation: number): Promise<void>;
  queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
  factsFor(inputFile: string, generation?: number): Promise<JavaSourceFacts>;
  methodAt(inputFile: string, line: number, generation?: number): Promise<JavaMethodFact | undefined>;
  /**
   * `scan` mirrors V1 SourceIndex's cheap-cache-only default vs. an explicit
   * repo-wide rg scan: callers that already asked V1 for a full scan (the
   * type-reference implementer lookups) must keep asking for one, since a
   * silently cheaper default would under-find candidates relative to V1's
   * pre-migration behavior. V2 ignores it - its index has no such tier.
   */
  findImplementers(typeName: string, limit?: number, scan?: boolean): Promise<JavaSourceFacts[]>;
  findTypeReferences(typeName: string, limit?: number): Promise<JavaSourceFacts[]>;
  findImporters(typeName: string, limit?: number): Promise<JavaSourceFacts[]>;
  findTypeDefinitions(typeNames: readonly string[], limit?: number): Promise<JavaSourceFacts[]>;
  routerStatus(): Promise<RouterIndexStatus>;
}

/**
 * High-level async index used by AgentRouter. Wraps JavaIndexClient and maps
 * V2 queries into the fact shapes collectors already understand.
 */
export class RouterJavaIndex implements JavaIndexView, RouterIndex {
  private generation = 0;
  private opened = false;
  private openSource: JavaIndexOpenSource = "cold";
  private typeLookupHits = 0;
  private typeLookupMisses = 0;
  private factsHits = 0;
  private factsMisses = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly client: JavaIndexClient,
    private readonly openOptions: JavaIndexOpenOptions = {}
  ) {}

  static create(repoRoot: string, cacheDir = repoCacheRoot(repoRoot), openOptions: JavaIndexOpenOptions = {}): RouterJavaIndex {
    return new RouterJavaIndex(repoRoot, new JavaIndexClient(repoRoot, cacheDir), openOptions);
  }

  rawClient(): JavaIndexClient {
    return this.client;
  }

  async open(generation: number, options: JavaIndexOpenOptions = {}): Promise<JavaIndexStatus> {
    const status = await this.client.open(generation, { ...this.openOptions, ...options });
    this.generation = Math.max(generation, status.indexedGeneration);
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
    );
    if (absoluteFiles.length === 0) {
      this.generation = Math.max(this.generation, generation);
      return;
    }
    const status = await this.client.refresh(generation, absoluteFiles, []);
    this.generation = Math.max(generation, status.indexedGeneration);
  }

  async queryAnchor(file: string, line: number, column: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryAnchor(file, line, column);
  }

  async queryType(typeText: string, scopeFile?: string) {
    await this.ensureOpened(this.generation);
    return this.client.queryType(typeText, scopeFile);
  }

  async queryImplementers(typeId: string, limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryImplementers(typeId, limit);
  }

  async queryTypeReferencers(typeId: string, kinds: StaticEdgeKind[], limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryTypeReferencers(typeId, kinds, limit);
  }

  async queryCallers(methodId: string, limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryCallers(methodId, limit);
  }

  async queryCallees(methodId: string, limit: number) {
    await this.ensureOpened(this.generation);
    return this.client.queryCallees(methodId, limit);
  }

  async queryFiles(files: string[]) {
    await this.ensureOpened(this.generation);
    return this.client.queryFiles(files);
  }

  async status(): Promise<JavaIndexStatus> {
    await this.ensureOpened(this.generation);
    const status = await this.client.status();
    if (this.openSource === "cold" && status.files > 0) {
      this.openSource = openSourceFromStatus(status);
    }
    return status;
  }

  async routerStatus(): Promise<RouterIndexStatus> {
    const javaIndex = await this.status().catch(() => this.client.localStatus());
    return {
      entries: javaIndex.files,
      hits: this.factsHits,
      misses: this.factsMisses,
      regexFacts: 0,
      documentSymbolFacts: javaIndex.files,
      dirtyCount: javaIndex.pendingForeground + javaIndex.pendingBackground,
      warmIndexPending: javaIndex.pendingBackground,
      warmIndexFailed: 0,
      scanCacheHits: 0,
      scanCacheMisses: 0,
      scanCacheMissElapsedMs: 0,
      scanCacheEntries: 0,
      typeLookupIndexHits: this.typeLookupHits,
      typeLookupIndexMisses: this.typeLookupMisses,
      typeLookupIndexEntries: javaIndex.types,
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
    const status = await this.client.refresh(generation, changed, deleted);
    this.generation = Math.max(generation, status.indexedGeneration);
    return status;
  }

  async reconcile(generation: number): Promise<JavaIndexStatus> {
    await this.ensureOpened(generation);
    const status = await this.client.reconcile(generation);
    this.generation = Math.max(generation, status.indexedGeneration);
    return status;
  }

  async close(): Promise<void> {
    await this.client.close();
    this.opened = false;
  }

  async factsFor(inputFile: string, generation = this.generation): Promise<JavaSourceFacts> {
    const absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Java source file does not exist: ${inputFile}`);
    }
    await this.ensureFresh([absolutePath], generation);
    const bundles = await this.client.queryFiles([absolutePath]);
    const bundle = bundles[0];
    if (!bundle) {
      this.factsMisses += 1;
      return fallbackSourceFacts(this.repoRoot, absolutePath);
    }
    this.factsHits += 1;
    return bundleToSourceFacts(this.repoRoot, bundle);
  }

  async methodAt(inputFile: string, line: number, generation = this.generation): Promise<JavaMethodFact | undefined> {
    const facts = await this.factsFor(inputFile, generation);
    return [...facts.methods]
      .filter(method => method.line <= line && line <= method.endLine)
      .sort((left, right) => right.line - left.line)[0]
      || [...facts.methods].filter(method => method.line <= line).sort((left, right) => right.line - left.line)[0];
  }

  async findImplementers(typeName: string, limit = 20, _scan?: boolean): Promise<JavaSourceFacts[]> {
    const typeId = await this.resolveTypeId(typeName);
    if (!typeId) {
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const implementers = await this.client.queryImplementers(typeId, limit);
    return this.typesToFacts(implementers);
  }

  async findTypeReferences(typeName: string, limit = 20): Promise<JavaSourceFacts[]> {
    const typeId = await this.resolveTypeId(typeName);
    if (!typeId) {
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const refs = await this.client.queryTypeReferencers(typeId, TYPE_REFERENCE_EDGE_KINDS, limit * 4);
    return this.referencesToFacts(refs, limit);
  }

  async findImporters(typeName: string, limit = 20): Promise<JavaSourceFacts[]> {
    const typeId = await this.resolveTypeId(typeName);
    if (!typeId) {
      // IMPORTS edges target external: nodes for unresolved FQNs; try file-level
      // lookup via simple name definitions when the type is not yet indexed.
      this.typeLookupMisses += 1;
      return [];
    }
    this.typeLookupHits += 1;
    const refs = await this.client.queryTypeReferencers(typeId, IMPORT_EDGE_KINDS, limit * 2);
    return this.referencesToFacts(refs, limit);
  }

  async findTypeDefinitions(typeNames: readonly string[], limit = 40): Promise<JavaSourceFacts[]> {
    const found = new Map<string, JavaSourceFacts>();
    for (const typeName of unique(typeNames.map(value => value.replace(/<.*>/, "").trim()).filter(Boolean)).slice(0, 64)) {
      const lookup = await this.client.queryType(typeName);
      if (lookup.state === "RESOLVED") {
        this.typeLookupHits += 1;
        const facts = (await this.typesToFacts([lookup.type]))[0];
        if (facts) found.set(facts.absolutePath, facts);
        continue;
      }
      if (lookup.state === "AMBIGUOUS") {
        this.typeLookupHits += 1;
        for (const type of lookup.candidates.slice(0, 4)) {
          const facts = (await this.typesToFacts([type]))[0];
          if (facts) found.set(facts.absolutePath, facts);
        }
        continue;
      }
      this.typeLookupMisses += 1;
    }
    return [...found.values()]
      .sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath))
      .slice(0, limit);
  }

  private async resolveTypeId(typeName: string, scopeFile?: string): Promise<string | undefined> {
    const simple = typeName.slice(typeName.lastIndexOf(".") + 1);
    const lookup = await this.client.queryType(typeName, scopeFile);
    if (lookup.state === "RESOLVED") return lookup.type.typeId;
    if (lookup.state === "AMBIGUOUS" && lookup.candidates.length > 0) {
      // Prefer an exact simple-name match; otherwise first candidate.
      return lookup.candidates.find(type => type.simpleName === simple)?.typeId
        || lookup.candidates[0]?.typeId;
    }
    if (simple !== typeName) {
      const simpleLookup = await this.client.queryType(simple, scopeFile);
      if (simpleLookup.state === "RESOLVED") return simpleLookup.type.typeId;
      if (simpleLookup.state === "AMBIGUOUS") return simpleLookup.candidates[0]?.typeId;
    }
    return undefined;
  }

  private async typesToFacts(types: readonly JavaTypeFacts[]): Promise<JavaSourceFacts[]> {
    const byPath = new Map<string, JavaTypeFacts>();
    for (const type of types) {
      const relativePath = relativePathOfFileId(type.fileId);
      if (!byPath.has(relativePath)) byPath.set(relativePath, type);
    }
    const absolutePaths = [...byPath.keys()].map(relative => path.resolve(this.repoRoot, relative));
    const bundles = absolutePaths.length > 0 ? await this.client.queryFiles(absolutePaths) : [];
    const bundleByRelative = new Map(bundles.map(bundle => [bundle.file.relativePath, bundle]));
    const facts: JavaSourceFacts[] = [];
    for (const [relativePath, type] of byPath) {
      const bundle = bundleByRelative.get(relativePath);
      facts.push(typeFactsToSourceFacts(this.repoRoot, type, bundle));
    }
    return facts.sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  }

  private async referencesToFacts(refs: readonly IndexedReference[], limit: number): Promise<JavaSourceFacts[]> {
    const relativePaths = unique(refs.map(ref => ref.sourceFile)).slice(0, limit * 2);
    if (relativePaths.length === 0) return [];
    const absolutePaths = relativePaths.map(relative => path.resolve(this.repoRoot, relative));
    const bundles = await this.client.queryFiles(absolutePaths);
    return bundles
      .map(bundle => bundleToSourceFacts(this.repoRoot, bundle))
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
      const status = await this.client.open(generation, this.openOptions);
      this.opened = true;
      this.generation = Math.max(generation, status.indexedGeneration);
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
}

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}


