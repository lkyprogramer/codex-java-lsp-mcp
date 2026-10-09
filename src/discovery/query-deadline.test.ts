// input: a real cold-built index (parser + writer) and runStaticDiscovery.
// output: R09 regression lock: one absolute deadline across lookup,
//         postings, ranking, merge, locators and preview. An expired entry
//         runs no SQL; a deadline that passes mid-request stops the
//         remaining stages and reports PARTIAL/deadline; every stage is
//         traced with begin/end/remaining/visited; top-K selection by score
//         tiers equals a full sort.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb, type IndexDatabase } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlEntitySearch } from "../java-index/sql/entity-search.js";
import { replaceAllEntities } from "../java-index/sql/entity-tokens.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { runStaticDiscovery } from "./query.js";
import type { DetailedEntitySearchResult, EntitySearchOptions } from "../java-index/entity-search.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

const javaFile = (i: number) => {
  const name = `Service${String(i).padStart(3, "0")}`;
  return [
    "package demo;",
    `/** Keeps the order ledger for ${name}. */`,
    `public class ${name} {`,
    "    public void updateOrder(int id) {}",
    "    public void refundOrder(long id) {}",
    "}",
    ""
  ].join("\n");
};

async function corpus(files: number): Promise<{ root: string; dbPath: string; done: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "r09-deadline-"));
  for (let i = 0; i < files; i += 1) {
    const rel = path.join(root, "src/main/java/demo", `Service${String(i).padStart(3, "0")}.java`);
    await mkdir(path.dirname(rel), { recursive: true });
    await writeFile(rel, javaFile(i), "utf8");
  }
  const dbPath = path.join(root, ".index", "index.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ db, repoRoot: root });
  close(db);
  return { root, dbPath, done: () => rm(root, { recursive: true, force: true }) };
}

/** remainingMs that is positive for the first `calls` checks, then 0. */
function expiresAfter(calls: number): { remainingMs: () => number; checks: () => number } {
  let n = 0;
  return { remainingMs: () => (n++ < calls ? 60_000 : 0), checks: () => n };
}

test("Q03/R09: an exact request that is expired on entry reports deadline and runs no SQL", async () => {
  const fixture = await corpus(3);
  try {
    const db = openIndexDb(fixture.dbPath, { readOnly: true });
    const live = new SqlEntitySearch(db).searchDetailed("demo.Service001", 8, "exact");
    assert.equal(live.exact, "match", "the selector exists");
    close(db);
    // A closed connection throws on any statement: the expired request must
    // return before touching it.
    const expiredExact = new SqlEntitySearch(db).searchDetailed("demo.Service001", 8, "exact", { budget: { remainingMs: () => 0 } });
    assert.equal(expiredExact.stopReason, "deadline");
    assert.equal(expiredExact.work.postings, 0);
    assert.equal(expiredExact.truncated, true);
    assert.equal(expiredExact.exact, undefined, "no outcome: the lookup never ran");
    assert.deepEqual(expiredExact.hits, []);
    assert.deepEqual(expiredExact.trace, []);
  } finally {
    await fixture.done();
  }
});

test("R09: an expired discovery request reads no status and sends no query", async () => {
  const untouched = {
    status: async () => { throw new Error("status must not be read"); },
    querySearch: async () => { throw new Error("query must not run"); }
  } as unknown as JavaIndexClientApi;
  const r = await runStaticDiscovery(untouched, { repoRoot: tmpdir(), query: "demo.Service001", budget: { remainingMs: () => 0 }, trace: true });
  assert.equal(r.scopeState, "PARTIAL");
  assert.equal(r.stopReason, "deadline");
  assert.equal(r.truncated, true);
  assert.equal(r.exact, undefined);
  assert.deepEqual(r.scope, { state: "NOT_RESOLVED" });
  assert.deepEqual(r.trace, []);
});

test("R09: a scan that never read a snapshot is labelled deadline/queue_full; one that did still reports a generation change", async () => {
  for (const stopReason of ["deadline", "queue_full"] as const) {
    const client = {
      status: async () => ({ state: "READY", indexedGeneration: 5, coverage: [] }),
      // What the worker returns when it never opened a snapshot.
      querySearch: async (): Promise<DetailedEntitySearchResult> => ({ hits: [], truncated: true, selectionLimited: false, work: { postings: 0 }, generation: 0, stopReason, trace: [] })
    } as unknown as JavaIndexClientApi;
    const r = await runStaticDiscovery(client, { repoRoot: tmpdir(), query: "order ledger", budget: { remainingMs: () => 60_000 } });
    assert.deepEqual([r.scopeState, r.stopReason, r.truncated], ["PARTIAL", stopReason, true]);
  }
  // A scan that did read a snapshot (generation 7 != status 5) and then hit
  // the deadline still reports the generation change.
  const midScan = {
    status: async () => ({ state: "READY", indexedGeneration: 5, coverage: [] }),
    querySearch: async (): Promise<DetailedEntitySearchResult> => ({ hits: [], truncated: true, selectionLimited: false, work: { postings: 3 }, generation: 7, stopReason: "deadline", trace: [] })
  } as unknown as JavaIndexClientApi;
  const changed = await runStaticDiscovery(midScan, { repoRoot: tmpdir(), query: "order ledger", budget: { remainingMs: () => 60_000 } });
  assert.deepEqual([changed.scopeState, changed.stopReason], ["PARTIAL", "changed_during_request"]);
  const sameGeneration = await runStaticDiscovery({ ...midScan, status: async () => ({ state: "READY", indexedGeneration: 7, coverage: [] }) } as unknown as JavaIndexClientApi,
    { repoRoot: tmpdir(), query: "order ledger", budget: { remainingMs: () => 60_000 } });
  assert.equal(sameGeneration.stopReason, "deadline");
});

test("R09: a deadline passing during postings stops the remaining routes and keeps the bounded top-K", async () => {
  const fixture = await corpus(40);
  const db = openIndexDb(fixture.dbPath, { readOnly: true });
  try {
    const search = new SqlEntitySearch(db);
    const full = search.searchDetailed("order ledger", 8, "text", { budget: { remainingMs: () => 60_000 } });
    assert.equal(full.stopReason, undefined);
    const fullPostings = full.work.postings;
    assert.ok(fullPostings > 40, `${fullPostings}`);
    // entry check, route entry check, then 10 posting rows -> expired.
    const clock = expiresAfter(12);
    const cut = search.searchDetailed("order ledger", 8, "text", { budget: { remainingMs: clock.remainingMs } });
    assert.equal(cut.stopReason, "deadline");
    assert.equal(cut.truncated, true);
    assert.ok(cut.work.postings > 0 && cut.work.postings < fullPostings, `${cut.work.postings}`);
    const stages = cut.trace!.map(stage => stage.operation);
    assert.ok(stages.includes("postings:identifier"));
    assert.ok(!stages.includes("postings:chunk") && !stages.includes("postings:document"), `later routes are skipped: ${stages}`);
    assert.ok(stages.includes("merge") && stages.includes("locators"), "the bounded finish still runs");
    assert.ok(cut.hits.length > 0 && cut.hits.every(hit => hit.line !== undefined), "kept hits stay locatable");
    assert.ok(clock.checks() < 12 + cut.work.postings + 20, "no unbounded work after the deadline");
  } finally {
    close(db);
    await fixture.done();
  }
});

test("R09: an exact lookup interrupted by the deadline reports no exact outcome (not a miss)", async () => {
  const fixture = await corpus(3);
  const db = openIndexDb(fixture.dbPath, { readOnly: true });
  try {
    // entry check passes, the first alternative's check expires.
    const r = new SqlEntitySearch(db).searchDetailed("demo.Service001", 8, "exact", { budget: { remainingMs: expiresAfter(1).remainingMs } });
    assert.equal(r.stopReason, "deadline");
    assert.equal(r.exact, undefined);
    const client = {
      status: async () => ({ state: "READY", indexedGeneration: r.generation, coverage: [] }),
      querySearch: async () => r
    } as unknown as JavaIndexClientApi;
    const discovered = await runStaticDiscovery(client, { repoRoot: fixture.root, query: "demo.Service001" });
    assert.equal(discovered.exact, undefined, "discovery does not turn an interrupted lookup into a miss");
    assert.equal(discovered.stopReason, "deadline");
    assert.equal(discovered.scopeState, "PARTIAL");
  } finally {
    close(db);
    await fixture.done();
  }
});

test("R09: every stage is traced with begin/end/remaining/visited and nothing prefetches the graph", async () => {
  const fixture = await corpus(12);
  const db = openIndexDb(fixture.dbPath, { readOnly: true });
  try {
    const search = new SqlEntitySearch(db);
    const calls: EntitySearchOptions[] = [];
    const client = {
      status: async () => ({ state: "READY", indexedGeneration: 1, coverage: [{ root: "src/main/java", state: "COMPLETE", generation: 1 }] }),
      querySearch: async (task: string, options: EntitySearchOptions): Promise<DetailedEntitySearchResult> => {
        calls.push(options);
        return search.searchDetailed(task, options.limit, options.mode, options);
      }
    } as unknown as JavaIndexClientApi;
    const r = await runStaticDiscovery(client, { repoRoot: fixture.root, query: "order ledger", budget: { remainingMs: () => 60_000 }, trace: true });
    const queryTrace = r.trace!;
    const operations = queryTrace.map(stage => stage.operation);
    for (const expected of ["status", "query", "sql:postings:identifier", "sql:rank:identifier", "sql:postings:chunk", "sql:postings:document", "sql:merge", "sql:locators", "preview"]) {
      assert.ok(operations.includes(expected), `${expected} in ${operations}`);
    }
    assert.ok(!queryTrace.some(x => x.operation === "prefetch-entire-graph"));
    for (const stage of queryTrace) {
      assert.ok(stage.endMs >= stage.beginMs, stage.operation);
      assert.ok(typeof stage.remainingMs === "number" && stage.remainingMs > 0 && stage.remainingMs <= 60_000, stage.operation);
      assert.ok(Number.isInteger(stage.visited) && stage.visited >= 0, stage.operation);
    }
    const postings = queryTrace.filter(stage => stage.operation.startsWith("sql:postings:")).reduce((sum, stage) => sum + stage.visited, 0);
    const queryStage = queryTrace.find(stage => stage.operation === "query")!;
    assert.equal(queryStage.visited, postings, "the query stage bills exactly the posting rows its routes visited");
    assert.equal(queryTrace.find(stage => stage.operation === "preview")!.visited, r.candidates.length + r.droppedStale + r.droppedUnlocatable);
    assert.ok(calls[0]!.budget?.remainingMs, "the request deadline reaches the SQL scan");
    const untraced = await runStaticDiscovery(client, { repoRoot: fixture.root, query: "order ledger" });
    assert.equal(untraced.trace, undefined, "the MCP wire carries no trace by default");
  } finally {
    close(db);
    await fixture.done();
  }
});

test("R09: top-K by score tiers equals a full (score desc, id asc) sort, including ties across the cut", () => {
  const db: IndexDatabase = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    // 30 identical documents (one tie tier larger than the cap) plus three
    // stronger ones; ids inserted in reverse order.
    const records = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `tie-${String(29 - i).padStart(2, "0")}`, tokens: ["refund"] })),
      ...["strong-b", "strong-a", "strong-c"].map(id => ({ id, tokens: ["refund", "refund", "ledger"] }))
    ].map(({ id, tokens }) => ({ entityId: id, kind: "type" as const, fqn: `demo.${id}`, simpleName: id, relativePath: `${id}.java`, identifierTokens: [id], chunkTokens: tokens }));
    replaceAllEntities(db, records);
    const r = new SqlEntitySearch(db).searchDetailed("refund ledger", 8, "text");
    assert.deepEqual(r.hits.map(hit => hit.entityId), ["strong-a", "strong-b", "strong-c", "tie-00", "tie-01", "tie-02", "tie-03", "tie-04"]);
    assert.equal(r.selectionLimited, true);
  } finally {
    close(db);
  }
});
