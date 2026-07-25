import assert from "node:assert/strict";
import test from "node:test";
import { javaEdgeId, javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

test("stable IDs are independent of worktree absolute root", () => {
  const left = javaFileId("src/main/java/demo/A.java");
  const right = javaFileId("src\\main\\java\\demo\\A.java");
  assert.equal(left, right);
  assert.equal(left.includes("/Users/"), false);
});

test("local type IDs include relative path and source position", () => {
  assert.equal(javaTypeId({
    relativePath: "src/main/java/demo/A.java",
    range: { start: { line: 8, column: 3 }, end: { line: 9, column: 1 } }
  }), "type-local:src/main/java/demo/A.java:8:3");
});

test("method IDs use owner type and erased signature", () => {
  assert.equal(
    javaMethodId("type:demo.A", "save(java.lang.String,int)"),
    "method:type:demo.A#save(java.lang.String,int)"
  );
});

test("two call sites to the same target retain distinct root-independent edge IDs", () => {
  const first = javaEdgeId({
    kind: "CALLS",
    fromId: "method:type:demo.A#run()",
    toId: "method:type:demo.B#save()",
    range: { start: { line: 10, column: 3 }, end: { line: 10, column: 11 } }
  });
  const second = javaEdgeId({
    kind: "CALLS",
    fromId: "method:type:demo.A#run()",
    toId: "method:type:demo.B#save()",
    range: { start: { line: 12, column: 3 }, end: { line: 12, column: 11 } }
  });
  assert.notEqual(first, second);
  assert.equal(first.includes("/Users/"), false);
});
