import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BuilderSupervisor } from "../builder-supervisor.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { SqlJavaIndexClient } from "./sql-client.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";

async function copyFixtures(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "iod-sql-inc-"));
  await cp(fixturesRoot, root, { recursive: true });
  return root;
}

async function coldDb(repo: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-sql-inc-db-"));
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

async function mutateCreateSignature(repo: string): Promise<string> {
  const service = path.join(repo, serviceRel);
  const original = await readFile(service, "utf8");
  await writeFile(
    service,
    original.replace("OrderResponse create(OrderRequest request)", "OrderResponse create(OrderRequest request, String note)")
  );
  return service;
}

test("refresh through the shipped supervisor updates queryFiles methods", async () => {
  const repo = await copyFixtures();
  const dbPath = await coldDb(repo);
  const supervisor = new BuilderSupervisor({ repoRoot: repo, dbPath, idleMs: 10_000, stallMs: 60_000 });
  const client = new SqlJavaIndexClient(repo, dbPath, supervisor);
  try {
    await client.open(1);
    const service = await mutateCreateSignature(repo);
    const status = await client.refresh(2, [service], []);
    assert.equal(status.indexedGeneration, 2);
    const bundle = (await client.queryFiles([service]))[0];
    assert.ok(bundle);
    const created = bundle.methods.find(method => method.name === "create");
    assert.ok(created);
    assert.equal(created.parameters.length, 2);
    assert.equal(created.parameters[1]?.name, "note");
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(repo, { recursive: true, force: true });
  }
});

test("ensureFresh refreshes when indexedGeneration and file generation lag", async () => {
  const repo = await copyFixtures();
  const dbPath = await coldDb(repo);
  const supervisor = new BuilderSupervisor({ repoRoot: repo, dbPath, idleMs: 10_000, stallMs: 60_000 });
  const client = new SqlJavaIndexClient(repo, dbPath, supervisor);
  try {
    const opened = await client.open(1);
    assert.equal(opened.indexedGeneration, 1);
    const service = await mutateCreateSignature(repo);
    await client.ensureFresh([service], 1);
    assert.equal((await client.status()).indexedGeneration, 1);
    await client.ensureFresh([service], 2);
    const status = await client.status();
    assert.equal(status.indexedGeneration, 2);
    const created = (await client.queryFiles([service]))[0]?.methods.find(method => method.name === "create");
    assert.equal(created?.parameters[1]?.name, "note");
    await client.ensureFresh([service], 2);
    assert.equal((await client.status()).indexedGeneration, 2);
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(repo, { recursive: true, force: true });
  }
});
