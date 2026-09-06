import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb, prepareCached, withTransaction } from "./driver.js";
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
    ensureSchema(db);
    const first = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'");
    const second = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'");
    assert.equal(first, second);
  } finally {
    close(db);
    rmSync(dir, { recursive: true, force: true });
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
