import type { EntityRecord } from "../entity-search.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { decodeFacts, encodeFacts } from "./rows.js";

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
}

function tokenTf(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function insertTokenField(db: IndexDatabase, entityId: string, field: "identifier" | "chunk", tokens: readonly string[]): void {
  const insert = prepareCached(
    db,
    "INSERT INTO entity_token(entity_id, field, token, tf) VALUES (?, ?, ?, ?)"
  );
  for (const [token, tf] of tokenTf(tokens)) {
    insert.run(entityId, field, token, tf);
  }
}

export function writeEntityRecord(db: IndexDatabase, record: EntityRecord): void {
  runInWriteTx(db, () => {
    prepareCached(db, "DELETE FROM entity_token WHERE entity_id=?").run(record.entityId);
    prepareCached(
      db,
      `INSERT INTO entity(entity_id, kind, fqn, simple_name_lc, relative_path, owner_file, ident_len, chunk_len, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         kind=excluded.kind, fqn=excluded.fqn, simple_name_lc=excluded.simple_name_lc,
         relative_path=excluded.relative_path, owner_file=excluded.owner_file,
         ident_len=excluded.ident_len, chunk_len=excluded.chunk_len, facts=excluded.facts`
    ).run(
      record.entityId,
      record.kind,
      record.fqn,
      record.simpleName.toLowerCase(),
      record.relativePath,
      record.relativePath,
      record.identifierTokens.length,
      record.chunkTokens.length,
      encodeFacts(record)
    );
    insertTokenField(db, record.entityId, "identifier", record.identifierTokens);
    insertTokenField(db, record.entityId, "chunk", record.chunkTokens);
  });
}

export function rebuildEntityDf(db: IndexDatabase): void {
  db.exec("PRAGMA temp_store=FILE");
  try {
    runInWriteTx(db, () => {
      db.exec("DELETE FROM entity_df");
      db.exec("INSERT INTO entity_df(field, token, df) SELECT field, token, count(*) FROM entity_token GROUP BY field, token");
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
  const rows = prepareCached(db, "SELECT facts FROM entity ORDER BY entity_id").all();
  return rows.map(row => decodeFacts<EntityRecord>(row.facts));
}
