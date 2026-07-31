// input: Hand-built JavaFileBundle fixtures (types/fields/methods/edges) - no parser/worker needed, this module is pure.
// output: Coverage for the id-parsing helpers and the bundle -> FrameworkDeclarations projection.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  JavaAnnotationFact,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeRef,
  StaticEdge
} from "./index-types.js";
import {
  bundleToFrameworkFileFacts,
  bundlesToRequestedDeclarations,
  fqnOfTypeId,
  ownerTypeIdOf,
  relativePathOfLocalTypeId
} from "./framework-index-view.js";
import { javaParameterId } from "./stable-id.js";

const RANGE = { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } };

function rangeAt(line: number): typeof RANGE {
  return { start: { line, column: 1 }, end: { line, column: 5 } };
}

function annotation(name: string, overrides: Partial<JavaAnnotationFact> = {}): JavaAnnotationFact {
  return { name, range: RANGE, ...overrides };
}

function unresolvedRef(text: string): JavaTypeRef {
  return { text, simpleName: text, typeArguments: [], arrayDepth: 0, resolution: { state: "UNRESOLVED" } };
}

function externalRef(text: string, qualifiedName: string): JavaTypeRef {
  return {
    text,
    simpleName: text,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "EXTERNAL", qualifiedName, strategy: "EXPLICIT_IMPORT" }
  };
}

function repoRef(text: string, typeId: string): JavaTypeRef {
  return {
    text,
    simpleName: text,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId, strategy: "EXPLICIT_IMPORT" }
  };
}

function file(overrides: Partial<JavaFileFacts> = {}): JavaFileFacts {
  return {
    fileId: "file:src/main/java/demo/Widget.java",
    relativePath: "src/main/java/demo/Widget.java",
    sourceRoot: "src/main/java",
    module: "demo-module",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: ["type:demo.Widget"],
    allTypeIds: ["type:demo.Widget"],
    contentHash: "h",
    size: 1,
    mtimeMs: 0,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 1,
    ...overrides
  };
}

function edge(overrides: Partial<StaticEdge> & { fromId: string; toId: string; range: StaticEdge["range"] }): StaticEdge {
  return {
    edgeId: `edge:ANNOTATED_WITH:${overrides.fromId}:${overrides.toId}:1:1-1:5`,
    kind: "ANNOTATED_WITH",
    confidence: 0.98,
    sourceFile: "src/main/java/demo/Widget.java",
    generation: 1,
    resolution: { kind: "TYPE_REFERENCE", typeStrategy: "EXPLICIT_IMPORT" },
    ...overrides
  };
}

test("ownerTypeIdOf: types/type-local ids are their own owner, field/method ids are split on the first #", () => {
  assert.equal(ownerTypeIdOf("type:demo.Widget"), "type:demo.Widget");
  assert.equal(ownerTypeIdOf("type-local:src/main/java/demo/W.java:3:1"), "type-local:src/main/java/demo/W.java:3:1");
  assert.equal(ownerTypeIdOf("field:type:demo.Widget#name"), "type:demo.Widget");
  assert.equal(ownerTypeIdOf("method:type:demo.Widget#run()"), "type:demo.Widget");
  // A parameter id (method:...#sig#pN) is deliberately not resolved - parameters
  // are reached through their owning method's own declaration, not standalone.
  assert.equal(ownerTypeIdOf(javaParameterId("method:type:demo.Widget#run()", 0)), undefined);
  assert.equal(ownerTypeIdOf("external:java.lang.Deprecated"), undefined);
});

test("relativePathOfLocalTypeId / fqnOfTypeId are exact inverses of the two type-id shapes", () => {
  assert.equal(relativePathOfLocalTypeId("type-local:src/main/java/demo/W.java:3:1"), "src/main/java/demo/W.java");
  assert.equal(relativePathOfLocalTypeId("type:demo.Widget"), undefined);
  assert.equal(fqnOfTypeId("type:demo.Widget"), "demo.Widget");
  assert.equal(fqnOfTypeId("type-local:src/main/java/demo/W.java:3:1"), undefined);
});

test("bundleToFrameworkFileFacts resolves a type annotation's edge target but leaves an unresolvable one bare", () => {
  const type: JavaTypeFacts = {
    typeId: "type:demo.Widget",
    fqn: "demo.Widget",
    simpleName: "Widget",
    kind: "class",
    fileId: "file:src/main/java/demo/Widget.java",
    range: RANGE,
    modifiers: [],
    annotations: [annotation("Service", { range: rangeAt(1) }), annotation("Qualifier", { range: rangeAt(2), argumentsText: '("x")' })],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  const edges: StaticEdge[] = [
    // Only "Service" resolved (the fixture models Qualifier as ambiguous/unimported - no edge for it).
    edge({ fromId: type.typeId, toId: "external:org.springframework.stereotype.Service", range: rangeAt(1) })
  ];
  const bundle: JavaFileBundle = { file: file(), types: [type], fields: [], methods: [], edges };

  const facts = bundleToFrameworkFileFacts(bundle);

  assert.equal(facts.coverage, "COMPLETE");
  assert.equal(facts.relativePath, "src/main/java/demo/Widget.java");
  const projected = facts.types[0]!;
  assert.equal(projected.annotations[0]!.name, "Service");
  assert.equal(projected.annotations[0]!.resolvedFqn, "org.springframework.stereotype.Service");
  assert.equal(projected.annotations[1]!.name, "Qualifier");
  assert.equal(projected.annotations[1]!.resolvedFqn, undefined, "an annotation with no ANNOTATED_WITH edge must not get a guessed resolvedFqn");
  assert.equal(projected.annotations[1]!.argumentsText, '("x")');
});

test("bundleToFrameworkFileFacts joins parameter annotations by the parameter's synthetic id, not by position among all annotations", () => {
  const methodId = "method:type:demo.Widget#handle(demo.Order)";
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: "type:demo.Widget",
    name: "handle",
    constructor: false,
    signatureKey: "handle(demo.Order)",
    range: RANGE,
    modifiers: [],
    annotations: [],
    typeParameters: [],
    parameters: [
      { name: "order", type: repoRef("Order", "type:demo.Order"), varargs: false, annotations: [annotation("Autowired")], range: RANGE }
    ],
    throws: [],
    callSites: [
      {
        kind: "CONSTRUCTOR_INVOCATION",
        name: "OrderCreated",
        arity: 1,
        argumentTypeHints: [externalRef("Instant", "java.time.Instant"), unresolvedRef("")],
        range: RANGE
      }
    ],
    localTypes: []
  };
  const edges: StaticEdge[] = [
    edge({
      fromId: javaParameterId(methodId, 0),
      toId: "external:org.springframework.beans.factory.annotation.Autowired",
      range: RANGE
    })
  ];
  const bundle: JavaFileBundle = { file: file(), types: [], fields: [], methods: [method], edges };

  const facts = bundleToFrameworkFileFacts(bundle);
  const projectedMethod = facts.methods[0]!;

  assert.equal(projectedMethod.parameters[0]!.annotations[0]!.resolvedFqn, "org.springframework.beans.factory.annotation.Autowired");
  assert.deepEqual(projectedMethod.range, RANGE);
  assert.equal(projectedMethod.parameters[0]!.type.resolvedFqn, "demo.Order");
  assert.equal(projectedMethod.callSites[0]!.argumentTypeHints[0]!.resolvedFqn, "java.time.Instant");
  assert.equal(projectedMethod.callSites[0]!.argumentTypeHints[1]!.resolvedFqn, undefined);
});

test("bundleToFrameworkFileFacts maps parseState to coverage: COMPLETE/RECOVERED/FAILED -> COMPLETE/PARTIAL/DEGRADED", () => {
  const recovered = bundleToFrameworkFileFacts({ file: file({ parseState: "RECOVERED" }), types: [], fields: [], methods: [], edges: [] });
  const failed = bundleToFrameworkFileFacts({ file: file({ parseState: "FAILED" }), types: [], fields: [], methods: [], edges: [] });
  assert.equal(recovered.coverage, "PARTIAL");
  assert.equal(failed.coverage, "DEGRADED");
});

test("bundlesToRequestedDeclarations returns only the requested ids across multiple bundles, and reports the rest as missing", () => {
  const fieldA: JavaFieldFacts = {
    fieldId: "field:type:demo.A#name",
    ownerTypeId: "type:demo.A",
    name: "name",
    type: unresolvedRef("String"),
    modifiers: [],
    annotations: [],
    range: RANGE
  };
  const fieldB: JavaFieldFacts = {
    fieldId: "field:type:demo.B#other",
    ownerTypeId: "type:demo.B",
    name: "other",
    type: unresolvedRef("String"),
    modifiers: [],
    annotations: [],
    range: RANGE
  };
  const bundleA: JavaFileBundle = { file: file({ relativePath: "A.java" }), types: [], fields: [fieldA], methods: [], edges: [] };
  const bundleB: JavaFileBundle = { file: file({ relativePath: "B.java" }), types: [], fields: [fieldB], methods: [], edges: [] };

  const result = bundlesToRequestedDeclarations([bundleA, bundleB], [fieldA.fieldId, "field:type:demo.C#missing"]);

  assert.deepEqual(result.fields.map(f => f.fieldId), [fieldA.fieldId]);
  assert.deepEqual(result.missingIds, ["field:type:demo.C#missing"]);
});
