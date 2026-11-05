// input: runStaticDiscovery with a capturing fake index client.
// output: R07 regression lock for the discovery input contract: terms
//         supplement the query, intent comes from the raw query only, one
//         limit contract (1..20, default 8, never silently clamped), UTF-16
//         length boundaries, and exact/selectionLimited reporting.
import assert from "node:assert/strict";
import test from "node:test";
import { DISCOVERY_DEFAULT_LIMIT, DISCOVERY_MAX_LIMIT, DiscoveryUnsupportedError, runStaticDiscovery } from "./query.js";
import { ENTITY_SEARCH_MAX_LIMIT, type DetailedEntitySearchResult, type EntitySearchOptions } from "../java-index/entity-search.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

type Call = { task: string; options?: EntitySearchOptions };

function client(calls: Call[], reply: Partial<DetailedEntitySearchResult> = {}): JavaIndexClientApi {
  const status = { state: "READY" as const, indexedGeneration: 3, files: 1, types: 1, methods: 1, edges: 0, snapshotBytes: 0, pendingForeground: 0, pendingBackground: 0, coverage: [], resourceCoverage: [] };
  return {
    status: async () => status,
    querySearch: async (task: string, options?: EntitySearchOptions) => {
      calls.push({ task, options });
      return { hits: [], truncated: false, selectionLimited: false, work: { postings: 0 }, generation: 3, ...reply };
    }
  } as unknown as JavaIndexClientApi;
}

const run = (calls: Call[], args: Record<string, unknown>, reply?: Partial<DetailedEntitySearchResult>) =>
  runStaticDiscovery(client(calls, reply), { repoRoot: "/nonexistent", query: "OrderService rollback", ...args } as Parameters<typeof runStaticDiscovery>[1]);

test("R07: terms supplement the raw query and force text intent", async () => {
  const calls: Call[] = [];
  await run(calls, { terms: ["refund"] });
  assert.ok(calls[0]!.task.includes("OrderService") && calls[0]!.task.includes("rollback") && calls[0]!.task.includes("refund"));
  assert.equal(calls[0]!.options?.mode, "text");
  await run(calls, { query: "OrderService", terms: ["refund", "  ledger  "] });
  assert.equal(calls[1]!.task, "OrderService refund ledger", "a selector plus terms is a text search over both");
  assert.equal(calls[1]!.options?.mode, "text");
  await assert.rejects(() => run(calls, { query: "OrderService", searchMode: "exact", terms: ["refund"] }), DiscoveryUnsupportedError);
});

test("R07: auto intent is exact only when the whole raw query is one selector", async () => {
  const calls: Call[] = [];
  for (const [query, mode] of [
    ["demo.OrderService", "exact"],
    ["OrderService#refund", "exact"],
    ["where is demo.OrderService used", "text"],
    ["OrderService rollback", "text"],
    ["rollback", "text"]
  ] as const) {
    await run(calls, { query });
    assert.equal(calls.at(-1)!.options?.mode, mode, query);
    assert.equal(calls.at(-1)!.task, query, "the raw query is never rewritten");
  }
});

test("R07: one limit contract - default 8, 1..20, never silently clamped", async () => {
  const calls: Call[] = [];
  assert.equal(DISCOVERY_DEFAULT_LIMIT, 8);
  assert.equal(DISCOVERY_MAX_LIMIT, 20);
  assert.equal(DISCOVERY_MAX_LIMIT, ENTITY_SEARCH_MAX_LIMIT, "discovery and SQL share one cap");
  await run(calls, {});
  assert.equal(calls[0]!.options?.limit, 8);
  await run(calls, { limit: 20 });
  assert.equal(calls[1]!.options?.limit, 20);
  await run(calls, { limit: 1 });
  assert.equal(calls[2]!.options?.limit, 1);
  for (const limit of [0, -1, 21, 300, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => run(calls, { limit }), /limit must be an integer 1\.\.20/, String(limit));
  }
  assert.equal(calls.length, 3, "rejected requests never reach the index");
});

test("R07: query and term lengths are UTF-16 code units, with exact boundaries", async () => {
  const calls: Call[] = [];
  const emoji = "🧪"; // 2 UTF-16 code units
  await run(calls, { query: emoji.repeat(256) });
  await assert.rejects(() => run(calls, { query: emoji.repeat(256) + "a" }), /exceeds 512 code units/);
  await run(calls, { terms: [emoji.repeat(32)] });
  await assert.rejects(() => run(calls, { terms: [emoji.repeat(32) + "a"] }), /64 code units/);
  await assert.rejects(() => run(calls, { terms: ["   "] }), /non-empty/);
  await assert.rejects(() => run(calls, { terms: ["a", "b", "c", "d", "e", "f", "g"] }), /limited to 6/);
  await run(calls, { terms: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(calls.length, 3);
});

test("R07: exact outcome and selectionLimited are reported, never hidden", async () => {
  const calls: Call[] = [];
  const miss = await run(calls, { query: "demo.MissingService" }, { exact: "miss" });
  assert.equal(miss.exact, "miss");
  assert.deepEqual(miss.candidates, []);
  assert.equal(miss.scopeState, "READY", "a miss in a complete index is an answer, not a partial");
  const text = await run(calls, { query: "refund ledger" }, { selectionLimited: true });
  assert.equal(text.selectionLimited, true);
  assert.equal(text.exact, undefined, "text searches carry no exact outcome");
  await assert.rejects(() => run(calls, { query: "Map<String, V>", searchMode: "exact" }), DiscoveryUnsupportedError);
});
