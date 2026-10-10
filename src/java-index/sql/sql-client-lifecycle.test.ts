import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BuilderSupervisor } from "../builder-supervisor.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
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

test("missing DB open returns BUILDING and starts the builder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-missing-"));
  const dbPath = path.join(dir, "index.sqlite");
  const scriptPath = path.join(dir, "fake-builder.mjs");
  await writeFile(scriptPath, `import readline from "node:readline";
const mode = process.argv[process.argv.indexOf("--mode") + 1];
if (mode === "cold") {
  setInterval(() => {}, 1000);
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const job = JSON.parse(String(line).trim() || "{}");
    if (job.kind === "exit") process.exit(0);
  }
}
`);
  const supervisor = new BuilderSupervisor({
    repoRoot: dir,
    dbPath,
    scriptPath,
    idleMs: 5_000,
    stallMs: 5_000,
    watchdogIntervalMs: 200
  });
  const client = new SqlJavaIndexClient(dir, dbPath, supervisor, 5_000);
  try {
    assert.equal(existsSync(dbPath), false);
    const status = await client.open(1);
    assert.equal(status.state, "BUILDING");
    await waitUntil(() => supervisor.status().state === "cold-building" && supervisor.status().pid !== undefined);
    const builder = (await client.status()).builder;
    assert.ok(builder);
    assert.equal(builder.state, "cold-building");
    assert.ok(builder.pid);
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status publishes db and builder fields", async () => {
  const dbPath = await coldDb(fixturesRoot);
  const supervisor = new BuilderSupervisor({
    repoRoot: fixturesRoot,
    dbPath,
    idleMs: 5_000,
    stallMs: 30_000
  });
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
  const supervisor = new BuilderSupervisor({
    repoRoot: fixturesRoot,
    dbPath,
    idleMs: 5_000,
    stallMs: 30_000
  });
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

test("failed sibling copy does not leave dest and falls back to cold build", async () => {
  const destDir = await mkdtemp(path.join(tmpdir(), "iod-life-failcopy-"));
  const dest = path.join(destDir, "index.sqlite");
  const bogus = path.join(destDir, "not-a-db");
  await writeFile(bogus, "not sqlite");
  const supervisor = new BuilderSupervisor({ repoRoot: destDir, dbPath: dest, idleMs: 5_000, stallMs: 30_000 });
  const client = new SqlJavaIndexClient(destDir, dest, supervisor, 5_000);
  try {
    const status = await client.open(1, { siblingDbPath: bogus });
    assert.equal(status.state, "BUILDING", "an unusable sibling copy falls back to a cold rebuild instead of rejecting");
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(`${dest}.copying`), false);
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(destDir, { recursive: true, force: true });
  }
});

test("sibling copy with a stale schema/identity version is discarded and rebuilt", async () => {
  const destDir = await mkdtemp(path.join(tmpdir(), "iod-life-stale-"));
  const dest = path.join(destDir, "index.sqlite");
  const stale = path.join(destDir, "stale.sqlite");
  {
    const db = openIndexDb(stale);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO meta(key, value) VALUES ('schemaVersion', ?)").run("3");
    close(db);
  }
  const supervisor = new BuilderSupervisor({ repoRoot: destDir, dbPath: dest, idleMs: 5_000, stallMs: 30_000 });
  const client = new SqlJavaIndexClient(destDir, dest, supervisor, 5_000);
  try {
    const status = await client.open(1, { siblingDbPath: stale });
    assert.equal(status.state, "BUILDING", "a stale-identity seed is never reused; it is rebuilt");
    assert.equal(existsSync(`${dest}.copying`), false);
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(destDir, { recursive: true, force: true });
  }
});

test("close while BUILDING does not reopen after coldBuild", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-life-close-cold-"));
  const dbPath = path.join(dir, "index.sqlite");
  const scriptPath = path.join(dir, "fake-builder.mjs");
  await writeFile(scriptPath, `import { setTimeout as delay } from "node:timers/promises";
const mode = process.argv[process.argv.indexOf("--mode") + 1];
if (mode === "cold") {
  await delay(80);
  process.exit(0);
}
`);
  const supervisor = new BuilderSupervisor({
    repoRoot: dir,
    dbPath,
    scriptPath,
    idleMs: 5_000,
    stallMs: 5_000,
    watchdogIntervalMs: 200
  });
  const client = new SqlJavaIndexClient(dir, dbPath, supervisor, 5_000);
  try {
    const status = await client.open(1);
    assert.equal(status.state, "BUILDING");
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(client.localStatus().state, "CLOSED");
    assert.equal((client as unknown as ClientInternals).db, undefined);
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed sibling reconcile marks DEGRADED", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "iod-life-recon-fail-"));
  await cp(fixturesRoot, repo, { recursive: true });
  const sibling = await coldDb(repo);
  const destDir = await mkdtemp(path.join(tmpdir(), "iod-life-recon-dest-"));
  const dest = path.join(destDir, "index.sqlite");
  const scriptPath = path.join(destDir, "fake-builder.mjs");
  await writeFile(scriptPath, `import readline from "node:readline";
const mode = process.argv[process.argv.indexOf("--mode") + 1];
if (mode === "cold") process.exit(0);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const job = JSON.parse(String(line).trim() || "{}");
  if (job.kind === "exit") process.exit(0);
  process.stdout.write(JSON.stringify({
    id: job.id, ok: false, indexedGeneration: 0, files: 0, error: "boom"
  }) + "\\n");
}
`);
  const supervisor = new BuilderSupervisor({
    repoRoot: repo,
    dbPath: dest,
    scriptPath,
    idleMs: 5_000,
    stallMs: 30_000
  });
  const client = new SqlJavaIndexClient(repo, dest, supervisor, 5_000);
  try {
    const opened = await client.open(1, { siblingDbPath: sibling });
    assert.equal(opened.state, "DEGRADED");
    assert.match(opened.lastError ?? "", /boom|reconcile/i);
    const published = await client.status();
    assert.equal(published.state, "DEGRADED");
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(repo, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test("sibling VACUUM INTO copy retargets repoRoot and waits for reconcile", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "iod-life-sib-"));
  await cp(fixturesRoot, repo, { recursive: true });
  const sibling = await coldDb(repo);
  const destDir = await mkdtemp(path.join(tmpdir(), "iod-life-dest-"));
  const dest = path.join(destDir, "index.sqlite");
  const supervisor = new BuilderSupervisor({ repoRoot: repo, dbPath: dest, idleMs: 5_000, stallMs: 30_000 });
  const client = new SqlJavaIndexClient(repo, dest, supervisor, 5_000);
  try {
    const status = await client.open(1, { siblingDbPath: sibling });
    assert.equal(existsSync(dest), true);
    assert.ok(status.files > 0);
    assert.ok(status.db?.bytes && status.db.bytes > 0);
    assert.equal(status.state, "READY");
    const db = openIndexDb(dest, { readOnly: true });
    try {
      const root = db.prepare("SELECT value FROM meta WHERE key='repoRoot'").get() as { value?: string } | undefined;
      assert.equal(root?.value, repo);
      const progress = db.prepare("SELECT value FROM meta WHERE key='buildProgress'").get() as { value?: string } | undefined;
      assert.match(progress?.value ?? "", /"phase":"declare"/);
    } finally {
      close(db);
    }
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(repo, { recursive: true, force: true });
  }
});

// Cold-build lock follow-up: an agent polling java_symbol while the index is
// BUILDING (status + awaitPrewarmReady, the R09 runtime path) must never make
// the real builder child fail with "database is locked". maxRestarts=0 so a
// single lock failure is visible instead of being hidden by a restart.
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
      const supervisor = new BuilderSupervisor({ repoRoot: repo, dbPath, maxRestarts: 0, idleMs: 5_000 });
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
  const scriptPath = path.join(dir, "fake-builder.mjs");
  await writeFile(scriptPath, `const mode = process.argv[process.argv.indexOf("--mode") + 1];
if (mode === "cold") process.exit(1);
`);
  const supervisor = new BuilderSupervisor({ repoRoot: dir, dbPath, scriptPath, maxRestarts: 0, idleMs: 5_000, stallMs: 5_000, watchdogIntervalMs: 200 });
  const client = new SqlJavaIndexClient(dir, dbPath, supervisor, 5_000);
  try {
    assert.equal((await client.open(1)).state, "BUILDING");
    await assert.rejects(client.awaitPrewarmReady(), /cold-build exited 1/);
    await client.close();
    await assert.rejects(client.awaitPrewarmReady(), /closed/);
  } finally {
    await client.close();
    await supervisor.stop();
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
  } as unknown as BuilderSupervisor;
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
