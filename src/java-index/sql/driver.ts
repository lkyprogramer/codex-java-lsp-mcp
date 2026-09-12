import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const DEFAULT_SQLITE_CACHE_KB = 32768;
/** SQLite default; kept explicit so write connections always autocheckpoint. */
export const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1000;
/** After a successful checkpoint, cap leftover WAL (bytes). */
export const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** node:sqlite compile-time SQLITE_MAX_VARIABLE_NUMBER. */
export const SQLITE_MAX_VARIABLE_NUMBER = 32766;

export function inClause(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`inClause count must be a positive integer, got ${String(count)}`);
  }
  return `(${Array.from({ length: count }, () => "?").join(",")})`;
}

export function* bindChunks<T>(values: readonly T[], extraBinds = 0): Generator<T[]> {
  const extra = Number.isFinite(extraBinds) && extraBinds > 0 ? Math.floor(extraBinds) : 0;
  const size = Math.max(1, SQLITE_MAX_VARIABLE_NUMBER - extra);
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size);
  }
}

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
  db.exec(`PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS}`);
  const cacheKb = resolveCacheKb(options.cacheKb);
  if (!options.readOnly) {
    // auto_vacuum is a create-time file setting; applying WAL first freezes it at NONE.
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(`PRAGMA wal_autocheckpoint=${DEFAULT_WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec(`PRAGMA journal_size_limit=${DEFAULT_JOURNAL_SIZE_LIMIT_BYTES}`);
  }
  db.exec(`PRAGMA cache_size=-${cacheKb}`);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA temp_store=MEMORY");
  return db;
}

export function checkpointWal(db: IndexDatabase, mode: "PASSIVE" | "TRUNCATE" | "RESTART" = "PASSIVE"): void {
  try {
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
  } catch {
    // Readonly connections and SQLITE_BUSY writers cannot checkpoint.
  }
}

/** Open a writer just long enough to truncate WAL after the last reader drops. */
export function compactWalFile(dbPath: string): void {
  if (isMemoryPath(dbPath) || !existsSync(dbPath)) return;
  try {
    const db = openIndexDb(dbPath);
    close(db);
  } catch {
    // Another writer (builder) owns the file; the next close will truncate.
  }
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
  checkpointWal(db, "TRUNCATE");
  db.close();
}
