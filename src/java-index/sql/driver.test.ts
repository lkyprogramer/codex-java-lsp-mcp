import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindChunks,
  close,
  compactWalFile,
  DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
  DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  inClause,
  openIndexDb,
  prepareCached,
  SQLITE_MAX_VARIABLE_NUMBER,
  withTransaction
} from "./driver.js";
import { SCHEMA_VERSION, ensureSchema } from "./schema.js";

function pragma(db: ReturnType<typeof openIndexDb>, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  assert.ok(row, `missing PRAGMA ${name}`);
  return row[name];
}

test("memory database applies connection pragmas, rolls back, and records schemaVersion", () => {
  const db = openIndexDb(":memory:", { cacheKb: 4096 });
  try {
    assert.equal(pragma(db, "cache_size"), -4096);
    assert.equal(pragma(db, "foreign_keys"), 1);
    assert.equal(pragma(db, "temp_store"), 2);
    assert.equal(pragma(db, "auto_vacuum"), 2);
    assert.equal(pragma(db, "synchronous"), 1);
    ensureSchema(db);
    const version = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'").get() as
      | { value: string }
      | undefined;
    assert.equal(version?.value, String(SCHEMA_VERSION));
    db.exec("CREATE TABLE scratch(id INTEGER PRIMARY KEY, v TEXT)");
    assert.throws(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO scratch(v) VALUES (?)").run("keep");
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM scratch").get()?.n, 0);
  } finally {
    close(db);
  }
});

test("file database enables WAL and incremental auto_vacuum", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-driver-"));
  const file = path.join(dir, "nested", "index.sqlite");
  const db = openIndexDb(file);
  try {
    assert.equal(pragma(db, "journal_mode"), "wal");
    assert.equal(pragma(db, "auto_vacuum"), 2);
    assert.equal(pragma(db, "synchronous"), 1);
    assert.equal(pragma(db, "cache_size"), -32768);
    assert.equal(pragma(db, "wal_autocheckpoint"), DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
    assert.equal(pragma(db, "journal_size_limit"), DEFAULT_JOURNAL_SIZE_LIMIT_BYTES);
    assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout?: number }).timeout, 5000);
    ensureSchema(db);
    const first = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'");
    const second = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'");
    assert.equal(first, second);
  } finally {
    close(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer close truncates WAL; a held reader can delay that until compactWalFile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-wal-"));
  const file = path.join(dir, "index.sqlite");
  const wal = `${file}-wal`;
  const writer = openIndexDb(file);
  ensureSchema(writer);
  withTransaction(writer, () => {
    writer.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = writer.prepare("INSERT INTO bulk(payload) VALUES (?)");
    const payload = "x".repeat(4096);
    for (let i = 0; i < 400; i += 1) insert.run(payload);
  });
  close(writer);
  assert.equal(existsSync(file), true);
  if (existsSync(wal)) {
    assert.ok(statSync(wal).size <= DEFAULT_JOURNAL_SIZE_LIMIT_BYTES, `wal ${statSync(wal).size}`);
  }

  const heldWriter = openIndexDb(file);
  const reader = openIndexDb(file, { readOnly: true });
  withTransaction(heldWriter, () => {
    const insert = heldWriter.prepare("INSERT INTO bulk(payload) VALUES (?)");
    const payload = "y".repeat(4096);
    for (let i = 0; i < 800; i += 1) insert.run(payload);
  });
  close(heldWriter);
  const pinned = existsSync(wal) ? statSync(wal).size : 0;
  close(reader);
  compactWalFile(file);
  const after = existsSync(wal) ? statSync(wal).size : 0;
  assert.ok(after <= DEFAULT_JOURNAL_SIZE_LIMIT_BYTES, `compacted wal ${after}`);
  assert.ok(after <= pinned, `compact ${after} should not grow pinned ${pinned}`);
  rmSync(dir, { recursive: true, force: true });
});

// Cold-build lock follow-up: readers live in the MCP process while a builder
// child owns the writer lock. A reader's close must never take (or wait for)
// that lock, and the WAL compaction must never commit.
test("read-only close never checkpoints, so it never waits on a live writer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-ro-close-"));
  const file = path.join(dir, "index.sqlite");
  const writer = openIndexDb(file);
  try {
    writer.exec("CREATE TABLE t(x)");
    writer.exec("INSERT INTO t VALUES (1)");
    const reader = openIndexDb(file, { readOnly: true });
    reader.prepare("SELECT x FROM t").get();
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO t VALUES (2)");
    const started = Date.now();
    close(reader);
    const elapsed = Date.now() - started;
    writer.exec("COMMIT");
    assert.ok(elapsed < 1000, `read-only close blocked ${elapsed}ms on the writer lock`);
  } finally {
    close(writer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only close never resets the WAL under a writer's open cursor", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-ro-reset-"));
  const file = path.join(dir, "index.sqlite");
  const writer = openIndexDb(file);
  try {
    writer.exec("CREATE TABLE t(x)");
    for (let i = 0; i < 5; i += 1) writer.exec(`INSERT INTO t VALUES (${i})`);
    // a fully backfilled WAL: a TRUNCATE checkpoint from any connection,
    // even a read-only one, would restart it
    writer.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const cursor = writer.prepare("SELECT x FROM t").iterate();
    cursor.next();
    const reader = openIndexDb(file, { readOnly: true });
    reader.prepare("SELECT x FROM t").get();
    close(reader);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO t VALUES (99)");
    writer.exec("COMMIT");
    cursor.return?.();
  } finally {
    close(writer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compactWalFile never commits and never waits on a live writer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-compact-"));
  const file = path.join(dir, "index.sqlite");
  const writer = openIndexDb(file);
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("CREATE TABLE t(x)");
    for (let i = 0; i < 5; i += 1) writer.exec(`INSERT INTO t VALUES (${i})`);
    // WAL frames not yet backfilled + an open cursor: any foreign commit
    // (the writer pragmas did one) breaks this connection's next write.
    const cursor = writer.prepare("SELECT x FROM t").iterate();
    cursor.next();
    compactWalFile(file);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO t VALUES (99)");
    writer.exec("COMMIT");
    cursor.return?.();
    writer.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    compactWalFile(file);
    const elapsed = Date.now() - started;
    writer.exec("COMMIT");
    assert.ok(elapsed < 1000, `compaction blocked ${elapsed}ms behind the writer`);
  } finally {
    close(writer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IN lists above SQLITE_MAX_VARIABLE_NUMBER fail unless chunked", () => {
  const db = openIndexDb(":memory:");
  try {
    const overflow = Array.from({ length: SQLITE_MAX_VARIABLE_NUMBER + 1 }, (_, index) => index + 1);
    assert.throws(
      () => db.prepare(`SELECT 1 AS ok WHERE 1 IN ${inClause(overflow.length)}`).get(...overflow),
      /too many SQL variables/
    );
    let seen = 0;
    for (const chunk of bindChunks(overflow)) {
      db.prepare(`SELECT 1 AS ok WHERE 1 IN ${inClause(chunk.length)}`).get(...chunk);
      seen += chunk.length;
    }
    assert.equal(seen, overflow.length);
  } finally {
    close(db);
  }
});

test("schemaVersion mismatch drops all tables and rebuilds", () => {
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO file(path, content_hash, generation, facts) VALUES ('a.java', 'h', 1, jsonb('{}'))");
    db.exec("UPDATE meta SET value='0' WHERE key='schemaVersion'");
    assert.equal(db.prepare("SELECT count(*) AS n FROM file").get()?.n, 1);
    ensureSchema(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value, String(SCHEMA_VERSION));
    assert.equal(db.prepare("SELECT count(*) AS n FROM file").get()?.n, 0);
    db.exec("INSERT INTO file(path, content_hash, generation, facts) VALUES ('a.java', 'h', 1, jsonb('{}'))");
    db.exec("UPDATE meta SET value='1' WHERE key='schemaVersion'");
    ensureSchema(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value, String(SCHEMA_VERSION));
    assert.equal(db.prepare("SELECT count(*) AS n FROM file").get()?.n, 0);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='factsEncoding'").get()?.value, "deflate-raw");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='entity_token'").get()?.n, 1);
  } finally {
    close(db);
  }
});
