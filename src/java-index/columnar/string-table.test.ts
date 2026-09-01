import assert from "node:assert/strict";
import test from "node:test";
import { STRING_TABLE_INITIAL_BYTES, StringTable } from "./string-table.js";

test("StringTable intern is stable, empty is 0, and get round-trips unicode", () => {
  const table = new StringTable();
  assert.equal(table.intern(""), 0);
  const first = table.intern("file:src/A.java#PayAccount#save#abcd");
  const second = table.intern("file:src/A.java#PayAccount#save#abcd");
  const other = table.intern("中文路径/PayAccount.java");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(table.get(first), "file:src/A.java#PayAccount#save#abcd");
  assert.equal(table.get(other), "中文路径/PayAccount.java");
  assert.equal(table.interned("x") === table.interned("x"), true);
});

test("StringTable grows past the initial buffer and hash capacity", () => {
  const table = new StringTable();
  const handles = new Set<number>();
  for (let index = 0; index < 4000; index += 1) {
    handles.add(table.intern(`id:${index}:${"x".repeat(index % 40)}`));
  }
  assert.equal(handles.size, 4000);
  const last = `id:3999:${"x".repeat(3999 % 40)}`;
  assert.equal(table.get(table.intern(last)), last);
  assert.ok(table.allocatedPayloadBytes() > STRING_TABLE_INITIAL_BYTES);
  table.clear();
  assert.equal(table.size, 1);
  assert.equal(table.allocatedPayloadBytes(), STRING_TABLE_INITIAL_BYTES);
  assert.equal(table.intern("id:0:"), 1);
});
