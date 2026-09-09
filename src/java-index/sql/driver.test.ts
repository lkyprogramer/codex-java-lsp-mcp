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
import { vacuumInto } from "./vacuum-into.js";

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

test("vacuumInto copies a file database to a new path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-vacuum-"));
  const source = path.join(dir, "src.sqlite");
  const dest = path.join(dir, "nested", "dst.sqlite");
  const db = openIndexDb(source);
  try {
    ensureSchema(db);
    db.exec("INSERT INTO file(path, content_hash, generation, facts) VALUES ('a.java', 'h', 1, jsonb('{}'))");
  } finally {
    close(db);
  }
  vacuumInto(source, dest);
  assert.equal(existsSync(dest), true);
  const copied = openIndexDb(dest, { readOnly: true });
  try {
    assert.equal(copied.prepare("SELECT count(*) AS n FROM file").get()?.n, 1);
    assert.equal(copied.prepare("SELECT path AS path FROM file").get()?.path, "a.java");
  } finally {
    close(copied);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vacuumInto rejects quoted paths", () => {
  assert.throws(() => vacuumInto("/tmp/a.sqlite", "/tmp/o'reilly.sqlite"), /unsafe dest/);
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
