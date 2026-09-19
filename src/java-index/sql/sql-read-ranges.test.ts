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