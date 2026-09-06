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

function encodeFacts(value: unknown): string {
  return JSON.stringify(value);
}

function decodeFacts<T>(value: SQLOutputValue): T {
  if (typeof value !== "string") throw new Error("expected json(facts) text");
  return JSON.parse(value) as T;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?))`
      ).run(
        row.path, row.contentHash, row.size, row.mtimeMs, row.ctimeMs, row.sourceRoot,
        row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts)
      )
      : prepareCached(
        db,
        `INSERT INTO file(id, path, content_hash, size, mtime_ms, ctime_ms, source_root, module, package, parse_state, generation, facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?))`
      ).run(
        fileId, row.path, row.contentHash, row.size, row.mtimeMs, row.ctimeMs, row.sourceRoot,
        row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts)
      );
    const id = fileId ?? asRowId(inserted.lastInsertRowid);
    const insertType = prepareCached(
      db,
      `INSERT INTO type(type_id, file_id, fqn, simple_name, kind, owner_type_id, facts)
       VALUES (?, ?, ?, ?, ?, ?, jsonb(?))`
    );
    for (const type of typeRows(bundle)) {
      insertType.run(type.typeId, id, type.fqn, type.simpleName, type.kind, type.ownerTypeId, encodeFacts(type.facts));
    }
    const insertField = prepareCached(
      db,
      "INSERT INTO field(field_id, owner_type_id, file_id, name, facts) VALUES (?, ?, ?, ?, jsonb(?))"
    );
    for (const field of fieldRows(bundle)) {
      insertField.run(field.fieldId, field.ownerTypeId, id, field.name, encodeFacts(field.facts));
    }
    const insertMethod = prepareCached(
      db,
      "INSERT INTO method(method_id, owner_type_id, file_id, name, is_ctor, arity, facts) VALUES (?, ?, ?, ?, ?, ?, jsonb(?))"
    );
    for (const method of methodRows(bundle)) {
      insertMethod.run(
        method.methodId, method.ownerTypeId, id, method.name, method.isCtor, method.arity, encodeFacts(method.facts)
      );
    }
    const insertEdge = prepareCached(
      db,
      "INSERT INTO edge(edge_id, from_id, to_id, kind, source_file_id, facts) VALUES (?, ?, ?, ?, ?, jsonb(?))"
    );
    for (const edge of edgeRows(bundle.edges, id)) {
      insertEdge.run(edge.edgeId, edge.fromId, edge.toId, edge.kind, edge.sourceFileId, encodeFacts(edge.facts));
    }
    return id;
  });
}

export function readBundle(db: IndexDatabase, path: string): JavaFileBundle | undefined {
  const file = prepareCached(db, "SELECT json(facts) AS facts FROM file WHERE path=?").get(path);
  if (!file) return undefined;
  const idRow = prepareCached(db, "SELECT id FROM file WHERE path=?").get(path);
  const fileId = asRowId(idRow?.id as number | bigint);
  const types = prepareCached(db, "SELECT json(facts) AS facts FROM type WHERE file_id=? ORDER BY id").all(fileId);
  const fields = prepareCached(db, "SELECT json(facts) AS facts FROM field WHERE file_id=? ORDER BY id").all(fileId);
  const methods = prepareCached(db, "SELECT json(facts) AS facts FROM method WHERE file_id=? ORDER BY id").all(fileId);
  const edges = prepareCached(db, "SELECT json(facts) AS facts FROM edge WHERE source_file_id=? ORDER BY id").all(fileId);
  return {
    file: decodeFacts<JavaFileFacts>(file.facts),
    types: types.map(row => decodeFacts<JavaTypeFacts>(row.facts)),
    fields: fields.map(row => decodeFacts<JavaFieldFacts>(row.facts)),
    methods: methods.map(row => decodeFacts<JavaMethodFacts>(row.facts)),
    edges: edges.map(row => decodeFacts<StaticEdge>(row.facts))
  };
}

export function writeMyBatisResource(db: IndexDatabase, resource: MyBatisMapperResourceFacts): void {
  const row = myBatisRow(resource);
  prepareCached(
    db,
    `INSERT INTO mybatis_resource(path, namespace, content_hash, facts) VALUES (?, ?, ?, jsonb(?))
     ON CONFLICT(path) DO UPDATE SET namespace=excluded.namespace, content_hash=excluded.content_hash, facts=excluded.facts`
  ).run(row.path, row.namespace, row.contentHash, encodeFacts(row.facts));
}

export function readMyBatisResource(db: IndexDatabase, path: string): MyBatisMapperResourceFacts | undefined {
  const row = prepareCached(db, "SELECT json(facts) AS facts FROM mybatis_resource WHERE path=?").get(path);
  if (!row) return undefined;
  return decodeFacts<MyBatisMapperResourceFacts>(row.facts);
}
