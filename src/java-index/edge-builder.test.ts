import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { extractJavaFile, type ExtractedJavaFile, type ExtractJavaInput } from "./ast-extractor.js";
import { JavaNameResolver, buildTypeRegistryView } from "./name-resolver.js";
import { buildStaticEdges, resolveFileRefs, sameResolution } from "./edge-builder.js";
import type { StaticEdge, StaticEdgeKind } from "./index-types.js";
import { javaParameterId } from "./stable-id.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

function baseInput(overrides: Partial<ExtractJavaInput> & { content: string; relativePath: string }): ExtractJavaInput {
  return {
    repoRoot: fixturesRoot,
    absolutePath: path.join(fixturesRoot, overrides.relativePath),
    sourceRoot: "src/main/java",
    module: "demo-module",
    sourceSet: "main",
    size: Buffer.byteLength(overrides.content, "utf8"),
    contentHash: "test",
    generation: 1,
    ...overrides
  };
}

function extractFixture(backend: JavaParserBackend, relativePath: string): ExtractedJavaFile {
  const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
  return extractJavaFile(baseInput({ content, relativePath }), backend);
}

async function loadPaymentBundle(): Promise<{ resolved: ExtractedJavaFile; edges: StaticEdge[] }> {
  const backend = await createJavaParserBackend();
  const raw = extractFixture(backend, "src/main/java/demo/PaymentGateway.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  // buildStaticEdges must see method facts from the *resolved* bundle for
  // owner-type lookups (super-chain/receiver resolution reads resolved refs
  // off bundle.types), so the registry backing edge building is rebuilt from
  // the resolved bundle, not the raw pre-resolution one.
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);
  return { resolved, edges };
}

function findEdge(edges: StaticEdge[], fromId: string, toId: string, kind: StaticEdgeKind): StaticEdge | undefined {
  return edges.find(e => e.fromId === fromId && e.toId === toId && e.kind === kind);
}

test("declaration/type edges: implements, field type, return type, param type", async () => {
  const { resolved, edges } = await loadPaymentBundle();
  const typeByName = new Map(resolved.types.map(t => [t.simpleName, t]));
  const aliyunGateway = typeByName.get("AliyunGateway")!;
  const paymentGateway = typeByName.get("PaymentGateway")!;
  const paymentResult = typeByName.get("PaymentResult")!;
  const paymentCommand = typeByName.get("PaymentCommand")!;
  const paymentService = typeByName.get("PaymentService")!;
  const gatewayField = resolved.fields.find(f => f.ownerTypeId === paymentService.typeId && f.name === "gateway")!;
  const payMethod = resolved.methods.find(m => m.ownerTypeId === paymentService.typeId && m.name === "pay")!;

  // v2: declaration ids are source-scoped ("type:v2:<escaped path>#<fqn>");
  // the FQN stays embedded as a search attribute after the final "#".
  assert.match(aliyunGateway.typeId, /^type:v2:.+#demo\.AliyunGateway$/);
  assert.match(paymentGateway.typeId, /^type:v2:.+#demo\.PaymentGateway$/);
  assert.notEqual(aliyunGateway.typeId, paymentGateway.typeId);
  // javaFieldId embeds the owner's full source-scoped id, not a bare fqn.
  assert.match(gatewayField.fieldId, /^field:type:v2:.+#demo\.PaymentService#gateway$/);

  const implementsEdge = findEdge(edges, aliyunGateway.typeId, paymentGateway.typeId, "IMPLEMENTS");
  assert.ok(implementsEdge, "expected AliyunGateway IMPLEMENTS PaymentGateway");
  assert.equal(implementsEdge!.confidence, 0.98);

  const fieldTypeEdge = findEdge(edges, gatewayField.fieldId, paymentGateway.typeId, "FIELD_TYPE");
  assert.ok(fieldTypeEdge, "expected PaymentService#gateway FIELD_TYPE PaymentGateway");
  assert.equal(fieldTypeEdge!.confidence, 0.98);

  const returnTypeEdge = findEdge(edges, payMethod.methodId, paymentResult.typeId, "RETURN_TYPE");
  assert.ok(returnTypeEdge, "expected PaymentService#pay RETURN_TYPE PaymentResult");
  assert.equal(returnTypeEdge!.confidence, 0.98);

  const paramTypeEdge = findEdge(edges, payMethod.methodId, paymentCommand.typeId, "PARAM_TYPE");
  assert.ok(paramTypeEdge, "expected PaymentService#pay PARAM_TYPE PaymentCommand");
  assert.equal(paramTypeEdge!.confidence, 0.98);
});

test("bounded call resolution: declared-receiver CALLS and constructor CONSTRUCTS", async () => {
  const { resolved, edges } = await loadPaymentBundle();
  const typeByName = new Map(resolved.types.map(t => [t.simpleName, t]));
  const paymentService = typeByName.get("PaymentService")!;
  const paymentGateway = typeByName.get("PaymentGateway")!;
  const aliyunGateway = typeByName.get("AliyunGateway")!;
  const paymentResult = typeByName.get("PaymentResult")!;
  const servicePayMethod = resolved.methods.find(m => m.ownerTypeId === paymentService.typeId && m.name === "pay")!;
  const gatewayPayMethod = resolved.methods.find(m => m.ownerTypeId === paymentGateway.typeId && m.name === "pay")!;
  const aliyunPayMethod = resolved.methods.find(m => m.ownerTypeId === aliyunGateway.typeId && m.name === "pay")!;

  const callsEdge = findEdge(edges, servicePayMethod.methodId, gatewayPayMethod.methodId, "CALLS");
  assert.ok(callsEdge, "expected PaymentService#pay CALLS PaymentGateway#pay via the declared gateway field");
  assert.equal(callsEdge!.confidence, 0.9);
  assert.equal(callsEdge!.resolution.kind, "DECLARED_RECEIVER_NAME_ARITY");

  const constructsEdge = findEdge(edges, aliyunPayMethod.methodId, paymentResult.typeId, "CONSTRUCTS");
  assert.ok(constructsEdge, "expected AliyunGateway#pay CONSTRUCTS PaymentResult via `new PaymentResult(...)`");
  assert.equal(constructsEdge!.confidence, 0.98);
  assert.equal(constructsEdge!.resolution.kind, "CONSTRUCTOR_TYPE");
});

test("an unshadowed explicit imported type receiver resolves a static CALLS edge", async () => {
  const backend = await createJavaParserBackend();
  const callerRaw = extractFromRawSource(backend, [
    "package demo;",
    "",
    "import tools.Converters;",
    "",
    "class StaticCaller {",
    "  void run() {",
    "    Converters.map();",
    "  }",
    "}",
    ""
  ].join("\n"), "src/main/java/demo/StaticCaller.java");
  const targetRaw = extractFromRawSource(backend, [
    "package tools;",
    "",
    "public class Converters {",
    "  public static void map() {}",
    "}",
    ""
  ].join("\n"), "src/main/java/tools/Converters.java");
  const registry = buildTypeRegistryView(
    [...callerRaw.types, ...targetRaw.types],
    [...callerRaw.methods, ...targetRaw.methods]
  );
  const resolver = new JavaNameResolver(registry);
  const caller = resolveFileRefs(callerRaw, resolver, registry);
  const target = resolveFileRefs(targetRaw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(
    [...caller.types, ...target.types],
    [...caller.methods, ...target.methods]
  );
  const edges = buildStaticEdges(caller, resolvedRegistry, resolver);
  const callerType = caller.types.find(type => type.simpleName === "StaticCaller")!;
  const converterType = target.types.find(type => type.simpleName === "Converters")!;
  const run = caller.methods.find(method => method.ownerTypeId === callerType.typeId && method.name === "run")!;
  const map = target.methods.find(method => method.ownerTypeId === converterType.typeId && method.name === "map")!;

  const edge = findEdge(edges, run.methodId, map.methodId, "CALLS");
  assert.ok(edge, "expected StaticCaller#run CALLS Converters#map via an unshadowed explicit import");
  assert.equal(edge!.resolution.kind, "DECLARED_RECEIVER_NAME_ARITY");
});

test("an unqualified call matching two same-arity overloads produces no CALLS edge", async () => {
  const { resolved, edges } = await loadPaymentBundle();
  const paymentService = resolved.types.find(t => t.simpleName === "PaymentService")!;
  const ambiguousSave = resolved.methods.find(m => m.ownerTypeId === paymentService.typeId && m.name === "ambiguousSave")!;
  const saveOverloads = resolved.methods.filter(m => m.ownerTypeId === paymentService.typeId && m.name === "save");
  assert.equal(saveOverloads.length, 2, "fixture must declare exactly two same-arity save() overloads");

  const callsFromAmbiguousSave = edges.filter(e => e.kind === "CALLS" && e.fromId === ambiguousSave.methodId);
  assert.equal(
    callsFromAmbiguousSave.length,
    0,
    "a call with unknown arg type matching two same-arity overloads must not arbitrarily pick one"
  );
});

test("an unqualified same-owner call produces SAME_OWNER_NAME_ARITY at 0.92 confidence", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "class SameOwnerCaller {",
    "  void run() {",
    "    helper();",
    "  }",
    "  void helper() {}",
    "}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/SameOwnerCaller.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);

  const owner = resolved.types.find(t => t.simpleName === "SameOwnerCaller")!;
  const run = resolved.methods.find(m => m.ownerTypeId === owner.typeId && m.name === "run")!;
  const helper = resolved.methods.find(m => m.ownerTypeId === owner.typeId && m.name === "helper")!;

  const edge = findEdge(edges, run.methodId, helper.methodId, "CALLS");
  assert.ok(edge, "expected SameOwnerCaller#run CALLS SameOwnerCaller#helper");
  assert.equal(edge!.confidence, 0.92);
  assert.equal(edge!.resolution.kind, "SAME_OWNER_NAME_ARITY");
});

test("an inherited method call produces SUPER_CHAIN_NAME_ARITY at 0.85 confidence", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "class Base {",
    "  void run() {}",
    "}",
    "",
    "class Derived extends Base {",
    "  void trigger() {",
    "    run();",
    "  }",
    "}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/SuperChain.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);

  const base = resolved.types.find(t => t.simpleName === "Base")!;
  const derived = resolved.types.find(t => t.simpleName === "Derived")!;
  const baseRun = resolved.methods.find(m => m.ownerTypeId === base.typeId && m.name === "run")!;
  const trigger = resolved.methods.find(m => m.ownerTypeId === derived.typeId && m.name === "trigger")!;

  const edge = findEdge(edges, trigger.methodId, baseRun.methodId, "CALLS");
  assert.ok(edge, "expected Derived#trigger CALLS the inherited Base#run");
  assert.equal(edge!.confidence, 0.85);
  assert.equal(edge!.resolution.kind, "SUPER_CHAIN_NAME_ARITY");
});

test("IMPORTS and ANNOTATED_WITH edges resolve to external: nodes for names never stored as a JavaTypeRef", async () => {
  const backend = await createJavaParserBackend();
  const raw = extractFixture(backend, "src/main/java/demo/ComplexJava.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);
  const complexJava = resolved.types.find(t => t.simpleName === "ComplexJava")!;

  const importsEdge = findEdge(edges, resolved.file.fileId, "external:java.util.List", "IMPORTS");
  assert.ok(importsEdge, "expected an IMPORTS edge from the file to external:java.util.List");
  assert.equal(importsEdge!.confidence, 0.98);
  assert.equal(importsEdge!.resolution.kind, "AST_EXPLICIT");

  const annotatedWithEdge = findEdge(edges, complexJava.typeId, "external:java.lang.Deprecated", "ANNOTATED_WITH");
  assert.ok(annotatedWithEdge, "expected an ANNOTATED_WITH edge from ComplexJava to external:java.lang.Deprecated");
  assert.equal(annotatedWithEdge!.confidence, 0.98);
  assert.equal(annotatedWithEdge!.resolution.typeStrategy, "JAVA_LANG");
});

test("a constructor parameter annotation produces an ANNOTATED_WITH edge from the parameter's synthetic id", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "import org.springframework.beans.factory.annotation.Autowired;",
    "",
    "class ParamAnnotationEdges {",
    "  ParamAnnotationEdges(@Autowired Service svc) {}",
    "}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/ParamAnnotationEdges.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);

  const ctor = resolved.methods.find(m => m.constructor)!;
  const paramId = javaParameterId(ctor.methodId, 0);

  const edge = findEdge(edges, paramId, "external:org.springframework.beans.factory.annotation.Autowired", "ANNOTATED_WITH");
  assert.ok(edge, "expected an ANNOTATED_WITH edge from the constructor's first parameter to the resolved @Autowired import");
  assert.equal(edge!.resolution.typeStrategy, "EXPLICIT_IMPORT");
});

test("a repo-defined parameter annotation (e.g. a custom @CurrentUser) resolves to the repo type, not an external: node", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "class RepoParamAnnotation {",
    "  void handle(@CurrentUser User caller) {}",
    "}",
    "",
    "@interface CurrentUser {}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/RepoParamAnnotation.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);

  const owner = resolved.types.find(t => t.simpleName === "RepoParamAnnotation")!;
  const currentUser = resolved.types.find(t => t.simpleName === "CurrentUser")!;
  const handle = resolved.methods.find(m => m.ownerTypeId === owner.typeId && m.name === "handle")!;
  const paramId = javaParameterId(handle.methodId, 0);

  const edge = findEdge(edges, paramId, currentUser.typeId, "ANNOTATED_WITH");
  assert.ok(edge, "expected a repo-defined parameter annotation to resolve RESOLVED_REPO, not external:");
  assert.equal(edge!.resolution.kind, "TYPE_REFERENCE");
});

test("an ambiguous/unimported parameter annotation produces no ANNOTATED_WITH edge", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "class UnresolvedParamAnnotation {",
    "  UnresolvedParamAnnotation(@Qualifier(\"x\") Service svc) {}",
    "}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/UnresolvedParamAnnotation.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
  const edges = buildStaticEdges(resolved, resolvedRegistry, resolver);

  const ctor = resolved.methods.find(m => m.constructor)!;
  const paramId = javaParameterId(ctor.methodId, 0);

  assert.equal(
    edges.filter(e => e.fromId === paramId && e.kind === "ANNOTATED_WITH").length,
    0,
    "a short annotation name with no matching import must not guess a target"
  );
});

test("a call argument's structured type hint resolves to its repo type via the same pass that resolves method parameters", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "",
    "class ArgHintCaller {",
    "  void handle() {",
    "    publish(new Marker());",
    "  }",
    "  void publish(Object o) {}",
    "}",
    "",
    "class Marker {}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/ArgHintCaller.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);

  const caller = resolved.types.find(t => t.simpleName === "ArgHintCaller")!;
  const marker = resolved.types.find(t => t.simpleName === "Marker")!;
  const handle = resolved.methods.find(m => m.ownerTypeId === caller.typeId && m.name === "handle")!;
  const publishCall = handle.callSites.find(c => c.name === "publish")!;

  const hint = publishCall.argumentTypeHints[0]!;
  assert.equal(hint.resolution.state, "RESOLVED_REPO");
  if (hint.resolution.state === "RESOLVED_REPO") {
    assert.equal(hint.resolution.typeId, marker.typeId);
  }
});

test("sameResolution agrees with comparing the serialized facts, for every fixture and against a smaller registry", async () => {
  const backend = await createJavaParserBackend();
  const files = (readdirSync(fixturesRoot, { recursive: true }) as string[]).filter(file => file.endsWith(".java")).sort();
  const raws = files.map(file => extractFixture(backend, file));
  const registry = buildTypeRegistryView(raws.flatMap(raw => raw.types), raws.flatMap(raw => raw.methods));
  const resolver = new JavaNameResolver(registry);
  // Half the types missing: refs fall to EXTERNAL/UNRESOLVED, or to another candidate.
  const partial = buildTypeRegistryView(raws.flatMap((raw, index) => index % 2 ? [] : raw.types), raws.flatMap(raw => raw.methods));
  const partialResolver = new JavaNameResolver(partial);
  const serialized = (bundle: ExtractedJavaFile) => JSON.stringify([bundle.file, bundle.types, bundle.fields, bundle.methods]);
  let same = 0, moved = 0;
  for (const raw of raws) {
    const resolved = resolveFileRefs(raw, resolver, registry);
    const decoded = JSON.parse(serialized(resolved)) as [ExtractedJavaFile["file"], ExtractedJavaFile["types"], ExtractedJavaFile["fields"], ExtractedJavaFile["methods"]];
    const stored: ExtractedJavaFile = { file: decoded[0], types: decoded[1], fields: decoded[2], methods: decoded[3] };
    for (const next of [resolveFileRefs(stored, resolver, registry), resolveFileRefs(stored, partialResolver, partial), resolveFileRefs(raw, resolver, registry)]) {
      const expected = serialized(stored) === serialized(next);
      assert.equal(sameResolution(stored, next), expected, raw.file.relativePath);
      if (expected) same++; else moved++;
    }
  }
  assert.ok(same >= raws.length && moved > 0, `same ${same} moved ${moved}`);
});

test("a method's type parameter shadows a same-named class only in that method, though names resolve once per file", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "class T {}",
    "class Holder {",
    "  <T> T generic(T value) { return value; }",
    "  T plain(T value) { return value; }",
    "  class Inner { T nested; }",
    "}",
    ""
  ].join("\n");
  const raw = extractFromRawSource(backend, source, "src/main/java/demo/Holder.java");
  const registry = buildTypeRegistryView(raw.types, raw.methods);
  const resolved = resolveFileRefs(raw, new JavaNameResolver(registry), registry);
  const classT = resolved.types.find(type => type.simpleName === "T")!;
  const method = (name: string) => resolved.methods.find(item => item.name === name)!;
  assert.equal(method("generic").parameters[0]!.type.resolution.state, "TYPE_VARIABLE");
  assert.equal(method("generic").returnType!.resolution.state, "TYPE_VARIABLE");
  for (const ref of [method("plain").parameters[0]!.type, method("plain").returnType!, resolved.fields.find(field => field.name === "nested")!.type]) {
    assert.deepEqual(ref.resolution, { state: "RESOLVED_REPO", typeId: classT.typeId, strategy: "SAME_PACKAGE" });
  }
});

function extractFromRawSource(backend: JavaParserBackend, content: string, relativePath: string): ExtractedJavaFile {
  return extractJavaFile(baseInput({ content, relativePath }), backend);
}
