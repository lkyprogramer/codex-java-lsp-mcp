import type { SQLOutputValue } from "node:sqlite";
import type {
  AnchorFacts,
  IndexedReference,
  JavaAnnotationFact,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeLookupResult,
  JavaTypeRef,
  SourcePosition,
  SourceRange,
  StaticEdge,
  StaticEdgeKind
} from "../index-types.js";
import { javaFileId } from "../stable-id.js";
import { JavaNameResolver, type TypeRegistryView } from "../name-resolver.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { myBatisQualifiedId } from "../mybatis-types.js";
import { prepareCached, type IndexDatabase } from "./driver.js";
import { decodeFacts, readBundle } from "./rows.js";

export { decodeFacts };

const LRU_LIMIT = 2048;

export type PointLookup<V> = {
  get(key: string): V | undefined;
  has(key: string): boolean;
  readonly size: number;
};

export function asCount(row: Record<string, SQLOutputValue> | undefined): number {
  const value = row?.n;
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
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
  const rangeA = a.range ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  const rangeB = b.range ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  return compareByLocation(javaFileId(a.sourceFile), rangeA, a.sourceId, javaFileId(b.sourceFile), rangeB, b.sourceId);
}

function inClause(count: number): string {
  return `(${Array.from({ length: count }, () => "?").join(",")})`;
}

function resolvedRepoTypeIds(ref: JavaTypeRef | undefined): string[] {
  if (!ref) return [];
  const ids: string[] = [];
  if (ref.resolution.state === "RESOLVED_REPO") ids.push(ref.resolution.typeId);
  for (const argument of ref.typeArguments) ids.push(...resolvedRepoTypeIds(argument));
  return ids;
}

class PointMap<V> implements PointLookup<V> {
  constructor(
    private readonly load: (key: string) => V | undefined,
    private readonly countKeys: () => number
  ) {}
  get(key: string): V | undefined { return this.load(key); }
  has(key: string): boolean { return this.load(key) !== undefined; }
  get size(): number { return this.countKeys(); }
}

export class SqlFactsStore {
  readonly typesById: PointLookup<JavaTypeFacts>;
  readonly methodsById: PointLookup<JavaMethodFacts>;
  readonly fieldsById: PointLookup<JavaFieldFacts>;
  readonly filesByPath: PointLookup<JavaFileFacts>;
  readonly typeIdByFqn: PointLookup<string>;
  readonly typeIdsBySimpleName: PointLookup<ReadonlySet<string>>;
  readonly methodIdsByOwnerAndName: PointLookup<ReadonlySet<string>>;
  private readonly db: IndexDatabase;
  private readonly lru = new Map<string, unknown>();

  constructor(db: IndexDatabase) {
    this.db = db;
    this.typesById = new PointMap(id => this.cached(`type:${id}`, () => this.selectFacts("type", "type_id", id)), () => this.countTable("type"));
    this.methodsById = new PointMap(id => this.cached(`method:${id}`, () => this.selectFacts("method", "method_id", id)), () => this.countTable("method"));
    this.fieldsById = new PointMap(id => this.cached(`field:${id}`, () => this.selectFacts("field", "field_id", id)), () => this.countTable("field"));
    this.filesByPath = new PointMap(path => this.cached(`file:${path}`, () => this.selectFacts("file", "path", path)), () => this.countTable("file"));
    this.typeIdByFqn = new PointMap(fqn => this.cached(`fqn:${fqn}`, () => {
      const row = prepareCached(this.db, "SELECT type_id AS id FROM type WHERE fqn=?").get(fqn);
      return typeof row?.id === "string" ? row.id : undefined;
    }), () => asCount(prepareCached(this.db, "SELECT count(DISTINCT fqn) AS n FROM type WHERE fqn IS NOT NULL").get()));
    this.typeIdsBySimpleName = new PointMap(
      name => this.loadIdSet(`simple:${name}`, "SELECT type_id AS id FROM type WHERE simple_name=?", name),
      () => asCount(prepareCached(this.db, "SELECT count(DISTINCT simple_name) AS n FROM type").get())
    );
    this.methodIdsByOwnerAndName = new PointMap(key => {
      const sep = key.indexOf("#");
      if (sep < 0) return undefined;
      return this.loadIdSet(
        `owner:${key}`,
        "SELECT method_id AS id FROM method WHERE owner_type_id=? AND name=?",
        key.slice(0, sep),
        key.slice(sep + 1)
      );
    }, () => asCount(prepareCached(this.db, "SELECT count(*) AS n FROM (SELECT 1 FROM method GROUP BY owner_type_id, name)").get()));
  }

  clearRequestCache(): void { this.lru.clear(); }

  private cached<T>(key: string, load: () => T | undefined): T | undefined {
    if (this.lru.has(key)) {
      const hit = this.lru.get(key) as T;
      this.lru.delete(key);
      this.lru.set(key, hit);
      return hit;
    }
    const value = load();
    if (value === undefined) return undefined;
    this.lru.set(key, value);
    if (this.lru.size > LRU_LIMIT) {
      const oldest = this.lru.keys().next().value;
      if (oldest !== undefined) this.lru.delete(oldest);
    }
    return value;
  }

  file(path: string): JavaFileFacts | undefined { return this.filesByPath.get(path); }

  files(paths: readonly string[]): JavaFileBundle[] {
    const results: JavaFileBundle[] = [];
    for (const path of paths) {
      const bundle = readBundle(this.db, path);
      if (bundle) results.push(bundle);
    }
    this.clearRequestCache();
    return results;
  }

  typeByFqn(fqn: string): JavaTypeFacts | undefined {
    const typeId = this.typeIdByFqn.get(fqn);
    return typeId ? this.typesById.get(typeId) : undefined;
  }

  nestedTypeId(ownerTypeId: string, simpleName: string): string | undefined {
    const row = prepareCached(this.db, "SELECT type_id AS id FROM type WHERE owner_type_id=? AND simple_name=?").get(ownerTypeId, simpleName);
    return typeof row?.id === "string" ? row.id : undefined;
  }

  methodsOfOwner(typeId: string): JavaMethodFacts[] {
    const type = this.typesById.get(typeId);
    if (!type) return [];
    const methods: JavaMethodFacts[] = [];
    for (const methodId of type.methodIds) {
      const method = this.methodsById.get(methodId);
      if (method) methods.push(method);
    }
    return methods;
  }

  myBatisResource(path: string): MyBatisMapperResourceFacts | undefined {
    const row = prepareCached(this.db, "SELECT facts FROM mybatis_resource WHERE path=?").get(path);
    return row ? decodeFacts<MyBatisMapperResourceFacts>(row.facts) : undefined;
  }

  myBatisResourceForNamespace(ns: string): MyBatisMapperResourceFacts | undefined {
    const rows = prepareCached(this.db, "SELECT path FROM mybatis_resource WHERE namespace=?").all(ns);
    if (rows.length !== 1 || typeof rows[0]?.path !== "string") return undefined;
    return this.myBatisResource(rows[0].path);
  }

  myBatisStatement(qid: string): MyBatisMapperResourceFacts["statements"][number] | undefined {
    for (const row of prepareCached(this.db, "SELECT facts FROM mybatis_resource").iterate()) {
      const resource = decodeFacts<MyBatisMapperResourceFacts>(row.facts);
      const hit = resource.statements.find(statement =>
        myBatisQualifiedId(resource.namespace, statement.id) === qid || statement.statementId === qid
      );
      if (hit) return hit;
    }
    return undefined;
  }

  implementers(typeId: string, limit = 40): JavaTypeFacts[] {
    const results: JavaTypeFacts[] = [];
    const seen = new Set<string>();
    for (const row of prepareCached(this.db, "SELECT DISTINCT from_id AS id FROM edge WHERE to_id=? AND kind IN ('IMPLEMENTS','EXTENDS')").all(typeId)) {
      if (typeof row.id !== "string" || seen.has(row.id)) continue;
      const type = this.typesById.get(row.id);
      if (!type) continue;
      seen.add(row.id);
      results.push(type);
    }
    results.sort(compareTypes);
    this.clearRequestCache();
    return results.slice(0, limit);
  }

  callers(methodId: string, limit = 80): IndexedReference[] {
    return this.references("to_id", methodId, ["CALLS", "METHOD_REFERENCE"], limit);
  }

  callees(methodId: string, limit = 80): IndexedReference[] {
    return this.references("from_id", methodId, ["CALLS", "CONSTRUCTS", "METHOD_REFERENCE"], limit);
  }

  typeReferencers(typeId: string, kinds: ReadonlySet<StaticEdgeKind>, limit = 80): IndexedReference[] {
    return this.references("to_id", typeId, [...kinds], limit);
  }

  methodsWithParameterTypes(typeIds: readonly string[], limit = 64): string[] {
    if (typeIds.length === 0) return [];
    const rows = prepareCached(
      this.db,
      `SELECT DISTINCT e.from_id AS id FROM edge e
       WHERE e.kind='PARAM_TYPE' AND e.to_id IN ${inClause(typeIds.length)}
         AND EXISTS (SELECT 1 FROM method m WHERE m.method_id=e.from_id)`
    ).all(...typeIds);
    const methods = rows
      .map(row => typeof row.id === "string" ? this.methodsById.get(row.id) : undefined)
      .filter((method): method is JavaMethodFacts => method !== undefined)
      .sort((left, right) => compareByLocation(
        this.typesById.get(left.ownerTypeId)?.fileId ?? "",
        left.range,
        left.methodId,
        this.typesById.get(right.ownerTypeId)?.fileId ?? "",
        right.range,
        right.methodId
      ));
    this.clearRequestCache();
    return methods.slice(0, Math.max(0, limit)).map(method => method.methodId);
  }

  anchor(path: string, line: number, column: number): AnchorFacts | undefined {
    const file = this.filesByPath.get(path);
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
          candidates.push({ range: field.range, isMember: true, depth: depth + 1, symbolKind: "FIELD", symbolId: field.fieldId, symbolName: field.name, type, field });
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
    this.clearRequestCache();
    if (candidates.length === 0) {
      return {
        file,
        symbolId: file.fileId,
        symbolKind: "FILE",
        symbolName: file.relativePath,
        range: { start: position, end: position },
        coverage: "DEGRADED",
        confidence: 1
      };
    }
    candidates.sort((a, b) => (a.isMember !== b.isMember ? (a.isMember ? -1 : 1) : b.depth - a.depth));
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

  typeLookup(typeText: string, scopeFile?: string): JavaTypeLookupResult {
    const registry: TypeRegistryView = {
      byId: this.typesById as unknown as TypeRegistryView["byId"],
      byFqn: this.typeIdByFqn as unknown as TypeRegistryView["byFqn"],
      bySimpleName: this.typeIdsBySimpleName as unknown as TypeRegistryView["bySimpleName"],
      nestedByOwnerAndSimpleName: new Map(),
      methodsByOwnerTypeId: new Map()
    };
    const resolver = new JavaNameResolver(registry);
    const file = scopeFile ? this.filesByPath.get(scopeFile) : undefined;
    const resolution = resolver.resolveTypeText(typeText, {
      packageName: file?.packageName ?? "",
      imports: file?.imports ?? [],
      enclosingTypeIds: [],
      typeParameterNames: new Set()
    }).resolution;
    this.clearRequestCache();
    switch (resolution.state) {
      case "RESOLVED_REPO": {
        const type = this.typesById.get(resolution.typeId);
        return type ? { state: "RESOLVED", type } : { state: "UNRESOLVED", coverage: "DEGRADED" };
      }
      case "AMBIGUOUS": {
        const candidates = resolution.candidates
          .map(id => this.typesById.get(id))
          .filter((type): type is JavaTypeFacts => type !== undefined);
        return { state: "AMBIGUOUS", candidates };
      }
      default:
        return { state: "UNRESOLVED", coverage: "DEGRADED" };
    }
  }

  repositoryFactMarkers(importPrefixes: readonly string[], annotationPrefixes: readonly string[]): {
    importPrefixFound: boolean;
    annotationPrefixFound: boolean;
  } {
    if (importPrefixes.length === 0 && annotationPrefixes.length === 0) {
      return { importPrefixFound: false, annotationPrefixFound: false };
    }
    const hasPrefix = (value: string | undefined, prefixes: readonly string[]) =>
      value !== undefined && prefixes.some(prefix => value.startsWith(prefix));
    const annotationsMatch = (items: readonly JavaAnnotationFact[] | undefined): boolean =>
      (items ?? []).some(item => hasPrefix(item.qualifiedName, annotationPrefixes));
    let importPrefixFound = false;
    if (importPrefixes.length > 0) {
      for (const file of this.iterFiles()) {
        if (file.imports.some(item => hasPrefix(item.qualifiedName, importPrefixes))) {
          importPrefixFound = true;
          break;
        }
      }
    }
    let annotationPrefixFound = false;
    if (annotationPrefixes.length > 0) {
      for (const type of this.iterTypes()) {
        if (annotationsMatch(type.annotations)) {
          annotationPrefixFound = true;
          break;
        }
      }
      if (!annotationPrefixFound) {
        for (const field of this.iterFields()) {
          if (annotationsMatch(field.annotations)) {
            annotationPrefixFound = true;
            break;
          }
        }
      }
      if (!annotationPrefixFound) {
        for (const method of this.iterMethods()) {
          if (annotationsMatch(method.annotations) || method.parameters.some(parameter => annotationsMatch(parameter.annotations))) {
            annotationPrefixFound = true;
            break;
          }
        }
      }
      if (!annotationPrefixFound) {
        for (const row of prepareCached(this.db, "SELECT to_id AS id FROM edge WHERE kind='ANNOTATED_WITH'").iterate()) {
          const toId = typeof row.id === "string" ? row.id : "";
          const name = toId.startsWith("external:") ? toId.slice("external:".length) : undefined;
          if (hasPrefix(name, annotationPrefixes)) {
            annotationPrefixFound = true;
            break;
          }
        }
      }
    }
    this.clearRequestCache();
    return { importPrefixFound, annotationPrefixFound };
  }

  implementersOfAny(typeIds: readonly string[]): string[] {
    if (typeIds.length === 0) return [];
    const targets = typeIds.map(id => this.typesById.get(id)).filter((type): type is JavaTypeFacts => type !== undefined);
    if (targets.length === 0) return [];
    const rows = prepareCached(
      this.db,
      `SELECT DISTINCT from_id AS id FROM edge WHERE kind IN ('IMPLEMENTS','EXTENDS') AND to_id IN ${inClause(typeIds.length)}`
    ).all(...typeIds);
    const hits: string[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      const type = this.typesById.get(row.id);
      if (!type) continue;
      const refs = [...type.implements, ...type.extends];
      const implementerFile = relativePathOfFileId(type.fileId);
      if (targets.some(target => refs.some(ref => this.refTargetsType(ref, target, implementerFile)))) hits.push(type.typeId);
    }
    this.clearRequestCache();
    return hits;
  }

  typesBySimpleNameOrFqn(simple: string, fqn: string): JavaTypeFacts[] {
    const rows = prepareCached(this.db, "SELECT facts FROM type WHERE simple_name=? OR fqn=?").all(simple, fqn);
    const hits = rows.map(row => decodeFacts<JavaTypeFacts>(row.facts)).filter(type => type.simpleName === simple || type.fqn === fqn);
    this.clearRequestCache();
    return hits;
  }

  *iterTypes(): IterableIterator<JavaTypeFacts> { yield* this.iterFacts("type"); }
  *iterFields(): IterableIterator<JavaFieldFacts> { yield* this.iterFacts("field"); }
  *iterMethods(): IterableIterator<JavaMethodFacts> { yield* this.iterFacts("method"); }
  *iterEdges(): IterableIterator<StaticEdge> { yield* this.iterFacts("edge"); }
  *iterFiles(): IterableIterator<JavaFileFacts> { yield* this.iterFacts("file"); }

  private *iterFacts<T>(table: string): IterableIterator<T> {
    for (const row of prepareCached(this.db, `SELECT facts FROM ${table} ORDER BY rowid`).iterate()) {
      yield decodeFacts<T>(row.facts);
    }
  }

  private selectFacts<T>(table: string, column: string, key: string): T | undefined {
    const row = prepareCached(this.db, `SELECT facts FROM ${table} WHERE ${column}=?`).get(key);
    return row ? decodeFacts<T>(row.facts) : undefined;
  }

  private countTable(table: string): number {
    return asCount(prepareCached(this.db, `SELECT count(*) AS n FROM ${table}`).get());
  }

  private loadIdSet(cacheKey: string, sql: string, ...params: string[]): ReadonlySet<string> | undefined {
    return this.cached(cacheKey, () => {
      const ids = new Set<string>();
      for (const row of prepareCached(this.db, sql).all(...params)) {
        if (typeof row.id === "string") ids.add(row.id);
      }
      return ids.size === 0 ? undefined : ids;
    });
  }

  private references(column: "from_id" | "to_id", nodeId: string, kinds: readonly string[], limit: number): IndexedReference[] {
    if (kinds.length === 0) return [];
    const rows = prepareCached(
      this.db,
      `SELECT e.facts AS facts, f.facts AS file_facts
       FROM edge e JOIN file f ON f.id=e.source_file_id
       WHERE e.${column}=? AND e.kind IN ${inClause(kinds.length)}`
    ).all(nodeId, ...kinds);
    const results: IndexedReference[] = [];
    for (const row of rows) {
      const edge = decodeFacts<StaticEdge>(row.facts);
      const file = decodeFacts<JavaFileFacts>(row.file_facts);
      results.push({
        sourceId: edge.fromId,
        targetId: edge.toId,
        sourceFile: edge.sourceFile,
        sourceModule: file.module ?? "",
        sourceSet: file.sourceSet ?? "unknown",
        kind: edge.kind,
        confidence: edge.confidence,
        ...(edge.range ? { range: edge.range } : {}),
        generation: edge.generation
      });
    }
    results.sort(compareReferences);
    this.clearRequestCache();
    return results.slice(0, limit);
  }

  private refTargetsType(ref: JavaTypeRef, target: JavaTypeFacts, implementerFile?: string): boolean {
    if (resolvedRepoTypeIds(ref).includes(target.typeId)) return true;
    if (ref.simpleName !== target.simpleName) return false;
    if (target.fqn && ref.qualifiedName === target.fqn) return true;
    const ids = this.typeIdsBySimpleName.get(ref.simpleName);
    if (ids && ids.size === 1 && [...ids][0] === target.typeId) return true;
    if (!implementerFile || !target.fqn) return false;
    const file = this.filesByPath.get(implementerFile);
    return Boolean(file?.imports.some(item => item.qualifiedName === target.fqn));
  }
}
