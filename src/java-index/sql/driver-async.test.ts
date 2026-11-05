import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb, withAsyncTransaction } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { internSym } from "./sym.js";

test("asynchronous rejection rolls back SQL and invalidates interned symbol IDs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ilv2-async-rollback-"));
  const writer = openIndexDb(path.join(dir, "index.sqlite"));
  ensureSchema(writer);
  writer.exec("CREATE TABLE scratch(value TEXT); INSERT INTO scratch VALUES ('old')");
  const reader = openIndexDb(path.join(dir, "index.sqlite"), { readOnly: true });
  try {
    const original = new Error("reject after suspension");
    await assert.rejects(withAsyncTransaction(writer, async () => {
      writer.exec("UPDATE scratch SET value='incomplete'");
      internSym(writer, "rolled-back-symbol");
      await Promise.resolve();
      assert.equal(reader.prepare("SELECT value FROM scratch").get()?.value, "old");
      throw original;
    }), error => error === original);
    assert.equal(writer.isTransaction, false);
    assert.equal(writer.prepare("SELECT value FROM scratch").get()?.value, "old");
    assert.equal(reader.prepare("SELECT value FROM scratch").get()?.value, "old");
    assert.equal(writer.prepare("SELECT id FROM sym WHERE text='rolled-back-symbol'").get(), undefined);
    // Occupy the rolled-back rowid before retrying: a stale cache entry would
    // now silently name another symbol, rather than merely a missing row.
    const other = internSym(writer, "replacement-symbol");
    const retried = internSym(writer, "rolled-back-symbol");
    assert.notEqual(retried, other);
    assert.equal(writer.prepare("SELECT text FROM sym WHERE id=?").get(retried)?.text, "rolled-back-symbol");
    assert.equal(reader.prepare("SELECT text FROM sym WHERE id=?").get(retried)?.text, "rolled-back-symbol");
  } finally { close(reader); close(writer); rmSync(dir, { recursive: true, force: true }); }
});

test("an independent reader sees the complete asynchronous commit only after work resolves", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ilv2-async-commit-"));
  const writer = openIndexDb(path.join(dir, "index.sqlite"));
  writer.exec("CREATE TABLE scratch(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO scratch VALUES (1,'old')");
  const reader = openIndexDb(path.join(dir, "index.sqlite"), { readOnly: true });
  let resume!: () => void;
  const suspended = new Promise<void>(resolve => { resume = resolve; });
  try {
    const pending = withAsyncTransaction(writer, async () => {
      writer.exec("UPDATE scratch SET value='new'; INSERT INTO scratch VALUES (2,'second')");
      await suspended;
      writer.exec("INSERT INTO scratch VALUES (3,'third')");
      return "published";
    });
    await Promise.resolve();
    assert.deepEqual(reader.prepare("SELECT id,value FROM scratch ORDER BY id").all(), [{ id: 1, value: "old" }].map(row => Object.assign(Object.create(null), row)));
    resume();
    assert.equal(await pending, "published");
    assert.equal(writer.isTransaction, false);
    assert.deepEqual(reader.prepare("SELECT value FROM scratch ORDER BY id").all().map(row => row.value), ["new", "second", "third"]);
  } finally { resume(); close(reader); close(writer); rmSync(dir, { recursive: true, force: true }); }
});
