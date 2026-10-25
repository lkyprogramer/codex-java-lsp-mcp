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
import { BoundedCache } from "./bounded-cache.js";
import { onRollback, prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { internSym, internSymNullable, rememberSyms, symId } from "./sym.js";

export type FileRow = {
  path: string;
  contentHash: string;
  size: number | null;
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
  if (!(value instanceof Uint8Array)) throw new Error("expected facts blob");
  if (!decoded) return JSON.parse(inflateRawSync(value).toString("utf8")) as T;
  const key = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
  const hit = decoded.get(key);
  if (hit !== undefined) return hit as T;
  const facts = JSON.parse(inflateRawSync(value).toString("utf8")) as T;
  decoded.set(key, facts);
  return facts;
}

// While any bundle memo is held, equal blobs decode once: a decoded value is a
// function of its bytes alone, so nothing invalidates it, on any connection.
// The same rows are decoded by every stage of a delta (snapshot, resolution,
// edges, graph); callers already share decoded facts as immutable.
const DECODED_LIMIT = 32_768;
let decoded: BoundedCache<string, unknown> | undefined;
let decodeScopes = 0;

function asRowId(value: number | bigint): number {
  if (typeof value === "bigint" && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`unsafe rowid ${value}`);
  const rowId = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(rowId) || rowId <= 0) throw new Error(`invalid rowid ${String(value)}`);
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

export type WriteBundleOptions = {
  /** "keep" leaves an existing file's static edges for the resolve stage, which
   *  replaces them in the same transaction (replaceBundleEdges); the parser
   *  emits none, so writing the bundle's edges would delete and re-add them. */
  edges?: "replace" | "keep";
};

/**
 * Writes one parsed file. A file already indexed keeps its row id, so its
 * members, type-reference names and edges are reconciled row by row instead
 * of being cascade-deleted and re-inserted; unchanged rows are not written.
 */
export function writeBundle(db: IndexDatabase, bundle: JavaFileBundle, options: WriteBundleOptions = {}): number {
  forgetBundle(db, bundle);
  return runInWriteTx(db, () => {
    const row = fileRow(bundle);
    const existing = prepareCached(db, "SELECT id FROM file WHERE path=?").get(row.path) as { id: number | bigint } | undefined;
    let id: number;
    if (existing) {
      id = asRowId(existing.id);
      prepareCached(
        db,
        `UPDATE file SET content_hash=?, size=?, source_root=?, module=?, package=?, parse_state=?, generation=?, facts=?
         WHERE id=? AND (content_hash IS NOT ? OR size IS NOT ? OR source_root IS NOT ? OR module IS NOT ? OR package IS NOT ?
           OR parse_state IS NOT ? OR facts IS NOT ?)`
      ).run(
        row.contentHash, row.size, row.sourceRoot, row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts),
        id, row.contentHash, row.size, row.sourceRoot, row.module, row.packageName, row.parseState, encodeFacts(row.facts)
      );
    } else {
      id = asRowId(prepareCached(
        db,
        `INSERT INTO file(path, content_hash, size, source_root, module, package, parse_state, generation, facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.path, row.contentHash, row.size, row.sourceRoot,
        row.module, row.packageName, row.parseState, row.generation, encodeFacts(row.facts)
      ).lastInsertRowid);
    }
    if (existing) {
      // A rewrite mostly re-interns the ids and names its rows already hold.
      for (const sql of ["SELECT s.text AS text, s.id AS id FROM type m JOIN sym s ON s.id=m.sym WHERE m.file_id=?",
        "SELECT s.text AS text, s.id AS id FROM field m JOIN sym s ON s.id=m.sym WHERE m.file_id=?",
        "SELECT s.text AS text, s.id AS id FROM method m JOIN sym s ON s.id=m.sym WHERE m.file_id=?",
        "SELECT s.text AS text, s.id AS id FROM type_ref_name r JOIN sym s ON s.id=r.name_sym WHERE r.file_id=?"]) {
        rememberSyms(db, prepareCached(db, sql).all(id) as Array<{ text: unknown; id: unknown }>);
      }
    }
    const types = typeRows(bundle).map(type => ({ ...type, sym: internSym(db, type.typeId) }));
    const fields = fieldRows(bundle).map(field => ({ ...field, sym: internSym(db, field.fieldId) }));
    const methods = methodRows(bundle).map(method => ({ ...method, sym: internSym(db, method.methodId) }));
    if (existing) {
      dropMissingMembers(db, "type", id, types.map(type => type.sym));
      dropMissingMembers(db, "field", id, fields.map(field => field.sym));
      dropMissingMembers(db, "method", id, methods.map(method => method.sym));
    }
    const insertType = prepareCached(
      db,
      `INSERT INTO type(sym, file_id, fqn, simple_name, kind, owner_sym, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         file_id=excluded.file_id, fqn=excluded.fqn, simple_name=excluded.simple_name,
         kind=excluded.kind, owner_sym=excluded.owner_sym, facts=excluded.facts
       WHERE type.file_id IS NOT excluded.file_id OR type.fqn IS NOT excluded.fqn OR type.simple_name IS NOT excluded.simple_name
         OR type.kind IS NOT excluded.kind OR type.owner_sym IS NOT excluded.owner_sym OR type.facts IS NOT excluded.facts`
    );
    for (const type of types) {
      insertType.run(type.sym, id, type.fqn, type.simpleName, type.kind, internSymNullable(db, type.ownerTypeId), encodeFacts(type.facts));
    }
    const insertField = prepareCached(
      db,
      `INSERT INTO field(sym, owner_sym, file_id, name, facts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         owner_sym=excluded.owner_sym, file_id=excluded.file_id, name=excluded.name, facts=excluded.facts
       WHERE field.owner_sym IS NOT excluded.owner_sym OR field.file_id IS NOT excluded.file_id
         OR field.name IS NOT excluded.name OR field.facts IS NOT excluded.facts`
    );
    for (const field of fields) {
      insertField.run(field.sym, internSym(db, field.ownerTypeId), id, field.name, encodeFacts(field.facts));
    }
    const insertMethod = prepareCached(
      db,
      `INSERT INTO method(sym, owner_sym, file_id, name, is_ctor, arity, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         owner_sym=excluded.owner_sym, file_id=excluded.file_id, name=excluded.name,
         is_ctor=excluded.is_ctor, arity=excluded.arity, facts=excluded.facts
       WHERE method.owner_sym IS NOT excluded.owner_sym OR method.file_id IS NOT excluded.file_id OR method.name IS NOT excluded.name
         OR method.is_ctor IS NOT excluded.is_ctor OR method.arity IS NOT excluded.arity OR method.facts IS NOT excluded.facts`
    );
    for (const method of methods) {
      insertMethod.run(method.sym, internSym(db, method.ownerTypeId), id, method.name, method.isCtor, method.arity, encodeFacts(method.facts));
    }
    if (!existing || options.edges !== "keep") syncStaticEdges(db, id, bundle.edges, existing !== undefined);
    const names = new Set(typeReferenceNames(bundle).map(name => internSym(db, name)));
    if (existing) {
      const deleteRefName = prepareCached(db, "DELETE FROM type_ref_name WHERE name_sym=? AND file_id=?");
      for (const stored of prepareCached(db, "SELECT name_sym AS sym FROM type_ref_name WHERE file_id=?").all(id) as Array<{ sym: number }>) {
        if (!names.delete(Number(stored.sym))) deleteRefName.run(stored.sym, id);
      }
    }
    const insertRefName = prepareCached(db, "INSERT OR IGNORE INTO type_ref_name(name_sym, file_id) VALUES (?, ?)");
    for (const name of names) insertRefName.run(name, id);
    return id;
  });
}

function dropMissingMembers(db: IndexDatabase, table: "type" | "field" | "method", fileId: number, keep: readonly number[]): void {
  const wanted = new Set(keep);
  const drop = prepareCached(db, `DELETE FROM ${table} WHERE sym=?`);
  for (const stored of prepareCached(db, `SELECT sym FROM ${table} WHERE file_id=?`).all(fileId) as Array<{ sym: number }>) {
    if (!wanted.has(Number(stored.sym))) drop.run(stored.sym);
  }
}

/**
 * Makes one file's static edges exactly `edges`. An edge keeps its row while
 * its identity (kind, endpoints, range) is unchanged; only a changed
 * resolution rewrites it, and a rewrite alone (same facts, new generation)
 * writes nothing.
 */
/** Writes only the difference to the file's stored edges; true when any row changed. */
function syncStaticEdges(db: IndexDatabase, fileId: number, edges: readonly StaticEdge[], existed: boolean): boolean {
  let changed = false;
  const stale = new Map<string, { id: number; confidence: number; resKind: number; resStrategy: number | null }>();
  if (existed) {
    for (const row of prepareCached(
      db,
      `SELECT e.id AS id, kind_sym, from_sym, to_sym, sl, sc, el, ec, confidence, res_kind_sym, res_strategy_sym, fs.text AS from_text, ts.text AS to_text
       FROM edge e JOIN sym fs ON fs.id=e.from_sym JOIN sym ts ON ts.id=e.to_sym WHERE e.file_id=?`
    ).all(fileId) as Array<Record<string, number | string | null>>) {
      // The new edge set mostly repeats these endpoints.
      rememberSyms(db, [{ text: row.from_text, id: row.from_sym }, { text: row.to_text, id: row.to_sym }]);
      stale.set([row.kind_sym, row.from_sym, row.to_sym, row.sl, row.sc, row.el, row.ec].join(":"), {
        id: Number(row.id), confidence: Number(row.confidence), resKind: Number(row.res_kind_sym),
        resStrategy: row.res_strategy_sym == null ? null : Number(row.res_strategy_sym)
      });
    }
  }
  const update = prepareCached(db, "UPDATE edge SET confidence=?, res_kind_sym=?, res_strategy_sym=?, generation=? WHERE id=?");
  for (const edge of edges) {
    const [sl, sc, el, ec] = rangeColumns(edge.range);
    const kindSym = internSym(db, edge.kind);
    const fromSym = internSym(db, edge.fromId);
    const toSym = internSym(db, edge.toId);
    const resKind = internSym(db, edge.resolution.kind);
    const resStrategy = internSymNullable(db, edge.resolution.typeStrategy);
    const key = [kindSym, fromSym, toSym, sl, sc, el, ec].join(":");
    const old = stale.get(key);
    if (old) {
      stale.delete(key);
      if (old.confidence !== edge.confidence || old.resKind !== resKind || old.resStrategy !== resStrategy) {
        update.run(edge.confidence, resKind, resStrategy, edge.generation, old.id);
        changed = true;
      }
      continue;
    }
    // The upsert takes over a row another file wrote (duplicate FQNs): that file's kept bundle is stale.
    if (memos.has(db)) forgetEdgeHolder(db, [kindSym, fromSym, toSym, sl, sc, el, ec], fileId);
    insertStaticEdge(db, edge, fileId);
    changed = true;
  }
  const drop = prepareCached(db, "DELETE FROM edge WHERE id=?");
  for (const old of stale.values()) drop.run(old.id);
  return changed || stale.size > 0;
}

function forgetEdgeHolder(db: IndexDatabase, key: readonly (number | null)[], fileId: number): void {
  const holder = prepareCached(db,
    "SELECT f.path AS path FROM edge e JOIN file f ON f.id=e.file_id WHERE e.kind_sym=? AND e.from_sym=? AND e.to_sym=? AND e.sl IS ? AND e.sc IS ? AND e.el IS ? AND e.ec IS ? AND e.file_id<>?"
  ).get(...key, fileId) as { path: string } | undefined;
  if (holder) memos.get(db)?.bundles.delete(holder.path);
}

/** Records that a resource XML (mapper or not) with this content was examined. Its stat lives in the workspace store. */
export function recordResourceScan(db: IndexDatabase, relativePath: string, contentHash: string): void {
  prepareCached(
    db,
    `INSERT INTO resource_scan(path, content_hash) VALUES (?, ?)
     ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash WHERE content_hash<>excluded.content_hash`
  ).run(relativePath, contentHash);
}

export function deleteResourceScan(db: IndexDatabase, relativePath: string): void {
  prepareCached(db, "DELETE FROM resource_scan WHERE path=?").run(relativePath);
}

const REF_IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Identifiers a file uses where a type name can appear: every
 * type reference (text, simple and qualified name, type arguments), import,
 * call receiver text and annotation name. Over-approximate on purpose: the
 * set only decides which files an incremental refresh re-resolves.
 */
export function typeReferenceNames(bundle: JavaFileBundle): string[] {
  const names = new Set<string>();
  const addText = (text: unknown) => {
    if (typeof text !== "string") return;
    // Case-sensitive, as Java names are: a `scope` receiver is not type `Scope`.
    for (const match of text.matchAll(REF_IDENTIFIER)) names.add(match[0]);
  };
  const visit = (value: unknown, parentKey: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentKey);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if ("resolution" in record && typeof record.simpleName === "string") {
      addText(record.text);
      addText(record.simpleName);
      addText(record.qualifiedName);
    }
    if (parentKey === "annotations") addText(record.name);
    // `new N()` binds N from its text when edges are built.
    if (record.kind === "CONSTRUCTOR_INVOCATION") addText(record.name);
    addText(record.receiverText);
    for (const [key, child] of Object.entries(record)) {
      if (child && typeof child === "object") visit(child, key);
    }
  };
  for (const entry of bundle.file.imports) addText(entry.qualifiedName);
  visit(bundle.types, "types");
  visit(bundle.fields, "fields");
  visit(bundle.methods, "methods");
  return [...names].sort();
}

function fileIdByPath(db: IndexDatabase, path: string): number {
  const row = prepareCached(db, "SELECT id FROM file WHERE path=?").get(path);
  if (!row) throw new Error(`file not found: ${path}`);
  return asRowId(row.id as number | bigint);
}

/** Rewrites one file's facts in place; true when any row changed. */
export function updateBundleFacts(db: IndexDatabase, bundle: JavaFileBundle): boolean {
  forgetBundle(db, bundle);
  return runInWriteTx(db, () => {
    const id = fileIdByPath(db, bundle.file.relativePath);
    const row = fileRow(bundle);
    // A dependent whose resolution did not change re-encodes the same bytes;
    // the guards keep such a refresh from writing any page.
    const facts = encodeFacts(row.facts);
    let changes = 0;
    const count = (result: { changes: number | bigint }) => { changes += Number(result.changes); };
    count(prepareCached(db, "UPDATE file SET facts=?, parse_state=?, generation=? WHERE id=? AND (facts IS NOT ? OR parse_state IS NOT ?)").run(
      facts,
      row.parseState,
      row.generation,
      id,
      facts,
      row.parseState
    ));
    const updateType = prepareCached(db, "UPDATE type SET facts=?, fqn=? WHERE sym=? AND (facts IS NOT ? OR fqn IS NOT ?)");
    for (const type of typeRows(bundle)) {
      const blob = encodeFacts(type.facts);
      count(updateType.run(blob, type.fqn, internSym(db, type.typeId), blob, type.fqn));
    }
    const updateField = prepareCached(db, "UPDATE field SET facts=? WHERE sym=? AND facts IS NOT ?");
    for (const field of fieldRows(bundle)) {
      const blob = encodeFacts(field.facts);
      count(updateField.run(blob, internSym(db, field.fieldId), blob));
    }
    const updateMethod = prepareCached(db, "UPDATE method SET facts=?, arity=? WHERE sym=? AND (facts IS NOT ? OR arity IS NOT ?)");
    for (const method of methodRows(bundle)) {
      const blob = encodeFacts(method.facts);
      count(updateMethod.run(blob, method.arity, internSym(db, method.methodId), blob, method.arity));
    }
    return changes > 0;
  });
}

/** Replaces one file's static edges by difference; true when any row changed. */
export function replaceBundleEdges(db: IndexDatabase, filePath: string, edges: readonly StaticEdge[]): boolean {
  memos.get(db)?.bundles.delete(filePath);
  return runInWriteTx(db, () => syncStaticEdges(db, fileIdByPath(db, filePath), edges, true));
}

/**
 * One job's reads of a file's bundle, kept until a write touches the rows it
 * was read from: the file row and its edges (by path), and its members (by
 * id, since a member row can move between files). A rollback drops it all.
 * Callers treat bundles as immutable, so a kept one is shared.
 */
type BundleMemo = { bundles: Map<string, JavaFileBundle | undefined>; memberPaths: Map<string, string> };
const memos = new WeakMap<IndexDatabase, BundleMemo>();
const memoRollbackHooked = new WeakSet<IndexDatabase>();

/** Keeps readBundle's results on this connection until endBundleMemo. Only the
 * connection's writer may hold one: other writers' rows are not seen. */
export function beginBundleMemo(db: IndexDatabase): void {
  if (!memos.has(db) && decodeScopes++ === 0) decoded = new BoundedCache(DECODED_LIMIT);
  memos.set(db, { bundles: new Map(), memberPaths: new Map() });
  if (memoRollbackHooked.has(db)) return;
  memoRollbackHooked.add(db);
  onRollback(db, () => {
    const memo = memos.get(db);
    memo?.bundles.clear();
    memo?.memberPaths.clear();
  });
}

export function endBundleMemo(db: IndexDatabase): void {
  if (memos.delete(db) && --decodeScopes === 0) decoded = undefined;
}

/** Drops the kept bundle of a path about to be written or deleted, and of every file holding one of `bundle`'s members. */
export function forgetBundle(db: IndexDatabase, target: string | JavaFileBundle): void {
  const memo = memos.get(db);
  if (!memo) return;
  if (typeof target === "string") { memo.bundles.delete(target); return; }
  memo.bundles.delete(target.file.relativePath);
  for (const id of memberIdsOf(target)) {
    const holder = memo.memberPaths.get(id);
    if (holder !== undefined) memo.bundles.delete(holder);
  }
}

function memberIdsOf(bundle: JavaFileBundle): string[] {
  return [...bundle.types.map(type => type.typeId), ...bundle.fields.map(field => field.fieldId), ...bundle.methods.map(method => method.methodId)];
}

export function readBundle(db: IndexDatabase, path: string): JavaFileBundle | undefined {
  const memo = memos.get(db);
  if (memo?.bundles.has(path)) return memo.bundles.get(path);
  let foreign = false;
  const bundle = readBundleRows(db, path, () => { foreign = true; });
  // A member read by id from another file's rows is not tracked: not kept.
  if (memo && !foreign) {
    memo.bundles.set(path, bundle);
    if (bundle) for (const id of memberIdsOf(bundle)) memo.memberPaths.set(id, path);
  }
  return bundle;
}

function readBundleRows(db: IndexDatabase, path: string, onForeign: () => void): JavaFileBundle | undefined {
  const file = prepareCached(db, "SELECT id, facts FROM file WHERE path=?").get(path);
  if (!file) return undefined;
  const fileId = asRowId(file.id as number | bigint);
  const fileFacts = decodeFacts<JavaFileFacts>(file.facts);
  // One read per member table of the rows this file owns, by id text (sym is
  // unique per text). An id stored under another file is still read by id.
  const owned = (table: "type" | "field" | "method") => new Map((prepareCached(db,
    `SELECT s.text AS id, m.facts AS facts FROM ${table} m JOIN sym s ON s.id=m.sym WHERE m.file_id=?`).all(fileId) as Array<{ id: string; facts: SQLOutputValue }>)
    .map(row => [row.id, row.facts] as const));
  const rows = { type: owned("type"), field: owned("field"), method: owned("method") };
  const member = <T>(table: "type" | "field" | "method", id: string): T | undefined =>
    rows[table].has(id) ? decodeFacts<T>(rows[table].get(id)!) : (onForeign(), lookupMemberFacts<T>(db, table, id));
  const types: JavaTypeFacts[] = [];
  const fields: JavaFieldFacts[] = [];
  const methods: JavaMethodFacts[] = [];
  const seenField = new Set<string>();
  const seenMethod = new Set<string>();
  for (const typeId of fileFacts.allTypeIds) {
    const type = member<JavaTypeFacts>("type", typeId);
    if (!type) continue;
    types.push(type);
    for (const fieldId of type.fieldIds) {
      if (seenField.has(fieldId)) continue;
      const field = member<JavaFieldFacts>("field", fieldId);
      if (field) {
        seenField.add(fieldId);
        fields.push(field);
      }
    }
    for (const methodId of type.methodIds) {
      if (seenMethod.has(methodId)) continue;
      const method = member<JavaMethodFacts>("method", methodId);
      if (method) {
        seenMethod.add(methodId);
        methods.push(method);
      }
    }
  }
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
  const sym = symId(db, id);
  if (sym === undefined) return undefined;
  const row = prepareCached(db, `SELECT facts FROM ${table} WHERE sym=?`).get(sym);
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
