import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { recordsFromBundle, type EntityRecord } from "../entity-search.js";
import type { JavaFileBundle } from "../index-types.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
import { searchEntitiesDetailed } from "../../test-support/entity-search-oracle.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { replaceAllEntities, writeEntityRecord } from "./entity-tokens.js";
import { SqlEntitySearch } from "./entity-search.js";
import { commitSearchDocStats, rebuildSearchDocDf, replaceSearchDocuments } from "./search-docs.js";

const ALPHA_SOURCE = `package alpha;
public class AlphaService {
    public void updateWidget(int id) {
        // alpha keeps the widget ledger
    }
}
`;
const BETA_SOURCE = `package beta;
public class BetaService {
    public void updateWidget(int id) {
        // beta keeps the widget ledger
    }
}
`;

type Fixture = {
  root: string;
  db: ReturnType<typeof openIndexDb>;
  records: EntityRecord[];
};

async function writeAndParse(root: string, backend: Awaited<ReturnType<typeof createJavaParserBackend>>, relativePath: string, content: string): Promise<JavaFileBundle> {
  await mkdir(path.join(root, path.dirname(relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), content, "utf8");
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  return parseJavaSourceFile({
    repoRoot: root,
    resolvedRepoRoot: await realpath(root),
    inputPath: path.join(root, relativePath),
    generation: 1,
    backend,
    cache
  });
}

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "devkit-bounded-"));
  const backend = await createJavaParserBackend();
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const alpha = await writeAndParse(root, backend, "alpha/AlphaService.java", ALPHA_SOURCE);
  const beta = await writeAndParse(root, backend, "beta/BetaService.java", BETA_SOURCE);
  const records = [...recordsFromBundle(alpha), ...recordsFromBundle(beta)];
  replaceAllEntities(db, records);
  return { root, db, records };
}

async function teardown(fixture: Fixture): Promise<void> {
  close(fixture.db);
  await rm(fixture.root, { recursive: true, force: true });
}

test("T07 scope is applied before the result cap", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const search = new SqlEntitySearch(fixture.db);
      const unscoped = search.searchDetailed("widget", 3, "text");
      assert.ok(unscoped.hits.length > 0, `broad term matches both roots, got ${JSON.stringify(unscoped.hits)}`);
      assert.ok(
        unscoped.hits.some(hit => hit.relativePath.startsWith("alpha/")) &&
          unscoped.hits.some(hit => hit.relativePath.startsWith("beta/")),
        "without scope the top results span both source roots"
      );
      const scoped = search.searchDetailed("widget", 3, "text", { scope: { sourceRoots: ["beta"] } });
      assert.ok(scoped.hits.length > 0, `scoped query still finds the beta candidate, got ${JSON.stringify(scoped.hits)}`);
      for (const hit of scoped.hits) {
        assert.ok(hit.relativePath.startsWith("beta/"), `out-of-scope hit leaked into the capped result: ${hit.relativePath}`);
      }
      assert.equal(scoped.truncated, false);
      assert.equal(scoped.work.postings, 0, "no budget passed means no budget accounting");
    } finally {
      await teardown(fixture);
    }
  })();
});

test("T07 the posting budget yields an explicit partial, not a silent topK", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const search = new SqlEntitySearch(fixture.db);
      const full = search.searchDetailed("widget", 3, "text");
      assert.ok(full.hits.length > 0);
      const bounded = search.searchDetailed("widget", 3, "text", {
        budget: { maxPostings: 2, remainingMs: () => 10_000 }
      });
      assert.equal(bounded.truncated, true, `expected an explicit partial, got ${JSON.stringify(bounded)}`);
      assert.equal(bounded.stopReason, "postings");
      assert.equal(bounded.work.postings, 2, "the visit counter reports exactly the rows the budget allowed");
      assert.ok(bounded.hits.length < full.hits.length, "a truncated scan must return fewer candidates than the unbounded one");
    } finally {
      await teardown(fixture);
    }
  })();
});

test("T07 an exhausted parent deadline stops before any posting row", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const search = new SqlEntitySearch(fixture.db);
      const result = search.searchDetailed("widget", 3, "text", {
        budget: { maxPostings: 100, remainingMs: () => 0 }
      });
      assert.equal(result.truncated, true);
      assert.equal(result.stopReason, "deadline");
      assert.equal(result.work.postings, 0, "a deadline at the query boundary must not visit a single posting row");
      assert.equal(result.hits.length, 0, "deadline must not pretend the scan completed");
    } finally {
      await teardown(fixture);
    }
  })();
});

test("T07 exact lookups never consume the posting budget", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const search = new SqlEntitySearch(fixture.db);
      const result = search.searchDetailed("alpha.AlphaService", 3, "exact", {
        budget: { maxPostings: 1, remainingMs: () => 10_000 }
      });
      assert.ok(result.hits.length === 1, `exact FQN resolves to one hit, got ${JSON.stringify(result.hits)}`);
      assert.equal(result.hits[0].kind, "type");
      assert.equal(result.truncated, false);
      assert.equal(result.work.postings, 0, "the exact route is a point lookup and must not touch postings");
    } finally {
      await teardown(fixture);
    }
  })();
});

test("T07 writer-maintained entity stats stay consistent under replace and match the scan fallback", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const rows = fixture.db.prepare("SELECT count(*) AS n, coalesce(sum(ident_len), 0) AS total FROM entity").all() as Array<{
        n: number | bigint;
        total: number | bigint;
      }>;
      const count = Number(rows[0]?.n ?? 0);
      const total = Number(rows[0]?.total ?? 0);
      const meta = fixture.db.prepare("SELECT value FROM meta WHERE key=?").get("entityStats:identifier") as { value: string } | undefined;
      assert.ok(meta, "rebuildEntityDf must commit per-field corpus statistics");
      const [metaCount, metaTotal] = meta.value.split(":").map(Number);
      assert.equal(metaCount, count, "meta docCount matches the table scan");
      assert.equal(metaTotal, total, "meta total length matches the table scan");

      // Deleting half the corpus must update the stats, not just the postings.
      const alphaOnly = fixture.records.filter(record => record.relativePath.startsWith("alpha/"));
      replaceAllEntities(fixture.db, alphaOnly);
      const afterRows = fixture.db.prepare("SELECT count(*) AS n, coalesce(sum(ident_len), 0) AS total FROM entity").all() as Array<{
        n: number | bigint;
        total: number | bigint;
      }>;
      const afterMeta = fixture.db.prepare("SELECT value FROM meta WHERE key=?").get("entityStats:identifier") as { value: string } | undefined;
      assert.ok(afterMeta);
      const [afterCount, afterTotal] = afterMeta.value.split(":").map(Number);
      assert.equal(afterCount, Number(afterRows[0].n));
      assert.equal(afterTotal, Number(afterRows[0].total));

      // Parity with the in-memory reference proves the budgeted SQL path and
      // the meta-backed statistics together still reproduce the reference.
      const sql = new SqlEntitySearch(fixture.db);
      const sqlResult = sql.searchDetailed("widget", 3, "text");
      const oracleResult = searchEntitiesDetailed(alphaOnly, "widget", 3, "text");
      assert.deepEqual(
        sqlResult.hits.map(hit => [hit.entityId, hit.layer]),
        oracleResult.hits.map(hit => [hit.entityId, hit.layer]),
        "SQL with meta stats matches the in-memory reference after deletion"
      );
      assert.ok(sqlResult.generation >= 0);
    } finally {
      await teardown(fixture);
    }
  })();
});

test("T07 in-memory and SQL detailed results agree with no budget", () => {
  let fixture: Fixture;
  return (async () => {
    fixture = await buildFixture();
    try {
      const sql = new SqlEntitySearch(fixture.db);
      for (const task of ["widget", "BetaService", "widget ledger keep"]) {
        const sqlResult = sql.searchDetailed(task, 3, "auto");
        const oracleResult = searchEntitiesDetailed(fixture.records, task, 3, "auto");
        assert.deepEqual(
          sqlResult.hits.map(hit => [hit.entityId, hit.layer]),
          oracleResult.hits.map(hit => [hit.entityId, hit.layer]),
          `parity for task=${JSON.stringify(task)}`
        );
      }
    } finally {
      await teardown(fixture);
    }
  })();
});
// ---------------------------------------------------------------- R06
// 20 high-frequency out-of-scope candidates that sort/rank ahead of the one
// in-scope candidate; with limit 1 every route must still return the
// in-scope one, and the posting budget must only be spent inside the scope.

const TARGET = "z/src/main/java/demo/OrderService.java";

function r06Record(entityId: string, relativePath: string, heavy: boolean): EntityRecord {
  const repeat = (token: string) => (heavy ? [token, token, token] : [token]);
  return {
    entityId,
    kind: "type",
    fqn: "demo.OrderService",
    simpleName: "OrderService",
    relativePath,
    identifierTokens: ["demo", "order", "service", "orderservice", ...repeat("refund")],
    chunkTokens: repeat("ledger")
  };
}

function r06Fixture() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const records: EntityRecord[] = Array.from({ length: 20 }, (_, i) =>
    r06Record(`a${String(i).padStart(2, "0")}`, `noise${i}/src/main/java/demo/OrderService.java`, true));
  // a prefix sibling of the scope root and a LIKE-metacharacter path
  records.push(r06Record("b-sibling", "zz/src/main/java/demo/OrderService.java", true));
  records.push(r06Record("b-meta", "z_x/src/main/java/demo/OrderService.java", true));
  records.push(r06Record("zz-target", TARGET, false));
  replaceAllEntities(db, records);
  const docs = records.map((record, index) => ({
    documentId: `doc:${record.entityId}`,
    declarationId: record.entityId,
    path: record.relativePath,
    contentHash: "h",
    representationVersion: 1 as const,
    sourceKind: "comment" as const,
    startLine: 1,
    endLine: 1,
    normalizedText: index < 22 ? "rollback rollback rollback compensation" : "rollback"
  }));
  for (const doc of docs) replaceSearchDocuments(db, doc.path, [doc]);
  rebuildSearchDocDf(db);
  commitSearchDocStats(db);
  return { db, records };
}

test("R06: scope precedes every route's ranking and cap (limit 1, 20+ outside candidates)", () => {
  const { db, records } = r06Fixture();
  try {
    const search = new SqlEntitySearch(db);
    const cases: Array<[string, "auto" | "exact" | "text", string]> = [
      ["demo.OrderService", "exact", "FQN"],
      ["OrderService", "exact", "SIMPLE_NAME"],
      ["refund", "auto", "BM25_IDENTIFIER"],
      ["ledger", "auto", "CHUNK"],
      ["rollback compensation", "text", "any"]
    ];
    for (const [task, mode, layer] of cases) {
      const unscoped = search.searchDetailed(task, 1, mode);
      assert.notEqual(unscoped.hits[0]?.relativePath, TARGET, `${task}: without scope an outside candidate wins (the fixture is adversarial)`);
      for (const roots of [["z"], ["z/"], ["z/src/main/java"]]) {
        const scoped = search.searchDetailed(task, 1, mode, { scope: { sourceRoots: roots } });
        assert.equal(scoped.hits.length, 1, `${task} @ ${roots}: ${JSON.stringify(scoped.hits)}`);
        assert.equal(scoped.hits[0]!.relativePath, TARGET);
        if (layer !== "any") assert.equal(scoped.hits[0]!.layer, layer);
      }
      const oracle = searchEntitiesDetailed(records, task, 1, mode, { scope: { sourceRoots: ["z"] } });
      if (mode !== "text") {
        assert.deepEqual(search.searchDetailed(task, 1, mode, { scope: { sourceRoots: ["z"] } }).hits.map(hit => hit.entityId), oracle.hits.map(hit => hit.entityId), `${task}: SQL/oracle parity`);
      }
    }
    // the document route: tokens that only the search docs carry
    const docOnly = search.searchDetailed("compensation rollback", 1, "text", { scope: { sourceRoots: ["z"] } });
    assert.equal(docOnly.hits[0]?.relativePath, TARGET);
  } finally {
    close(db);
  }
});

test("R06: prefix siblings and LIKE metacharacters never widen the scope", () => {
  const { db } = r06Fixture();
  try {
    const search = new SqlEntitySearch(db);
    const z = search.searchDetailed("OrderService", 10, "exact", { scope: { sourceRoots: ["z"] } });
    assert.deepEqual(z.hits.map(hit => hit.relativePath), [TARGET], "z must not match zz/ or z_x/");
    assert.deepEqual(search.searchDetailed("OrderService", 10, "exact", { scope: { sourceRoots: ["%"] } }).hits, []);
    assert.deepEqual(search.searchDetailed("OrderService", 10, "exact", { scope: { sourceRoots: ["z_"] } }).hits, []);
    const two = search.searchDetailed("OrderService", 10, "exact", { scope: { sourceRoots: ["z", "zz"] } });
    assert.deepEqual(two.hits.map(hit => hit.relativePath).sort(), [TARGET, "zz/src/main/java/demo/OrderService.java"].sort(), "several roots are a union of exact roots");
  } finally {
    close(db);
  }
});

test("R06: the posting budget is only spent on in-scope postings", () => {
  const { db } = r06Fixture();
  try {
    const search = new SqlEntitySearch(db);
    const budget = { maxPostings: 3, remainingMs: () => 10_000 };
    const unscoped = search.searchDetailed("refund ledger", 1, "auto", { budget });
    assert.equal(unscoped.truncated, true, "outside postings alone exhaust this budget");
    const scoped = search.searchDetailed("refund ledger", 1, "auto", { budget, scope: { sourceRoots: ["z"] } });
    assert.equal(scoped.truncated, false, `scope is applied before billing: ${JSON.stringify(scoped)}`);
    assert.equal(scoped.hits[0]?.relativePath, TARGET);
    assert.ok(scoped.work.postings <= 2, `only the target's postings are visited, got ${scoped.work.postings}`);
  } finally {
    close(db);
  }
});
