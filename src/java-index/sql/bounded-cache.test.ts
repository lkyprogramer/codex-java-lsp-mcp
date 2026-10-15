import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCache } from "./bounded-cache.js";

test("a bounded cache keeps recently read entries and never exceeds its limit", () => {
  const cache = new BoundedCache<string, number>(8);
  for (let index = 0; index < 4; index += 1) cache.set(`k${index}`, index);
  // Rotation at limit/2: k0..k3 are now the old generation.
  assert.equal(cache.get("k0"), 0, "an old-generation hit is returned and promoted");
  for (let index = 4; index < 7; index += 1) cache.set(`k${index}`, index);
  // The second rotation drops k1..k3 but keeps the promoted k0.
  assert.equal(cache.get("k0"), 0);
  assert.equal(cache.get("k1"), undefined);
  for (let index = 0; index < 100; index += 1) {
    cache.set(`n${index}`, index);
    assert.ok(cache.size <= 8, `size ${cache.size}`);
  }
  assert.equal(cache.get("n99"), 99);
});

test("delete and clear remove entries from both generations", () => {
  const cache = new BoundedCache<number, string>(4);
  cache.set(1, "a");
  cache.set(2, "b");
  cache.set(3, "c");
  cache.delete(1);
  assert.equal(cache.get(1), undefined);
  assert.equal(cache.get(2), "b");
  cache.clear();
  assert.equal(cache.get(2), undefined);
  assert.equal(cache.get(3), undefined);
  assert.equal(cache.size, 0);
});
