import { javaEdgeId, javaFieldId, javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";
import { JavaNameResolver, type JavaResolutionContext, type TypeRegistryView } from "./name-resolver.js";
import { myBatisQualifiedId, type MyBatisMapperResourceFacts } from "./mybatis-types.js";
import { EdgeColumns } from "./columnar/edge-columns.js";
import { FileColumns, FileIdMap } from "./columnar/file-columns.js";
import { MethodColumns } from "./columnar/method-columns.js";
import { internField, internFile, internFileBundle, internMethod, internType } from "./columnar/facts-view.js";
import type { SharedFactsPool } from "./shared-facts-pool.js";
import type {
  AnchorFacts,
  IndexedReference,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeLookupResult,
  SourcePosition,
  SourceRange,
  StaticEdge,
  StaticEdgeKind
} from "./index-types.js";

function addToSetMap<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

function removeFromSetMap<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const bucket = map.get(key);
  if (!bucket) return;
  bucket.delete(value);
  if (bucket.size === 0) map.delete(key);
}

function rangeContains(range: SourceRange, position: SourcePosition): boolean {
  const afterStart = position.line > range.start.line
    || (position.line === range.start.line && position.column >= range.start.column);
  const beforeEnd = position.line < range.end.line
    || (position.line === range.end.line && position.column <= range.end.column);
  return afterStart && beforeEnd;
}

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function compareByLocation(fileIdA: string, rangeA: SourceRange, idA: string, fileIdB: string, rangeB: SourceRange, idB: string): number {
  const pathA = relativePathOfFileId(fileIdA);
  const pathB = relativePathOfFileId(fileIdB);
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  if (rangeA.start.line !== rangeB.start.line) return rangeA.start.line - rangeB.start.line;
  if (rangeA.start.column !== rangeB.start.column) return rangeA.start.column - rangeB.start.column;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function compareTypes(a: JavaTypeFacts, b: JavaTypeFacts): number {
  return compareByLocation(a.fileId, a.range, a.typeId, b.fileId, b.range, b.typeId);
}

function compareReferences(a: IndexedReference, b: IndexedReference): number {
  const fileIdA = javaFileId(a.sourceFile);
  const fileIdB = javaFileId(b.sourceFile);
  const rangeA = a.range ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  const rangeB = b.range ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  return compareByLocation(fileIdA, rangeA, a.sourceId, fileIdB, rangeB, b.sourceId);
}

// Recomputes every id in a bundle against the Task 15 factories and rejects
// the whole bundle (leaving the store untouched) if anything doesn't match -
// e.g. an absolute-path-derived id, or a hand-built id that skipped
// normalizeStableRelativePath. Cheaper and more direct than trying to
// special-case "looks like an absolute path".
function validateBundleIds(bundle: JavaFileBundle): void {
  const relativePath = bundle.file.relativePath;
  const expectedFileId = javaFileId(relativePath);
  if (bundle.file.fileId !== expectedFileId) {
    throw new Error(
      `file ${relativePath} does not have a stable repo-relative id (expected ${expectedFileId}, got ${bundle.file.fileId})`
    );
  }
  for (const type of bundle.types) {
    const expectedTypeId = javaTypeId({ ...(type.fqn ? { fqn: type.fqn } : {}), relativePath, range: type.range });
    if (type.typeId !== expectedTypeId) {
      throw new Error(
        `type ${type.simpleName} in ${relativePath} does not have a stable repo-relative id (expected ${expectedTypeId}, got ${type.typeId})`
      );
    }
  }
  for (const field of bundle.fields) {
    const expectedFieldId = javaFieldId(field.ownerTypeId, field.name);
    if (field.fieldId !== expectedFieldId) {
      throw new Error(`field ${field.name} in ${relativePath} does not have a stable repo-relative id`);
    }
  }
  for (const method of bundle.methods) {
    const expectedMethodId = javaMethodId(method.ownerTypeId, method.signatureKey);
    if (method.methodId !== expectedMethodId) {
      throw new Error(`method ${method.name} in ${relativePath} does not have a stable repo-relative id`);
    }
  }
  for (const edge of bundle.edges) {
    const expectedEdgeId = javaEdgeId({
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      ...(edge.range ? { range: edge.range } : {})
    });
    if (edge.edgeId !== expectedEdgeId) {
      throw new Error(`edge ${edge.kind} in ${relativePath} does not have a stable repo-relative id`);
    }
  }
}

// Normalized in-memory Java fact/edge store: one entry per file/type/field/
// method/edge id, plus reverse indexes so every Step 4 query is a map
// lookup (bounded by result size), never a scan over every file or edge.
export class JavaIndexStore {
  constructor(private readonly factsPool?: SharedFactsPool) {}

  private readonly installedBundles = new Map<string, JavaFileBundle>();
  private readonly edgeColumns = new EdgeColumns();
  private readonly fileColumns = new FileColumns(this.edgeColumns.strings, this.edgeColumns.ranges);
  readonly filesByPath = new FileIdMap(this.fileColumns);
  readonly typesById = new Map<string, JavaTypeFacts>();
  readonly typeIdByFqn = new Map<string, string>();
  readonly typeIdsBySimpleName = new Map<string, Set<string>>();
  readonly fieldsById = new Map<string, JavaFieldFacts>();
  private readonly methodColumns = new MethodColumns(this.edgeColumns.strings, this.edgeColumns.ranges);
  private readonly overlayMethods = new Map<string, JavaMethodFacts>();
  private readonly overlayEdges = new Map<string, StaticEdge>();
  private readonly methodRedirects = new Map<string, DonorRedirect>();
  private readonly edgeRedirects = new Map<string, DonorRedirect>();
  readonly methodsById = new MethodIdMap(this.methodColumns, this.overlayMethods, this.methodRedirects);
  readonly methodIdsByOwnerAndName = new Map<string, Set<string>>();
  readonly edgesById = new EdgeIdMap(this.edgeColumns, this.overlayEdges, this.edgeRedirects);
  readonly outEdgeIdsByNode = new Map<string, Set<string>>();
  readonly inEdgeIdsByNode = new Map<string, Set<string>>();
  readonly fileOwnedNodeIds = new Map<string, Set<string>>();
  readonly fileOwnedEdgeIds = new Map<string, Set<string>>();
  // Reserved for Task 20's reverse-dependency re-resolution (a new type
  // turning a previously unique simple name into a collision): declared here
  // per the required store shape, but deliberately left unpopulated. Nothing
  // consumes it yet, and populating it correctly requires knowing, at
  // replaceFile time, whether a cross-file target has already been indexed -
  // information this store doesn't reliably have file-by-file. Task 20 owns
  // both populating and consuming it as part of the refresh pipeline it
  // already owns.
  readonly dependentFilesByTypeName = new Map<string, Set<string>>();

  // MyBatis mapper resource facts (Task 28 Slice B) - a second, independent
  // fact family alongside the Java one above. Deliberately not woven into
  // filesByPath/fileOwnedNodeIds: a mapper XML resource is not a Java file,
  // carries no static edges into the Java graph, and its own reuse/dirty
  // story (Slice C) is resource-path + resource-contentHash keyed, not
  // Java's node-id-based one.
  readonly myBatisResourcesByPath = new Map<string, MyBatisMapperResourceFacts>();
  // statementId is deterministic from (namespace, id) alone - two different
  // resource files can claim the exact same qualifiedId (a malformed repo),
  // so the owning relativePath (not the statement's own id) is what removal
  // must compare against to know whether it is still the current claimant.
  readonly myBatisStatementsByQualifiedId = new Map<string, { relativePath: string; statement: MyBatisMapperResourceFacts["statements"][number] }>();
  readonly myBatisResourcesByNamespace = new Map<string, Set<string>>();

  myBatisResource(relativePath: string): MyBatisMapperResourceFacts | undefined {
    return this.myBatisResourcesByPath.get(relativePath);
  }

  myBatisStatement(namespace: string, id: string): MyBatisMapperResourceFacts["statements"][number] | undefined {
    return this.myBatisStatementsByQualifiedId.get(myBatisQualifiedId(namespace, id))?.statement;
  }

  /** A namespace is exact only when one mapper resource claims it. */
  myBatisResourceForNamespace(namespace: string): MyBatisMapperResourceFacts | undefined {
    const paths = this.myBatisResourcesByNamespace.get(namespace);
    if (!paths || paths.size !== 1) return undefined;
    return this.myBatisResourcesByPath.get([...paths][0]!);
  }

  /** Replaces one mapper resource's facts, evicting its previous version's derived-index entries first (mirrors replaceFile/removeFileInternal's own evict-before-insert pattern). */
  replaceMyBatisResource(facts: MyBatisMapperResourceFacts): void {
    this.removeMyBatisResourceInternal(facts.relativePath);
    this.myBatisResourcesByPath.set(facts.relativePath, facts);
    for (const statement of facts.statements) {
      this.myBatisStatementsByQualifiedId.set(myBatisQualifiedId(facts.namespace, statement.id), { relativePath: facts.relativePath, statement });
    }
    if (facts.namespace) addToSetMap(this.myBatisResourcesByNamespace, facts.namespace, facts.relativePath);
  }

  removeMyBatisResources(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths) this.removeMyBatisResourceInternal(relativePath);
  }

  private removeMyBatisResourceInternal(relativePath: string): void {
    const existing = this.myBatisResourcesByPath.get(relativePath);
    if (!existing) return;
    this.myBatisResourcesByPath.delete(relativePath);
    for (const statement of existing.statements) {
      const qualifiedId = myBatisQualifiedId(existing.namespace, statement.id);
      // Only evict if this resource is still the current claimant - a
      // different resource may already have claimed the same (namespace,
      // id) pair (a malformed repo), and must not be evicted by this removal.
      if (this.myBatisStatementsByQualifiedId.get(qualifiedId)?.relativePath === relativePath) {
        this.myBatisStatementsByQualifiedId.delete(qualifiedId);
      }
    }
    if (existing.namespace) removeFromSetMap(this.myBatisResourcesByNamespace, existing.namespace, relativePath);
  }

  /**
   * Replaces one file's facts and returns surviving files whose static edges
   * pointed at a node owned by the previous version.  Callers must re-resolve
   * those files after the new declarations are installed; otherwise the
   * reverse lookup maps lose valid implementation/call edges during an
   * incremental refresh of their target.
   */
  replaceFile(bundle: JavaFileBundle): string[] {
    validateBundleIds(bundle);
    const relativePath = bundle.file.relativePath;
    const previous = this.installedBundles.get(relativePath);
    const installed = this.internOrShare(bundle, previous);
    const nextNodeIds = bundleNodeIds(installed);
    const retainedIncoming = new Map<string, Set<string>>();
    for (const nodeId of nextNodeIds) {
      const inbound = this.inEdgeIdsByNode.get(nodeId);
      if (inbound) retainedIncoming.set(nodeId, new Set(inbound));
    }
    const dependents = this.dependentFilesForOwnedNodes(relativePath, nextNodeIds);
    this.removeFileInternal(relativePath, false);

    this.fileColumns.add(installed.file);

    const ownedNodeIds = new Set<string>();
    for (const type of installed.types) {
      this.typesById.set(type.typeId, type);
      if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
      addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
      ownedNodeIds.add(type.typeId);
    }
    for (const field of installed.fields) {
      this.fieldsById.set(field.fieldId, field);
      ownedNodeIds.add(field.fieldId);
    }
    for (const method of installed.methods) {
      this.methodColumns.add(method);
      addToSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, method.methodId);
      ownedNodeIds.add(method.methodId);
    }
    this.fileOwnedNodeIds.set(relativePath, ownedNodeIds);
    for (const [nodeId, inbound] of retainedIncoming) {
      this.inEdgeIdsByNode.set(nodeId, inbound);
    }

    const ownedEdgeIds = new Set<string>();
    const strings = this.edgeColumns.strings;
    this.installedBundles.set(relativePath, installed);
    for (const edge of installed.edges) {
      const edgeId = strings.interned(edge.edgeId);
      this.edgeColumns.add(edge);
      addToSetMap(this.outEdgeIdsByNode, strings.interned(edge.fromId), edgeId);
      addToSetMap(this.inEdgeIdsByNode, strings.interned(edge.toId), edgeId);
      ownedEdgeIds.add(edgeId);
    }
    this.fileOwnedEdgeIds.set(relativePath, ownedEdgeIds);
    return dependents;
  }

  /**
   * Install a pooled bundle without copying methods/edges into this store's
   * SoA. Snapshot hydrate of a sibling root must not intern a second copy.
   */
  attachSharedBundle(bundle: JavaFileBundle): void {
    validateBundleIds(bundle);
    const relativePath = bundle.file.relativePath;
    const previous = this.installedBundles.get(relativePath);
    const installed = this.internOrShare(bundle, previous);
    this.removeFileInternal(relativePath, false);
    this.fileColumns.add(installed.file);
    const ownedNodeIds = new Set<string>();
    for (const type of installed.types) {
      this.typesById.set(type.typeId, type);
      if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
      addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
      ownedNodeIds.add(type.typeId);
    }
    for (const field of installed.fields) {
      this.fieldsById.set(field.fieldId, field);
      ownedNodeIds.add(field.fieldId);
    }
    for (const method of installed.methods) {
      this.overlayMethods.set(method.methodId, method);
      addToSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, method.methodId);
      ownedNodeIds.add(method.methodId);
    }
    this.fileOwnedNodeIds.set(relativePath, ownedNodeIds);
    this.installedBundles.set(relativePath, installed);
    const ownedEdgeIds = new Set<string>();
    for (const edge of installed.edges) {
      this.overlayEdges.set(edge.edgeId, edge);
      addToSetMap(this.outEdgeIdsByNode, edge.fromId, edge.edgeId);
      addToSetMap(this.inEdgeIdsByNode, edge.toId, edge.edgeId);
      ownedEdgeIds.add(edge.edgeId);
    }
    this.fileOwnedEdgeIds.set(relativePath, ownedEdgeIds);
  }

  /**
   * Point this store at a sibling's interned facts without copying SoA rows.
   * Methods/edges resolve through the donor until this root overlays a file.
   */
  attachFromDonorStore(donor: JavaIndexStore): number {
    let attached = 0;
    for (const file of donor.filesByPath.values()) {
      this.fileColumns.add(file);
      const nodes = new Set(donor.fileOwnedNodeIds.get(file.relativePath) ?? []);
      this.fileOwnedNodeIds.set(file.relativePath, nodes);
      for (const nodeId of nodes) {
        const type = donor.typesById.get(nodeId);
        if (type) {
          this.typesById.set(nodeId, type);
          if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
          addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
          continue;
        }
        const field = donor.fieldsById.get(nodeId);
        if (field) {
          this.fieldsById.set(nodeId, field);
          continue;
        }
        this.methodRedirects.set(nodeId, {
          donor,
          relativePath: file.relativePath,
          contentHash: file.contentHash
        });
      }
      const edgeIds = new Set(donor.fileOwnedEdgeIds.get(file.relativePath) ?? []);
      this.fileOwnedEdgeIds.set(file.relativePath, edgeIds);
      for (const edgeId of edgeIds) {
        this.edgeRedirects.set(edgeId, {
          donor,
          relativePath: file.relativePath,
          contentHash: file.contentHash
        });
      }
      attached += 1;
    }
    for (const [key, ids] of donor.methodIdsByOwnerAndName) {
      this.methodIdsByOwnerAndName.set(key, new Set(ids));
    }
    for (const [nodeId, ids] of donor.outEdgeIdsByNode) {
      this.outEdgeIdsByNode.set(nodeId, new Set(ids));
    }
    for (const [nodeId, ids] of donor.inEdgeIdsByNode) {
      this.inEdgeIdsByNode.set(nodeId, new Set(ids));
    }
    return attached;
  }

  /** After snapshot ingest, register reconstructed bundles so siblings can attach. */
  publishHydratedToPool(): void {
    if (!this.factsPool) return;
    for (const file of this.filesByPath.values()) {
      if (this.installedBundles.has(file.relativePath)) continue;
      const [bundle] = this.files([file.relativePath]);
      if (!bundle) continue;
      this.installedBundles.set(file.relativePath, this.internOrShare(bundle, undefined));
    }
  }

  // Returns the relative paths of files with an edge into a node this
  // removal deletes - the caller (worker) decides whether/how to re-resolve
  // them. Does not touch those files' own facts or edges.
  removeFiles(relativePaths: readonly string[]): string[] {
    const dependents = new Set<string>();
    for (const relativePath of relativePaths) {
      for (const dependent of this.dependentFilesForOwnedNodes(relativePath)) dependents.add(dependent);
      this.removeFileInternal(relativePath);
    }
    return [...dependents];
  }

  /**
   * Drops only the edges a file owns (`sourceFile === relativePath`),
   * leaving that file's own type/field/method facts untouched - unlike
   * `removeFiles`, which deletes a file's facts entirely. Used by
   * sibling-worktree seeding (Task 21a) for a RELINK_ONLY file: its own
   * declarations are still valid (their target-side content matched), but a
   * resolved edge into a *different*, non-reused file's now-removed type
   * must never survive into the seeded (unresolved-pending-relink) store.
   * The seeder itself never re-resolves; that is left to whatever consumes
   * `relinkPaths` next. Returns how many edges were dropped.
   */
  dropOwnedEdges(relativePaths: readonly string[]): number {
    let dropped = 0;
    for (const relativePath of relativePaths) {
      if (!this.filesByPath.has(relativePath)) continue; // never resurrect bookkeeping for a file this store doesn't have
      for (const edgeId of this.fileOwnedEdgeIds.get(relativePath) ?? []) {
        const edge = this.edgeColumns.remove(edgeId);
        if (!edge) continue;
        removeFromSetMap(this.outEdgeIdsByNode, edge.fromId, edgeId);
        removeFromSetMap(this.inEdgeIdsByNode, edge.toId, edgeId);
        dropped += 1;
      }
      this.fileOwnedEdgeIds.set(relativePath, new Set());
    }
    return dropped;
  }

  /**
   * Rewrites just the `generation` field on already-installed files (and any
   * edge they own) without re-deriving or re-validating ids - used by
   * sibling-worktree seeding (Task 21a) to stamp reused facts into the
   * *target's* current generation, since their underlying content (and
   * therefore every id) has not changed.
   */
  stampGeneration(relativePaths: readonly string[], generation: number): void {
    const paths = new Set(relativePaths);
    for (const relativePath of paths) {
      this.fileColumns.stampGeneration(relativePath, generation);
    }
    for (const relativePath of paths) {
      for (const edgeId of this.fileOwnedEdgeIds.get(relativePath) ?? []) {
        const row = this.edgeColumns.rowOf(edgeId);
        if (row !== undefined) this.edgeColumns.stampGeneration(row, generation);
      }
    }
  }

  file(relativePath: string): JavaFileFacts | undefined {
    return this.filesByPath.get(relativePath);
  }

  typeByFqn(fqn: string): JavaTypeFacts | undefined {
    const typeId = this.typeIdByFqn.get(fqn);
    return typeId ? this.typesById.get(typeId) : undefined;
  }

  anchor(relativePath: string, line: number, column: number): AnchorFacts | undefined {
    const file = this.filesByPath.get(relativePath);
    if (!file) return undefined;
    const position: SourcePosition = { line, column };

    type Candidate = {
      range: SourceRange;
      isMember: boolean;
      depth: number;
      symbolKind: AnchorFacts["symbolKind"];
      symbolId: string;
      symbolName: string;
      type?: JavaTypeFacts;
      method?: JavaMethodFacts;
      field?: JavaFieldFacts;
    };
    const candidates: Candidate[] = [];

    for (const typeId of file.allTypeIds) {
      const type = this.typesById.get(typeId);
      if (!type) continue;
      let depth = 0;
      for (let owner = type.enclosingTypeId; owner; owner = this.typesById.get(owner)?.enclosingTypeId) depth += 1;
      if (rangeContains(type.range, position)) {
        candidates.push({ range: type.range, isMember: false, depth, symbolKind: "TYPE", symbolId: type.typeId, symbolName: type.simpleName, type });
      }
      for (const fieldId of type.fieldIds) {
        const field = this.fieldsById.get(fieldId);
        if (field && rangeContains(field.range, position)) {
          candidates.push({
            range: field.range,
            isMember: true,
            depth: depth + 1,
            symbolKind: "FIELD",
            symbolId: field.fieldId,
            symbolName: field.name,
            type,
            field
          });
        }
      }
      for (const methodId of type.methodIds) {
        const method = this.methodsById.get(methodId);
        if (method && rangeContains(method.range, position)) {
          candidates.push({
            range: method.range,
            isMember: true,
            depth: depth + 1,
            symbolKind: method.constructor ? "CONSTRUCTOR" : "METHOD",
            symbolId: method.methodId,
            symbolName: method.name,
            type,
            method
          });
        }
      }
    }

    if (candidates.length === 0) {
      const zeroWidth: SourceRange = { start: position, end: position };
      return {
        file,
        symbolId: file.fileId,
        symbolKind: "FILE",
        symbolName: file.relativePath,
        range: zeroWidth,
        coverage: "DEGRADED",
        confidence: 1
      };
    }

    // A member's range is always inside its owner type's range, so members
    // outrank types outright; among same-kind candidates the more deeply
    // nested one wins. No range-size arithmetic needed.
    candidates.sort((a, b) => {
      if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
      return b.depth - a.depth;
    });
    const best = candidates[0]!;
    return {
      file,
      symbolId: best.symbolId,
      symbolKind: best.symbolKind,
      symbolName: best.symbolName,
      range: best.range,
      ...(best.type ? { type: best.type } : {}),
      ...(best.method ? { method: best.method } : {}),
      ...(best.field ? { field: best.field } : {}),
      coverage: "DEGRADED",
      confidence: 1
    };
  }

  // Reuses JavaNameResolver directly rather than a separate lookup
  // algorithm. scopeFile only supplies packageName/imports (a file has no
  // single enclosing type or type-parameter scope), so steps 1 (type
  // parameter) and 4 (enclosing/nested type) of architecture V3 §9.8
  // degrade to no-ops against the empty context below - by design, not
  // because they're missing.
  typeLookup(typeText: string, scopeFile?: string): JavaTypeLookupResult {
    const registry: TypeRegistryView = {
      byId: this.typesById,
      byFqn: this.typeIdByFqn,
      bySimpleName: this.typeIdsBySimpleName,
      nestedByOwnerAndSimpleName: new Map(),
      methodsByOwnerTypeId: new Map()
    };
    const resolver = new JavaNameResolver(registry);
    const file = scopeFile ? this.filesByPath.get(scopeFile) : undefined;
    const context: JavaResolutionContext = {
      packageName: file?.packageName ?? "",
      imports: file?.imports ?? [],
      enclosingTypeIds: [],
      typeParameterNames: new Set()
    };
    const resolution = resolver.resolveTypeText(typeText, context).resolution;
    switch (resolution.state) {
      case "RESOLVED_REPO": {
        const type = this.typesById.get(resolution.typeId);
        return type ? { state: "RESOLVED", type } : { state: "UNRESOLVED", coverage: "DEGRADED" };
      }
      case "AMBIGUOUS": {
        const candidates = resolution.candidates
          .map(id => this.typesById.get(id))
          .filter((t): t is JavaTypeFacts => t !== undefined);
        return { state: "AMBIGUOUS", candidates };
      }
      default:
        // §9.10: negative results are only trustworthy at COMPLETE coverage;
        // this store has no coverage tracking of its own (Task 20's), so
        // DEGRADED is the honest answer rather than an unearned COMPLETE.
        return { state: "UNRESOLVED", coverage: "DEGRADED" };
    }
  }

  implementers(typeId: string, limit = 40): JavaTypeFacts[] {
    const seen = new Set<string>();
    const results: JavaTypeFacts[] = [];
    for (const edgeId of this.inEdgeIdsByNode.get(typeId) ?? []) {
      const edge = this.edgesById.get(edgeId);
      if (!edge || (edge.kind !== "IMPLEMENTS" && edge.kind !== "EXTENDS")) continue;
      if (seen.has(edge.fromId)) continue;
      const type = this.typesById.get(edge.fromId);
      if (!type) continue;
      seen.add(edge.fromId);
      results.push(type);
    }
    results.sort(compareTypes);
    return results.slice(0, limit);
  }

  typeReferencers(typeId: string, kinds: ReadonlySet<StaticEdgeKind>, limit = 80): IndexedReference[] {
    return this.referencesInto(typeId, kinds, limit);
  }

  callers(methodId: string, limit = 80): IndexedReference[] {
    return this.referencesInto(methodId, new Set<StaticEdgeKind>(["CALLS", "METHOD_REFERENCE"]), limit);
  }

  callees(methodId: string, limit = 80): IndexedReference[] {
    return this.referencesFrom(methodId, new Set<StaticEdgeKind>(["CALLS", "CONSTRUCTS", "METHOD_REFERENCE"]), limit);
  }

  /**
   * One bounded union over the existing PARAM_TYPE reverse indexes. Framework
   * packs use this for event-listener discovery so an N-event publication does
   * not become N separate worker requests. The returned method ids are sorted
   * by source location before the shared limit is applied.
   */
  methodsOfOwner(ownerTypeId: string): JavaMethodFacts[] {
    const type = this.typesById.get(ownerTypeId);
    if (!type) return [];
    const methods: JavaMethodFacts[] = [];
    for (const methodId of type.methodIds) {
      const method = this.methodsById.get(methodId);
      if (method) methods.push(method);
    }
    return methods;
  }

  methodsWithParameterTypes(typeIds: readonly string[], limit = 64): string[] {
    const methodIds = new Set<string>();
    for (const typeId of typeIds) {
      for (const edgeId of this.inEdgeIdsByNode.get(typeId) ?? []) {
        const edge = this.edgesById.get(edgeId);
        if (edge?.kind === "PARAM_TYPE" && this.methodsById.has(edge.fromId)) {
          methodIds.add(edge.fromId);
        }
      }
    }
    return [...methodIds]
      .map(methodId => this.methodsById.get(methodId)!)
      .sort((left, right) => {
        const leftFileId = this.typesById.get(left.ownerTypeId)?.fileId ?? "";
        const rightFileId = this.typesById.get(right.ownerTypeId)?.fileId ?? "";
        return compareByLocation(leftFileId, left.range, left.methodId, rightFileId, right.range, right.methodId);
      })
      .slice(0, Math.max(0, limit))
      .map(method => method.methodId);
  }

  /**
   * A bounded summary for framework activation. The worker performs this
   * store-local scan once per RouterJavaIndex generation and the router
   * caches the boolean result, so packs never reread or parse Java source.
   */
  repositoryFactMarkers(importPrefixes: readonly string[], annotationPrefixes: readonly string[]): {
    importPrefixFound: boolean;
    annotationPrefixFound: boolean;
  } {
    const hasPrefix = (value: string | undefined, prefixes: readonly string[]) =>
      value !== undefined && prefixes.some(prefix => value.startsWith(prefix));
    // Prewarm kicks hydrate with empty prefixes. Scanning 250k edges for a
    // match that cannot succeed blocks STATUS for hundreds of ms to minutes.
    if (importPrefixes.length === 0 && annotationPrefixes.length === 0) {
      return { importPrefixFound: false, annotationPrefixFound: false };
    }
    let importPrefixFound = false;
    let annotationPrefixFound = false;
    for (const file of this.filesByPath.values()) {
      if (!importPrefixFound && file.imports.some(imp => hasPrefix(imp.qualifiedName, importPrefixes))) {
        importPrefixFound = true;
      }
      if (importPrefixFound) break;
    }
    annotationPrefixFound = [...this.typesById.values()].some(type => type.annotations.some(annotation => hasPrefix(annotation.qualifiedName, annotationPrefixes)))
      || [...this.fieldsById.values()].some(field => field.annotations.some(annotation => hasPrefix(annotation.qualifiedName, annotationPrefixes)))
      || [...this.methodsById.values()].some(method =>
        method.annotations.some(annotation => hasPrefix(annotation.qualifiedName, annotationPrefixes))
        || method.parameters.some(parameter => parameter.annotations.some(annotation => hasPrefix(annotation.qualifiedName, annotationPrefixes)))
      )
      // A short annotation imported from a framework package is stored as an
      // AST name plus its resolved ANNOTATED_WITH edge; its raw qualifiedName
      // is intentionally not rewritten. Consult that resolved edge as well,
      // otherwise `import org.springframework...; @Service` is invisible to
      // repository activation despite being exact JavaIndex evidence.
      || [...this.edgeColumns.values()].some(edge =>
        edge.kind === "ANNOTATED_WITH"
        && hasPrefix(edge.toId.startsWith("external:") ? edge.toId.slice("external:".length) : undefined, annotationPrefixes)
      );
    return { importPrefixFound, annotationPrefixFound };
  }

  files(paths: readonly string[]): JavaFileBundle[] {
    const results: JavaFileBundle[] = [];
    for (const relativePath of paths) {
      const file = this.filesByPath.get(relativePath);
      if (!file) continue;
      const types: JavaTypeFacts[] = [];
      const fields: JavaFieldFacts[] = [];
      const methods: JavaMethodFacts[] = [];
      for (const nodeId of this.fileOwnedNodeIds.get(relativePath) ?? []) {
        const type = this.typesById.get(nodeId);
        if (type) { types.push(type); continue; }
        const field = this.fieldsById.get(nodeId);
        if (field) { fields.push(field); continue; }
        const method = this.methodsById.get(nodeId);
        if (method) methods.push(method);
      }
      const edges: StaticEdge[] = [];
      for (const edgeId of this.fileOwnedEdgeIds.get(relativePath) ?? []) {
        const row = this.edgeColumns.rowOf(edgeId);
        if (row !== undefined) edges.push(this.edgeColumns.materialize(row));
      }
      results.push({ file, types, fields, methods, edges });
    }
    return results;
  }

  /** Deterministic (sorted by id/path) so two snapshots of identical facts diff/compare cleanly. */
  toSnapshotData(): {
    files: JavaFileFacts[];
    types: JavaTypeFacts[];
    fields: JavaFieldFacts[];
    methods: JavaMethodFacts[];
    edges: StaticEdge[];
    myBatisResources: MyBatisMapperResourceFacts[];
  } {
    return {
      files: [...this.filesByPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      types: [...this.typesById.values()].sort((a, b) => a.typeId.localeCompare(b.typeId)),
      fields: [...this.fieldsById.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
      methods: [...this.methodColumns.values(), ...this.overlayMethods.values()]
        .sort((a, b) => a.methodId.localeCompare(b.methodId)),
      edges: [...this.edgeColumns.values(), ...this.overlayEdges.values()]
        .sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
      myBatisResources: [...this.myBatisResourcesByPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    };
  }

  /**
   * Bulk-rebuilds this store from a snapshot's flat fact arrays, replacing
   * whatever it currently holds. Reverse indexes are derived here, never
   * persisted. Unlike `replaceFile`, this does not recompute every id via the
   * Task 15 factories (the snapshot was produced by this same store's own
   * `toSnapshotData`, so that would be redundant work on a trusted
   * round-trip) - it only rejects a duplicate id, which a hand-edited or
   * corrupted snapshot file could otherwise introduce silently.
   */
  loadSnapshotData(data: {
    files: readonly JavaFileFacts[];
    types: readonly JavaTypeFacts[];
    fields: readonly JavaFieldFacts[];
    methods: readonly JavaMethodFacts[];
    edges: readonly StaticEdge[];
    myBatisResources: readonly MyBatisMapperResourceFacts[];
  }): void {
    this.disposeSharedFacts();
    this.fileColumns.clear();
    this.typesById.clear();
    this.typeIdByFqn.clear();
    this.typeIdsBySimpleName.clear();
    this.fieldsById.clear();
    this.methodIdsByOwnerAndName.clear();
    this.methodColumns.clear();
    this.edgeColumns.clear();
    this.edgeColumns.strings.clear();
    this.edgeColumns.ranges.clear();
    this.outEdgeIdsByNode.clear();
    this.inEdgeIdsByNode.clear();
    this.fileOwnedNodeIds.clear();
    this.fileOwnedEdgeIds.clear();
    this.myBatisResourcesByPath.clear();
    this.myBatisStatementsByQualifiedId.clear();
    this.myBatisResourcesByNamespace.clear();

    for (const file of data.files) {
      if (this.filesByPath.has(file.relativePath)) {
        throw new Error(`duplicate file in snapshot: ${file.relativePath}`);
      }
      internFile(this.edgeColumns.strings, this.edgeColumns.ranges, file);
      this.fileColumns.add(file);
    }
    this.ingestSnapshotFacts(data);
  }

  /**
   * Installs types/fields/methods/edges/myBatis on top of files already loaded
   * (M3 lazy v4: files metadata first, remaining segments on first query).
   */
  ingestSnapshotFacts(data: {
    types: readonly JavaTypeFacts[];
    fields: readonly JavaFieldFacts[];
    methods: readonly JavaMethodFacts[];
    edges: readonly StaticEdge[];
    myBatisResources?: readonly MyBatisMapperResourceFacts[];
  }, options: { onDuplicate?: "throw" | "skip" } = {}): void {
    const onDuplicate = options.onDuplicate ?? "throw";
    // Empty arrays mean "this call does not carry that collection". Non-empty
    // arrays append; a second methods/edges/fields chunk must land, not skip.
    const skipExistingResources = this.myBatisResourcesByPath.size > 0;
    for (const resource of data.myBatisResources ?? []) {
      if (this.myBatisResourcesByPath.has(resource.relativePath)) {
        if (skipExistingResources) continue;
        throw new Error(`duplicate mybatis resource in snapshot: ${resource.relativePath}`);
      }
      this.myBatisResourcesByPath.set(resource.relativePath, resource);
      for (const statement of resource.statements) {
        this.myBatisStatementsByQualifiedId.set(
          myBatisQualifiedId(resource.namespace, statement.id),
          { relativePath: resource.relativePath, statement }
        );
      }
      if (resource.namespace) addToSetMap(this.myBatisResourcesByNamespace, resource.namespace, resource.relativePath);
    }
    if (data.types.length > 0) for (const type of data.types) {
      if (this.typesById.has(type.typeId)) {
        if (onDuplicate === "skip") continue;
        throw new Error(`duplicate type id in snapshot: ${type.typeId}`);
      }
      internType(this.edgeColumns.strings, this.edgeColumns.ranges, type);
      this.typesById.set(type.typeId, type);
      if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
      addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(type.fileId), type.typeId);
    }
    if (data.fields.length > 0) for (const field of data.fields) {
      if (this.fieldsById.has(field.fieldId)) {
        if (onDuplicate === "skip") continue;
        throw new Error(`duplicate field id in snapshot: ${field.fieldId}`);
      }
      internField(this.edgeColumns.strings, this.edgeColumns.ranges, field);
      this.fieldsById.set(field.fieldId, field);
      const ownerType = this.typesById.get(field.ownerTypeId);
      if (!ownerType) throw new Error(`field ${field.fieldId} references unknown owner type ${field.ownerTypeId}`);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(ownerType.fileId), field.fieldId);
    }
    if (data.methods.length > 0) for (const method of data.methods) {
      if (this.methodColumns.has(method.methodId)) {
        if (onDuplicate === "skip") continue;
        throw new Error(`duplicate method id in snapshot: ${method.methodId}`);
      }
      internMethod(this.edgeColumns.strings, this.edgeColumns.ranges, method);
      this.methodColumns.add(method);
      addToSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, method.methodId);
      const ownerType = this.typesById.get(method.ownerTypeId);
      if (!ownerType) throw new Error(`method ${method.methodId} references unknown owner type ${method.ownerTypeId}`);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(ownerType.fileId), method.methodId);
    }
    const strings = this.edgeColumns.strings;
    if (data.edges.length > 0) for (const edge of data.edges) {
      if (this.edgeColumns.has(edge.edgeId)) {
        if (onDuplicate === "skip") continue;
        throw new Error(`duplicate edge id in snapshot: ${edge.edgeId}`);
      }
      this.edgeColumns.add(edge);
      const edgeId = strings.interned(edge.edgeId);
      addToSetMap(this.outEdgeIdsByNode, strings.interned(edge.fromId), edgeId);
      addToSetMap(this.inEdgeIdsByNode, strings.interned(edge.toId), edgeId);
      addToSetMap(this.fileOwnedEdgeIds, strings.interned(edge.sourceFile), edgeId);
    }
  }

  private referencesInto(nodeId: string, kinds: ReadonlySet<StaticEdgeKind>, limit: number): IndexedReference[] {
    return this.referencesVia(this.inEdgeIdsByNode.get(nodeId), kinds, limit);
  }

  private referencesFrom(nodeId: string, kinds: ReadonlySet<StaticEdgeKind>, limit: number): IndexedReference[] {
    return this.referencesVia(this.outEdgeIdsByNode.get(nodeId), kinds, limit);
  }

  private referencesVia(edgeIds: Set<string> | undefined, kinds: ReadonlySet<StaticEdgeKind>, limit: number): IndexedReference[] {
    const results: IndexedReference[] = [];
    for (const edgeId of edgeIds ?? []) {
      const edge = this.edgesById.get(edgeId);
      if (!edge || !kinds.has(edge.kind)) continue;
      const file = this.filesByPath.get(edge.sourceFile);
      results.push({
        sourceId: edge.fromId,
        targetId: edge.toId,
        sourceFile: edge.sourceFile,
        sourceModule: file?.module ?? "",
        sourceSet: file?.sourceSet ?? "unknown",
        kind: edge.kind,
        confidence: edge.confidence,
        ...(edge.range ? { range: edge.range } : {}),
        generation: edge.generation
      });
    }
    results.sort(compareReferences);
    return results.slice(0, limit);
  }

  installedBundle(relativePath: string): JavaFileBundle | undefined {
    return this.installedBundles.get(relativePath);
  }

  disposeSharedFacts(): void {
    for (const bundle of this.installedBundles.values()) {
      this.factsPool?.release(bundle.file.contentHash);
    }
    this.installedBundles.clear();
    this.overlayMethods.clear();
    this.overlayEdges.clear();
    this.methodRedirects.clear();
    this.edgeRedirects.clear();
  }

  private internOrShare(bundle: JavaFileBundle, previous: JavaFileBundle | undefined): JavaFileBundle {
    // contentHash keys file bytes, not the derived edge set. REFRESH installs
    // `{ ...resolved, edges: [] }` then `withEdges` under the same hash.
    if (previous) this.factsPool?.release(previous.file.contentHash);
    if (this.factsPool) {
      return this.factsPool.acquire(bundle.file.contentHash, () => {
        internFileBundle(this.edgeColumns.strings, this.edgeColumns.ranges, bundle);
        return bundle;
      });
    }
    internFileBundle(this.edgeColumns.strings, this.edgeColumns.ranges, bundle);
    return bundle;
  }

  private removeFileInternal(relativePath: string, releasePool = true): void {
    const previous = this.installedBundles.get(relativePath);
    this.installedBundles.delete(relativePath);
    if (releasePool && previous) this.factsPool?.release(previous.file.contentHash);
    this.fileColumns.remove(relativePath);

    for (const nodeId of this.fileOwnedNodeIds.get(relativePath) ?? []) {
      const type = this.typesById.get(nodeId);
      if (type) {
        this.typesById.delete(nodeId);
        if (type.fqn && this.typeIdByFqn.get(type.fqn) === nodeId) this.typeIdByFqn.delete(type.fqn);
        removeFromSetMap(this.typeIdsBySimpleName, type.simpleName, nodeId);
        this.inEdgeIdsByNode.delete(nodeId);
        continue;
      }
      const field = this.fieldsById.get(nodeId);
      if (field) {
        this.fieldsById.delete(nodeId);
        continue;
      }
      const method = this.methodColumns.remove(nodeId) ?? this.overlayMethods.get(nodeId);
      this.overlayMethods.delete(nodeId);
      this.methodRedirects.delete(nodeId);
      if (method) {
        removeFromSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, nodeId);
        this.inEdgeIdsByNode.delete(nodeId);
      }
    }
    this.fileOwnedNodeIds.delete(relativePath);

    for (const edgeId of this.fileOwnedEdgeIds.get(relativePath) ?? []) {
      const edge = this.edgeColumns.remove(edgeId) ?? this.overlayEdges.get(edgeId);
      this.overlayEdges.delete(edgeId);
      this.edgeRedirects.delete(edgeId);
      if (!edge) continue;
      removeFromSetMap(this.outEdgeIdsByNode, edge.fromId, edgeId);
      removeFromSetMap(this.inEdgeIdsByNode, edge.toId, edgeId);
    }
    this.fileOwnedEdgeIds.delete(relativePath);
  }

  private dependentFilesForOwnedNodes(relativePath: string, retainedNodeIds: ReadonlySet<string> = new Set()): string[] {
    const dependents = new Set<string>();
    for (const nodeId of this.fileOwnedNodeIds.get(relativePath) ?? []) {
      if (retainedNodeIds.has(nodeId)) continue;
      for (const edgeId of this.inEdgeIdsByNode.get(nodeId) ?? []) {
        const edge = this.edgesById.get(edgeId);
        if (edge && edge.sourceFile !== relativePath) dependents.add(edge.sourceFile);
      }
    }
    return [...dependents];
  }
}

type DonorRedirect = {
  donor: {
    file(relativePath: string): JavaFileFacts | undefined;
    methodsById: { get(id: string): JavaMethodFacts | undefined };
    edgesById: { get(id: string): StaticEdge | undefined };
  };
  relativePath: string;
  contentHash: string;
};

function resolveRedirect<T>(
  overlay: Map<string, T>,
  redirects: Map<string, DonorRedirect>,
  id: string,
  read: (donor: DonorRedirect["donor"], id: string) => T | undefined
): T | undefined {
  const cached = overlay.get(id);
  if (cached) return cached;
  const redirect = redirects.get(id);
  if (!redirect) return undefined;
  if (redirect.donor.file(redirect.relativePath)?.contentHash !== redirect.contentHash) return undefined;
  const value = read(redirect.donor, id);
  if (value) overlay.set(id, value);
  return value;
}

class EdgeIdMap {
  constructor(
    private readonly columns: EdgeColumns,
    private readonly overlay: Map<string, StaticEdge> = new Map(),
    private readonly redirects: Map<string, DonorRedirect> = new Map()
  ) {}

  get size(): number {
    return this.columns.size + this.overlay.size + this.redirects.size;
  }

  get(id: string): StaticEdge | undefined {
    const row = this.columns.rowOf(id);
    if (row !== undefined) return this.columns.materialize(row);
    return resolveRedirect(this.overlay, this.redirects, id, (donor, edgeId) => donor.edgesById.get(edgeId));
  }

  has(id: string): boolean {
    return this.columns.has(id) || this.overlay.has(id) || this.redirects.has(id);
  }

  values(): IterableIterator<StaticEdge> {
    return this.iterate() as IterableIterator<StaticEdge>;
  }

  *[Symbol.iterator](): IterableIterator<[string, StaticEdge]> {
    for (const edge of this.iterate()) yield [edge.edgeId, edge];
  }

  private *iterate(): IterableIterator<StaticEdge> {
    yield* this.columns.values();
    yield* this.overlay.values();
  }
}

class MethodIdMap {
  constructor(
    private readonly columns: MethodColumns,
    private readonly overlay: Map<string, JavaMethodFacts> = new Map(),
    private readonly redirects: Map<string, DonorRedirect> = new Map()
  ) {}

  get size(): number {
    return this.columns.size + this.overlay.size + this.redirects.size;
  }

  get(id: string): JavaMethodFacts | undefined {
    const row = this.columns.rowOf(id);
    if (row !== undefined) return this.columns.materialize(row);
    return resolveRedirect(this.overlay, this.redirects, id, (donor, methodId) => donor.methodsById.get(methodId));
  }

  has(id: string): boolean {
    return this.columns.has(id) || this.overlay.has(id) || this.redirects.has(id);
  }

  values(): IterableIterator<JavaMethodFacts> {
    return this.iterate() as IterableIterator<JavaMethodFacts>;
  }

  private *iterate(): IterableIterator<JavaMethodFacts> {
    yield* this.columns.values();
    yield* this.overlay.values();
  }
}

function bundleNodeIds(bundle: JavaFileBundle): Set<string> {
  return new Set([
    ...bundle.types.map(type => type.typeId),
    ...bundle.fields.map(field => field.fieldId),
    ...bundle.methods.map(method => method.methodId)
  ]);
}
