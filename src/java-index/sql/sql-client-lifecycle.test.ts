import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BuilderSupervisor } from "../builder-supervisor.js";
import { runSqlColdBuild } from "../builder/cold-build.js";
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

test("sibling VACUUM INTO copy is opened without waiting for reconcile", async () => {
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
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(repo, { recursive: true, force: true });
  }
});
