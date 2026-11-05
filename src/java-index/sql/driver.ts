import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const DEFAULT_SQLITE_CACHE_KB = 32768;
/** SQLite default; kept explicit so write connections always autocheckpoint. */
export const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1000;
/** After a successful checkpoint, cap leftover WAL (bytes). */
export const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/**
 * A new file's page size: APFS unshares a cloned file in 16 KiB units, so a delta's scattered 4 KiB page
 * writes would each pay for four.
 */
export const DEFAULT_PAGE_SIZE_BYTES = 16384;

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
// Read-only connections never checkpoint: a checkpoint takes the WAL writer
// lock (and waits busy_timeout for it), which a reader in the MCP process must
// never contend for while the builder child is writing.
const readOnlyConnections = new WeakSet<IndexDatabase>();
const connectionPaths = new WeakMap<IndexDatabase, string>();

export function indexDbPath(db: IndexDatabase): string | undefined {
  return connectionPaths.get(db);
}

export function isReadOnlyConnection(db: IndexDatabase): boolean {
  return readOnlyConnections.has(db);
}

export function isMemoryPath(path: string): boolean {
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

/** A published mac1 snapshot (contract §2.7): never opened by a writer. */
export function isSealedSnapshotPath(path: string): boolean {
  return /(^|\/)mac1\/snapshots\//.test(path);
}

export function openIndexDb(path: string, options: OpenIndexDbOptions = {}): IndexDatabase {
  if (!options.readOnly && isSealedSnapshotPath(path)) throw new Error("sealed snapshots are read-only");
  if (!options.readOnly && !isMemoryPath(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  if (options.readOnly === true) readOnlyConnections.add(db);
  connectionPaths.set(db, path);
  db.exec(`PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS}`);
  const cacheKb = resolveCacheKb(options.cacheKb);
  if (!options.readOnly) {
    // page_size, like auto_vacuum, only takes on a file nothing has written yet; an existing file keeps its own.
    db.exec(`PRAGMA page_size=${DEFAULT_PAGE_SIZE_BYTES}`);
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

/** A SEALED snapshot reader: read-only and SQLite immutable (no locks, no WAL/SHM), registered like any reader. */
export function openImmutableIndexDb(path: string, options: { cacheKb?: number } = {}): IndexDatabase {
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  url.searchParams.set("mode", "ro");
  const db = new DatabaseSync(url.href, { readOnly: true });
  readOnlyConnections.add(db);
  connectionPaths.set(db, path);
  db.exec(`PRAGMA cache_size=-${resolveCacheKb(options.cacheKb)}`);
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

/**
 * Truncate WAL after the last reader drops. Only a bare checkpoint: the
 * openIndexDb writer pragmas (auto_vacuum) commit a transaction, which breaks
 * any other connection's read snapshot. Never waits: a busy writer means the
 * builder owns the file and truncates on its own close.
 */
export function compactWalFile(dbPath: string): void {
  if (isMemoryPath(dbPath) || !existsSync(dbPath)) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout=0");
      checkpointWal(db, "TRUNCATE");
    } finally {
      db.close();
    }
  } catch {
    // Another connection holds the file; the next writer close will truncate.
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
    for (const hook of rollbackHooks.get(db) ?? []) hook();
    throw error;
  }
}

/** Keeps asynchronous capture/stages inside one writer transaction when serving
 * still reads this inode. Never pass an async callback to withTransaction. */
export async function withAsyncTransaction<T>(db: IndexDatabase, fn: () => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value=await fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {db.exec("ROLLBACK");} catch { /* original failure wins */ }
    for(const hook of rollbackHooks.get(db) ?? []) hook();
    throw error;
  }
}

const rollbackHooks = new WeakMap<IndexDatabase, Set<() => void>>();

/** Per-connection caches of rows written inside a transaction register here to forget them on rollback. */
export function onRollback(db: IndexDatabase, hook: () => void): void {
  let hooks = rollbackHooks.get(db);
  if (!hooks) {
    hooks = new Set();
    rollbackHooks.set(db, hooks);
  }
  hooks.add(hook);
}

export function rollbackHookCountForTesting(db: IndexDatabase): number {
  return rollbackHooks.get(db)?.size ?? 0;
}

/**
 * Runs read-only work on one WAL snapshot (BEGIN DEFERRED takes the read
 * snapshot at the first SELECT). Nested inside an open transaction it simply
 * joins it.
 */
export function withReadSnapshot<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    try {
      db.exec("COMMIT");
    } catch {
      // A read transaction has nothing to lose; never mask fn()'s outcome.
      try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    }
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
  if (!readOnlyConnections.has(db)) {
    // Best effort and non-blocking: with a reader still open the truncate
    // simply fails and a later close or compactWalFile retries it.
    try {
      db.exec("PRAGMA busy_timeout=0");
    } catch {
      // keep closing
    }
    checkpointWal(db, "TRUNCATE");
  }
  db.close();
}
