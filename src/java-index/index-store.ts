import { javaEdgeId, javaFieldId, javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";
import { JavaNameResolver, type JavaResolutionContext, type TypeRegistryView } from "./name-resolver.js";
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
  readonly filesByPath = new Map<string, JavaFileFacts>();
  readonly typesById = new Map<string, JavaTypeFacts>();
  readonly typeIdByFqn = new Map<string, string>();
  readonly typeIdsBySimpleName = new Map<string, Set<string>>();
  readonly fieldsById = new Map<string, JavaFieldFacts>();
  readonly methodsById = new Map<string, JavaMethodFacts>();
  readonly methodIdsByOwnerAndName = new Map<string, Set<string>>();
  readonly edgesById = new Map<string, StaticEdge>();
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
    const nextNodeIds = bundleNodeIds(bundle);
    const retainedIncoming = new Map<string, Set<string>>();
    for (const nodeId of nextNodeIds) {
      const inbound = this.inEdgeIdsByNode.get(nodeId);
      if (inbound) retainedIncoming.set(nodeId, new Set(inbound));
    }
    const dependents = this.dependentFilesForOwnedNodes(relativePath, nextNodeIds);
    this.removeFileInternal(relativePath);

    this.filesByPath.set(relativePath, bundle.file);

    const ownedNodeIds = new Set<string>();
    for (const type of bundle.types) {
      this.typesById.set(type.typeId, type);
      if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
      addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
      ownedNodeIds.add(type.typeId);
    }
    for (const field of bundle.fields) {
      this.fieldsById.set(field.fieldId, field);
      ownedNodeIds.add(field.fieldId);
    }
    for (const method of bundle.methods) {
      this.methodsById.set(method.methodId, method);
      addToSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, method.methodId);
      ownedNodeIds.add(method.methodId);
    }
    this.fileOwnedNodeIds.set(relativePath, ownedNodeIds);
    for (const [nodeId, inbound] of retainedIncoming) {
      this.inEdgeIdsByNode.set(nodeId, inbound);
    }

    const ownedEdgeIds = new Set<string>();
    for (const edge of bundle.edges) {
      this.edgesById.set(edge.edgeId, edge);
      addToSetMap(this.outEdgeIdsByNode, edge.fromId, edge.edgeId);
      addToSetMap(this.inEdgeIdsByNode, edge.toId, edge.edgeId);
      ownedEdgeIds.add(edge.edgeId);
    }
    this.fileOwnedEdgeIds.set(relativePath, ownedEdgeIds);
    return dependents;
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
        const edge = this.edgesById.get(edgeId);
        if (!edge) continue;
        this.edgesById.delete(edgeId);
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
      const file = this.filesByPath.get(relativePath);
      if (file) this.filesByPath.set(relativePath, { ...file, generation });
    }
    for (const [edgeId, edge] of this.edgesById) {
      if (paths.has(edge.sourceFile)) this.edgesById.set(edgeId, { ...edge, generation });
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
      || [...this.edgesById.values()].some(edge =>
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
        const edge = this.edgesById.get(edgeId);
        if (edge) edges.push(edge);
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
  } {
    return {
      files: [...this.filesByPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      types: [...this.typesById.values()].sort((a, b) => a.typeId.localeCompare(b.typeId)),
      fields: [...this.fieldsById.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
      methods: [...this.methodsById.values()].sort((a, b) => a.methodId.localeCompare(b.methodId)),
      edges: [...this.edgesById.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId))
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
  }): void {
    this.filesByPath.clear();
    this.typesById.clear();
    this.typeIdByFqn.clear();
    this.typeIdsBySimpleName.clear();
    this.fieldsById.clear();
    this.methodsById.clear();
    this.methodIdsByOwnerAndName.clear();
    this.edgesById.clear();
    this.outEdgeIdsByNode.clear();
    this.inEdgeIdsByNode.clear();
    this.fileOwnedNodeIds.clear();
    this.fileOwnedEdgeIds.clear();

    for (const file of data.files) {
      if (this.filesByPath.has(file.relativePath)) {
        throw new Error(`duplicate file in snapshot: ${file.relativePath}`);
      }
      this.filesByPath.set(file.relativePath, file);
    }
    for (const type of data.types) {
      if (this.typesById.has(type.typeId)) throw new Error(`duplicate type id in snapshot: ${type.typeId}`);
      this.typesById.set(type.typeId, type);
      if (type.fqn) this.typeIdByFqn.set(type.fqn, type.typeId);
      addToSetMap(this.typeIdsBySimpleName, type.simpleName, type.typeId);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(type.fileId), type.typeId);
    }
    for (const field of data.fields) {
      if (this.fieldsById.has(field.fieldId)) throw new Error(`duplicate field id in snapshot: ${field.fieldId}`);
      this.fieldsById.set(field.fieldId, field);
      const ownerType = this.typesById.get(field.ownerTypeId);
      if (!ownerType) throw new Error(`field ${field.fieldId} references unknown owner type ${field.ownerTypeId}`);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(ownerType.fileId), field.fieldId);
    }
    for (const method of data.methods) {
      if (this.methodsById.has(method.methodId)) throw new Error(`duplicate method id in snapshot: ${method.methodId}`);
      this.methodsById.set(method.methodId, method);
      addToSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, method.methodId);
      const ownerType = this.typesById.get(method.ownerTypeId);
      if (!ownerType) throw new Error(`method ${method.methodId} references unknown owner type ${method.ownerTypeId}`);
      addToSetMap(this.fileOwnedNodeIds, relativePathOfFileId(ownerType.fileId), method.methodId);
    }
    for (const edge of data.edges) {
      if (this.edgesById.has(edge.edgeId)) throw new Error(`duplicate edge id in snapshot: ${edge.edgeId}`);
      this.edgesById.set(edge.edgeId, edge);
      addToSetMap(this.outEdgeIdsByNode, edge.fromId, edge.edgeId);
      addToSetMap(this.inEdgeIdsByNode, edge.toId, edge.edgeId);
      addToSetMap(this.fileOwnedEdgeIds, edge.sourceFile, edge.edgeId);
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

  private removeFileInternal(relativePath: string): void {
    this.filesByPath.delete(relativePath);

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
      const method = this.methodsById.get(nodeId);
      if (method) {
        this.methodsById.delete(nodeId);
        removeFromSetMap(this.methodIdsByOwnerAndName, `${method.ownerTypeId}#${method.name}`, nodeId);
        this.inEdgeIdsByNode.delete(nodeId);
      }
    }
    this.fileOwnedNodeIds.delete(relativePath);

    for (const edgeId of this.fileOwnedEdgeIds.get(relativePath) ?? []) {
      const edge = this.edgesById.get(edgeId);
      if (!edge) continue;
      this.edgesById.delete(edgeId);
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

function bundleNodeIds(bundle: JavaFileBundle): Set<string> {
  return new Set([
    ...bundle.types.map(type => type.typeId),
    ...bundle.fields.map(field => field.fieldId),
    ...bundle.methods.map(method => method.methodId)
  ]);
}
