import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../builder/cold-build.js";
import { JavaIndexClient } from "../java-index-client.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { SqlJavaIndexClient } from "./sql-client.js";
import type { ContextGraphInput } from "./sql-queries.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const goldenPath = path.resolve(dirname, "..", "..", "..", "golden", "java-index-v2.scenarios.jsonl");

type GoldenRow = {
  name?: string;
  anchor?: { file?: string; line?: number; profile?: string; taskKeywords?: string[] };
};

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dropVolatile<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof key === "string" && /elapsed|heapUsed|rssBytes|childCold|parentCold|serviceMs/i.test(key)) {
      return undefined;
    }
    return item;
  })) as T;
}

function byPath<T extends { path?: string; file?: string; id?: string }>(left: T, right: T): number {
  return (left.path ?? left.file ?? left.id ?? "").localeCompare(right.path ?? right.file ?? right.id ?? "");
}

function normalizeContext(value: unknown): unknown {
  const cloned = dropVolatile(value) as {
    resolvedIntent?: string;
    coverage?: string;
    bundles?: Array<{ path: string; closedObligations?: string[] }>;
    unresolved?: Array<{ id?: string; role?: string }>;
  };
  return {
    resolvedIntent: cloned.resolvedIntent,
    coverage: cloned.coverage,
    bundles: [...(cloned.bundles ?? [])]
      .map(bundle => ({
        path: bundle.path,
        closedObligations: [...(bundle.closedObligations ?? [])].sort()
      }))
      .sort(byPath),
    unresolved: [...(cloned.unresolved ?? [])].sort(byPath)
  };
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

function goldenRows(): GoldenRow[] {
  return readFileSync(goldenPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as GoldenRow);
}

async function openPair(): Promise<{ sql: SqlJavaIndexClient; heap: JavaIndexClient }> {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-sql-queries-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: fixturesRoot, db, generation: 1 });
  } finally {
    close(db);
  }
  const sql = new SqlJavaIndexClient(fixturesRoot, dbPath);
  const heap = new JavaIndexClient(fixturesRoot, mkdtempSync(path.join(tmpdir(), "iod-heap-queries-")));
  await sql.open(1);
  await heap.open(1);
  await heap.refresh(1, listAbsolute(fixturesRoot, ".java"), []);
  await heap.refreshResources(1, listAbsolute(path.join(fixturesRoot, "src/main/resources"), ".xml"));
  await heap.reconcile(1);
  await waitUntil(async () => (await heap.status()).pendingBackground === 0, 15_000);
  return { sql, heap };
}

test("SqlJavaIndexClient graph/entity RPCs match a real forked JavaIndexClient on java-index-v2", async () => {
  const { sql, heap } = await openPair();
  try {
    assert.deepEqual(dropVolatile(await sql.queryGraphDigest()), dropVolatile(await heap.queryGraphDigest()));
    const from = "src/main/java/demo/PaymentGateway.java";
    assert.deepEqual(jsonClone(await sql.queryGraphReachable(from, 3)), jsonClone(await heap.queryGraphReachable(from, 3)));
    assert.deepEqual(
      jsonClone(await sql.queryContextGraph({
        fromRelativePath: from,
        intent: "IMPLEMENTATION_CHANGE",
        mode: "navigate",
        direction: "callees",
        maxHops: 2
      })),
      jsonClone(await heap.queryContextGraph({
        fromRelativePath: from,
        intent: "IMPLEMENTATION_CHANGE",
        mode: "navigate",
        direction: "callees",
        maxHops: 2
      }))
    );

    const rows = goldenRows();
    assert.ok(rows.length >= 8);
    for (const row of rows) {
      const relative = row.anchor?.file;
      if (!relative) continue;
      const task = [row.name, ...(row.anchor?.taskKeywords ?? [])].filter(Boolean).join(" ");
      assert.deepEqual(jsonClone(await sql.queryEntitySearch(task)), jsonClone(await heap.queryEntitySearch(task)), task);
      for (const intent of ["IMPLEMENTATION_CHANGE", "PERSISTENCE_FLOW"] as const) {
        const input: ContextGraphInput = {
          fromRelativePath: relative,
          intent,
          taskText: task,
          profile: row.anchor?.profile,
          anchorLine: row.anchor?.line
        };
        const sqlContext = normalizeContext(await sql.queryContextGraph(input)) as {
          resolvedIntent: string;
          coverage: string;
          unresolved: unknown;
        };
        const heapContext = normalizeContext(await heap.queryContextGraph(input)) as {
          resolvedIntent: string;
          coverage: string;
          unresolved: unknown;
        };
        assert.equal(sqlContext.resolvedIntent, heapContext.resolvedIntent, `${row.name}:${intent}:intent`);
        assert.equal(sqlContext.coverage, heapContext.coverage, `${row.name}:${intent}:coverage`);
        assert.deepEqual(sqlContext.unresolved, heapContext.unresolved, `${row.name}:${intent}:unresolved`);
      }
    }
    assert.deepEqual(
      normalizeContext(await sql.queryContextGraph({
        fromRelativePath: "src/main/java/demo/PaymentGateway.java",
        intent: "IMPLEMENTATION_CHANGE",
        anchorLine: 6
      })),
      normalizeContext(await heap.queryContextGraph({
        fromRelativePath: "src/main/java/demo/PaymentGateway.java",
        intent: "IMPLEMENTATION_CHANGE",
        anchorLine: 6
      }))
    );
  } finally {
    await sql.close();
    await heap.close();
  }
});
