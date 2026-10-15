import assert from "node:assert/strict";
import test from "node:test";
import { close, openIndexDb, withTransaction } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { internSym, setSymHashForTesting, SYM_HASH_BYTES, symId, symText } from "./sym.js";

function memoryDb() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return db;
}

test("colliding hashes keep distinct identities and resolve by original text", () => {
  const db = memoryDb();
  try {
    setSymHashForTesting(db, () => new Uint8Array(SYM_HASH_BYTES));
    const a = internSym(db, "type:v2:a#com.example.A");
    const b = internSym(db, "type:v2:b#com.example.B");
    assert.notEqual(a, b);
    assert.equal(internSym(db, "type:v2:a#com.example.A"), a);
    assert.equal(symText(db, b), "type:v2:b#com.example.B");
    assert.equal(symId(db, "type:v2:c#com.example.C"), undefined);
    const rows = db.prepare("SELECT count(*) AS n, count(DISTINCT hash) AS hashes FROM sym").get() as { n: number; hashes: number };
    assert.deepEqual({ ...rows }, { n: 2, hashes: 1 });
  } finally {
    close(db);
  }
});

test("hash length and unsafe surrogate ids are rejected", () => {
  const db = memoryDb();
  try {
    setSymHashForTesting(db, () => new Uint8Array(4));
    assert.throws(() => internSym(db, "short"), /16 bytes/);
    setSymHashForTesting(db, undefined);
    assert.throws(() => db.prepare("INSERT INTO sym(hash, text) VALUES (?, ?)").run(new Uint8Array(4), "bad"), /CHECK constraint/);
    db.prepare("INSERT INTO sym(id, hash, text) VALUES (9007199254740991, ?, 'edge')").run(new Uint8Array(SYM_HASH_BYTES));
    assert.throws(() => internSym(db, "overflow"), /unsafe sym id|invalid sym id|too large/);
  } finally {
    close(db);
  }
});

test("a rolled-back intern is forgotten, so its rowid cannot alias another text", () => {
  const db = memoryDb();
  try {
    assert.throws(() => withTransaction(db, () => {
      internSym(db, "rolled-back");
      throw new Error("abort");
    }), /abort/);
    assert.equal(symId(db, "rolled-back"), undefined);
    const other = internSym(db, "kept");
    assert.equal(symText(db, other), "kept");
    assert.notEqual(internSym(db, "rolled-back"), other);
  } finally {
    close(db);
  }
});
