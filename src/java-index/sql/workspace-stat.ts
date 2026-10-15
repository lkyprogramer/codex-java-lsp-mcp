import path from "node:path";
import type { FileStat, JavaFileBundle } from "../index-types.js";
import { indexDbPath, isMemoryPath, isReadOnlyConnection, prepareCached, withTransaction, type IndexDatabase } from "./driver.js";

// Filesystem stat belongs to one workspace, not to the shared facts database.
// It lives in a sibling file attached as `ws`, so restamping after a checkout,
// worktree copy or root move writes no facts page. A stat row only short-cuts
// hashing: it is trusted when size/mtime match the file AND its content_hash
// equals the hash the facts database recorded for that path.
export const WORKSPACE_STAT_FILE = "workspace-stat.sqlite";
const STAT_SCHEMA_VERSION = 1;
const attached = new WeakSet<IndexDatabase>();

export type StatKind = "java" | "resource";
export type { FileStat };
export type StatRow = FileStat & { path: string; contentHash: string };

export function workspaceStatPath(factsPath: string): string {
  return isMemoryPath(factsPath) ? ":memory:" : path.join(path.dirname(factsPath), WORKSPACE_STAT_FILE);
}

/** Attaches the workspace stat store; call outside any transaction (ATTACH cannot run inside one). */
export function attachWorkspaceStat(db: IndexDatabase): void {
  if (attached.has(db)) return;
  const factsPath = indexDbPath(db);
  if (factsPath === undefined) throw new Error("workspace stat needs a connection from openIndexDb");
  if (isReadOnlyConnection(db)) throw new Error("workspace stat is written only by the builder connection");
  db.prepare("ATTACH DATABASE ? AS ws").run(workspaceStatPath(factsPath));
  try {
    initializeStatStore(db, factsPath);
  } catch (error) {
    // Leave the connection as it was, so a later attach can retry (e.g. after SQLITE_BUSY).
    try { db.exec("DETACH DATABASE ws"); } catch { /* already detached */ }
    throw error;
  }
  attached.add(db);
}

function initializeStatStore(db: IndexDatabase, factsPath: string): void {
  // A lost stat commit only costs a re-hash, so it needs no fsync per transaction.
  if (!isMemoryPath(factsPath)) db.exec("PRAGMA ws.journal_mode=WAL; PRAGMA ws.synchronous=NORMAL; PRAGMA ws.journal_size_limit=4194304");
  const version = () => Number((db.prepare("PRAGMA ws.user_version").get() as { user_version: number }).user_version);
  if (version() !== STAT_SCHEMA_VERSION) {
    // Re-checked under the write lock: two connections attaching a fresh store
    // must not both drop and recreate it.
    withTransaction(db, () => {
      if (version() === STAT_SCHEMA_VERSION) return;
      // Stat is a pure cache; an unknown layout is dropped, never migrated.
      db.exec(`DROP TABLE IF EXISTS ws.file_stat;
        CREATE TABLE ws.file_stat(path TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('java','resource')),
          content_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL) WITHOUT ROWID;
        PRAGMA ws.user_version=${STAT_SCHEMA_VERSION};`);
    });
  }
}

function requireAttached(db: IndexDatabase): void {
  if (!attached.has(db)) throw new Error("workspace stat store is not attached");
}

export function readStats(db: IndexDatabase, kind: StatKind): Map<string, StatRow> {
  requireAttached(db);
  const rows = prepareCached(
    db,
    "SELECT path, content_hash AS contentHash, size, mtime_ms AS mtimeMs, ctime_ms AS ctimeMs FROM ws.file_stat WHERE kind=?"
  ).all(kind) as StatRow[];
  return new Map(rows.map(row => [row.path, { ...row }]));
}

export function recordStats(db: IndexDatabase, kind: StatKind, rows: Iterable<StatRow>): void {
  requireAttached(db);
  const stmt = prepareCached(
    db,
    `INSERT INTO ws.file_stat(path, kind, content_hash, size, mtime_ms, ctime_ms) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, content_hash=excluded.content_hash,
       size=excluded.size, mtime_ms=excluded.mtime_ms, ctime_ms=excluded.ctime_ms`
  );
  for (const row of rows) stmt.run(row.path, kind, row.contentHash, row.size, row.mtimeMs, row.ctimeMs);
}

export function deleteStats(db: IndexDatabase, paths: Iterable<string>): void {
  requireAttached(db);
  const stmt = prepareCached(db, "DELETE FROM ws.file_stat WHERE path=?");
  for (const relativePath of paths) stmt.run(relativePath);
}

export function clearStats(db: IndexDatabase, kind?: StatKind): void {
  requireAttached(db);
  if (kind) prepareCached(db, "DELETE FROM ws.file_stat WHERE kind=?").run(kind);
  else db.exec("DELETE FROM ws.file_stat");
}

/** Equal size and mtime (sub-ms tolerance for filesystems that round) against a stat taken now. */
export function statUnchanged(previous: FileStat | undefined, current: { size: number; mtimeMs: number }): boolean {
  return previous !== undefined && previous.size === current.size && Math.abs(previous.mtimeMs - current.mtimeMs) <= 0.5;
}

export function fileStatOf(info: { size: number; mtimeMs: number; ctimeMs: number }): FileStat {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

/** Stat rows for freshly parsed bundles; a bundle whose file changed while it was read has none. */
export function observedStats(bundles: readonly JavaFileBundle[]): StatRow[] {
  return bundles.flatMap(bundle => bundle.observed ? [{ path: bundle.file.relativePath, contentHash: bundle.file.contentHash, ...bundle.observed }] : []);
}
