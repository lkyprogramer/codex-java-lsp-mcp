import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { SQLOutputValue } from "node:sqlite";
import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  SourceRange,
  StaticEdge,
  StaticEdgeKind,
  StaticEdgeResolutionKind,
  TypeResolutionStrategy
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { javaEdgeId } from "../stable-id.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { internSym, internSymNullable } from "./sym.js";

export type FileRow = {
  path: string;
  contentHash: string;
  size: number | null;
  mtimeMs: number | null;
  ctimeMs: number | null;
  sourceRoot: string | null;
  module: string | null;
  packageName: string | null;
  parseState: string | null;
  generation: number;
  facts: JavaFileFacts;
};

export type TypeRow = {
  typeId: string;
  fqn: string | null;
  simpleName: string;
  kind: string;
  ownerTypeId: string | null;
  facts: JavaTypeFacts;
};

export type FieldRow = {
  fieldId: string;
  ownerTypeId: string;
  name: string;
  facts: JavaFieldFacts;
};

export type MethodRow = {
  methodId: string;
  ownerTypeId: string;
  name: string;
  isCtor: number;
  arity: number;
  facts: JavaMethodFacts;
};

export type MyBatisRow = {
  path: string;
  namespace: string | null;
  contentHash: string | null;
  facts: MyBatisMapperResourceFacts;
};

export const STATIC_EDGE_SELECT = `SELECT e.sl AS sl, e.sc AS sc, e.el AS el, e.ec AS ec, e.confidence AS confidence,
  e.generation AS generation, ks.text AS kind, fs.text AS fromId, ts.text AS toId, rs.text AS resKind,
  ss.text AS resStrategy, f.path AS sourceFile, f.path AS path, f.module AS module
  FROM edge e
  JOIN file f ON f.id=e.file_id
  JOIN sym ks ON ks.id=e.kind_sym
  JOIN sym fs ON fs.id=e.from_sym
  JOIN sym ts ON ts.id=e.to_sym
  JOIN sym rs ON rs.id=e.res_kind_sym
  LEFT JOIN sym ss ON ss.id=e.res_strategy_sym`;

export function encodeFacts(value: unknown): Buffer {
  return deflateRawSync(Buffer.from(JSON.stringify(value), "utf8"));
}

export function decodeFacts<T>(value: SQLOutputValue): T {
  if (value instanceof Uint8Array) {
    return JSON.parse(inflateRawSync(value).toString("utf8")) as T;
  }
  throw new Error("expected facts blob");
}

function asRowId(value: number | bigint): number {
  const rowId = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(rowId) || rowId <= 0) throw new Error(`invalid rowid ${String(value)}`);
  return rowId;
}

function asInt(value: SQLOutputValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new Error(`expected integer, got ${String(value)}`);
}

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
}

function rangeColumns(range: SourceRange | undefined): [number, number, number, number] {
  if (!range) return [-1, -1, -1, -1];
  return [range.start.line, range.start.column, range.end.line, range.end.column];
}

export function staticEdgeFromSqlRow(row: Record<string, SQLOutputValue>): StaticEdge {
  const sl = asInt(row.sl);
  const sc = asInt(row.sc);
  const el = asInt(row.el);
  const ec = asInt(row.ec);
  const range = sl === -1 && sc === -1 && el === -1 && ec === -1
    ? undefined
    : { start: { line: sl, column: sc }, end: { line: el, column: ec } };
  const kind = String(row.kind);
  const fromId = String(row.fromId);
  const toId = String(row.toId);
  const resStrategy = typeof row.resStrategy === "string" ? row.resStrategy : undefined;
  return {
    edgeId: javaEdgeId({ kind, fromId, toId, range }),
    fromId,
    toId,
    kind: kind as StaticEdgeKind,
    confidence: Number(row.confidence),
    ...(range ? { range } : {}),
    sourceFile: String(row.sourceFile),
    generation: asInt(row.generation),
    resolution: {
      kind: String(row.resKind) as StaticEdgeResolutionKind,
      ...(resStrategy ? { typeStrategy: resStrategy as TypeResolutionStrategy } : {})
    }
  };
}

function insertStaticEdge(db: IndexDatabase, edge: StaticEdge, fileId: number): void {
  const [sl, sc, el, ec] = rangeColumns(edge.range);
  prepareCached(
    db,
    `INSERT INTO edge(kind_sym, from_sym, to_sym, file_id, sl, sc, el, ec, confidence, res_kind_sym, res_strategy_sym, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind_sym, from_sym, to_sym, sl, sc, el, ec) DO UPDATE SET
       file_id=excluded.file_id, confidence=excluded.confidence, res_kind_sym=excluded.res_kind_sym,
       res_strategy_sym=excluded.res_strategy_sym, generation=excluded.generation`
  ).run(
    internSym(db, edge.kind),
    internSym(db, edge.fromId),
    internSym(db, edge.toId),
    fileId,
    sl,
    sc,
    el,
    ec,
    edge.confidence,
    internSym(db, edge.resolution.kind),
    internSymNullable(db, edge.resolution.typeStrategy),
    edge.generation
  );
}

export function fileRow(bundle: JavaFileBundle): FileRow {
  const file = bundle.file;
  return {
    path: file.relativePath,
    contentHash: file.contentHash,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ctimeMs: file.ctimeMs ?? null,
    sourceRoot: file.sourceRoot,
    module: file.module,
    packageName: file.packageName,
    parseState: file.parseState,
    generation: file.generation,
    facts: file
  };
}

export function typeRows(bundle: JavaFileBundle): TypeRow[] {
  return bundle.types.map(type => ({
    typeId: type.typeId,
    fqn: type.fqn ?? null,
    simpleName: type.simpleName,
    kind: type.kind,
    ownerTypeId: type.enclosingTypeId ?? null,
    facts: type
  }));
}

export function fieldRows(bundle: JavaFileBundle): FieldRow[] {
  return bundle.fields.map(field => ({
    fieldId: field.fieldId,
    ownerTypeId: field.ownerTypeId,
    name: field.name,
    facts: field
  }));
}

export function methodRows(bundle: JavaFileBundle): MethodRow[] {
  return bundle.methods.map(method => ({
    methodId: method.methodId,
    ownerTypeId: method.ownerTypeId,
    name: method.name,
    isCtor: method.constructor ? 1 : 0,
    arity: method.parameters.length,
    facts: method
  }));
}

export function myBatisRow(resource: MyBatisMapperResourceFacts): MyBatisRow {
  return {
    path: resource.relativePath,
    namespace: resource.namespace,
    contentHash: resource.contentHash,
    facts: resource
  };
}

export function writeBundle(db: IndexDatabase, bundle: JavaFileBundle, fileId?: number): number {
  return runInWriteTx(db, () => {
    prepareCached(db, "DELETE FROM file WHERE path=?").run(bundle.file.relativePath);
    const row = fileRow(bundle);
    const inserted = fileId === undefined
      ? prepareCached(
        db,
        `INSERT INTO file(path, content_hash, size, mtime_ms, ctime_ms, source_root, module, package, parse_state, generation, facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.path, row.contentHash, row.size, row.mtimeMs, row.ctimeMs, row.sourceRoot,
        row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts)
      )
      : prepareCached(
        db,
        `INSERT INTO file(id, path, content_hash, size, mtime_ms, ctime_ms, source_root, module, package, parse_state, generation, facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fileId, row.path, row.contentHash, row.size, row.mtimeMs, row.ctimeMs, row.sourceRoot,
        row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts)
      );
    const id = fileId ?? asRowId(inserted.lastInsertRowid);
    const insertType = prepareCached(
      db,
      `INSERT INTO type(sym, file_id, fqn, simple_name, kind, owner_sym, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         file_id=excluded.file_id, fqn=excluded.fqn, simple_name=excluded.simple_name,
         kind=excluded.kind, owner_sym=excluded.owner_sym, facts=excluded.facts`
    );
    for (const type of typeRows(bundle)) {
      insertType.run(
        internSym(db, type.typeId), id, type.fqn, type.simpleName, type.kind,
        internSymNullable(db, type.ownerTypeId), encodeFacts(type.facts)
      );
    }
    const insertField = prepareCached(
      db,
      `INSERT INTO field(sym, owner_sym, file_id, name, facts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         owner_sym=excluded.owner_sym, file_id=excluded.file_id, name=excluded.name, facts=excluded.facts`
    );
    for (const field of fieldRows(bundle)) {
      insertField.run(
        internSym(db, field.fieldId), internSym(db, field.ownerTypeId), id, field.name, encodeFacts(field.facts)
      );
    }
    const insertMethod = prepareCached(
      db,
      `INSERT INTO method(sym, owner_sym, file_id, name, is_ctor, arity, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         owner_sym=excluded.owner_sym, file_id=excluded.file_id, name=excluded.name,
         is_ctor=excluded.is_ctor, arity=excluded.arity, facts=excluded.facts`
    );
    for (const method of methodRows(bundle)) {
      insertMethod.run(
        internSym(db, method.methodId), internSym(db, method.ownerTypeId), id,
        method.name, method.isCtor, method.arity, encodeFacts(method.facts)
      );
    }
    for (const edge of bundle.edges) insertStaticEdge(db, edge, id);
    return id;
  });
}

function fileIdByPath(db: IndexDatabase, path: string): number {
  const row = prepareCached(db, "SELECT id FROM file WHERE path=?").get(path);
  if (!row) throw new Error(`file not found: ${path}`);
  return asRowId(row.id as number | bigint);
}

export function updateBundleFacts(db: IndexDatabase, bundle: JavaFileBundle): number {
  return runInWriteTx(db, () => {
    const id = fileIdByPath(db, bundle.file.relativePath);
    const row = fileRow(bundle);
    prepareCached(db, "UPDATE file SET facts=?, parse_state=?, generation=? WHERE id=?").run(
      encodeFacts(row.facts),
      row.parseState,
      row.generation,
      id
    );
    const updateType = prepareCached(db, "UPDATE type SET facts=?, fqn=? WHERE sym=?");
    for (const type of typeRows(bundle)) {
      updateType.run(encodeFacts(type.facts), type.fqn, internSym(db, type.typeId));
    }
    const updateField = prepareCached(db, "UPDATE field SET facts=? WHERE sym=?");
    for (const field of fieldRows(bundle)) {
      updateField.run(encodeFacts(field.facts), internSym(db, field.fieldId));
    }
    const updateMethod = prepareCached(db, "UPDATE method SET facts=?, arity=? WHERE sym=?");
    for (const method of methodRows(bundle)) {
      updateMethod.run(encodeFacts(method.facts), method.arity, internSym(db, method.methodId));
    }
    return id;
  });
}

export function replaceBundleEdges(db: IndexDatabase, filePath: string, edges: readonly StaticEdge[]): void {
  runInWriteTx(db, () => {
    const id = fileIdByPath(db, filePath);
    prepareCached(db, "DELETE FROM edge WHERE file_id=?").run(id);
    for (const edge of edges) insertStaticEdge(db, edge, id);
  });
}

export function readBundle(db: IndexDatabase, path: string): JavaFileBundle | undefined {
  const file = prepareCached(db, "SELECT facts FROM file WHERE path=?").get(path);
  if (!file) return undefined;
  const fileFacts = decodeFacts<JavaFileFacts>(file.facts);
  const types: JavaTypeFacts[] = [];
  const fields: JavaFieldFacts[] = [];
  const methods: JavaMethodFacts[] = [];
  const seenField = new Set<string>();
  const seenMethod = new Set<string>();
  for (const typeId of fileFacts.allTypeIds) {
    const type = lookupMemberFacts<JavaTypeFacts>(db, "type", typeId);
    if (!type) continue;
    types.push(type);
    for (const fieldId of type.fieldIds) {
      if (seenField.has(fieldId)) continue;
      const field = lookupMemberFacts<JavaFieldFacts>(db, "field", fieldId);
      if (field) {
        seenField.add(fieldId);
        fields.push(field);
      }
    }
    for (const methodId of type.methodIds) {
      if (seenMethod.has(methodId)) continue;
      const method = lookupMemberFacts<JavaMethodFacts>(db, "method", methodId);
      if (method) {
        seenMethod.add(methodId);
        methods.push(method);
      }
    }
  }
  const idRow = prepareCached(db, "SELECT id FROM file WHERE path=?").get(path);
  const fileId = asRowId(idRow?.id as number | bigint);
  const edges = prepareCached(db, `${STATIC_EDGE_SELECT} WHERE e.file_id=? ORDER BY e.id`).all(fileId);
  return {
    file: fileFacts,
    types,
    fields,
    methods,
    edges: edges.map(row => staticEdgeFromSqlRow(row))
  };
}

function lookupMemberFacts<T>(db: IndexDatabase, table: "type" | "field" | "method", id: string): T | undefined {
  const row = prepareCached(
    db,
    `SELECT t.facts FROM ${table} t JOIN sym s ON s.id=t.sym WHERE s.text=?`
  ).get(id);
  return row ? decodeFacts<T>(row.facts) : undefined;
}

export function writeMyBatisResource(db: IndexDatabase, resource: MyBatisMapperResourceFacts): void {
  const row = myBatisRow(resource);
  prepareCached(
    db,
    `INSERT INTO mybatis_resource(path, namespace, content_hash, facts) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET namespace=excluded.namespace, content_hash=excluded.content_hash, facts=excluded.facts`
  ).run(row.path, row.namespace, row.contentHash, encodeFacts(row.facts));
}

export function readMyBatisResource(db: IndexDatabase, path: string): MyBatisMapperResourceFacts | undefined {
  const row = prepareCached(db, "SELECT facts FROM mybatis_resource WHERE path=?").get(path);
  if (!row) return undefined;
  return decodeFacts<MyBatisMapperResourceFacts>(row.facts);
}
