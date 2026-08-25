import assert from "node:assert/strict";
import test from "node:test";
import type {
  JavaAnnotationFact,
  JavaCallSiteFact,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaImportFact,
  JavaIndexStatus,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeParameterFact,
  JavaTypeRef,
  StaticEdge
} from "./index-types.js";
import {
  isJavaIndexResponse,
  validateAnchorFacts,
  validateFileBundleArray,
  validateIndexedReadRangeResults,
  validateIndexedReferenceArray,
  validateJavaIndexStatus,
  validateTypeFactsArray,
  validateTypeLookup,
  validateTypeLookupArray,
  validateEntitySearchHits,
  validateGraphDigest,
  validateGraphReachable
} from "./worker-protocol.js";

function validStatus(): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: 3,
    files: 1,
    types: 1,
    methods: 1,
    edges: 2,
    snapshotBytes: 4096,
    snapshot: { state: "DURABLE", durableGeneration: 3, durableManifestFingerprint: "manifest" },
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [{
      root: "src/main/java",
      generation: 3,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "1"
    }],
    resourceCoverage: []
  };
}

function fullBundle(): JavaFileBundle {
  const stringRef: JavaTypeRef = {
    text: "String",
    simpleName: "String",
    qualifiedName: "java.lang.String",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "EXTERNAL", qualifiedName: "java.lang.String", strategy: "JAVA_LANG" },
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 7 } }
  };
  const widgetRef: JavaTypeRef = {
    text: "Widget",
    simpleName: "Widget",
    qualifiedName: "demo.Widget",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId: "type:demo.Widget", strategy: "SAME_PACKAGE" }
  };
  const listRef: JavaTypeRef = {
    text: "List<Widget>",
    simpleName: "List",
    qualifiedName: "java.util.List",
    typeArguments: [widgetRef],
    arrayDepth: 0,
    resolution: { state: "EXTERNAL", qualifiedName: "java.util.List", strategy: "EXPLICIT_IMPORT" },
    range: { start: { line: 2, column: 3 }, end: { line: 2, column: 20 } }
  };
  const ambiguousRef: JavaTypeRef = {
    text: "Widget",
    simpleName: "Widget",
    typeArguments: [],
    arrayDepth: 1,
    wildcard: "extends",
    resolution: { state: "AMBIGUOUS", candidates: ["type:demo.Widget", "type:other.Widget"] }
  };
  const unresolvedRef: JavaTypeRef = {
    text: "Mystery",
    simpleName: "Mystery",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "UNRESOLVED" }
  };
  const typeVarRef: JavaTypeRef = {
    text: "T",
    simpleName: "T",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "TYPE_VARIABLE", name: "T" }
  };

  const annotation: JavaAnnotationFact = {
    name: "Override",
    qualifiedName: "java.lang.Override",
    range: { start: { line: 3, column: 3 }, end: { line: 3, column: 12 } }
  };

  const typeParam: JavaTypeParameterFact = {
    name: "T",
    bounds: [stringRef],
    range: { start: { line: 4, column: 10 }, end: { line: 4, column: 20 } }
  };

  const invocationCallSite: JavaCallSiteFact = {
    kind: "METHOD_INVOCATION",
    name: "save",
    receiverText: "repo",
    receiverDeclaredType: widgetRef,
    arity: 1,
    argumentTypeHints: [stringRef],
    range: { start: { line: 5, column: 5 }, end: { line: 5, column: 15 } }
  };
  const constructorCallSite: JavaCallSiteFact = {
    kind: "CONSTRUCTOR_INVOCATION",
    name: "Widget",
    arity: 0,
    argumentTypeHints: [],
    range: { start: { line: 6, column: 5 }, end: { line: 6, column: 18 } }
  };
  const methodRefCallSite: JavaCallSiteFact = {
    kind: "METHOD_REFERENCE",
    name: "toString",
    receiverText: "Widget",
    arity: 0,
    argumentTypeHints: [],
    range: { start: { line: 7, column: 5 }, end: { line: 7, column: 20 } }
  };

  const field: JavaFieldFacts = {
    fieldId: "field:type:demo.Widget#name",
    ownerTypeId: "type:demo.Widget",
    name: "name",
    type: stringRef,
    modifiers: ["private", "final"],
    annotations: [annotation],
    range: { start: { line: 8, column: 3 }, end: { line: 8, column: 25 } }
  };

  const method: JavaMethodFacts = {
    methodId: "method:type:demo.Widget#save(java.lang.String)",
    ownerTypeId: "type:demo.Widget",
    name: "save",
    constructor: false,
    signatureKey: "save(java.lang.String)",
    range: { start: { line: 10, column: 3 }, end: { line: 15, column: 4 } },
    bodyRange: { start: { line: 10, column: 30 }, end: { line: 15, column: 3 } },
    modifiers: ["public"],
    annotations: [annotation],
    typeParameters: [typeParam],
    returnType: listRef,
    parameters: [
      {
        name: "id",
        type: stringRef,
        varargs: false,
        annotations: [annotation],
        range: { start: { line: 10, column: 15 }, end: { line: 10, column: 25 } }
      },
      {
        name: "rest",
        type: typeVarRef,
        varargs: true,
        annotations: [],
        range: { start: { line: 10, column: 26 }, end: { line: 10, column: 35 } }
      }
    ],
    throws: [unresolvedRef],
    callSites: [invocationCallSite, constructorCallSite, methodRefCallSite],
    localTypes: [ambiguousRef]
  };

  const type: JavaTypeFacts = {
    typeId: "type:demo.Widget",
    fqn: "demo.Widget",
    simpleName: "Widget",
    kind: "class",
    fileId: "file:src/main/java/demo/Widget.java",
    range: { start: { line: 1, column: 1 }, end: { line: 20, column: 1 } },
    modifiers: ["public"],
    annotations: [annotation],
    typeParameters: [typeParam],
    extends: [stringRef],
    implements: [listRef],
    permits: [],
    fieldIds: [field.fieldId],
    methodIds: [method.methodId],
    confidence: 0.95
  };

  const importFact: JavaImportFact = {
    qualifiedName: "java.util.List",
    wildcard: false,
    static: false,
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 20 } }
  };

  const file: JavaFileFacts = {
    fileId: "file:src/main/java/demo/Widget.java",
    relativePath: "src/main/java/demo/Widget.java",
    sourceRoot: "src/main/java",
    module: "demo-module",
    sourceSet: "main",
    packageName: "demo",
    imports: [importFact],
    topLevelTypeIds: [type.typeId],
    allTypeIds: [type.typeId],
    contentHash: "abc123",
    size: 512,
    mtimeMs: 1700000000000,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 3
  };

  const edgeWithStrategy: StaticEdge = {
    edgeId: "edge:FIELD_TYPE:field:type:demo.Widget#name:java.lang.String:none",
    fromId: field.fieldId,
    toId: "java.lang.String",
    kind: "FIELD_TYPE",
    confidence: 1,
    range: field.range,
    sourceFile: file.relativePath,
    generation: 3,
    resolution: { kind: "TYPE_REFERENCE", typeStrategy: "JAVA_LANG" }
  };
  const edgeWithoutStrategy: StaticEdge = {
    edgeId: "edge:CALLS:method:type:demo.Widget#save(java.lang.String):method:type:demo.Repo#save(java.lang.String):none",
    fromId: method.methodId,
    toId: "method:type:demo.Repo#save(java.lang.String)",
    kind: "CALLS",
    confidence: 0.8,
    sourceFile: file.relativePath,
    generation: 3,
    resolution: { kind: "SAME_OWNER_NAME_ARITY" }
  };

  return {
    file,
    types: [type],
    fields: [field],
    methods: [method],
    edges: [edgeWithStrategy, edgeWithoutStrategy]
  };
}

test("validateFileBundleArray round-trips a fully populated bundle", () => {
  const bundle = fullBundle();
  const result = validateFileBundleArray([bundle]);
  assert.deepEqual(result, [bundle]);
});

test("validateGraphDigest requires digest and counts", () => {
  const digest = { digest: "abc", generation: 1, nodes: 2, edges: 3 };
  assert.deepEqual(validateGraphDigest(digest), digest);
  assert.throws(() => validateGraphDigest({ ...digest, digest: 1 }));
});

test("validateGraphReachable requires files and hops", () => {
  const reachable = { files: ["src/A.java"], hops: { "src/A.java": 0 } };
  assert.deepEqual(validateGraphReachable(reachable), reachable);
  assert.throws(() => validateGraphReachable({ files: ["src/A.java"], hops: { "src/A.java": "0" } }));
});

test("validateEntitySearchHits accepts a LocAgent hit and rejects an unknown layer", () => {
  const hit = {
    entityId: "type:demo.StorageGateway",
    kind: "type",
    fqn: "demo.StorageGateway",
    simpleName: "StorageGateway",
    relativePath: "src/main/java/demo/StorageGateway.java",
    layer: "BM25_IDENTIFIER",
    score: 1.2
  };
  assert.deepEqual(validateEntitySearchHits([hit]), [hit]);
  assert.throws(() => validateEntitySearchHits([{ ...hit, layer: "MAGIC" }]));
});

test("validateJavaIndexStatus accepts a well-formed status and rejects an unknown state", () => {
  const status = validStatus();
  assert.deepEqual(validateJavaIndexStatus(status), status);
  assert.throws(() => validateJavaIndexStatus({ ...status, state: "BOGUS" }));
  assert.throws(() => validateJavaIndexStatus({ ...status, snapshot: { state: "DURABLE", durableGeneration: "3" } }));
  assert.throws(() => validateJavaIndexStatus({ ...status, snapshot: { state: "DURABLE" } }));
  assert.throws(() => validateJavaIndexStatus({ ...status, snapshot: { state: "FAILED" } }));
  assert.throws(() => validateJavaIndexStatus({ ...status, snapshot: { state: "EMPTY", failure: "WRITE_FAILED" } }));
  assert.throws(() => validateJavaIndexStatus({
    ...status,
    snapshot: { state: "PENDING", durableGeneration: 3 }
  }));
  assert.deepEqual(
    validateJavaIndexStatus({ ...status, factsHydrated: false }),
    { ...status, factsHydrated: false }
  );
  assert.throws(() => validateJavaIndexStatus({ ...status, factsHydrated: "yes" }));
});

test("validateAnchorFacts passes through undefined and rejects a payload missing required fields", () => {
  assert.equal(validateAnchorFacts(undefined), undefined);
  assert.equal(validateAnchorFacts(null), undefined);
  assert.throws(() => validateAnchorFacts({ symbolKind: "TYPE" }));
});

test("validateTypeLookup accepts each state and rejects an unknown one", () => {
  const bundle = fullBundle();
  assert.deepEqual(
    validateTypeLookup({ state: "RESOLVED", type: bundle.types[0] }),
    { state: "RESOLVED", type: bundle.types[0] }
  );
  assert.deepEqual(
    validateTypeLookup({ state: "UNRESOLVED", coverage: "PARTIAL" }),
    { state: "UNRESOLVED", coverage: "PARTIAL" }
  );
  assert.throws(() => validateTypeLookup({ state: "BOGUS" }));
});

test("validateTypeLookupArray preserves a batched lookup response", () => {
  const bundle = fullBundle();
  const values = [
    { state: "RESOLVED", type: bundle.types[0] },
    { state: "UNRESOLVED", coverage: "COMPLETE" }
  ];
  assert.deepEqual(validateTypeLookupArray(values), values);
});

test("validateTypeFactsArray rejects a type missing required fields", () => {
  assert.throws(() => validateTypeFactsArray([{ typeId: "type:demo.Widget" }]));
});

test("validateIndexedReferenceArray rejects a reference missing required fields", () => {
  assert.throws(() => validateIndexedReferenceArray([{ sourceId: "a" }]));
});

test("validateIndexedReadRangeResults requires canonical exact coordinates", () => {
  const valid = [{
    file: "/repo/A.java",
    ranges: [{
      startLine: 1,
      endLine: 3,
      range: { start: { line: 1, column: 1 }, end: { line: 4, column: 1 } },
      kind: "method",
      estimatedBytes: 64
    }]
  }];
  assert.deepEqual(validateIndexedReadRangeResults(valid), valid);
  assert.throws(() => validateIndexedReadRangeResults([{ ...valid[0], ranges: [{ ...valid[0]!.ranges[0], range: undefined }] }]));
  assert.throws(() => validateIndexedReadRangeResults([{ ...valid[0], ranges: [{
    ...valid[0]!.ranges[0],
    range: { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } }
  }] }]));
  assert.throws(() => validateIndexedReadRangeResults([{ ...valid[0], ranges: [{
    ...valid[0]!.ranges[0],
    range: { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } }
  }] }]));
});

test("validateFileBundleArray rejects a bundle with an incomplete file", () => {
  assert.throws(() => validateFileBundleArray([{ file: {}, types: [], fields: [], methods: [], edges: [] }]));
});

test("isJavaIndexResponse accepts well-formed envelopes and rejects malformed ones", () => {
  assert.equal(isJavaIndexResponse({ id: 1, ok: true, value: null }), true);
  assert.equal(isJavaIndexResponse({ id: 1, ok: true, value: null, timing: { queueDepthAtEnqueue: 1, queueMs: 1.5, processingMs: 2 } }), true);
  assert.equal(isJavaIndexResponse({ id: 1, ok: false, error: { code: "X", message: "boom" } }), true);
  assert.equal(isJavaIndexResponse({ id: 1, ok: true, value: null, timing: { queueDepthAtEnqueue: 1, queueMs: -1, processingMs: 2 } }), false);
  assert.equal(isJavaIndexResponse({ id: 1, ok: true, value: null, timing: { queueDepthAtEnqueue: -1, queueMs: 1, processingMs: 2 } }), false);
  assert.equal(isJavaIndexResponse({ id: 1, ok: true, value: null, timing: { queueDepthAtEnqueue: 1, queueMs: 1 } }), false);
  assert.equal(isJavaIndexResponse({ id: 1, ok: true }), false);
  assert.equal(isJavaIndexResponse({ id: 1, ok: false, error: {} }), false);
  assert.equal(isJavaIndexResponse({ ok: true, value: 1 }), false);
  assert.equal(isJavaIndexResponse("not an object"), false);
});
