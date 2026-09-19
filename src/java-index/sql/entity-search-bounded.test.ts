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