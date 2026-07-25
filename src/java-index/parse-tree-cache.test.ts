import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParserBackend, type JavaSyntaxTree } from "./java-parser-backend.js";
import { extractFromParsedTree, type ExtractJavaInput } from "./ast-extractor.js";
import {
  ParseTreeCache,
  computeSingleEdit,
  refreshParseTree,
  type ParseTreeCacheOptions
} from "./parse-tree-cache.js";

function assertValidEdit(oldSource: string, newSource: string, edit: ReturnType<typeof computeSingleEdit>): void {
  assert.ok(edit, "expected an edit to be computed");
  const e = edit!;
  assert.equal(oldSource.slice(0, e.startIndex), newSource.slice(0, e.startIndex));
  assert.equal(oldSource.slice(e.oldEndIndex), newSource.slice(e.newEndIndex));
  assert.notEqual(
    oldSource.slice(e.startIndex, e.oldEndIndex),
    newSource.slice(e.startIndex, e.newEndIndex)
  );
}

function baseInput(overrides: Partial<ExtractJavaInput> & { content: string; relativePath: string }): ExtractJavaInput {
  return {
    repoRoot: "/repo",
    absolutePath: `/repo/${overrides.relativePath}`,
    sourceRoot: "src/main/java",
    module: "demo-module",
    sourceSet: "main",
    size: Buffer.byteLength(overrides.content, "utf8"),
    mtimeMs: 0,
    contentHash: "test",
    generation: 1,
    ...overrides
  };
}

test("computeSingleEdit: ASCII one-token edit", () => {
  const oldSource = "class X { int a = 1; }";
  const newSource = "class X { int abcdef = 1; }";
  const edit = computeSingleEdit(oldSource, newSource, {
    maxSingleFileBytes: 1024,
    maxIncrementalChangeRatio: 1
  });
  assertValidEdit(oldSource, newSource, edit);
});

test("computeSingleEdit: Chinese string before the edit point", () => {
  const oldSource = 'class X { String s = "中文注释 \u{1F389}"; int a = 1; }';
  const newSource = 'class X { String s = "中文注释 \u{1F389}"; int abcdef = 1; }';
  const edit = computeSingleEdit(oldSource, newSource, {
    maxSingleFileBytes: 1024,
    maxIncrementalChangeRatio: 1
  });
  assertValidEdit(oldSource, newSource, edit);
  // The common prefix must extend past the CJK text and emoji (both fully
  // preserved ahead of the edit point) - if prefix matching were byte-based
  // instead of UTF-16-based, this offset would land inside the emoji's
  // surrogate pair or the multi-byte CJK sequence instead of just after it.
  const e = edit!;
  assert.equal(oldSource.slice(0, e.startIndex), newSource.slice(0, e.startIndex));
  assert.ok(e.startIndex > oldSource.indexOf('\u{1F389}'));
});

test("computeSingleEdit: insert/delete across a line boundary", () => {
  const oldSource = "line one\nline two\nline three\n";
  const newSource = "line one\nline two extra\nline two point five\nline three\n";
  const edit = computeSingleEdit(oldSource, newSource, {
    maxSingleFileBytes: 1024,
    maxIncrementalChangeRatio: 1
  });
  assertValidEdit(oldSource, newSource, edit);
  const e = edit!;
  assert.equal(e.startPosition.row, 1);
  assert.equal(e.newEndPosition.row, 2);
});

test("computeSingleEdit: large rewrite falls back to full parse (returns undefined)", () => {
  const oldSource = "a".repeat(1000);
  const newSource = "b".repeat(1000);
  const edit = computeSingleEdit(oldSource, newSource, {
    maxSingleFileBytes: 10_000,
    maxIncrementalChangeRatio: 0.25
  });
  assert.equal(edit, undefined);
});

test("computeSingleEdit: unchanged text and oversized files return undefined", () => {
  const source = "class X {}";
  assert.equal(
    computeSingleEdit(source, source, { maxSingleFileBytes: 1024, maxIncrementalChangeRatio: 1 }),
    undefined
  );
  assert.equal(
    computeSingleEdit(source, `${source} `, { maxSingleFileBytes: 1, maxIncrementalChangeRatio: 1 }),
    undefined
  );
});

test("ParseTreeCache: entry-count LRU eviction", () => {
  const options: ParseTreeCacheOptions = {
    maxEntries: 2,
    maxSourceBytes: 1024 * 1024,
    maxSingleFileBytes: 1024 * 1024,
    maxIncrementalChangeRatio: 1
  };
  const cache = new ParseTreeCache(options);
  const fakeTree = (): JavaSyntaxTree => ({
    rootNode: {} as JavaSyntaxTree["rootNode"],
    edit: () => {},
    getChangedRanges: () => [],
    delete: () => {}
  });

  cache.replace("A.java", "a", fakeTree());
  cache.replace("B.java", "b", fakeTree());
  cache.get("A.java"); // touch A so B becomes the least-recently-used
  cache.replace("C.java", "c", fakeTree());

  assert.equal(cache.size(), 2);
  assert.ok(cache.get("A.java"));
  assert.ok(cache.get("C.java"));
  assert.equal(cache.get("B.java"), undefined);
  assert.equal(cache.metrics.evictions, 1);
});

test("ParseTreeCache: total-byte-cap eviction", () => {
  const options: ParseTreeCacheOptions = {
    maxEntries: 100,
    maxSourceBytes: 10,
    maxSingleFileBytes: 1024,
    maxIncrementalChangeRatio: 1
  };
  const cache = new ParseTreeCache(options);
  const fakeTree = (): JavaSyntaxTree => ({
    rootNode: {} as JavaSyntaxTree["rootNode"],
    edit: () => {},
    getChangedRanges: () => [],
    delete: () => {}
  });

  cache.replace("A.java", "1234567", fakeTree()); // 7 bytes
  cache.replace("B.java", "1234567", fakeTree()); // 7 + 7 = 14 > 10, evicts A

  assert.equal(cache.get("A.java"), undefined);
  assert.ok(cache.get("B.java"));
  assert.ok(cache.metrics.evictions >= 1);
});

test("ParseTreeCache: eviction calls Tree.delete()", () => {
  const options: ParseTreeCacheOptions = {
    maxEntries: 1,
    maxSourceBytes: 1024 * 1024,
    maxSingleFileBytes: 1024 * 1024,
    maxIncrementalChangeRatio: 1
  };
  const cache = new ParseTreeCache(options);
  let deleted = false;
  const spyTree: JavaSyntaxTree = {
    rootNode: {} as JavaSyntaxTree["rootNode"],
    edit: () => {},
    getChangedRanges: () => [],
    delete: () => { deleted = true; }
  };
  const otherTree: JavaSyntaxTree = {
    rootNode: {} as JavaSyntaxTree["rootNode"],
    edit: () => {},
    getChangedRanges: () => [],
    delete: () => {}
  };

  cache.replace("A.java", "a", spyTree);
  assert.equal(deleted, false);
  cache.replace("B.java", "b", otherTree); // maxEntries=1 forces A out
  assert.equal(deleted, true);
});

test("incremental facts equal clean full-parse facts", async () => {
  const backend = await createJavaParserBackend();
  // A permissive ratio decouples this equivalence check from the separate
  // "large rewrite falls back" threshold test - the edit below is
  // deliberately non-trivial (adds a statement and a new method) to exercise
  // more than a single-token change.
  const cache = new ParseTreeCache({
    maxEntries: 128,
    maxSourceBytes: 64 * 1024 * 1024,
    maxSingleFileBytes: 2 * 1024 * 1024,
    maxIncrementalChangeRatio: 1
  });
  const relativePath = "src/main/java/demo/Widget.java";

  const original = [
    "package demo;",
    "",
    "public class Widget {",
    "  void run() {",
    "    String text = \"hello\";",
    "  }",
    "}",
    ""
  ].join("\n");
  refreshParseTree(cache, backend, relativePath, original);

  const edited = [
    "package demo;",
    "",
    "public class Widget {",
    "  void run() {",
    "    String text = \"hello world\";",
    "    helper();",
    "  }",
    "  void helper() {}",
    "}",
    ""
  ].join("\n");
  const { tree: incrementalTree, incremental } = refreshParseTree(cache, backend, relativePath, edited);
  assert.equal(incremental, true, "expected the second refresh to reuse the cached tree incrementally");

  const incrementalFacts = extractFromParsedTree(baseInput({ content: edited, relativePath }), incrementalTree);

  const freshTree = backend.parse(edited);
  const freshFacts = extractFromParsedTree(baseInput({ content: edited, relativePath }), freshTree);

  assert.deepEqual(incrementalFacts, freshFacts);
});
