import assert from "node:assert/strict";
import test from "node:test";
import { isSymbolIdLike, selectorParameters } from "./symbol-target.js";

test("selectorParameters spells a parameter list the way an erased declaration key does", () => {
  assert.equal(selectorParameters("com.example.Orders#place"), undefined, "no list: a plain name");
  assert.equal(selectorParameters("com.example.Orders"), undefined);
  assert.deepEqual(selectorParameters("com.example.Orders#ship()"), { name: "com.example.Orders#ship", parameters: [] });
  assert.deepEqual(selectorParameters(" Orders#place(int, java.lang.String) "), { name: "Orders#place", parameters: ["int", "java.lang.String"] });
  assert.deepEqual(selectorParameters("Orders#put(Map<String, List<Integer>> values, int n)")?.parameters, ["Map", "int"], "generics never split a list");
  assert.deepEqual(selectorParameters("Orders#log(@NotNull final String... lines)")?.parameters, ["String[]"], "annotations, modifiers and names drop; varargs is []");
  assert.deepEqual(selectorParameters("Orders#fill(byte [] data, @Named(\"x\") int[][] grid)")?.parameters, ["byte[]", "int[][]"]);
});

test("isSymbolIdLike routes ids, not names", () => {
  for (const id of ["jsym:mac1:w:k", "jev:mac1:x", "type:v2:a#b", "method:x#y()", "field:x#y", "file:a", "type-local:a:1:1"]) assert.equal(isSymbolIdLike(id), true, id);
  for (const name of ["com.example.Orders", "Orders#place(int)"]) assert.equal(isSymbolIdLike(name), false, name);
});
