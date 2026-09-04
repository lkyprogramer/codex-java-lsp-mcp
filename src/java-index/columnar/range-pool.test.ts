import assert from "node:assert/strict";
import test from "node:test";
import { NO_RANGE, RangePool } from "./range-pool.js";

test("RangePool intern is coordinate-identity and 0 means absent", () => {
  const pool = new RangePool();
  assert.equal(pool.intern(undefined), NO_RANGE);
  assert.equal(pool.get(NO_RANGE), undefined);
  const first = pool.intern({ start: { line: 10, column: 2 }, end: { line: 12, column: 1 } });
  const second = pool.intern({ start: { line: 10, column: 2 }, end: { line: 12, column: 1 } });
  const other = pool.intern({ start: { line: 10, column: 3 }, end: { line: 12, column: 1 } });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.deepEqual(pool.get(first), { start: { line: 10, column: 2 }, end: { line: 12, column: 1 } });
  assert.equal(pool.getObject(first), pool.getObject(second));
  assert.ok(pool.memoBytes() > 0, "memo JS objects are measured");
  assert.ok(pool.memoLiveCount() >= 1);
  pool.clear();
  assert.equal(pool.memoLiveCount(), 0);
});
