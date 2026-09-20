// input: A discovery query that asks for an exact symbol but carries
//         parameterized (generic) type arguments.
// output: A structured unsupported-shape error instead of a silent empty
//         result: the static index stores raw declarations, so "Map<String,
//         V>" can never match, and callers must learn the raw-name retry
//         instead of a FAIL probe.
// pos: M2 T08 M2-2 - exact + generics is a shape the search route cannot
//      address; it is an error, not a zero-hit surprise.
import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryUnsupportedError, runStaticDiscovery } from "./query.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

function fakeClient(calls: string[]): JavaIndexClientApi {
  const ready = { state: "READY" as const, indexedGeneration: 1, files: 1, types: 1, methods: 1, edges: 0, snapshotBytes: 0 };
  return {
    open: async () => ready,
    close: async () => ready,
    status: async () => ready,
    querySearch: async (task: string) => {
      calls.push(task);
      return {
        hits: [],
        truncated: false,
        generation: 1,
        totalMs: 1,
        stats: { entityRows: 1, candidateRows: 0, avgLength: 0 }
      };
    }
  } as unknown as JavaIndexClientApi;
}

test("exact search with generics throws a structured unsupported-shape error", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runStaticDiscovery(fakeClient(calls), {
      query: "Map<String, V>",
      searchMode: "exact",
      repoRoot: "/tmp"
    }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryUnsupportedError, `expected DiscoveryUnsupportedError, got ${String(error)}`);
      assert.equal((error as DiscoveryUnsupportedError).code, "DISCOVERY_UNSUPPORTED");
      return true;
    }
  );
  assert.equal(calls.length, 0, "the unsupported shape must fail before any search executes");
});

test("auto mode with generics stays on the text route instead of erroring", async () => {
  const calls: string[] = [];
  const result = await runStaticDiscovery(fakeClient(calls), {
    query: "Map<String, V> rollback",
    repoRoot: "/tmp"
  });
  assert.equal(result.schemaVersion, "java-discovery/v1");
  assert.equal(result.candidates.length, 0);
  assert.equal(calls.length, 1, "the text route still searches, it just does not claim exact binding");
});