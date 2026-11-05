import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { assertVerificationComplete, runSealStep, runVerificationTasks, sealWorkerUsage, SEAL_WORKER_LIMIT } from "./seal.js";
import type { VerificationTask } from "./seal-worker.js";

type Check = { sql: string; rows?: string[]; error?: string };
type Report = { ok: boolean; checks: Check[]; tables: string[] };
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Independent SQL protocol oracle, compared below with the actual worker path.
function inspect(file: string, mode: "full" | "combined" | "quick"): Report {
  const checks: Check[] = [], tables: string[] = [];
  let db: DatabaseSync | undefined;
  const check = (sql: string) => {
    try {
      const rows = db!.prepare(sql).all().map(row => String(Object.values(row)[0]));
      checks.push({ sql, rows });
    } catch (error) {
      if (!(error instanceof Error) || !("errcode" in error)) throw error;
      checks.push({ sql, error: error.message });
    }
  };
  try {
    db = new DatabaseSync(file, { readOnly: true });
    check(mode === "full" ? "PRAGMA main.integrity_check" : "PRAGMA main.quick_check");
    if (mode === "combined") {
      tables.push("sqlite_schema", ...(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name));
      assert.equal(new Set(tables).size, tables.length);
      for (const table of tables) check(`PRAGMA main.integrity_check(${quote(table)})`);
      assert.equal(checks.length, tables.length + 1);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("errcode" in error)) throw error;
    checks.push({ sql: "open/schema", error: error.message });
  } finally { db?.close(); }
  return { ok: checks.every(check => !check.error && check.rows?.length === 1 && check.rows[0] === "ok"), checks, tables };
}

async function fixture(sql: string, fn: (file: string, roots: Record<string, number>, tables: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "seal-integrity-"));
  const file = path.join(root, "fixture.sqlite");
  try {
    const db = new DatabaseSync(file);
    let roots: Record<string, number>, tables: string[];
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=NONE;");
      db.exec(sql);
      roots = Object.fromEntries((db.prepare("SELECT name, rootpage FROM sqlite_schema WHERE rootpage>0").all() as Array<{ name: string; rootpage: number }>).map(row => [row.name, row.rootpage]));
      tables = ["sqlite_schema", ...(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)];
    } finally { db.close(); }
    for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(existsSync(file + suffix), false);
    assert.equal(inspect(file, "full").ok, true, "fixture starts as a healthy database");
    await fn(file, roots, tables);
    assert.equal(sealWorkerUsage().active, 0, "worker exit precedes fixture teardown");
    assert.equal(sealWorkerUsage().queued, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function tasksFor(tables: string[]): VerificationTask[] {
  return [{ kind: "global" }, ...tables.map(table => ({ kind: "table" as const, table, logical: false }))];
}

async function assertRejected(file: string, tables: string[], quickMustMiss = false) {
  const before = await readFile(file);
  const full = inspect(file, "full"), combined = inspect(file, "combined"), quick = inspect(file, "quick");
  assert.equal(full.ok, false, JSON.stringify(full));
  assert.equal(combined.ok, false, JSON.stringify(combined));
  if (quickMustMiss) assert.equal(quick.ok, true, "quick-only must miss this index-content corruption");
  await assert.rejects(runVerificationTasks(file, tasksFor(tables)), /seal: integrity|malformed|corrupt/i);
  assert.deepEqual(await readFile(file), before, "all inspections are read-only");
}

// The fixtures deliberately fit in one non-overflow index leaf. Locate a
// same-length text field inside one complete cell payload; no guessed offset.
async function replaceLeafText(file: string, page: number, from: string, to: string) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const bytes = await readFile(file), encodedPageSize = bytes.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  const start = (page - 1) * pageSize, header = start + (page === 1 ? 100 : 0);
  assert.equal(bytes[header], 0x0a, "fixture has an index leaf root");
  const matches: number[] = [];
  for (let i = 0; i < bytes.readUInt16BE(header + 3); i++) {
    const cell = start + bytes.readUInt16BE(header + 8 + i * 2);
    const payloadSize = bytes[cell]!;
    assert.ok(payloadSize < 128, "fixture uses a one-byte, inline payload size");
    const payloadStart = cell + 1, payloadEnd = payloadStart + payloadSize;
    assert.ok(payloadEnd <= start + pageSize);
    const offset = bytes.indexOf(Buffer.from(from), payloadStart);
    if (offset >= payloadStart && offset + Buffer.byteLength(from) <= payloadEnd) matches.push(offset);
  }
  assert.equal(matches.length, 1);
  bytes.write(to, matches[0]!, "utf8");
  await writeFile(file, bytes);
}

test("full and composed integrity checks accept every healthy table including dictionary, metadata and internal sequence", async () => {
  assert.equal(process.versions.sqlite, "3.49.1", "source proof is tied to the frozen SQLite runtime");
  await fixture(`CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE);
    INSERT INTO sample(value) VALUES ('alpha-key'), ('beta-key');`, async (file, _roots, tables) => {
    const full = inspect(file, "full"), combined = inspect(file, "combined");
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.equal(combined.ok, true, JSON.stringify(combined));
    assert.deepEqual(combined.tables, ["sqlite_schema", "meta", "sample", "sqlite_sequence", "sym"]);
    assert.equal(combined.checks.length, combined.tables.length + 1);
    const tasks = tasksFor(tables), actual = await runVerificationTasks(file, tasks);
    assert.deepEqual(actual.map(task => JSON.stringify(task)).sort(), tasks.map(task => JSON.stringify(task)).sort());
  });
});

test("global integrity coverage rejects a root page shared by two tables", async () => {
  await fixture(`CREATE TABLE first_table(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE second_table(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO first_table VALUES (1, 'first'); INSERT INTO second_table VALUES (1, 'second');`, async (file, roots, tables) => {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA writable_schema=ON");
      assert.equal(Number(db.prepare("UPDATE sqlite_schema SET rootpage=? WHERE name='second_table'").run(roots.first_table!).changes), 1);
    } finally { db.close(); }
    await assertRejected(file, tables);
  });
});

test("global integrity coverage rejects a freelist pointing at a live table page", async () => {
  await fixture(`CREATE TABLE live(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO live VALUES (1, 'live');
    CREATE TABLE disposable(value BLOB); INSERT INTO disposable VALUES(zeroblob(20000)); DROP TABLE disposable;`, async (file, roots, tables) => {
    const bytes = await readFile(file);
    assert.ok(bytes.readUInt32BE(36) > 0, "fixture starts with a real freelist");
    assert.notEqual(bytes.readUInt32BE(32), roots.live);
    bytes.writeUInt32BE(roots.live!, 32);
    bytes.writeUInt32BE(1, 36);
    await writeFile(file, bytes);
    await assertRejected(file, tables);
  });
});

test("complete table checks reject a wrong index key at unchanged entry count that quick-only misses", async () => {
  await fixture(`CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT UNIQUE);
    INSERT INTO sample VALUES (1, 'alpha-key'), (2, 'beta-key');`, async (file, roots, tables) => {
    await replaceLeafText(file, roots.sqlite_autoindex_sample_1!, "beta-key", "zeta-key");
    await assertRejected(file, tables, true);
  });
});

test("complete table checks reject duplicate keys in a UNIQUE index", async () => {
  await fixture(`CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX sample_key ON sample(value);
    INSERT INTO sample VALUES (1, 'same-key'), (2, 'same-key');`, async (file, _roots, tables) => {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA writable_schema=ON");
      assert.equal(Number(db.prepare("UPDATE sqlite_schema SET sql='CREATE UNIQUE INDEX sample_key ON sample(value)' WHERE name='sample_key'").run().changes), 1);
    } finally { db.close(); }
    await assertRejected(file, tables);
  });
});

test("complete table checks reject corrupted WITHOUT ROWID key order", async () => {
  await fixture(`CREATE TABLE ordered(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    INSERT INTO ordered VALUES ('alpha-key', 'first'), ('beta-key', 'second');`, async (file, roots, tables) => {
    await replaceLeafText(file, roots.ordered!, "beta-key", "aaaa-key");
    await assertRejected(file, tables);
  });
});

test("verification refuses missing, duplicate, unexpected and mismatched acknowledgements", () => {
  const tables = [{ name: "sym", logical: false, weight: 1 }, { name: "file", logical: true, weight: 2 }];
  const complete: VerificationTask[] = [{ kind: "global" }, { kind: "common" },
    { kind: "table", table: "sym", logical: false }, { kind: "table", table: "file", logical: true }];
  assert.doesNotThrow(() => assertVerificationComplete(tables, complete));
  for (let missing = 0; missing < complete.length; missing++) {
    assert.throws(() => assertVerificationComplete(tables, complete.filter((_task, index) => index !== missing)), /missing verification/);
  }
  assert.throws(() => assertVerificationComplete(tables, [...complete, complete[0]!]), /unexpected verification/);
  assert.throws(() => assertVerificationComplete(tables, [...complete, { kind: "table", table: "extra", logical: false }]), /unexpected verification/);
  assert.throws(() => assertVerificationComplete(tables, complete.map(task => task.kind === "table" ? { ...task, logical: !task.logical } : task)), /unexpected verification/);
});

test("the global seal cap includes concurrent callers and cancellation waits for actual worker exits", async t => {
  await fixture("CREATE TABLE sample(id INTEGER PRIMARY KEY)", async file => {
    const terminate = t.mock.method(Worker.prototype, "terminate");
    const controllers = Array.from({ length: SEAL_WORKER_LIMIT + 2 }, () => new AbortController());
    const settled = Promise.allSettled(controllers.map(controller =>
      runSealStep({ step: "verify-parts", source: file, tasks: tasksFor(["sample"]), cursor: new SharedArrayBuffer(8) }, controller.signal)));
    // All four spawn continuations run before the event loop can deliver exits.
    await Promise.resolve();
    assert.equal(sealWorkerUsage().active, SEAL_WORKER_LIMIT);
    assert.equal(sealWorkerUsage().queued, 2);
    controllers[0]!.abort(new Error("cancel active seal"));
    assert.equal(sealWorkerUsage().active, SEAL_WORKER_LIMIT, "abort does not release a live worker's permit");
    for (const controller of controllers) controller.abort(new Error("cancel seal"));
    assert.ok((await settled).every(result => result.status === "rejected"));
    assert.deepEqual(sealWorkerUsage(), { active: 0, queued: 0, peak: SEAL_WORKER_LIMIT });
    assert.equal(terminate.mock.callCount(), 0, "verification cancellation uses safe task boundaries, never forced native interruption");
    terminate.mock.restore();
  });
});

test("a bad facts batch preserves its error and drains siblings without forced termination", async t => {
  await fixture("CREATE TABLE bad(facts BLOB); INSERT INTO bad VALUES (x'00'); CREATE TABLE good(facts BLOB)", async file => {
    const writer = new DatabaseSync(file);
    try {
      const valid = deflateRawSync(Buffer.from("{}"));
      const insert = writer.prepare("INSERT INTO good VALUES (?)");
      writer.exec("BEGIN");
      for (let i = 0; i < 2000; i++) insert.run(valid);
      writer.exec("COMMIT");
    } finally { writer.close(); }
    const terminate = t.mock.method(Worker.prototype, "terminate");
    try {
      const tasks: VerificationTask[] = [{ kind: "table", table: "bad", logical: true },
        ...Array.from({ length: SEAL_WORKER_LIMIT - 1 }, () => ({ kind: "table" as const, table: "good", logical: true }))];
      await assert.rejects(runVerificationTasks(file, tasks), /unexpected end of file/);
      assert.equal(terminate.mock.callCount(), 0);
      assert.equal(sealWorkerUsage().active, 0);
      assert.equal(sealWorkerUsage().queued, 0);
    } finally { terminate.mock.restore(); }
  });
});
