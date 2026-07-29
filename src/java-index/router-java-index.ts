// input: JavaIndexClient plus router lookup patterns (type name, file, method line).
// output: Async JavaIndex facts for AgentRouter collectors and scoring.
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
  typeLookupIndexHits: number;
  typeLookupIndexMisses: number;
  javaIndex: JavaIndexStatus;
  openSource: JavaIndexOpenSource;
  coverage: "complete" | "partial" | "degraded";
};

/** Router-facing fact surface backed exclusively by JavaIndex V2. */
export interface RouterIndex {
  ensureFresh(files: string[], generation: number): Promise<void>;
  queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
  factsFor(inputFile: string, generation?: number): Promise<JavaSourceFacts>;
  methodAt(inputFile: string, line: number, generation?: number): Promise<JavaMethodFact | undefined>;
  findImplementers(typeName: string, limit?: number, scopeFile?: string): Promise<JavaSourceFacts[]>;
  findTypeReferences(typeName: string, limit?: number): Promise<JavaSourceFacts[]>;
  findImporters(typeName: string, limit?: number): Promise<JavaSourceFacts[]>;
  findTypeDefinitions(typeNames: readonly string[], limit?: number, hydrate?: boolean): Promise<JavaSourceFacts[]>;
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
  /** Files known to have completed a foreground refresh at a repo generation. */
  private readonly freshGenerationByPath = new Map<string, number>();
  /** Router facts are immutable for one generation; retain them across ranking phases. */
  private readonly factsByPath = new Map<string, { generation: number; facts: JavaSourceFacts }>();

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
    const status = await this.client.refresh(generation, staleFiles, []);
    for (const file of staleFiles) this.freshGenerationByPath.set(file, generation);
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

  async queryTypes(queries: Array<{ typeText: string; scopeFile?: string }>) {
    await this.ensureOpened(this.generation);
    return this.client.queryTypes(queries);
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
    const status = await this.client.refresh(generation, changed, deleted);
    for (const file of changed) {
      const absolute = normalizeRepoFile(this.repoRoot, file);
      this.freshGenerationByPath.set(absolute, generation);
      this.factsByPath.delete(absolute);
    }
    for (const file of deleted) {
      const absolute = normalizeRepoFile(this.repoRoot, file);
      this.freshGenerationByPath.delete(absolute);
      this.factsByPath.delete(absolute);
    }
    this.generation = Math.max(generation, status.indexedGeneration);
    return status;
  }

  async reconcile(generation: number): Promise<JavaIndexStatus> {
    await this.ensureOpened(generation);
    const status = await this.client.reconcile(generation);
    this.freshGenerationByPath.clear();
    this.factsByPath.clear();
    this.generation = Math.max(generation, status.indexedGeneration);
    return status;
  }

  async close(): Promise<void> {
    await this.client.close();
    this.opened = false;
    this.freshGenerationByPath.clear();
    this.factsByPath.clear();
  }

  async factsFor(inputFile: string, generation = this.generation): Promise<JavaSourceFacts> {
    const absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Java source file does not exist: ${inputFile}`);
    }
    const cached = this.factsByPath.get(absolutePath);
    if (cached?.generation === generation) {
      this.factsHits += 1;
      return cached.facts;
    }
    await this.ensureFresh([absolutePath], generation);
    const bundles = await this.client.queryFiles([absolutePath]);
    const bundle = bundles[0];
    if (!bundle) {
      this.factsMisses += 1;
      const facts = fallbackSourceFacts(this.repoRoot, absolutePath);
      this.factsByPath.set(absolutePath, { generation, facts });
      return facts;
    }
    this.factsHits += 1;
    const facts = bundleToSourceFacts(this.repoRoot, bundle);
    this.factsByPath.set(absolutePath, { generation, facts });
    return facts;
  }

  async methodAt(inputFile: string, line: number, generation = this.generation): Promise<JavaMethodFact | undefined> {
    const facts = await this.factsFor(inputFile, generation);
    return [...facts.methods]
      .filter(method => method.line <= line && line <= method.endLine)
      .sort((left, right) => right.line - left.line)[0]
      || [...facts.methods].filter(method => method.line <= line).sort((left, right) => right.line - left.line)[0];
  }

  async findImplementers(typeName: string, limit = 20, scopeFile?: string): Promise<JavaSourceFacts[]> {
    const typeId = await this.resolveTypeId(typeName, scopeFile);
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

  async findTypeDefinitions(typeNames: readonly string[], limit = 40, hydrate = true): Promise<JavaSourceFacts[]> {
    const names = unique(typeNames.map(value => value.replace(/<.*>/, "").trim()).filter(Boolean)).slice(0, 64);
    // A request commonly has a method signature plus a handful of imports.
    // Resolve those independent lookups together and hydrate their owning
    // files once.  The former one-type-at-a-time pattern paid a worker IPC
    // round-trip for every definition and then another for every file bundle.
    const lookupResults = await this.client.queryTypes(names.map(typeText => ({ typeText })));
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
    const bundles = absolutePaths.length > 0 ? await this.client.queryFiles(absolutePaths) : [];
    const bundleByRelative = new Map(bundles.map(bundle => [bundle.file.relativePath, bundle]));
    const facts: JavaSourceFacts[] = [];
    for (const [relativePath, type] of byPath) {
      const bundle = bundleByRelative.get(relativePath);
      if (bundle) {
        // Definition lookup already paid to transfer the complete bundle.
        // Retain the ordinary file facts as well as returning the
        // type-specific projection, so final ranking does not immediately
        // issue the same QUERY_FILES request again.
        const fullFacts = bundleToSourceFacts(this.repoRoot, bundle);
        this.factsByPath.set(fullFacts.absolutePath, { generation: this.generation, facts: fullFacts });
      }
      facts.push(typeFactsToSourceFacts(this.repoRoot, type, bundle));
    }
    return preserveInputOrder
      ? facts
      : facts.sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  }

  private async referencesToFacts(refs: readonly IndexedReference[], limit: number): Promise<JavaSourceFacts[]> {
    const relativePaths = unique(refs.map(ref => ref.sourceFile)).slice(0, limit * 2);
    if (relativePaths.length === 0) return [];
    const absolutePaths = relativePaths.map(relative => path.resolve(this.repoRoot, relative));
    const bundles = await this.client.queryFiles(absolutePaths);
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
