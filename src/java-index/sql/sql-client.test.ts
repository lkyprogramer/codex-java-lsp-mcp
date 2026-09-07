import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../builder/cold-build.js";
import { readIndexCounts } from "../builder/progress.js";
import { JavaIndexClient } from "../java-index-client.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { SqlJavaIndexClient } from "./sql-client.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const paymentGateway = path.join(fixturesRoot, "src/main/java/demo/PaymentGateway.java");
const orderMapper = "src/main/resources/mapper/OrderMapper.xml";

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function listAbsolute(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function buildFixtureDb(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-sql-client-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: fixturesRoot, db, generation: 1 });
  } finally {
    close(db);
  }
  return dbPath;
}

test("SqlJavaIndexClient point RPCs match a real forked JavaIndexClient on java-index-v2", async () => {
  const dbPath = await buildFixtureDb();
  const sql = new SqlJavaIndexClient(fixturesRoot, dbPath);
  const heap = new JavaIndexClient(fixturesRoot, mkdtempSync(path.join(tmpdir(), "iod-heap-client-")));
  try {
    await sql.open(1);
    await heap.open(1);
    await heap.refresh(1, listAbsolute(fixturesRoot, ".java"), []);
    await heap.refreshResources(1, listAbsolute(path.join(fixturesRoot, "src/main/resources"), ".xml"));
    await heap.reconcile(1);
    await waitUntil(async () => (await heap.status()).pendingBackground === 0, 15_000);
    const sqlStatus = await sql.status();
    const countsDb = openIndexDb(dbPath, { readOnly: true });
    const counts = readIndexCounts(countsDb)!;
    close(countsDb);
    assert.equal(sqlStatus.files, counts.files);
    assert.equal(sqlStatus.types, counts.types);
    assert.equal(sqlStatus.methods, counts.methods);
    assert.equal(sqlStatus.edges, counts.edges);
    assert.equal(sqlStatus.factsHydrated, true);
    assert.equal(sqlStatus.hibernated, false);
    assert.equal(sqlStatus.pendingForeground, 0);
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL("./sql-client.js", import.meta.url)), "utf8"), /count\(\*\)/);

    const files = await sql.queryFiles([paymentGateway]);
    assert.deepEqual(jsonClone(files), jsonClone(await heap.queryFiles([paymentGateway])));
    const bundle = files[0]!;
    const paymentType = bundle.types.find(type => type.simpleName === "PaymentGateway")!;
    const gatewayPay = bundle.methods.find(method => method.ownerTypeId === paymentType.typeId && method.name === "pay")!;
    const servicePay = bundle.methods.find(
      method => method.ownerTypeId === bundle.types.find(type => type.simpleName === "PaymentService")!.typeId && method.name === "pay"
    )!;

    assert.deepEqual(
      jsonClone(await sql.queryImplementers(paymentType.typeId, 10)),
      jsonClone(await heap.queryImplementers(paymentType.typeId, 10))
    );
    assert.deepEqual(
      jsonClone(await sql.queryTypeReferencers(paymentType.typeId, ["IMPLEMENTS"], 10)),
      jsonClone(await heap.queryTypeReferencers(paymentType.typeId, ["IMPLEMENTS"], 10))
    );
    assert.deepEqual(jsonClone(await sql.queryCallers(gatewayPay.methodId, 10)), jsonClone(await heap.queryCallers(gatewayPay.methodId, 10)));
    assert.deepEqual(jsonClone(await sql.queryCallees(servicePay.methodId, 10)), jsonClone(await heap.queryCallees(servicePay.methodId, 10)));
    assert.deepEqual(
      jsonClone(await sql.queryCalleesBatch([servicePay.methodId], 10)),
      jsonClone(await heap.queryCalleesBatch([servicePay.methodId], 10))
    );
    assert.deepEqual(
      jsonClone(await sql.queryAnchor(paymentGateway, paymentType.range.start.line, paymentType.range.start.column)),
      jsonClone(await heap.queryAnchor(paymentGateway, paymentType.range.start.line, paymentType.range.start.column))
    );
    assert.deepEqual(
      jsonClone(await sql.queryType("PaymentGateway", paymentGateway)),
      jsonClone(await heap.queryType("PaymentGateway", paymentGateway))
    );
    assert.deepEqual(
      jsonClone(await sql.queryTypes([{ typeText: "PaymentGateway", scopeFile: paymentGateway }, { typeText: "NoSuchType" }])),
      jsonClone(await heap.queryTypes([{ typeText: "PaymentGateway", scopeFile: paymentGateway }, { typeText: "NoSuchType" }]))
    );
    const command = await sql.queryType("PaymentCommand", paymentGateway);
    assert.equal(command.state, "RESOLVED");
    const typeId = (command as { type: { typeId: string } }).type.typeId;
    assert.deepEqual(
      jsonClone(await sql.queryMethodsWithParameterTypes([typeId], 10)),
      jsonClone(await heap.queryMethodsWithParameterTypes([typeId], 10))
    );
    assert.deepEqual(
      jsonClone(await sql.queryMyBatisResource(orderMapper)),
      jsonClone(await heap.queryMyBatisResource(orderMapper))
    );
    assert.deepEqual(
      jsonClone(await sql.queryMyBatisResourcesByNamespace(["demo.OrderMapper"])),
      jsonClone(await heap.queryMyBatisResourcesByNamespace(["demo.OrderMapper"]))
    );
    assert.deepEqual(
      jsonClone(await sql.queryRepositoryFactMarkers(["org.springframework"], ["org.springframework"])),
      jsonClone(await heap.queryRepositoryFactMarkers(["org.springframework"], ["org.springframework"]))
    );
    const notImplemented = (error: Error) => error.name === "NOT_IMPLEMENTED";
    await assert.rejects(() => sql.refresh(2, [], []), notImplemented);
    await assert.rejects(() => sql.refreshResources(2, []), notImplemented);
    await assert.rejects(() => sql.reconcile(2), notImplemented);
    await assert.rejects(() => sql.ensureFresh([], 2), notImplemented);
    await assert.rejects(() => sql.awaitPrewarmReady(), notImplemented);
    await assert.rejects(() => sql.flush(), notImplemented);
    await assert.rejects(() => sql.hibernate(), notImplemented);
    await assert.rejects(() => sql.recycle(), notImplemented);
    await assert.rejects(() => sql.queryReadRanges([{ file: paymentGateway, positions: [{ line: 7, column: 3 }] }]), notImplemented);
  } finally {
    await sql.close();
    await heap.close();
  }
});

test("SqlJavaIndexClient open without a database is empty/degraded", async () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "iod-sql-missing-")), "index.sqlite");
  assert.equal(existsSync(missing), false);
  const client = new SqlJavaIndexClient(fixturesRoot, missing);
  const status = await client.open(1);
  assert.equal(status.lastError, "EMPTY");
  assert.equal(status.files, 0);
  await client.close();
});
