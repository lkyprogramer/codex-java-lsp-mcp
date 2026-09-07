import type { EntityKind, EntityRecord } from "../entity-search.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { internSym, internSymNullable, symText } from "./sym.js";

const FIELD_IDENTIFIER = 0;
const FIELD_CHUNK = 1;

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
}

function tokenTf(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function insertTokenField(db: IndexDatabase, entitySym: number, field: number, tokens: readonly string[]): void {
  const insert = prepareCached(
    db,
    "INSERT INTO entity_token(entity_sym, field, token_sym, tf) VALUES (?, ?, ?, ?)"
  );
  for (const [token, tf] of tokenTf(tokens)) {
    insert.run(entitySym, field, internSym(db, token), tf);
  }
}

function expandTokens(db: IndexDatabase, entitySym: number, field: number): string[] {
  const out: string[] = [];
  for (const row of prepareCached(
    db,
    "SELECT token_sym AS tokenSym, tf AS tf FROM entity_token WHERE entity_sym=? AND field=?"
  ).iterate(entitySym, field)) {
    const token = symText(db, Number(row.tokenSym));
    const copies = Number(row.tf) || 0;
    for (let i = 0; i < copies; i += 1) out.push(token);
  }
  return out;
}

export function writeEntityRecord(db: IndexDatabase, record: EntityRecord): void {
  runInWriteTx(db, () => {
    const entitySym = internSym(db, record.entityId);
    prepareCached(db, "DELETE FROM entity_token WHERE entity_sym=?").run(entitySym);
    prepareCached(
      db,
      `INSERT INTO entity(sym, kind, fqn, simple_name, simple_name_lc, path_sym, owner_sym, ident_len, chunk_len)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         kind=excluded.kind, fqn=excluded.fqn, simple_name=excluded.simple_name,
         simple_name_lc=excluded.simple_name_lc, path_sym=excluded.path_sym, owner_sym=excluded.owner_sym,
         ident_len=excluded.ident_len, chunk_len=excluded.chunk_len`
    ).run(
      entitySym,
      record.kind,
      record.fqn,
      record.simpleName,
      record.simpleName.toLowerCase(),
      internSymNullable(db, record.relativePath),
      internSymNullable(db, record.relativePath),
      record.identifierTokens.length,
      record.chunkTokens.length
    );
    insertTokenField(db, entitySym, FIELD_IDENTIFIER, record.identifierTokens);
    insertTokenField(db, entitySym, FIELD_CHUNK, record.chunkTokens);
  });
}

export function rebuildEntityDf(db: IndexDatabase): void {
  db.exec("PRAGMA temp_store=FILE");
  try {
    runInWriteTx(db, () => {
      db.exec("DELETE FROM entity_df");
      db.exec(
        "INSERT INTO entity_df(field, token_sym, df) SELECT field, token_sym, count(*) FROM entity_token GROUP BY field, token_sym"
      );
    });
  } finally {
    db.exec("PRAGMA temp_store=MEMORY");
  }
}

export function replaceAllEntities(db: IndexDatabase, records: readonly EntityRecord[]): void {
  runInWriteTx(db, () => {
    db.exec("DELETE FROM entity_token; DELETE FROM entity_df; DELETE FROM entity;");
    for (const record of records) writeEntityRecord(db, record);
    rebuildEntityDf(db);
  });
}

export function readEntityRecords(db: IndexDatabase): EntityRecord[] {
  const rows = prepareCached(
    db,
    `SELECT e.sym AS sym, e.kind AS kind, e.fqn AS fqn, e.simple_name AS simpleName, e.path_sym AS pathSym
     FROM entity e JOIN sym s ON s.id=e.sym ORDER BY s.text`
  ).all();
  return rows.map(row => {
    const entitySym = Number(row.sym);
    const pathSym = row.pathSym == null ? undefined : Number(row.pathSym);
    return {
      entityId: symText(db, entitySym),
      kind: String(row.kind) as EntityKind,
      fqn: String(row.fqn),
      simpleName: String(row.simpleName),
      relativePath: pathSym === undefined ? "" : symText(db, pathSym),
      identifierTokens: expandTokens(db, entitySym, FIELD_IDENTIFIER),
      chunkTokens: expandTokens(db, entitySym, FIELD_CHUNK)
    };
  });
}
