import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexStore } from "./index-store.js";
import type {
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  SourceRange,
  StaticEdge,
  StaticEdgeResolutionKind
} from "./index-types.js";
import { javaEdgeId, javaFieldId, javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

const RANGE: SourceRange = {
  start: { line: 1, column: 1 },
  end: { line: 4, column: 2 }
};

function fileFacts(relativePath: string, generation = 1): JavaFileFacts {
  return {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src/main/java",
    module: ".",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: [],
    allTypeIds: [],
    contentHash: `hash:${relativePath}:${generation}`,
    size: 100,
    mtimeMs: generation,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation
  };
}

function emptyBundle(relativePath: string, simpleName: string, generation = 1): JavaFileBundle {
  const file = fileFacts(relativePath, generation);
  const typeId = javaTypeId({
    fqn: `demo.${simpleName}`,
    relativePath,
    range: RANGE
  });
  const type: JavaTypeFacts = {
    typeId,
    fqn: `demo.${simpleName}`,
    simpleName,
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  return { file, types: [type], fields: [], methods: [], edges: [] };
}

function addMethod(bundle: JavaFileBundle, name: string): JavaMethodFacts {
  const owner = bundle.types[0]!;
  const methodId = javaMethodId(owner.typeId, `${name}()`);
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: owner.typeId,
    name,
    constructor: false,
    signatureKey: `${name}()`,
    range: RANGE,
    bodyRange: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
  owner.methodIds.push(methodId);
  bundle.methods.push(method);
  return method;
}

function addField(bundle: JavaFileBundle, name: string): JavaFieldFactsLike {
  const owner = bundle.types[0]!;
  const fieldId = javaFieldId(owner.typeId, name);
  const field = {
    fieldId,
    ownerTypeId: owner.typeId,
    name,
    type: { text: "Object", simpleName: "Object", typeArguments: [], arrayDepth: 0, resolution: { state: "UNRESOLVED" as const } },
    modifiers: ["private"],
    annotations: [],
    range: RANGE
  };
  owner.fieldIds.push(fieldId);
  bundle.fields.push(field);
  return field;
}
type JavaFieldFactsLike = JavaFileBundle["fields"][number];

// Import javaEdgeId from ./stable-id.js; never reconstruct edge IDs locally.
function addEdge(
  bundle: JavaFileBundle,
  edge: Omit<StaticEdge, "edgeId" | "sourceFile" | "generation" | "resolution"> & {
    resolutionKind?: StaticEdgeResolutionKind;
  }
): void {
  const { resolutionKind = "AST_EXPLICIT", ...base } = edge;
  bundle.edges.push({
    ...base,
    edgeId: javaEdgeId({
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      range: edge.range
    }),
    sourceFile: bundle.file.relativePath,
    generation: bundle.file.generation,
    resolution: { kind: resolutionKind }
  });
}

test("replacing a file removes all old facts and reverse edges", () => {
  const store = new JavaIndexStore();
  const target = emptyBundle("src/main/java/demo/Target.java", "Target");
  const targetMethod = addMethod(target, "run");

  const oldPath = "src/main/java/demo/Service.java";
  const oldBundle = emptyBundle(oldPath, "OldService");
  const caller = addMethod(oldBundle, "call");
  addEdge(oldBundle, {
    fromId: caller.methodId,
    toId: targetMethod.methodId,
    kind: "CALLS",
    confidence: 1,
    range: RANGE
  });

  store.replaceFile(target);
  store.replaceFile(oldBundle);
  assert.ok(store.typeByFqn("demo.OldService"));
  assert.equal(store.callers(targetMethod.methodId).length, 1);

  const newBundleForSamePath = emptyBundle(oldPath, "NewService", 2);
  store.replaceFile(newBundleForSamePath);
  assert.equal(store.typeByFqn("demo.OldService"), undefined);
  assert.equal(
    store.callers(targetMethod.methodId).some(item => item.sourceFile === oldPath),
    false
  );
});

test("deleting a file removes its facts and marks dependents", () => {
  const store = new JavaIndexStore();
  const repositoryPath = "src/main/java/demo/OrderRepository.java";
  const servicePath = "src/main/java/demo/OrderService.java";
  const repository = emptyBundle(repositoryPath, "OrderRepository");
  const service = emptyBundle(servicePath, "OrderService");
  addEdge(service, {
    fromId: service.types[0]!.typeId,
    toId: repository.types[0]!.typeId,
    kind: "FIELD_TYPE",
    confidence: 1,
    range: RANGE
  });

  store.replaceFile(repository);
  store.replaceFile(service);
  const dependents = store.removeFiles([repositoryPath]);
  assert.ok(dependents.includes(servicePath));
  assert.equal(store.file(repositoryPath), undefined);
});

test("store rejects absolute-path-derived IDs", () => {
  const store = new JavaIndexStore();
  const bundle = emptyBundle("src/main/java/demo/A.java", "A");
  bundle.file.fileId = "file:/Users/me/repo/src/main/java/demo/A.java";
  assert.throws(() => store.replaceFile(bundle), /stable repo-relative id/);
});

test("same relative facts from sibling worktrees have identical IDs", () => {
  const left = emptyBundle("src/main/java/demo/A.java", "A");
  const right = emptyBundle("src/main/java/demo/A.java", "A");
  assert.deepEqual(left.file.fileId, right.file.fileId);
  assert.deepEqual(left.types[0]?.typeId, right.types[0]?.typeId);
});

test("replacing a file at the same path with the same FQN drops old members but keeps the type resolvable", () => {
  // The common "edit a file without renaming its public class" case: old
  // and new bundles both declare fqn "demo.Service", so javaTypeId gives
  // them the *identical* typeId string. replaceFile must still fully clear
  // the old bundle's own members (an old field that got deleted in the
  // edit) before inserting the new ones, not just skip cleanup because the
  // fqn/typeId look unchanged.
  const store = new JavaIndexStore();
  const path = "src/main/java/demo/Service.java";

  const v1 = emptyBundle(path, "Service");
  const oldField = addField(v1, "oldOnly");
  store.replaceFile(v1);
  assert.ok(store.typeByFqn("demo.Service"));
  assert.equal(store.fieldsById.has(oldField.fieldId), true);

  const v2 = emptyBundle(path, "Service", 2);
  const newMethod = addMethod(v2, "run");
  store.replaceFile(v2);

  const type = store.typeByFqn("demo.Service");
  assert.ok(type, "demo.Service must still resolve after the same-FQN edit");
  assert.equal(store.fieldsById.has(oldField.fieldId), false, "the old field must be gone");
  assert.equal(store.methodsById.has(newMethod.methodId), true, "the new method must be present");
  assert.deepEqual(type!.methodIds, [newMethod.methodId]);
});

test("anchor prefers the most specific containing symbol: method over its owning type", () => {
  const store = new JavaIndexStore();
  const bundle = emptyBundle("src/main/java/demo/Widget.java", "Widget");
  const method = addMethod(bundle, "run");
  bundle.methods[0]!.range = { start: { line: 2, column: 1 }, end: { line: 2, column: 20 } };
  store.replaceFile(bundle);

  const onMethod = store.anchor(bundle.file.relativePath, 2, 5);
  assert.equal(onMethod?.symbolKind, "METHOD");
  assert.equal(onMethod?.symbolId, method.methodId);
  assert.equal(onMethod?.type?.simpleName, "Widget", "member anchors retain their enclosing type facts");

  const onTypeOnly = store.anchor(bundle.file.relativePath, 1, 1);
  assert.equal(onTypeOnly?.symbolKind, "TYPE");

  const outsideAnySymbol = store.anchor(bundle.file.relativePath, 99, 1);
  assert.equal(outsideAnySymbol?.symbolKind, "FILE");
  assert.equal(outsideAnySymbol?.coverage, "DEGRADED");
});

test("typeByFqn, implementers, typeReferencers, callers, callees and files answer via map lookups", () => {
  const store = new JavaIndexStore();
  const gatewayPath = "src/main/java/demo/Gateway.java";
  const implPath = "src/main/java/demo/Impl.java";
  const gateway = emptyBundle(gatewayPath, "Gateway");
  const gatewayMethod = addMethod(gateway, "pay");
  const impl = emptyBundle(implPath, "Impl");
  const implMethod = addMethod(impl, "pay");
  addEdge(impl, {
    fromId: impl.types[0]!.typeId,
    toId: gateway.types[0]!.typeId,
    kind: "IMPLEMENTS",
    confidence: 0.98,
    range: RANGE
  });
  addEdge(impl, {
    fromId: implMethod.methodId,
    toId: gatewayMethod.methodId,
    kind: "CALLS",
    confidence: 0.9,
    range: RANGE
  });
  // A second inbound edge of a *different* kind on the same target type -
  // typeReferencers' kinds filter must exclude it, not just happen to be
  // the only edge present.
  addEdge(impl, {
    fromId: impl.types[0]!.typeId,
    toId: gateway.types[0]!.typeId,
    kind: "ANNOTATED_WITH",
    confidence: 0.9,
    range: RANGE
  });

  store.replaceFile(gateway);
  store.replaceFile(impl);

  assert.equal(store.typeByFqn("demo.Gateway")?.typeId, gateway.types[0]!.typeId);

  const implementers = store.implementers(gateway.types[0]!.typeId);
  assert.deepEqual(implementers.map(t => t.typeId), [impl.types[0]!.typeId]);

  const referencers = store.typeReferencers(gateway.types[0]!.typeId, new Set(["IMPLEMENTS"]));
  assert.equal(referencers.length, 1, "the ANNOTATED_WITH edge into the same type must be excluded by the kinds filter");
  assert.equal(referencers[0]!.kind, "IMPLEMENTS");
  assert.equal(referencers[0]!.sourceFile, implPath);
  assert.equal(referencers[0]!.sourceModule, ".");
  assert.equal(referencers[0]!.sourceSet, "main");

  assert.deepEqual(store.callers(gatewayMethod.methodId).map(r => r.sourceId), [implMethod.methodId]);
  assert.deepEqual(store.callees(implMethod.methodId).map(r => r.targetId), [gatewayMethod.methodId]);

  const bundles = store.files([implPath, gatewayPath]);
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]!.file.relativePath, implPath);
  assert.equal(bundles[0]!.edges.length, 3);
});

test("methodsWithParameterTypes unions bounded PARAM_TYPE reverse indexes without a per-type caller scan", () => {
  const store = new JavaIndexStore();
  const firstEvent = emptyBundle("src/main/java/demo/FirstEvent.java", "FirstEvent");
  const secondEvent = emptyBundle("src/main/java/demo/SecondEvent.java", "SecondEvent");
  const firstListener = emptyBundle("src/main/java/demo/FirstListener.java", "FirstListener");
  const secondListener = emptyBundle("src/main/java/demo/SecondListener.java", "SecondListener");
  const firstMethod = addMethod(firstListener, "onFirst");
  const secondMethod = addMethod(secondListener, "onSecond");
  firstMethod.parameters.push({
    name: "event",
    type: { text: "FirstEvent", simpleName: "FirstEvent", typeArguments: [], arrayDepth: 0, resolution: { state: "RESOLVED_REPO", typeId: firstEvent.types[0]!.typeId, strategy: "SAME_PACKAGE" } },
    varargs: false,
    annotations: [],
    range: RANGE
  });
  secondMethod.parameters.push({
    name: "event",
    type: { text: "SecondEvent", simpleName: "SecondEvent", typeArguments: [], arrayDepth: 0, resolution: { state: "RESOLVED_REPO", typeId: secondEvent.types[0]!.typeId, strategy: "SAME_PACKAGE" } },
    varargs: false,
    annotations: [],
    range: RANGE
  });
  addEdge(firstListener, { fromId: firstMethod.methodId, toId: firstEvent.types[0]!.typeId, kind: "PARAM_TYPE", confidence: 1, range: RANGE });
  addEdge(secondListener, { fromId: secondMethod.methodId, toId: secondEvent.types[0]!.typeId, kind: "PARAM_TYPE", confidence: 1, range: RANGE });
  for (const bundle of [firstEvent, secondEvent, firstListener, secondListener]) store.replaceFile(bundle);

  assert.deepEqual(
    store.methodsWithParameterTypes([firstEvent.types[0]!.typeId, secondEvent.types[0]!.typeId], 8),
    [firstMethod.methodId, secondMethod.methodId]
  );
  assert.deepEqual(
    store.methodsWithParameterTypes([firstEvent.types[0]!.typeId, secondEvent.types[0]!.typeId], 1),
    [firstMethod.methodId],
    "the shared batch bound applies after deduplication and deterministic ordering"
  );
});

// emptyBundle hardcodes package "demo" (matching the plan's Step 1 fixtures,
// all in one package); this test needs distinct packages "a"/"b"/"use" to
// exercise explicit-import vs same-package-name vs collision, so it builds
// its own bundles rather than reusing emptyBundle.
function bundleInPackage(relativePath: string, packageName: string, simpleName: string): JavaFileBundle {
  const file = fileFacts(relativePath);
  file.packageName = packageName;
  const fqn = `${packageName}.${simpleName}`;
  const typeId = javaTypeId({ fqn, relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn,
    simpleName,
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  return { file, types: [type], fields: [], methods: [], edges: [] };
}

test("typeLookup resolves explicit imports and same-package names, and reports AMBIGUOUS/UNRESOLVED honestly", () => {
  const store = new JavaIndexStore();
  const aUser = bundleInPackage("src/main/java/a/User.java", "a", "User");
  const bUser = bundleInPackage("src/main/java/b/User.java", "b", "User");
  store.replaceFile(aUser);
  store.replaceFile(bUser);

  const explicitFile = fileFacts("src/main/java/use/Service.java");
  explicitFile.packageName = "use";
  explicitFile.imports = [
    { qualifiedName: "a.User", wildcard: false, static: false, range: RANGE }
  ];
  store.replaceFile({ file: explicitFile, types: [], fields: [], methods: [], edges: [] });

  const explicit = store.typeLookup("User", explicitFile.relativePath);
  assert.equal(explicit.state, "RESOLVED");
  assert.equal((explicit as { type: JavaTypeFacts }).type.typeId, aUser.types[0]!.typeId);

  const noScope = store.typeLookup("User");
  assert.equal(noScope.state, "AMBIGUOUS");

  const missing = store.typeLookup("TotallyUnknownType");
  assert.deepEqual(missing, { state: "UNRESOLVED", coverage: "DEGRADED" });
});

test("performance: 10,000 types and 50,000 edges, 1,000 repeated lookups stay well within budget", () => {
  const store = new JavaIndexStore();
  const typeCount = 10_000;
  const typeIds: string[] = [];
  for (let i = 0; i < typeCount; i += 1) {
    const bundle = emptyBundle(`src/main/java/perf/Type${i}.java`, `Type${i}`);
    typeIds.push(bundle.types[0]!.typeId);
    store.replaceFile(bundle);
  }

  // Attach edges after every type exists, as a separate synthetic file per
  // batch of 5 edges (fromId/toId just need to be valid existing type ids;
  // this store doesn't require the edge's own file to declare either end).
  let edgeCount = 0;
  let fileIndex = 0;
  while (edgeCount < 50_000) {
    const bundle = emptyBundle(`src/main/java/perf/Edges${fileIndex}.java`, `Edges${fileIndex}`, 1);
    for (let i = 0; i < 5 && edgeCount < 50_000; i += 1, edgeCount += 1) {
      const from = typeIds[edgeCount % typeCount]!;
      const to = typeIds[(edgeCount * 7 + 1) % typeCount]!;
      addEdge(bundle, { fromId: from, toId: to, kind: "IMPLEMENTS", confidence: 0.9, range: RANGE });
    }
    store.replaceFile(bundle);
    fileIndex += 1;
  }

  const queryTarget = typeIds[0]!;
  const start = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    store.implementers(queryTarget, 1000);
  }
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 500, `indexed lookup took ${elapsedMs}ms`);
});

test("toSnapshotData returns arrays sorted by id/path regardless of insertion order", () => {
  const storeA = new JavaIndexStore();
  const bundleGateway = emptyBundle("src/main/java/demo/Gateway.java", "Gateway");
  addMethod(bundleGateway, "pay");
  const bundleImpl = emptyBundle("src/main/java/demo/Impl.java", "Impl");
  addEdge(bundleImpl, { fromId: bundleImpl.types[0]!.typeId, toId: bundleGateway.types[0]!.typeId, kind: "IMPLEMENTS", confidence: 0.98, range: RANGE });
  storeA.replaceFile(bundleGateway);
  storeA.replaceFile(bundleImpl);

  const storeB = new JavaIndexStore();
  // Same two files, loaded in the opposite order.
  storeB.replaceFile(bundleImpl);
  storeB.replaceFile(bundleGateway);

  assert.deepEqual(storeA.toSnapshotData(), storeB.toSnapshotData());
});

test("toSnapshotData sorts myBatisResources by relativePath regardless of insertion order", () => {
  const b = myBatisResource({ relativePath: "src/main/resources/mapper/B.xml", namespace: "demo.B" });
  const a = myBatisResource({ relativePath: "src/main/resources/mapper/A.xml", namespace: "demo.A" });

  const storeA = new JavaIndexStore();
  storeA.replaceMyBatisResource(b);
  storeA.replaceMyBatisResource(a);

  const storeB = new JavaIndexStore();
  storeB.replaceMyBatisResource(a);
  storeB.replaceMyBatisResource(b);

  assert.deepEqual(storeA.toSnapshotData().myBatisResources, storeB.toSnapshotData().myBatisResources);
  assert.deepEqual(storeA.toSnapshotData().myBatisResources.map(r => r.relativePath), [
    "src/main/resources/mapper/A.xml",
    "src/main/resources/mapper/B.xml"
  ]);
});

test("loadSnapshotData rebuilds a store whose queries behave identically to the original", () => {
  const original = new JavaIndexStore();
  const gateway = emptyBundle("src/main/java/demo/Gateway.java", "Gateway");
  addMethod(gateway, "pay");
  addField(gateway, "name");
  const impl = emptyBundle("src/main/java/demo/Impl.java", "Impl");
  addEdge(impl, { fromId: impl.types[0]!.typeId, toId: gateway.types[0]!.typeId, kind: "IMPLEMENTS", confidence: 0.98, range: RANGE });
  original.replaceFile(gateway);
  original.replaceFile(impl);

  const rebuilt = new JavaIndexStore();
  rebuilt.loadSnapshotData(original.toSnapshotData());

  const gatewayTypeId = gateway.types[0]!.typeId;
  assert.deepEqual(rebuilt.typeByFqn("demo.Gateway"), original.typeByFqn("demo.Gateway"));
  assert.deepEqual(rebuilt.implementers(gatewayTypeId), original.implementers(gatewayTypeId));
  assert.deepEqual(rebuilt.files(["src/main/java/demo/Gateway.java"]), original.files(["src/main/java/demo/Gateway.java"]));
  assert.deepEqual(rebuilt.files(["src/main/java/demo/Impl.java"]), original.files(["src/main/java/demo/Impl.java"]));
});

test("loadSnapshotData replaces whatever the store previously held", () => {
  const store = new JavaIndexStore();
  store.replaceFile(emptyBundle("src/main/java/demo/Old.java", "Old"));

  const fresh = emptyBundle("src/main/java/demo/New.java", "New");
  store.loadSnapshotData({ files: [fresh.file], types: fresh.types, fields: [], methods: [], edges: [], myBatisResources: [] });

  assert.equal(store.file("src/main/java/demo/Old.java"), undefined);
  assert.ok(store.file("src/main/java/demo/New.java"));
  assert.equal(store.typeByFqn("demo.New")?.simpleName, "New");
});

test("loadSnapshotData rejects a snapshot with a duplicate type id", () => {
  const store = new JavaIndexStore();
  const bundle = emptyBundle("src/main/java/demo/Dup.java", "Dup");
  const data = {
    files: [bundle.file],
    types: [bundle.types[0]!, bundle.types[0]!],
    fields: [],
    methods: [],
    edges: [],
    myBatisResources: []
  };
  assert.throws(() => store.loadSnapshotData(data), /duplicate type id/);
});

test("loadSnapshotData round-trips MyBatis resources and clears whatever the store previously held", () => {
  const store = new JavaIndexStore();
  store.replaceMyBatisResource(myBatisResource({
    relativePath: "src/main/resources/mapper/Old.xml",
    namespace: "demo.OldMapper",
    statements: [{ statementId: "mybatis-statement:demo.OldMapper.x", namespace: "demo.OldMapper", id: "x", kind: "select" }]
  }));

  const fresh = myBatisResource({
    relativePath: "src/main/resources/mapper/OrderMapper.xml",
    namespace: "demo.OrderMapper",
    statements: [{ statementId: "mybatis-statement:demo.OrderMapper.findById", namespace: "demo.OrderMapper", id: "findById", kind: "select" }]
  });
  store.loadSnapshotData({ files: [], types: [], fields: [], methods: [], edges: [], myBatisResources: [fresh] });

  assert.equal(store.myBatisResource("src/main/resources/mapper/Old.xml"), undefined);
  assert.equal(store.myBatisResourcesByNamespace.get("demo.OldMapper"), undefined);
  assert.deepEqual(store.myBatisResource("src/main/resources/mapper/OrderMapper.xml"), fresh);
  assert.equal(store.myBatisStatement("demo.OrderMapper", "findById")?.statementId, "mybatis-statement:demo.OrderMapper.findById");
  assert.deepEqual([...(store.myBatisResourcesByNamespace.get("demo.OrderMapper") ?? [])], ["src/main/resources/mapper/OrderMapper.xml"]);
});

test("ingestSnapshotFacts can install one rest segment at a time", () => {
  const original = new JavaIndexStore();
  const gateway = emptyBundle("src/main/java/demo/Gateway.java", "Gateway");
  addMethod(gateway, "pay");
  addField(gateway, "name");
  original.replaceFile(gateway);
  const data = original.toSnapshotData();
  const store = new JavaIndexStore();
  store.loadSnapshotData({ files: data.files, types: [], fields: [], methods: [], edges: [], myBatisResources: [] });
  store.ingestSnapshotFacts({ types: data.types, fields: [], methods: [], edges: [] });
  store.ingestSnapshotFacts({ types: [], fields: data.fields, methods: [], edges: [] });
  store.ingestSnapshotFacts({ types: [], fields: [], methods: data.methods, edges: [] });
  store.ingestSnapshotFacts({ types: [], fields: [], methods: [], edges: data.edges });
  assert.equal(store.typeByFqn("demo.Gateway")?.simpleName, "Gateway");
  assert.equal(store.files(["src/main/java/demo/Gateway.java"])[0]?.methods.length, 1);
});

test("ingestSnapshotFacts stores two same-kind method chunks", () => {
  const original = new JavaIndexStore();
  const gateway = emptyBundle("src/main/java/demo/Gateway.java", "Gateway");
  addMethod(gateway, "pay");
  addMethod(gateway, "refund");
  original.replaceFile(gateway);
  const data = original.toSnapshotData();
  const store = new JavaIndexStore();
  store.loadSnapshotData({ files: data.files, types: [], fields: [], methods: [], edges: [], myBatisResources: [] });
  store.ingestSnapshotFacts({ types: data.types, fields: [], methods: [], edges: [] });
  assert.equal(data.methods.length, 2);
  store.ingestSnapshotFacts({ types: [], fields: [], methods: [data.methods[0]!], edges: [] });
  store.ingestSnapshotFacts({ types: [], fields: [], methods: [data.methods[1]!], edges: [] });
  const methods = store.files(["src/main/java/demo/Gateway.java"])[0]?.methods ?? [];
  assert.equal(methods.length, 2);
  assert.deepEqual(methods.map(method => method.name).sort(), ["pay", "refund"]);
});

test("ingestSnapshotFacts skips a duplicate method id in a later chunk", () => {
  const original = new JavaIndexStore();
  const gateway = emptyBundle("src/main/java/demo/Gateway.java", "Gateway");
  addMethod(gateway, "pay");
  original.replaceFile(gateway);
  const data = original.toSnapshotData();
  const store = new JavaIndexStore();
  store.loadSnapshotData({ files: data.files, types: [], fields: [], methods: [], edges: [], myBatisResources: [] });
  store.ingestSnapshotFacts({ types: data.types, fields: [], methods: data.methods, edges: [] });
  store.ingestSnapshotFacts({ types: [], fields: [], methods: data.methods, edges: [] });
  assert.equal(store.files(["src/main/java/demo/Gateway.java"])[0]?.methods.length, 1);
});

test("loadSnapshotData rejects a snapshot with a duplicate mybatis resource relativePath", () => {
  const store = new JavaIndexStore();
  const resource = myBatisResource({ relativePath: "src/main/resources/mapper/Dup.xml" });
  assert.throws(
    () => store.loadSnapshotData({ files: [], types: [], fields: [], methods: [], edges: [], myBatisResources: [resource, resource] }),
    /duplicate mybatis resource/
  );
});

function myBatisResource(overrides: Partial<import("./mybatis-types.js").MyBatisMapperResourceFacts> & { relativePath: string }) {
  return {
    resourceId: `mybatis-resource:${overrides.relativePath}`,
    namespace: "demo.OrderMapper",
    statements: [],
    resultMaps: [],
    includes: [],
    contentHash: "h1",
    generation: 1,
    parseState: "COMPLETE" as const,
    ...overrides
  };
}

test("replaceMyBatisResource indexes statements by namespace.id and the resource by namespace", () => {
  const store = new JavaIndexStore();
  const facts = myBatisResource({
    relativePath: "src/main/resources/mapper/OrderMapper.xml",
    statements: [{ statementId: "mybatis-statement:demo.OrderMapper.findById", namespace: "demo.OrderMapper", id: "findById", kind: "select" }]
  });

  store.replaceMyBatisResource(facts);

  assert.deepEqual(store.myBatisResource("src/main/resources/mapper/OrderMapper.xml"), facts);
  assert.equal(store.myBatisStatement("demo.OrderMapper", "findById")?.statementId, "mybatis-statement:demo.OrderMapper.findById");
  assert.deepEqual([...(store.myBatisResourcesByNamespace.get("demo.OrderMapper") ?? [])], ["src/main/resources/mapper/OrderMapper.xml"]);
});

test("replacing a MyBatis resource evicts its previous version's statements and namespace entry, keyed by the old facts", () => {
  const store = new JavaIndexStore();
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  store.replaceMyBatisResource(myBatisResource({
    relativePath,
    namespace: "demo.OrderMapper",
    statements: [{ statementId: "mybatis-statement:demo.OrderMapper.findById", namespace: "demo.OrderMapper", id: "findById", kind: "select" }]
  }));

  // Same file, namespace renamed and the old statement id dropped.
  store.replaceMyBatisResource(myBatisResource({
    relativePath,
    namespace: "demo.RenamedMapper",
    statements: [{ statementId: "mybatis-statement:demo.RenamedMapper.insert", namespace: "demo.RenamedMapper", id: "insert", kind: "insert" }]
  }));

  assert.equal(store.myBatisStatement("demo.OrderMapper", "findById"), undefined);
  assert.equal(store.myBatisResourcesByNamespace.get("demo.OrderMapper"), undefined);
  assert.equal(store.myBatisStatement("demo.RenamedMapper", "insert")?.statementId, "mybatis-statement:demo.RenamedMapper.insert");
  assert.deepEqual([...(store.myBatisResourcesByNamespace.get("demo.RenamedMapper") ?? [])], [relativePath]);
});

test("removing a MyBatis resource does not evict a qualifiedId claimed by a different resource with the same (namespace, id)", () => {
  const store = new JavaIndexStore();
  const statement = { statementId: "mybatis-statement:demo.Dup.x", namespace: "demo.Dup", id: "x", kind: "select" as const };
  store.replaceMyBatisResource(myBatisResource({ relativePath: "a.xml", namespace: "demo.Dup", statements: [statement] }));
  // A second, malformed-repo resource claims the exact same qualified id.
  store.replaceMyBatisResource(myBatisResource({ relativePath: "b.xml", namespace: "demo.Dup", statements: [statement] }));

  store.removeMyBatisResources(["a.xml"]);

  assert.equal(store.myBatisResource("a.xml"), undefined);
  assert.equal(store.myBatisResource("b.xml")?.relativePath, "b.xml");
  assert.equal(store.myBatisStatement("demo.Dup", "x")?.statementId, "mybatis-statement:demo.Dup.x");
  assert.deepEqual([...(store.myBatisResourcesByNamespace.get("demo.Dup") ?? [])], ["b.xml"]);
});

test("removeMyBatisResources on an unindexed path is a no-op", () => {
  const store = new JavaIndexStore();
  assert.doesNotThrow(() => store.removeMyBatisResources(["never-indexed.xml"]));
  assert.equal(store.myBatisResource("never-indexed.xml"), undefined);
});

test("myBatisResourceForNamespace returns the sole resource claiming a namespace", () => {
  const store = new JavaIndexStore();
  store.replaceMyBatisResource(myBatisResource({ relativePath: "src/main/resources/mapper/OrderMapper.xml", namespace: "demo.OrderMapper" }));

  assert.equal(store.myBatisResourceForNamespace("demo.OrderMapper")?.relativePath, "src/main/resources/mapper/OrderMapper.xml");
  assert.equal(store.myBatisResourceForNamespace("demo.NoSuchMapper"), undefined);
});

test("myBatisResourceForNamespace treats a namespace collision as ambiguous instead of guessing", () => {
  const store = new JavaIndexStore();
  store.replaceMyBatisResource(myBatisResource({ relativePath: "z-second.xml", namespace: "demo.Dup" }));
  store.replaceMyBatisResource(myBatisResource({ relativePath: "a-first.xml", namespace: "demo.Dup" }));

  assert.equal(store.myBatisResourceForNamespace("demo.Dup"), undefined);
});
