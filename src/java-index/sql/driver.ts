import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const DEFAULT_SQLITE_CACHE_KB = 32768;

export type OpenIndexDbOptions = {
  readOnly?: boolean;
  cacheKb?: number;
};

export type IndexDatabase = DatabaseSync;

const statementCache = new WeakMap<IndexDatabase, Map<string, StatementSync>>();

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file:");
}

function resolveCacheKb(cacheKb: number | undefined): number {
  if (typeof cacheKb === "number" && Number.isFinite(cacheKb) && cacheKb > 0) {
    return Math.floor(cacheKb);
  }
  const fromEnv = Number(process.env.JAVA_LSP_SQLITE_CACHE_KB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_SQLITE_CACHE_KB;
}

export function openIndexDb(path: string, options: OpenIndexDbOptions = {}): IndexDatabase {
  if (!options.readOnly && !isMemoryPath(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  const cacheKb = resolveCacheKb(options.cacheKb);
  if (!options.readOnly) {
    // auto_vacuum is a create-time file setting; applying WAL first freezes it at NONE.
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
  }
  db.exec(`PRAGMA cache_size=-${cacheKb}`);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA temp_store=MEMORY");
  return db;
}

export function withTransaction<T>(db: IndexDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection may already have aborted the transaction.
    }
    throw error;
  }
}

export function prepareCached(db: IndexDatabase, sql: string): StatementSync {
  let cached = statementCache.get(db);
  if (!cached) {
    cached = new Map();
    statementCache.set(db, cached);
  }
  const hit = cached.get(sql);
  if (hit) return hit;
  const statement = db.prepare(sql);
  cached.set(sql, statement);
  return statement;
}

export function forgetPrepared(db: IndexDatabase): void {
  statementCache.delete(db);
}

export function close(db: IndexDatabase): void {
  forgetPrepared(db);
  db.close();
}
