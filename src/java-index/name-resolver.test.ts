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
  type JavaResolutionContext,
  type TypeRegistryView
} from "./name-resolver.js";

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
