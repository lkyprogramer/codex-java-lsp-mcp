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

  replaceFile(bundle: JavaFileBundle): void {
    validateBundleIds(bundle);
    const relativePath = bundle.file.relativePath;
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

    const ownedEdgeIds = new Set<string>();
    for (const edge of bundle.edges) {
      this.edgesById.set(edge.edgeId, edge);
      addToSetMap(this.outEdgeIdsByNode, edge.fromId, edge.edgeId);
      addToSetMap(this.inEdgeIdsByNode, edge.toId, edge.edgeId);
      ownedEdgeIds.add(edge.edgeId);
    }
    this.fileOwnedEdgeIds.set(relativePath, ownedEdgeIds);
  }

  // Returns the relative paths of files with an edge into a node this
  // removal deletes - the caller (worker) decides whether/how to re-resolve
  // them. Does not touch those files' own facts or edges.
  removeFiles(relativePaths: readonly string[]): string[] {
    const dependents = new Set<string>();
    for (const relativePath of relativePaths) {
      const ownedNodeIds = this.fileOwnedNodeIds.get(relativePath);
      if (ownedNodeIds) {
        for (const nodeId of ownedNodeIds) {
          for (const edgeId of this.inEdgeIdsByNode.get(nodeId) ?? []) {
            const edge = this.edgesById.get(edgeId);
            if (edge && edge.sourceFile !== relativePath) dependents.add(edge.sourceFile);
          }
        }
      }
      this.removeFileInternal(relativePath);
    }
    return [...dependents];
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
          candidates.push({ range: field.range, isMember: true, depth: depth + 1, symbolKind: "FIELD", symbolId: field.fieldId, symbolName: field.name, field });
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
}
