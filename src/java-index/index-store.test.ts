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
