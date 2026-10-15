import assert from "node:assert/strict";
import test from "node:test";
import { STABLE_ID_VERSION, javaEdgeId, javaFileId, javaMethodId, javaTypeId, scopedNamedTypeId, splitOwnerMemberKey } from "./stable-id.js";

test("T02: named type IDs are source-scoped so duplicate FQNs across files stay distinct", () => {
  const a = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/a/src/main/java/demo/Shared.java",
    range: { start: { line: 1, column: 1 }, end: { line: 9, column: 2 } }
  });
  const b = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/b/src/main/java/demo/Shared.java",
    range: { start: { line: 1, column: 1 }, end: { line: 9, column: 2 } }
  });
  assert.notEqual(a, b, "same FQN in two files must produce two declaration IDs");
  assert.ok(a.startsWith("type:v2:"), `expected v2 source-scoped id, got ${a}`);
  assert.ok(b.startsWith("type:v2:"), `expected v2 source-scoped id, got ${b}`);
});

test("T02: source-scoped type IDs are stable to line shifts and change on rename", () => {
  const before = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/a/src/main/java/demo/Shared.java",
    range: { start: { line: 4, column: 12 }, end: { line: 9, column: 2 } }
  });
  const afterBlankLineInsert = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/a/src/main/java/demo/Shared.java",
    range: { start: { line: 5, column: 12 }, end: { line: 10, column: 2 } }
  });
  assert.equal(before, afterBlankLineInsert, "blank-line insertion must not move a named type id");
  const renamed = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/a/src/main/java/demo/Renamed.java",
    range: { start: { line: 4, column: 12 }, end: { line: 9, column: 2 } }
  });
  assert.notEqual(before, renamed, "a rename changes the declaration id");
  assert.equal(STABLE_ID_VERSION, 2, "identity version must be bumped with the v2 id format");
});

test("T02: separator and special characters are escaped in source-scoped ids", () => {
  const tricky = scopedNamedTypeId("modules/a/src/main/java/demo/#weird  Shared.java", "demo.Shared");
  assert.equal(tricky, `type:v2:${encodeURIComponent("modules/a/src/main/java/demo/#weird  Shared.java")}#${encodeURIComponent("demo.Shared")}`);
  const body = tricky.slice("type:v2:".length);
  const hash = body.indexOf("#");
  assert.ok(hash > 0, "the separator is a raw # while the escaped path carries none");
  assert.equal(decodeURIComponent(body.slice(hash + 1)), "demo.Shared");
  assert.equal(decodeURIComponent(body.slice(0, hash)), "modules/a/src/main/java/demo/#weird  Shared.java");
});

test("T02: scopedNamedTypeId rejects absolute, URI, traversal, and empty-segment paths", () => {
  for (const invalid of ["/abs/Shared.java", "../Shared.java", "a/../b/Shared.java", "a\0b.java", "a:b.java", "a/./b.java", "a//b.java", ""]) {
    assert.throws(() => scopedNamedTypeId(invalid, "demo.Shared"), `path ${JSON.stringify(invalid)} must be rejected`);
  }
  assert.throws(() => scopedNamedTypeId("a/Shared.java", ""), "named types require an FQN");
});

test("T02: method IDs derive from the source-scoped owner and stay per-file", () => {
  const ownerA = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/a/src/main/java/demo/Shared.java",
    range: { start: { line: 1, column: 1 }, end: { line: 9, column: 2 } }
  });
  const ownerB = javaTypeId({
    fqn: "demo.Shared",
    relativePath: "modules/b/src/main/java/demo/Shared.java",
    range: { start: { line: 1, column: 1 }, end: { line: 9, column: 2 } }
  });
  assert.notEqual(javaMethodId(ownerA, "save()"), javaMethodId(ownerB, "save()"), "same method on same-FQN owners in different files must have distinct ids");
  assert.equal(javaMethodId(ownerA, "save()"), `method:${ownerA}#save()`);
});


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

test("owner#member keys split only for v2 and local owners; pre-v2 owners are malformed", () => {
  const owner = scopedNamedTypeId("src/main/java/a/B.java", "a.B");
  assert.deepEqual(splitOwnerMemberKey(`${owner}#save(int)`), { owner, member: "save(int)" });
  assert.deepEqual(splitOwnerMemberKey("type-local:src/A.java:3:4#run()"), { owner: "type-local:src/A.java:3:4", member: "run()" });
  assert.equal(splitOwnerMemberKey("type:a.B#save(int)"), undefined);
  assert.equal(splitOwnerMemberKey("a.B#save(int)"), undefined);
});
