import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { extractJavaFile, type ExtractedJavaFile, type ExtractJavaInput } from "./ast-extractor.js";
import type { JavaTypeFacts, JavaTypeRef } from "./index-types.js";
import {
  JavaNameResolver,
  buildTypeRegistryView,
  parseTypeText,
  selectVisibleDeclaration,
  type DeclarationLocation,
  type JavaResolutionContext,
  type TypeRegistryView
} from "./name-resolver.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { close, openIndexDb } from "./sql/driver.js";
import { SqlFactsStore } from "./sql/facts-store.js";
import { buildSqlRegistryView } from "./sql/registry-view.js";
import { writeBundle } from "./sql/rows.js";
import { ensureSchema } from "./sql/schema.js";

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
    mtimeMs: 0,
    contentHash: "test",
    generation: 1,
    ...overrides
  };
}

function extractFixture(backend: JavaParserBackend, relativePath: string): ExtractedJavaFile {
  const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
  return extractJavaFile(baseInput({ content, relativePath }), backend);
}

function contextFor(
  bundle: ExtractedJavaFile,
  overrides: Partial<JavaResolutionContext> = {}
): JavaResolutionContext {
  return {
    packageName: bundle.file.packageName,
    imports: bundle.file.imports,
    enclosingTypeIds: [],
    typeParameterNames: new Set(),
    ...overrides
  };
}

function fakeType(overrides: Partial<JavaTypeFacts> & { typeId: string; simpleName: string }): JavaTypeFacts {
  return {
    fqn: undefined,
    kind: "class",
    fileId: "file:fake",
    enclosingTypeId: undefined,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    modifiers: [],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1,
    ...overrides
  };
}

async function loadRegistry(): Promise<{
  backend: JavaParserBackend;
  registry: TypeRegistryView;
  bundles: Record<string, ExtractedJavaFile>;
}> {
  const backend = await createJavaParserBackend();
  const bundles = {
    aUser: extractFixture(backend, "src/main/java/a/User.java"),
    bUser: extractFixture(backend, "src/main/java/b/User.java"),
    explicit: extractFixture(backend, "src/main/java/use/ExplicitUserService.java"),
    ambiguous: extractFixture(backend, "src/main/java/use/AmbiguousUserService.java"),
    complexJava: extractFixture(backend, "src/main/java/demo/ComplexJava.java")
  };
  const allTypes = Object.values(bundles).flatMap(b => b.types);
  const registry = buildTypeRegistryView(allTypes);
  return { backend, registry, bundles };
}

test("explicit imports beat same simple-name candidates", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const aUserId = bundles.aUser.types[0]!.typeId;

  const resolved = resolver.resolveTypeText("User", contextFor(bundles.explicit));
  assert.deepEqual(resolved.resolution, {
    state: "RESOLVED_REPO",
    typeId: aUserId,
    strategy: "EXPLICIT_IMPORT"
  });
});

test("multiple wildcard candidates remain ambiguous", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const aUserId = bundles.aUser.types[0]!.typeId;
  const bUserId = bundles.bUser.types[0]!.typeId;

  const resolved = resolver.resolveTypeText("User", contextFor(bundles.ambiguous));
  assert.deepEqual(resolved.resolution, {
    state: "AMBIGUOUS",
    candidates: [aUserId, bUserId].sort()
  });
});

test("repo-unique simple name is a lower-priority fallback", async () => {
  const { registry, bundles } = await loadRegistry();
  const onlyOne = fakeType({ typeId: "type:only.OnlyOne", simpleName: "OnlyOne", fqn: "only.OnlyOne" });
  const augmented = buildTypeRegistryView([...Object.values(bundles).flatMap(b => b.types), onlyOne]);
  const resolver = new JavaNameResolver(augmented);

  const resolved = resolver.resolveTypeText("OnlyOne", contextFor(bundles.explicit));
  assert.equal(resolved.resolution.state, "RESOLVED_REPO");
  assert.equal((resolved.resolution as { strategy: string }).strategy, "REPO_UNIQUE_SIMPLE_NAME");
});

test("same-package type resolves without any import", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const secondTopLevelId = bundles.complexJava.types.find(t => t.simpleName === "SecondTopLevel")!.typeId;

  // SecondTopLevel is a *top-level* type sharing demo's package with
  // ComplexJava, so it is directly addressable as "demo.SecondTopLevel" -
  // unlike a nested type (e.g. Child, only reachable as
  // "demo.ComplexJava$Child"), which step 5's plain "package.SimpleName"
  // lookup can never match and must instead fall through to step 8.
  const resolved = resolver.resolveTypeText(
    "SecondTopLevel",
    contextFor(bundles.complexJava, { enclosingTypeIds: [] })
  );
  assert.deepEqual(resolved.resolution, {
    state: "RESOLVED_REPO",
    typeId: secondTopLevelId,
    strategy: "SAME_PACKAGE"
  });
});

test("nested type resolves through the enclosing type scope, innermost first", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const complexJavaId = bundles.complexJava.types.find(t => t.simpleName === "ComplexJava")!.typeId;
  const helperId = bundles.complexJava.types.find(t => t.simpleName === "Helper")!.typeId;

  // From within Helper (nested inside ComplexJava), "ComplexJava" refers to
  // the enclosing type itself and "Helper" resolves to Helper's own type -
  // both via ENCLOSING_TYPE, not SAME_PACKAGE, since enclosing scope must
  // win first (step 4 precedes step 5).
  const context = contextFor(bundles.complexJava, { enclosingTypeIds: [complexJavaId, helperId] });
  assert.deepEqual(resolver.resolveTypeText("ComplexJava", context).resolution, {
    state: "RESOLVED_REPO",
    typeId: complexJavaId,
    strategy: "ENCLOSING_TYPE"
  });
  assert.deepEqual(resolver.resolveTypeText("Helper", context).resolution, {
    state: "RESOLVED_REPO",
    typeId: helperId,
    strategy: "ENCLOSING_TYPE"
  });
});

test("a dotted Outer.Inner reference without a package prefix resolves via the current package", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const childId = bundles.complexJava.types.find(t => t.simpleName === "Child")!.typeId;

  // ComplexJava.java's own `permits ComplexJava.Child` clause is exactly
  // this case: a nested-type reference written as "Outer.Inner" (dots),
  // while this repo's FQN convention nests with "$" (demo.ComplexJava$Child).
  const resolved = resolver.resolveTypeText("ComplexJava.Child", contextFor(bundles.complexJava));
  assert.deepEqual(resolved.resolution, {
    state: "RESOLVED_REPO",
    typeId: childId,
    strategy: "QUALIFIED"
  });
});

test("java.lang.String resolves as EXTERNAL/JAVA_LANG", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);

  const resolved = resolver.resolveTypeText("String", contextFor(bundles.explicit));
  assert.deepEqual(resolved.resolution, { state: "EXTERNAL", qualifiedName: "java.lang.String", strategy: "JAVA_LANG" });
  assert.equal(resolved.qualifiedName, "java.lang.String");
});

test("an explicit import to a type with no repo source is still EXTERNAL/EXPLICIT_IMPORT", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const context = contextFor(bundles.explicit, {
    imports: [
      ...bundles.explicit.file.imports,
      { qualifiedName: "org.springframework.stereotype.Service", wildcard: false, static: false, range: bundles.explicit.file.imports[0]!.range }
    ]
  });

  const resolved = resolver.resolveTypeText("Service", context);
  assert.deepEqual(resolved.resolution, {
    state: "EXTERNAL",
    qualifiedName: "org.springframework.stereotype.Service",
    strategy: "EXPLICIT_IMPORT"
  });
});

test("an unresolvable bare name with no import, repo, or java.lang match is UNRESOLVED", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);

  const resolved = resolver.resolveTypeText("BaseType", contextFor(bundles.complexJava));
  assert.deepEqual(resolved.resolution, { state: "UNRESOLVED" });
});

test("a declared type parameter resolves to TYPE_VARIABLE, but an undeclared single letter does not", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);

  const withT = contextFor(bundles.complexJava, { typeParameterNames: new Set(["T"]) });
  assert.deepEqual(resolver.resolveTypeText("T", withT).resolution, { state: "TYPE_VARIABLE", name: "T" });

  const withoutT = contextFor(bundles.complexJava, { typeParameterNames: new Set() });
  assert.deepEqual(resolver.resolveTypeText("T", withoutT).resolution, { state: "UNRESOLVED" });
});

test("a static import of a member does not shadow or interfere with type resolution", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  // ComplexJava.java imports `static java.util.Objects.requireNonNull`; a
  // type reference to "Objects" must resolve independently of that import
  // (there is no repo type or java.lang entry named "Objects" here, so it
  // must land on UNRESOLVED, not be short-circuited by the static import's
  // presence in the imports list).
  const resolved = resolver.resolveTypeText("Objects", contextFor(bundles.complexJava));
  assert.deepEqual(resolved.resolution, { state: "UNRESOLVED" });
});

test("wildcard type arguments and array types resolve recursively through resolveTypeText", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const aUserId = bundles.aUser.types[0]!.typeId;

  const listOfUser = resolver.resolveTypeText("List<User>", contextFor(bundles.explicit));
  assert.equal(listOfUser.simpleName, "List");
  assert.equal(listOfUser.arrayDepth, 0);
  assert.equal(listOfUser.typeArguments.length, 1);
  assert.deepEqual(listOfUser.typeArguments[0]!.resolution, {
    state: "RESOLVED_REPO",
    typeId: aUserId,
    strategy: "EXPLICIT_IMPORT"
  });

  const arrayOfUser = resolver.resolveTypeText("User[]", contextFor(bundles.explicit));
  assert.equal(arrayOfUser.arrayDepth, 1);
  assert.deepEqual(arrayOfUser.resolution, { state: "RESOLVED_REPO", typeId: aUserId, strategy: "EXPLICIT_IMPORT" });

  const wildcardBound = resolver.resolveTypeText("Map<String, ? extends User>", contextFor(bundles.explicit));
  assert.equal(wildcardBound.typeArguments.length, 2);
  const boundArg = wildcardBound.typeArguments[1]!;
  assert.equal(boundArg.wildcard, "extends");
  assert.equal(boundArg.simpleName, "User");
  assert.deepEqual(boundArg.resolution, { state: "RESOLVED_REPO", typeId: aUserId, strategy: "EXPLICIT_IMPORT" });
});

test("resolveTypeRef re-resolves an already-built JavaTypeRef, including nested wildcard-bound type arguments", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const aUserId = bundles.aUser.types[0]!.typeId;

  // Simulates what ast-extractor's buildTypeRef produces for a field/param
  // typed `Map<String, ? extends User>` before resolution: text carries the
  // full generic text, typeArguments are already-structured refs, and the
  // wildcard-bound argument's own text is the whole "? extends User" node
  // text while its simpleName is already just "User".
  const stringRef: JavaTypeRef = {
    text: "String",
    simpleName: "String",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "UNRESOLVED" }
  };
  const wildcardUserRef: JavaTypeRef = {
    text: "? extends User",
    simpleName: "User",
    typeArguments: [],
    arrayDepth: 0,
    wildcard: "extends",
    resolution: { state: "UNRESOLVED" }
  };
  const mapRef: JavaTypeRef = {
    text: "Map<String, ? extends User>",
    simpleName: "Map",
    typeArguments: [stringRef, wildcardUserRef],
    arrayDepth: 0,
    resolution: { state: "UNRESOLVED" }
  };

  const resolved = resolver.resolveTypeRef(mapRef, contextFor(bundles.explicit));
  assert.equal(resolved.resolution.state, "UNRESOLVED"); // Map itself: no repo/java.lang "Map" without an import
  assert.deepEqual(resolved.typeArguments[1]!.resolution, {
    state: "RESOLVED_REPO",
    typeId: aUserId,
    strategy: "EXPLICIT_IMPORT"
  });
  // Fields untouched by resolution must be preserved as-is.
  assert.equal(resolved.text, "Map<String, ? extends User>");
  assert.equal(resolved.typeArguments[1]!.wildcard, "extends");
});

test("parseTypeText handles nested generics, arrays, wildcards and dotted names", () => {
  assert.deepEqual(parseTypeText("List<User>"), { baseName: "List", typeArguments: ["User"], arrayDepth: 0, wildcard: undefined });
  assert.deepEqual(parseTypeText("User[]"), { baseName: "User", typeArguments: [], arrayDepth: 1, wildcard: undefined });
  assert.deepEqual(parseTypeText("Outer.Inner"), { baseName: "Outer.Inner", typeArguments: [], arrayDepth: 0, wildcard: undefined });
  assert.deepEqual(parseTypeText("T"), { baseName: "T", typeArguments: [], arrayDepth: 0, wildcard: undefined });
  const map = parseTypeText("Map<String, ? extends User>");
  assert.equal(map.baseName, "Map");
  assert.deepEqual(map.typeArguments, ["String", "? extends User"]);
  const nestedArray = parseTypeText("List<Map<String, User>>[]");
  assert.equal(nestedArray.baseName, "List");
  assert.equal(nestedArray.arrayDepth, 1);
  assert.deepEqual(nestedArray.typeArguments, ["Map<String, User>"]);
});

test("exhaustive switch over all five resolution states", async () => {
  const { registry, bundles } = await loadRegistry();
  const resolver = new JavaNameResolver(registry);
  const onlyOne = fakeType({ typeId: "type:only.OnlyOne", simpleName: "OnlyOne", fqn: "only.OnlyOne" });
  const augmented = buildTypeRegistryView([...Object.values(bundles).flatMap(b => b.types), onlyOne]);
  const resolverWithOnlyOne = new JavaNameResolver(augmented);

  const cases: Array<{ text: string; context: JavaResolutionContext; resolver: JavaNameResolver }> = [
    { text: "User", context: contextFor(bundles.explicit), resolver },
    { text: "User", context: contextFor(bundles.ambiguous), resolver },
    { text: "String", context: contextFor(bundles.explicit), resolver },
    { text: "BaseType", context: contextFor(bundles.complexJava), resolver },
    { text: "T", context: contextFor(bundles.complexJava, { typeParameterNames: new Set(["T"]) }), resolver: resolverWithOnlyOne }
  ];

  const seenStates = new Set<string>();
  for (const testCase of cases) {
    const resolution = testCase.resolver.resolveTypeText(testCase.text, testCase.context).resolution;
    seenStates.add(resolution.state);
    switch (resolution.state) {
      case "RESOLVED_REPO":
        assert.ok(resolution.typeId);
        break;
      case "EXTERNAL":
        assert.ok(resolution.qualifiedName);
        break;
      case "AMBIGUOUS":
        assert.ok(resolution.candidates.length >= 2);
        break;
      case "TYPE_VARIABLE":
        assert.equal(resolution.name, "T");
        break;
      case "UNRESOLVED":
        break;
      default: {
        const exhaustive: never = resolution;
        throw new Error(`unhandled resolution state: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  assert.deepEqual(
    [...seenStates].sort(),
    ["AMBIGUOUS", "EXTERNAL", "RESOLVED_REPO", "TYPE_VARIABLE", "UNRESOLVED"]
  );
});

// ---------------------------------------------------------------- R05
// Duplicate FQNs across independent compilation scopes (modules, main/test).
// Real parser + real resolveFileRefs/buildStaticEdges + real SQL store.

type ScopedSource = { relativePath: string; module: string; sourceSet: "main" | "test"; content: string };

const SHARED = (track: string) => `package demo;
public class Shared {
  public String track() { return "${track}"; }
  public static class Inner {}
}
`;

const R05_SOURCES: ScopedSource[] = [
  { relativePath: "a/src/main/java/demo/Shared.java", module: "a", sourceSet: "main", content: SHARED("a") },
  { relativePath: "b/src/main/java/demo/Shared.java", module: "b", sourceSet: "main", content: SHARED("b") },
  {
    relativePath: "b/src/main/java/demo/UseB.java",
    module: "b",
    sourceSet: "main",
    content: "package demo;\npublic class UseB {\n  Shared shared;\n  Shared.Inner inner;\n  String go() { return shared.track(); }\n}\n"
  },
  { relativePath: "c/src/main/java/demo/Only.java", module: "c", sourceSet: "main", content: "package demo;\npublic class Only {}\n" },
  { relativePath: "c/src/test/java/demo/Only.java", module: "c", sourceSet: "test", content: "package demo;\npublic class Only {}\n" },
  { relativePath: "c/src/test/java/demo/TestOnly.java", module: "c", sourceSet: "test", content: "package demo;\npublic class TestOnly {}\n" },
  { relativePath: "d/src/test/java/demo/Shared.java", module: "d", sourceSet: "test", content: SHARED("d-test") }
];

async function extractScoped(sources: readonly ScopedSource[]): Promise<ExtractedJavaFile[]> {
  const backend = await createJavaParserBackend();
  return sources.map(source => extractJavaFile(baseInput({
    content: source.content,
    relativePath: source.relativePath,
    module: source.module,
    sourceSet: source.sourceSet,
    sourceRoot: `${source.module}/src/${source.sourceSet}/java`
  }), backend));
}

function scopedRegistry(bundles: readonly ExtractedJavaFile[]): TypeRegistryView {
  return buildTypeRegistryView(bundles.flatMap(b => b.types), bundles.flatMap(b => b.methods), undefined, bundles.map(b => b.file));
}

function typeIdOf(bundles: readonly ExtractedJavaFile[], relativePath: string, simpleName = relativePath.split("/").pop()!.replace(".java", "")): string {
  const bundle = bundles.find(b => b.file.relativePath === relativePath)!;
  return bundle.types.find(type => type.simpleName === simpleName)!.typeId;
}

const at = (module: string, sourceSet: "main" | "test"): JavaResolutionContext => ({
  packageName: "client",
  imports: [],
  enclosingTypeIds: [],
  typeParameterNames: new Set(),
  location: { module, sourceSet }
});

test("R05: duplicate FQN without a compilation context stays AMBIGUOUS with every candidate", async () => {
  const bundles = await extractScoped(R05_SOURCES);
  const resolver = new JavaNameResolver(scopedRegistry(bundles));
  const unknown = { packageName: "client", imports: [], enclosingTypeIds: [], typeParameterNames: new Set<string>() };
  const resolution = resolver.resolveTypeText("demo.Shared", unknown).resolution;
  assert.equal(resolution.state, "AMBIGUOUS");
  const candidates = resolution.state === "AMBIGUOUS" ? resolution.candidates : [];
  assert.deepEqual([...candidates].sort(), [
    typeIdOf(bundles, "a/src/main/java/demo/Shared.java"),
    typeIdOf(bundles, "b/src/main/java/demo/Shared.java"),
    typeIdOf(bundles, "d/src/test/java/demo/Shared.java")
  ].sort());
});

test("R05: the referring module's own declaration wins; other modules' tests are invisible", async () => {
  const bundles = await extractScoped(R05_SOURCES);
  const resolver = new JavaNameResolver(scopedRegistry(bundles));
  const a = typeIdOf(bundles, "a/src/main/java/demo/Shared.java");
  const b = typeIdOf(bundles, "b/src/main/java/demo/Shared.java");
  assert.deepEqual(resolver.resolveTypeText("demo.Shared", at("b", "main")).resolution, { state: "RESOLVED_REPO", typeId: b, strategy: "QUALIFIED" });
  assert.deepEqual(resolver.resolveTypeText("demo.Shared", at("a", "test")).resolution, { state: "RESOLVED_REPO", typeId: a, strategy: "QUALIFIED" }, "test sees its own module's main");
  // module e has no copy: a/main and b/main are equally possible (inter-module
  // dependencies unknown) -> AMBIGUOUS; d's test copy is not a candidate.
  const fromE = resolver.resolveTypeText("demo.Shared", at("e", "main")).resolution;
  assert.equal(fromE.state, "AMBIGUOUS");
  assert.deepEqual(fromE.state === "AMBIGUOUS" ? fromE.candidates : [], [a, b].sort());
});

test("R05: deleting one duplicate leaves the remaining declaration resolvable", async () => {
  const bundles = (await extractScoped(R05_SOURCES)).filter(b => b.file.relativePath !== "a/src/main/java/demo/Shared.java");
  const resolver = new JavaNameResolver(scopedRegistry(bundles));
  const b = typeIdOf(bundles, "b/src/main/java/demo/Shared.java");
  assert.deepEqual(resolver.resolveTypeText("demo.Shared", at("e", "main")).resolution, { state: "RESOLVED_REPO", typeId: b, strategy: "QUALIFIED" });
});

test("R05: main/test of one module - test prefers its own copy, main never sees test sources", async () => {
  const bundles = await extractScoped(R05_SOURCES);
  const resolver = new JavaNameResolver(scopedRegistry(bundles));
  const onlyMain = typeIdOf(bundles, "c/src/main/java/demo/Only.java");
  const onlyTest = typeIdOf(bundles, "c/src/test/java/demo/Only.java");
  const inPackage = (sourceSet: "main" | "test") => ({ ...at("c", sourceSet), packageName: "demo" });
  assert.deepEqual(resolver.resolveTypeText("Only", inPackage("test")).resolution, { state: "RESOLVED_REPO", typeId: onlyTest, strategy: "SAME_PACKAGE" });
  assert.deepEqual(resolver.resolveTypeText("Only", inPackage("main")).resolution, { state: "RESOLVED_REPO", typeId: onlyMain, strategy: "SAME_PACKAGE" });
  // a test-only type is not a repo candidate for main code, not even through
  // the repo-unique simple-name fallback
  assert.equal(resolver.resolveTypeText("TestOnly", { ...at("c", "main"), packageName: "other" }).resolution.state, "UNRESOLVED");
  assert.equal(resolver.resolveTypeText("TestOnly", { ...at("c", "test"), packageName: "other" }).resolution.state, "RESOLVED_REPO");
});

test("R05: nested types, same-signature methods and edges bind inside the referring module", async () => {
  const bundles = await extractScoped(R05_SOURCES);
  const registry = scopedRegistry(bundles);
  const resolver = new JavaNameResolver(registry);
  const useB = bundles.find(b => b.file.relativePath === "b/src/main/java/demo/UseB.java")!;
  const resolved = resolveFileRefs(useB, resolver, registry);
  const bShared = typeIdOf(bundles, "b/src/main/java/demo/Shared.java");
  const bInner = typeIdOf(bundles, "b/src/main/java/demo/Shared.java", "Inner");
  const fieldType = (name: string) => resolved.fields.find(f => f.name === name)!.type.resolution;
  assert.deepEqual(fieldType("shared"), { state: "RESOLVED_REPO", typeId: bShared, strategy: "SAME_PACKAGE" });
  const inner = fieldType("inner");
  assert.equal(inner.state === "RESOLVED_REPO" ? inner.typeId : inner.state, bInner);
  const edges = buildStaticEdges(resolved, registry, resolver);
  const bTrack = bundles.find(b => b.file.relativePath === "b/src/main/java/demo/Shared.java")!.methods.find(m => m.name === "track")!.methodId;
  const aTrack = bundles.find(b => b.file.relativePath === "a/src/main/java/demo/Shared.java")!.methods.find(m => m.name === "track")!.methodId;
  assert.notEqual(aTrack, bTrack, "same signature in two modules keeps two method ids");
  const calls = edges.filter(edge => edge.kind === "CALLS").map(edge => edge.toId);
  assert.deepEqual(calls, [bTrack]);
  assert.ok(!edges.some(edge => edge.toId === aTrack || edge.toId.includes("a%2Fsrc")), "no edge leaks into module a");
});

test("R05: SQL store resolution matches the in-memory registry (cold-build path)", async () => {
  const bundles = await extractScoped(R05_SOURCES);
  const memory = scopedRegistry(bundles);
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    for (const bundle of bundles) writeBundle(db, { ...bundle, edges: [] });
    const store = new SqlFactsStore(db);
    const sqlView = buildSqlRegistryView(store);
    const memoryResolver = new JavaNameResolver(memory);
    const sqlResolver = new JavaNameResolver(sqlView);
    const unknown: JavaResolutionContext = { packageName: "client", imports: [], enclosingTypeIds: [], typeParameterNames: new Set<string>() };
    for (const context of [unknown, at("a", "main"), at("b", "main"), at("a", "test"), at("e", "main"), { ...at("c", "test"), packageName: "demo" }]) {
      for (const text of ["demo.Shared", "demo.Only", "demo.TestOnly", "Only", "TestOnly"]) {
        assert.deepEqual(sqlResolver.resolveTypeText(text, context).resolution, memoryResolver.resolveTypeText(text, context).resolution, `${text} @ ${JSON.stringify(context.location)}`);
      }
    }
    assert.deepEqual([...(store.typeIdsByFqn.get("demo.Shared") ?? [])], [...(memory.byFqn.get("demo.Shared") ?? [])]);
    // typeLookup (the queryTypes path) scopes by the referring file
    const lookup = store.typeLookup("demo.Shared", "b/src/main/java/demo/UseB.java");
    assert.equal(lookup.state, "RESOLVED");
    assert.equal(lookup.state === "RESOLVED" ? lookup.type.typeId : "", typeIdOf(bundles, "b/src/main/java/demo/Shared.java"));
    assert.equal(store.typeLookup("demo.Shared").state, "AMBIGUOUS");
    // the edge builder over the SQL view binds the call in module b
    const useB = bundles.find(b => b.file.relativePath === "b/src/main/java/demo/UseB.java")!;
    const resolved = resolveFileRefs(useB, sqlResolver, sqlView);
    const edges = buildStaticEdges(resolved, sqlView, sqlResolver);
    const bTrack = bundles.find(b => b.file.relativePath === "b/src/main/java/demo/Shared.java")!.methods.find(m => m.name === "track")!.methodId;
    assert.deepEqual(edges.filter(edge => edge.kind === "CALLS").map(edge => edge.toId), [bTrack]);
  } finally {
    close(db);
  }
});

test("R05: selectVisibleDeclaration tiers and unknown locations", () => {
  const where: Record<string, DeclarationLocation | undefined> = {
    aMain: { module: "a", sourceSet: "main" },
    aTest: { module: "a", sourceSet: "test" },
    bMain: { module: "b", sourceSet: "main" },
    bTest: { module: "b", sourceSet: "test" },
    gen: { module: "a", sourceSet: "generated" },
    lost: undefined
  };
  const pick = (ids: string[], from?: DeclarationLocation) => selectVisibleDeclaration(ids, from, id => where[id]);
  assert.deepEqual(pick(["aMain", "bMain"], { module: "a", sourceSet: "main" }), { kind: "unique", typeId: "aMain" });
  assert.deepEqual(pick(["aMain", "aTest"], { module: "a", sourceSet: "test" }), { kind: "unique", typeId: "aTest" });
  assert.deepEqual(pick(["aTest"], { module: "a", sourceSet: "main" }), { kind: "none" });
  assert.deepEqual(pick(["bTest"], { module: "a", sourceSet: "test" }), { kind: "none" });
  assert.deepEqual(pick(["bMain", "lost"], { module: "a", sourceSet: "main" }), { kind: "ambiguous", typeIds: ["bMain", "lost"] });
  assert.deepEqual(pick(["aMain", "gen"], { module: "a", sourceSet: "main" }), { kind: "unique", typeId: "aMain" }, "a known own-scope copy outranks an unknown one");
  assert.deepEqual(pick(["aMain", "bMain"]), { kind: "ambiguous", typeIds: ["aMain", "bMain"] });
  assert.deepEqual(pick(["bMain"]), { kind: "unique", typeId: "bMain" });
  assert.deepEqual(pick([]), { kind: "none" });
});
