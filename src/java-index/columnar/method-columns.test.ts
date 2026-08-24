import assert from "node:assert/strict";
import test from "node:test";
import { RangePool } from "./range-pool.js";
import { StringTable } from "./string-table.js";
import { MethodColumns } from "./method-columns.js";
import type { JavaMethodFacts, JavaTypeRef } from "../index-types.js";

const RANGE = { start: { line: 2, column: 1 }, end: { line: 8, column: 2 } };

function typeRef(name: string, args: JavaTypeRef[] = []): JavaTypeRef {
  return {
    text: name,
    simpleName: name,
    typeArguments: args,
    arrayDepth: 0,
    resolution: { state: "UNRESOLVED" }
  };
}

function sampleMethod(): JavaMethodFacts {
  return {
    methodId: "m1",
    ownerTypeId: "t1",
    name: "save",
    constructor: false,
    signatureKey: "save(PayAccount)",
    range: RANGE,
    bodyRange: RANGE,
    modifiers: ["public"],
    annotations: [{ name: "Override", range: RANGE }],
    typeParameters: [],
    returnType: typeRef("void"),
    parameters: [{
      name: "account",
      type: typeRef("PayAccount"),
      varargs: false,
      annotations: [],
      range: RANGE
    }],
    throws: [typeRef("IOException")],
    callSites: [{
      kind: "METHOD_INVOCATION",
      name: "insert",
      arity: 1,
      argumentTypeHints: [typeRef("List", [typeRef("PayAccount")])],
      range: RANGE
    }],
    localTypes: []
  };
}

test("MethodColumns round-trips nested TypeRef arguments, calls, and annotations", () => {
  const columns = new MethodColumns(new StringTable(), new RangePool());
  columns.add(sampleMethod());
  const got = columns.materialize(columns.rowOf("m1")!);
  assert.deepEqual(got, sampleMethod());
  assert.equal(got.callSites[0]!.argumentTypeHints[0]!.typeArguments[0]!.simpleName, "PayAccount");
});

test("MethodColumns remove tombstones a row and add is last-write-wins", () => {
  const columns = new MethodColumns(new StringTable(), new RangePool());
  columns.add(sampleMethod());
  const updated = sampleMethod();
  updated.name = "save2";
  updated.signatureKey = "save2()";
  columns.add(updated);
  assert.equal(columns.size, 1);
  assert.equal(columns.materialize(columns.rowOf("m1")!).name, "save2");
  columns.remove("m1");
  assert.equal(columns.has("m1"), false);
  assert.equal(columns.size, 0);
});
