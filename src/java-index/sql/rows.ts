import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { SQLOutputValue } from "node:sqlite";
import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  StaticEdge
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";

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

export type EdgeRow = {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: string;
  sourceFileId: number;
  facts: StaticEdge;
};

export type MyBatisRow = {
  path: string;
  namespace: string | null;
  contentHash: string | null;
  facts: MyBatisMapperResourceFacts;
};

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

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
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

export function edgeRows(edges: readonly StaticEdge[], fileId: number): EdgeRow[] {
  return edges.map(edge => ({
    edgeId: edge.edgeId,
    fromId: edge.fromId,
    toId: edge.toId,
    kind: edge.kind,
    sourceFileId: fileId,
    facts: edge
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
      `INSERT INTO type(type_id, file_id, fqn, simple_name, kind, owner_type_id, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type_id) DO UPDATE SET
         file_id=excluded.file_id, fqn=excluded.fqn, simple_name=excluded.simple_name,
         kind=excluded.kind, owner_type_id=excluded.owner_type_id, facts=excluded.facts`
    );
    for (const type of typeRows(bundle)) {
      insertType.run(type.typeId, id, type.fqn, type.simpleName, type.kind, type.ownerTypeId, encodeFacts(type.facts));
    }
    const insertField = prepareCached(
      db,
      `INSERT INTO field(field_id, owner_type_id, file_id, name, facts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(field_id) DO UPDATE SET
         owner_type_id=excluded.owner_type_id, file_id=excluded.file_id, name=excluded.name, facts=excluded.facts`
    );
    for (const field of fieldRows(bundle)) {
      insertField.run(field.fieldId, field.ownerTypeId, id, field.name, encodeFacts(field.facts));
    }
    const insertMethod = prepareCached(
      db,
      `INSERT INTO method(method_id, owner_type_id, file_id, name, is_ctor, arity, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(method_id) DO UPDATE SET
         owner_type_id=excluded.owner_type_id, file_id=excluded.file_id, name=excluded.name,
         is_ctor=excluded.is_ctor, arity=excluded.arity, facts=excluded.facts`
    );
    for (const method of methodRows(bundle)) {
      insertMethod.run(
        method.methodId, method.ownerTypeId, id, method.name, method.isCtor, method.arity, encodeFacts(method.facts)
      );
    }
    const insertEdge = prepareCached(
      db,
      `INSERT INTO edge(edge_id, from_id, to_id, kind, source_file_id, facts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(edge_id) DO UPDATE SET
         from_id=excluded.from_id, to_id=excluded.to_id, kind=excluded.kind,
         source_file_id=excluded.source_file_id, facts=excluded.facts`
    );
    for (const edge of edgeRows(bundle.edges, id)) {
      insertEdge.run(edge.edgeId, edge.fromId, edge.toId, edge.kind, edge.sourceFileId, encodeFacts(edge.facts));
    }
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
    const updateType = prepareCached(db, "UPDATE type SET facts=?, fqn=? WHERE type_id=?");
    for (const type of typeRows(bundle)) {
      updateType.run(encodeFacts(type.facts), type.fqn, type.typeId);
    }
    const updateField = prepareCached(db, "UPDATE field SET facts=? WHERE field_id=?");
    for (const field of fieldRows(bundle)) {
      updateField.run(encodeFacts(field.facts), field.fieldId);
    }
    const updateMethod = prepareCached(db, "UPDATE method SET facts=?, arity=? WHERE method_id=?");
    for (const method of methodRows(bundle)) {
      updateMethod.run(encodeFacts(method.facts), method.arity, method.methodId);
    }
    return id;
  });
}

export function replaceBundleEdges(db: IndexDatabase, filePath: string, edges: readonly StaticEdge[]): void {
  runInWriteTx(db, () => {
    const id = fileIdByPath(db, filePath);
    prepareCached(db, "DELETE FROM edge WHERE source_file_id=?").run(id);
    const insertEdge = prepareCached(
      db,
      `INSERT INTO edge(edge_id, from_id, to_id, kind, source_file_id, facts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(edge_id) DO UPDATE SET
         from_id=excluded.from_id, to_id=excluded.to_id, kind=excluded.kind,
         source_file_id=excluded.source_file_id, facts=excluded.facts`
    );
    for (const edge of edgeRows(edges, id)) {
      insertEdge.run(edge.edgeId, edge.fromId, edge.toId, edge.kind, edge.sourceFileId, encodeFacts(edge.facts));
    }
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
    const type = lookupFacts<JavaTypeFacts>(db, "type", "type_id", typeId);
    if (!type) continue;
    types.push(type);
    for (const fieldId of type.fieldIds) {
      if (seenField.has(fieldId)) continue;
      const field = lookupFacts<JavaFieldFacts>(db, "field", "field_id", fieldId);
      if (field) {
        seenField.add(fieldId);
        fields.push(field);
      }
    }
    for (const methodId of type.methodIds) {
      if (seenMethod.has(methodId)) continue;
      const method = lookupFacts<JavaMethodFacts>(db, "method", "method_id", methodId);
      if (method) {
        seenMethod.add(methodId);
        methods.push(method);
      }
    }
  }
  const idRow = prepareCached(db, "SELECT id FROM file WHERE path=?").get(path);
  const fileId = asRowId(idRow?.id as number | bigint);
  const edges = prepareCached(db, "SELECT facts FROM edge WHERE source_file_id=? ORDER BY id").all(fileId);
  return {
    file: fileFacts,
    types,
    fields,
    methods,
    edges: edges.map(row => decodeFacts<StaticEdge>(row.facts))
  };
}

function lookupFacts<T>(
  db: IndexDatabase,
  table: "type" | "field" | "method",
  column: "type_id" | "field_id" | "method_id",
  id: string
): T | undefined {
  const row = prepareCached(db, `SELECT facts FROM ${table} WHERE ${column}=?`).get(id);
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
