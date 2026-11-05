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

function fieldTf(db: IndexDatabase, field: number, tokens: readonly string[], into: Map<string, { field: number; token: number; tf: number }>): void {
  for (const [token, tf] of tokenTf(tokens)) {
    const sym = internSym(db, token);
    into.set(`${field}:${sym}`, { field, token: sym, tf });
  }
}

/**
 * Makes the entities owned by one file exactly `records`, writing only
 * differences (rows and postings), so an edit that leaves a declaration's
 * tokens alone does not touch its posting pages. DF and the corpus stats are
 * the caller's (withEntitySearchDelta).
 */
export function replaceEntitiesForPath(db: IndexDatabase, relativePath: string, records: readonly EntityRecord[]): void {
  runInWriteTx(db, () => {
    const ownerSym = internSym(db, relativePath);
    const stale = new Set((prepareCached(db, "SELECT sym FROM entity WHERE owner_sym=?").all(ownerSym) as Array<{ sym: number }>).map(row => Number(row.sym)));
    const latest = new Map<string, EntityRecord>();
    for (const record of records) latest.set(record.entityId, record);
    const readRow = prepareCached(db, "SELECT kind, fqn, simple_name AS simpleName, path_sym AS pathSym, owner_sym AS ownerSym, ident_len AS identLen, chunk_len AS chunkLen FROM entity WHERE sym=?");
    const upsert = prepareCached(
      db,
      `INSERT INTO entity(sym, kind, fqn, simple_name, simple_name_lc, path_sym, owner_sym, ident_len, chunk_len)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sym) DO UPDATE SET
         kind=excluded.kind, fqn=excluded.fqn, simple_name=excluded.simple_name,
         simple_name_lc=excluded.simple_name_lc, path_sym=excluded.path_sym, owner_sym=excluded.owner_sym,
         ident_len=excluded.ident_len, chunk_len=excluded.chunk_len`
    );
    const readTokens = prepareCached(db, "SELECT field, token_sym AS token, tf FROM entity_token WHERE entity_sym=?");
    const insertToken = prepareCached(db, "INSERT INTO entity_token(entity_sym, field, token_sym, tf) VALUES (?, ?, ?, ?)");
    const updateToken = prepareCached(db, "UPDATE entity_token SET tf=? WHERE entity_sym=? AND field=? AND token_sym=?");
    const deleteToken = prepareCached(db, "DELETE FROM entity_token WHERE entity_sym=? AND field=? AND token_sym=?");
    for (const record of latest.values()) {
      const entitySym = internSym(db, record.entityId);
      stale.delete(entitySym);
      const pathSym = internSymNullable(db, record.relativePath);
      const row = readRow.get(entitySym) as Record<string, unknown> | undefined;
      // Entity ids are path-qualified; one owned elsewhere would leave the
      // delta's df/stats snapshot (withEntitySearchDelta) counting it twice.
      if (row?.ownerSym != null && Number(row.ownerSym) !== ownerSym) throw new Error(`entity ${record.entityId} is owned by another path`);
      const same = row !== undefined && row.kind === record.kind && row.fqn === record.fqn && row.simpleName === record.simpleName
        && (row.pathSym == null ? null : Number(row.pathSym)) === pathSym && (row.ownerSym == null ? null : Number(row.ownerSym)) === pathSym
        && Number(row.identLen) === record.identifierTokens.length && Number(row.chunkLen) === record.chunkTokens.length;
      if (!same) {
        upsert.run(entitySym, record.kind, record.fqn, record.simpleName, record.simpleName.toLowerCase(), pathSym, pathSym,
          record.identifierTokens.length, record.chunkTokens.length);
      }
      const wanted = new Map<string, { field: number; token: number; tf: number }>();
      fieldTf(db, FIELD_IDENTIFIER, record.identifierTokens, wanted);
      fieldTf(db, FIELD_CHUNK, record.chunkTokens, wanted);
      for (const stored of readTokens.all(entitySym) as Array<{ field: number; token: number; tf: number }>) {
        const key = `${Number(stored.field)}:${Number(stored.token)}`;
        const next = wanted.get(key);
        if (!next) deleteToken.run(entitySym, stored.field, stored.token);
        else if (next.tf !== Number(stored.tf)) updateToken.run(next.tf, entitySym, stored.field, stored.token);
        wanted.delete(key);
      }
      for (const next of wanted.values()) insertToken.run(entitySym, next.field, next.token, next.tf);
    }
    const deleteEntity = prepareCached(db, "DELETE FROM entity WHERE sym=?");
    for (const sym of stale) deleteEntity.run(sym);
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
      // T07: corpus normalization stats ride the same writer transaction as
      // the df table, so both are consistent for every published generation.
      commitEntityStats(db);
    });
  } finally {
    db.exec("PRAGMA temp_store=MEMORY");
  }
}

export const ENTITY_STATS_KEYS = { identifier: "entityStats:identifier", chunk: "entityStats:chunk" } as const;

/** Publishes per-field docCount/totalLen so queries never scan the entity table. */
export function commitEntityStats(db: IndexDatabase): void {
  const identifier = entityFieldStats(db, "ident_len");
  const chunk = entityFieldStats(db, "chunk_len");
  const upsert = prepareCached(
    db,
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );
  upsert.run(ENTITY_STATS_KEYS.identifier, `${identifier.count}:${identifier.total}`);
  upsert.run(ENTITY_STATS_KEYS.chunk, `${chunk.count}:${chunk.total}`);
}

function entityFieldStats(db: IndexDatabase, column: "ident_len" | "chunk_len"): { count: number; total: number } {
  const row = prepareCached(db, `SELECT count(*) AS c, coalesce(sum(${column}), 0) AS t FROM entity`).get() as
    | { c: number | bigint; t: number | bigint }
    | undefined;
  return { count: Number(row?.c ?? 0), total: Number(row?.t ?? 0) };
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

/** Recompute only postings touched by one delta, preserving unrelated DF pages. */
export function withEntitySearchDelta(db: IndexDatabase, paths: readonly string[], write: () => void): void {
  const collect = () => {
    let count = 0, identifier = 0, chunk = 0;
    const postings=new Map<string,{field:number;token:number;count:number}>();
    for (const relativePath of new Set(paths)) {
      const pathSym = internSym(db, relativePath);
      const rows = prepareCached(db, "SELECT sym, ident_len, chunk_len FROM entity WHERE owner_sym=?").all(pathSym) as Array<{sym:number;ident_len:number;chunk_len:number}>;
      for (const row of rows) {
        count++; identifier += row.ident_len; chunk += row.chunk_len;
        for (const token of prepareCached(db,"SELECT field,token_sym FROM entity_token WHERE entity_sym=?").all(row.sym) as Array<{field:number;token_sym:number}>) {
          const key=`${token.field}:${token.token_sym}`;
          const posting=postings.get(key);
          if(posting) posting.count++; else postings.set(key,{field:token.field,token:token.token_sym,count:1});
        }
      }
    }
    return {count,identifier,chunk,postings};
  };
  runInWriteTx(db, () => {
    const before = collect(); write(); const after = collect();
    // One posting row is one document occurrence, regardless of its TF.
    for (const key of new Set([...before.postings.keys(),...after.postings.keys()])) {
      const old=before.postings.get(key),next=after.postings.get(key);
      const delta=(next?.count??0)-(old?.count??0);
      if(delta===0) continue;
      const {field,token}=next??old!;
      const row=prepareCached(db,"SELECT df FROM entity_df WHERE field=? AND token_sym=?").get(field,token) as {df:number}|undefined;
      const previous=row?.df??0;const df=previous+delta;
      if(!Number.isSafeInteger(df) || previous<(old?.count??0) || df<0) throw new Error("inconsistent entity posting DF");
      if(df===0) prepareCached(db,"DELETE FROM entity_df WHERE field=? AND token_sym=?").run(field,token);
      else prepareCached(db,"INSERT INTO entity_df(field,token_sym,df) VALUES (?,?,?) ON CONFLICT(field,token_sym) DO UPDATE SET df=excluded.df").run(field,token,df);
    }
    for (const field of ["identifier","chunk"] as const) {
      const key=ENTITY_STATS_KEYS[field]; const row=prepareCached(db,"SELECT value FROM meta WHERE key=?").get(key) as {value:string}|undefined;
      if (!row) {commitEntityStats(db);break;}
      const [count,total]=row.value.split(":").map(Number);
      prepareCached(db,"UPDATE meta SET value=? WHERE key=? AND value<>?").run(`${count+after.count-before.count}:${total+after[field]-before[field]}`,key,`${count+after.count-before.count}:${total+after[field]-before[field]}`);
    }
  });
}
