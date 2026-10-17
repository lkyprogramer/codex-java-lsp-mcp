import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalBuilder } from "../local-builder.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { JAVA_FACTS_REVISION } from "../build-fingerprint.js";
import { SqlJavaIndexClient } from "./sql-client.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

type ClientInternals = { db?: unknown };

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function coldDb(repo: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-db-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
  } finally {
    close(db);
  }
  return dbPath;
}

test("idle close then a query reopens the readonly connection", async () => {
  const dbPath = await coldDb(fixturesRoot);
  const client = new SqlJavaIndexClient(fixturesRoot, dbPath, undefined, 40);
  try {
    await client.open(1);
    const before = await client.queryFiles(["src/main/java/demo/PaymentGateway.java"]);
    assert.ok(before[0]);
    await waitUntil(() => (client as unknown as ClientInternals).db === undefined);
    const after = await client.queryFiles(["src/main/java/demo/PaymentGateway.java"]);
    assert.equal(after[0]?.file.relativePath, before[0]?.file.relativePath);
    assert.ok((client as unknown as ClientInternals).db);
  } finally {
    await client.close();
  }
});

/** A builder whose jobs are scripted by the test (cold builds never run a real process). */
function scriptedBuilder(coldBuild: () => Promise<void>): LocalBuilder & { coldBuilds: number } {
  let running = false;
  const stub = {
    coldBuilds: 0,
    status: () => (running ? { state: "cold-building" as const, pid: process.pid, queued: 0 } : { state: "idle" as const, queued: 0 }),
    coldBuild: async () => {
      stub.coldBuilds += 1;
      running = true;
      try {
        await coldBuild();
      } finally {
        running = false;
      }
    },
    submit: () => new Promise(() => undefined),
    stop: async () => undefined
  };
  return stub as unknown as LocalBuilder & { coldBuilds: number };
}

test("missing DB open returns BUILDING and starts the builder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-missing-"));
  const dbPath = path.join(dir, "index.sqlite");
  const builder = scriptedBuilder(() => new Promise<void>(() => undefined));
  const client = new SqlJavaIndexClient(dir, dbPath, builder, 5_000);
  try {
    assert.equal(existsSync(dbPath), false);
    const status = await client.open(1);
    assert.equal(status.state, "BUILDING");
    assert.equal(builder.coldBuilds, 1);
    const published = (await client.status()).builder;
    assert.ok(published);
    assert.equal(published.state, "cold-building");
    assert.ok(published.pid);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status publishes db and builder fields", async () => {
  const dbPath = await coldDb(fixturesRoot);
  const supervisor = new LocalBuilder({ repoRoot: fixturesRoot, dbPath });
  const client = new SqlJavaIndexClient(fixturesRoot, dbPath, supervisor, 5_000);
  try {
    const status = await client.open(1);
    assert.ok(status.db);
    assert.ok(status.db.bytes > 0);
    assert.ok(status.db.cacheKb > 0);
    assert.ok(status.builder);
    assert.ok(["idle", "busy", "cold-building", "absent"].includes(status.builder.state));
    assert.equal(typeof status.builder.queued, "number");
  } finally {
    await client.close();
    await supervisor.stop();
  }
});

test("idle close then ensureFresh reopens the connection", async () => {
  const dbPath = await coldDb(fixturesRoot);
  const supervisor = new LocalBuilder({ repoRoot: fixturesRoot, dbPath });
  const client = new SqlJavaIndexClient(fixturesRoot, dbPath, supervisor, 40);
  try {
    await client.open(1);
    await waitUntil(() => (client as unknown as ClientInternals).db === undefined);
    await client.ensureFresh(["src/main/java/demo/PaymentGateway.java"], 1);
    assert.ok((client as unknown as ClientInternals).db);
  } finally {
    await client.close();
    await supervisor.stop();
  }
});

test("an existing index from an older facts revision is never served; it is rebuilt", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "iod-life-oldrev-repo-"));
  await cp(fixturesRoot, repo, { recursive: true });
  const dbPath = await coldDb(repo);
  {
    // An index written by the previous product version: same schema, older
    // facts revision (e.g. locators without nameRange).
    const db = openIndexDb(dbPath);
    db.prepare("UPDATE meta SET value=? WHERE key='factsRevision'").run(String(JAVA_FACTS_REVISION - 1));
    close(db);
  }
  const supervisor = new LocalBuilder({ repoRoot: repo, dbPath });
  const client = new SqlJavaIndexClient(repo, dbPath, supervisor, 5_000);
  try {
    const status = await client.open(1);
    assert.equal(status.state, "BUILDING", "a stale-revision index is not served as READY");
    await waitUntil(async () => (await client.status()).state === "READY", 60_000);
    const db = openIndexDb(dbPath, { readOnly: true });
    try {
      const revision = db.prepare("SELECT value FROM meta WHERE key='factsRevision'").get() as { value: string };
      assert.equal(Number(revision.value), JAVA_FACTS_REVISION, "the rebuilt index has the current facts revision");
    } finally {
      close(db);
    }
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(path.dirname(dbPath), { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("close while BUILDING does not reopen after coldBuild", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-close-cold-"));
  const dbPath = path.join(dir, "index.sqlite");
  const builder = scriptedBuilder(() => new Promise<void>(resolve => setTimeout(resolve, 80)));
  const client = new SqlJavaIndexClient(dir, dbPath, builder, 5_000);
  try {
    const status = await client.open(1);
    assert.equal(status.state, "BUILDING");
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(client.localStatus().state, "CLOSED");
    assert.equal((client as unknown as ClientInternals).db, undefined);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Cold-build lock follow-up: an agent polling java_symbol while the index is
// BUILDING (status + awaitPrewarmReady, the R09 runtime path) must never make
// the real builder child fail with "database is locked". A one-shot builder
// has no restart, so a single lock failure is visible.
test("polling a BUILDING index never fails the real cold builder", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "iod-life-poll-repo-"));
  await writeFile(path.join(repo, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>p</groupId><artifactId>p</artifactId><version>1</version></project>");
  for (let i = 0; i < 300; i += 1) {
    const dir = path.join(repo, "src", "main", "java", "demo", `p${i % 10}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `S${i}.java`), `package demo.p${i % 10};\n/** order ledger ${i} */\npublic class S${i} { public void updateOrder(int id) {} public void refund(long id) {} }\n`);
  }
  const outcomes: string[] = [];
  try {
    for (let round = 0; round < 6; round += 1) {
      const dbDir = await mkdtemp(path.join(tmpdir(), "iod-life-poll-db-"));
      const dbPath = path.join(dbDir, "index.sqlite");
      const supervisor = new LocalBuilder({ repoRoot: repo, dbPath });
      const client = new SqlJavaIndexClient(repo, dbPath, supervisor, 5_000);
      let polling = false;
      const poll = setInterval(() => {
        if (polling) return;
        polling = true;
        void (async () => {
          try {
            const status = await client.status();
            if (status.state === "BUILDING") await client.awaitPrewarmReady().catch(() => undefined);
          } catch {
            // not opened yet / closed
          } finally {
            polling = false;
          }
        })();
      }, 5);
      try {
        await client.open(1);
        await waitUntil(() => !["BUILDING", "NEW"].includes(client.localStatus().state), 60_000);
        const status = client.localStatus();
        outcomes.push(`${status.state}${status.lastError ? `:${status.lastError}` : ""}`);
      } finally {
        clearInterval(poll);
        await client.close();
        await supervisor.stop();
        await rm(dbDir, { recursive: true, force: true });
      }
    }
    assert.deepEqual(outcomes, Array(6).fill("READY"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("awaitPrewarmReady without a budget ends when the cold build fails or the client closes", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-prewarm-fail-"));
  const dbPath = path.join(dir, "index.sqlite");
  const builder = scriptedBuilder(async () => { throw new Error("cold-build exited 1"); });
  const client = new SqlJavaIndexClient(dir, dbPath, builder, 5_000);
  try {
    assert.equal((await client.open(1)).state, "BUILDING");
    await assert.rejects(client.awaitPrewarmReady(), /cold-build exited 1/);
    await client.close();
    await assert.rejects(client.awaitPrewarmReady(), /closed/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dropping the reader while a builder is alive leaves WAL truncation to the builder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-compact-gate-"));
  const dbPath = path.join(dir, "index.sqlite");
  const wal = `${dbPath}-wal`;
  const stub = {
    status: () => ({ state: "cold-building" as const, queued: 0 }),
    coldBuild: () => new Promise<void>(() => undefined),
    submit: () => new Promise(() => undefined),
    stop: async () => undefined
  } as unknown as LocalBuilder;
  const client = new SqlJavaIndexClient(dir, dbPath, stub, 5_000);
  let builder: ReturnType<typeof openIndexDb> | undefined;
  try {
    assert.equal((await client.open(1)).state, "BUILDING");
    // stands in for the builder child: the writer, with WAL frames pending
    builder = openIndexDb(dbPath);
    ensureSchema(builder);
    builder.exec("PRAGMA wal_autocheckpoint=0");
    builder.exec("CREATE TABLE IF NOT EXISTS bulk(payload TEXT)");
    for (let i = 0; i < 50; i += 1) builder.prepare("INSERT INTO bulk VALUES (?)").run("x".repeat(2048));
    await client.status(); // opens this process's reader
    assert.ok((client as unknown as ClientInternals).db);
    await assert.rejects(client.awaitPrewarmReady({ budget: DeadlineBudget.fromTimeout(30) }));
    await new Promise(resolve => setTimeout(resolve, 150)); // release() + the would-be compaction
    assert.ok(existsSync(wal) && statSync(wal).size > 0, "a live builder's WAL must not be truncated from the MCP process");
  } finally {
    if (builder) close(builder);
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
