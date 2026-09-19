import assert from "node:assert/strict";
import test from "node:test";
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts, SourcePosition, SourceRange } from "../index-types.js";
import { javaReadRanges } from "./sql-read-ranges.js";

const range = (startLine: number, endLine: number): SourceRange => ({
  start: { line: startLine, column: 1 },
  end: { line: endLine, column: 2 }
});

// A 422-line file whose single method spans lines 2..421 - the same shape as
// the C3 probe fixture, exercised through the real javaReadRanges logic.
function longMethodBundle(): JavaFileBundle {
  const file = "LongMethod.java";
  const type: JavaTypeFacts = {
    typeId: "type:long",
    fqn: "long.LongMethod",
    simpleName: "LongMethod",
    kind: "class",
    fileId: `file:${file}`,
    range: range(1, 422),
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: ["method:long#action()"],
    confidence: 1
  };
  const method: JavaMethodFacts = {
    methodId: "method:long#action()",
    ownerTypeId: "type:long",
    name: "action",
    constructor: false,
    signatureKey: "action()",
    range: range(2, 421),
    bodyRange: range(2, 421),
    modifiers: ["private"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
  return {
    file: {
      fileId: `file:${file}`,
      relativePath: file,
      sourceRoot: "src",
      module: "root",
      sourceSet: "main",
      packageName: "long",
      imports: [],
      topLevelTypeIds: [type.typeId],
      allTypeIds: [type.typeId],
      contentHash: "fixture",
      size: 5000,
      mtimeMs: 1,
      parseState: "COMPLETE",
      parseErrorCount: 0,
      generation: 1
    },
    types: [type],
    fields: [],
    methods: [method],
    edges: []
  };
}

function covered(lines: number[], windows: Array<{ startLine: number; endLine: number }>): boolean {
  return lines.every(line => windows.some(w => w.startLine <= line && line <= w.endLine));
}

test("T03: an anchor at line 201 of an extreme method is covered by its own window", () => {
  const { ranges } = javaReadRanges(longMethodBundle(), [{ line: 201, column: 5 } as SourcePosition]);
  assert.ok(ranges.length > 0);
  assert.ok(covered([201], ranges), `line 201 must be inside a returned window, got ${JSON.stringify(ranges.map(w => [w.startLine, w.endLine]))}`);
});

test("T03: anchors at lines 100 and 350 of an extreme method are both covered", () => {
  const { ranges } = javaReadRanges(longMethodBundle(), [
    { line: 100, column: 5 },
    { line: 350, column: 5 }
  ] as SourcePosition[]);
  assert.ok(covered([100, 350], ranges), `both anchors must survive, got ${JSON.stringify(ranges.map(w => [w.startLine, w.endLine]))}`);
});

test("T03: a position on the owning type's closing line still gets a window without losing method anchors", () => {
  const { ranges } = javaReadRanges(longMethodBundle(), [
    { line: 201, column: 5 },
    { line: 422, column: 1 }
  ] as SourcePosition[]);
  assert.ok(ranges.length > 0, "the request still produces windows");
  assert.ok(covered([201], ranges), `the in-method anchor keeps its window, got ${JSON.stringify(ranges.map(w => [w.startLine, w.endLine]))}`);
});
import { Buffer } from "node:buffer";
import { lineStartOffsets, sourceRangeForLines, utf8BytesForLines } from "./sql-read-ranges.js";

// T03: window costs and coordinates must be exact UTF-8 bytes on CRLF content
// with multibyte characters - never a character-count estimate.
test("T03: CRLF + emoji window bytes equal the real UTF-8 slice and ranges land on the right lines", () => {
  const content = [
    "package demo;",
    "public class EmojiService {",
    "    // emoji cost check: 🚀🚀🚀 (3 x 4 bytes)",
    "    int a = 1;",
    "    int b = 2;",
    "}",
    ""
  ].join("\r\n");
  const starts = lineStartOffsets(content);
  const bytes = utf8BytesForLines(content, starts, 2, 4);
  // Lines 2..4 end-exclusive at the start of line 5.
  const startOffset = starts[1]!;
  const endOffset = starts[4]!;
  assert.equal(bytes, Buffer.byteLength(content.slice(startOffset, endOffset), "utf8"), "reported cost must equal the real UTF-8 byte slice");
  assert.ok(bytes > endOffset - startOffset, "multibyte emoji + CRLF must cost more bytes than characters");
  const range = sourceRangeForLines(content, starts, 2, 4);
  assert.equal(range.start.line, 2);
  assert.equal(range.start.column, 1);
  // End-exclusive convention: covering lines 2..4 ends at the first column of line 5.
  assert.equal(range.end.line, 5);
  assert.equal(range.end.column, 1);
  const line3 = content.split("\r\n")[2]!;
  assert.ok(line3.includes("🚀"), "sanity: the window really contains the emoji line");
});
