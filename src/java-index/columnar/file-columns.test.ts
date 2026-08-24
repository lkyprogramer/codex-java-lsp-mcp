import assert from "node:assert/strict";
import test from "node:test";
import { FileColumns } from "./file-columns.js";
import { RangePool } from "./range-pool.js";
import { StringTable } from "./string-table.js";
import type { JavaFileFacts } from "../index-types.js";

function sampleFile(overrides: Partial<JavaFileFacts> = {}): JavaFileFacts {
  return {
    fileId: "file:src/A.java",
    relativePath: "src/A.java",
    sourceRoot: "src/main/java",
    module: ".",
    sourceSet: "main",
    packageName: "demo",
    imports: [{
      qualifiedName: "java.util.List",
      wildcard: false,
      static: false,
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 18 } }
    }],
    topLevelTypeIds: ["src/A.java#A"],
    allTypeIds: ["src/A.java#A", "src/A.java#A.Inner"],
    contentHash: "abc",
    size: 128,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_100,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 3,
    ...overrides
  };
}

test("file columns round-trip imports, type ids, and optional ctime", () => {
  const columns = new FileColumns(new StringTable(), new RangePool());
  columns.add(sampleFile());
  const got = columns.materialize(columns.rowOf("src/A.java")!);
  assert.equal(got.packageName, "demo");
  assert.equal(got.imports[0]?.qualifiedName, "java.util.List");
  assert.equal(got.imports[0]?.wildcard, false);
  assert.deepEqual(got.allTypeIds, ["src/A.java#A", "src/A.java#A.Inner"]);
  assert.equal(got.ctimeMs, 1_700_000_000_100);
  assert.equal(got.mtimeMs, 1_700_000_000_000);
  assert.equal(columns.size, 1);
});

test("file columns last-write-wins on the same relativePath", () => {
  const columns = new FileColumns(new StringTable(), new RangePool());
  columns.add(sampleFile({ generation: 1, packageName: "old" }));
  columns.add(sampleFile({ generation: 2, packageName: "new", imports: [] }));
  assert.equal(columns.size, 1);
  const got = columns.materialize(columns.rowOf("src/A.java")!);
  assert.equal(got.generation, 2);
  assert.equal(got.packageName, "new");
  assert.equal(got.imports.length, 0);
});

test("stampGeneration invalidates memo without dropping imports", () => {
  const columns = new FileColumns(new StringTable(), new RangePool());
  columns.add(sampleFile({ generation: 1 }));
  const first = columns.materialize(columns.rowOf("src/A.java")!);
  columns.stampGeneration("src/A.java", 9);
  const second = columns.materialize(columns.rowOf("src/A.java")!);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 9);
  assert.equal(second.imports[0]?.qualifiedName, "java.util.List");
  assert.notEqual(first, second);
});
