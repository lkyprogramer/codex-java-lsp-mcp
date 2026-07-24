import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRgCache } from "./rg-cache.js";
import type { Completion } from "../runtime/completion.js";
import type { SearchResult } from "./search-types.js";

function result(completion: Completion = "COMPLETE"): SearchResult {
  return {
    files: [{ absolutePath: "/repo/A.java", matchCount: 1, positions: [{ line: 1, column: 1 }] }],
    completion,
    rawBytes: 10,
    totalMatches: 1,
    elapsedMs: 1
  };
}

test("generation rg cache rejects partial results", () => {
  const cache = new GenerationRgCache(300_000);
  cache.set("k", 7, result());
  assert.ok(cache.get("k", 7));
  cache.set("partial", 7, result("PARTIAL_TIMEOUT"));
  assert.equal(cache.get("partial", 7), undefined);
  assert.equal(cache.get("k", 8), undefined);
});

test("no non-COMPLETE completion is ever cacheable", () => {
  const cache = new GenerationRgCache(300_000);
  for (const completion of ["PARTIAL_TIMEOUT", "PARTIAL_LIMIT", "CANCELLED", "FAILED"] as const) {
    cache.set(completion, 1, result(completion));
    assert.equal(cache.get(completion, 1), undefined, `${completion} must not be cached`);
  }
  assert.equal(cache.size, 0);
});

test("a stale generation entry is dropped rather than returned", () => {
  const cache = new GenerationRgCache(300_000);
  cache.set("k", 1, result());
  assert.equal(cache.get("k", 2), undefined);
  assert.equal(cache.get("k", 1), undefined, "the mismatched read also evicts the entry");
});

test("invalidateBefore removes only older generations", () => {
  const cache = new GenerationRgCache(300_000);
  cache.set("old", 1, result());
  cache.set("current", 2, result());
  cache.invalidateBefore(2);
  assert.equal(cache.get("old", 1), undefined);
  assert.ok(cache.get("current", 2));
});

test("a disabled ttl stores nothing", () => {
  const cache = new GenerationRgCache(0);
  cache.set("k", 1, result());
  assert.equal(cache.get("k", 1), undefined);
  assert.equal(cache.size, 0);
});
