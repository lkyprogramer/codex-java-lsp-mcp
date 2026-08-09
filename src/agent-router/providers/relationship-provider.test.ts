import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
import type { FrameworkFileFacts } from "../../java-index/framework-index-view.js";
import type { JavaMethodFact, JavaSourceFacts } from "../../java-index/router-facts.js";
import type { ProviderInput } from "../evidence.js";
import { collectRelationshipEvidence, type RelationshipProviderInput } from "./relationship-provider.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "auto",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

function anchor(overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  const absolutePath = "/repo/src/main/java/demo/OrderService.java";
  return {
    id: "A1",
    absolutePath,
    path: "src/main/java/demo/OrderService.java",
    module: "demo",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "OrderService",
    className: "OrderService",
    kind: "class",
    ...overrides
  };
}

function facts(absolutePath: string, overrides: Partial<JavaSourceFacts> = {}): JavaSourceFacts {
  return {
    absolutePath,
    path: absolutePath.slice("/repo/".length),
    sourceSet: "main",
    packageName: "demo",
    typeName: absolutePath.split("/").at(-1)!.replace(/\.java$/, ""),
    kind: "class",
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods: [],
    factSource: "javaIndex",
    ...overrides
  };
}

function candidate(absolutePath: string, overrides: Partial<CandidateFile> = {}): CandidateFile {
  return {
    absolutePath,
    path: absolutePath.slice("/repo/".length),
    module: "demo",
    score: 60,
    matchCount: 0,
    positions: [{ line: 1, column: 1 }],
    categories: ["semantic"],
    reasons: ["typeReference"],
    confidence: "medium",
    verifiedBy: ["typeReference"],
    ...overrides
  };
}

function providerInput(
  anchors: ResolvedAnchor[],
  allCandidates: CandidateFile[],
  staticVerifiedCandidates: CandidateFile[],
  javaIndex: Record<string, unknown>
): RelationshipProviderInput {
  return {
    repoRoot: "/repo",
    anchors,
    options,
    javaIndex,
    frameworkIndex: javaIndex,
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: allCandidates.map(item => item.absolutePath),
    generation: 0,
    allCandidates,
    staticVerifiedCandidates
  } as unknown as RelationshipProviderInput;
}

function noopJavaIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    factsFor: async () => undefined,
    methodAt: async (): Promise<JavaMethodFact | undefined> => undefined,
    ...overrides
  };
}

function frameworkFacts(overrides: Partial<FrameworkFileFacts> = {}): FrameworkFileFacts {
  return {
    relativePath: "src/main/java/demo/OrderService.java",
    module: "demo",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    types: [],
    methods: [],
    fields: [],
    missingIds: [],
    truncated: false,
    coverage: "COMPLETE",
    ...overrides
  };
}

test("filename similarity alone never creates relationship evidence", () => {
  return (async () => {
    const service = anchor();
    const controller = candidate("/repo/src/main/java/demo/OrderController.java", { verifiedBy: ["rg"] });
    const result = await collectRelationshipEvidence(providerInput(
      [service],
      [controller],
      [],
      noopJavaIndex()
    ));
    assert.equal(result.evidence.some(item => item.candidateFile === controller.absolutePath), false);
  })();
});

test("an anchor implementing the candidate interface earns a TYPE_SYMMETRIC structural signal", () => {
  return (async () => {
    const implementation = anchor({
      absolutePath: "/repo/src/main/java/demo/OrderServiceImpl.java",
      path: "src/main/java/demo/OrderServiceImpl.java",
      className: "OrderServiceImpl",
      kind: "class"
    });
    const service = candidate("/repo/src/main/java/demo/OrderService.java");
    const result = await collectRelationshipEvidence(providerInput(
      [implementation],
      [],
      [service],
      noopJavaIndex({
        factsFor: async (file: string) => file === implementation.absolutePath
          ? facts(implementation.absolutePath, { typeName: "OrderServiceImpl", implementsTypes: ["demo.OrderService"] })
          : facts(service.absolutePath, { typeName: "OrderService", kind: "interface" })
      })
    ));
    const signal = result.evidence.find(item => item.candidateFile === service.absolutePath && item.kind === "TYPE_SYMMETRIC");
    assert.ok(signal, "expected a TYPE_SYMMETRIC signal for the interface implemented by the anchor");
    assert.equal(signal!.family, "STATIC_STRUCTURE");
    assert.equal(signal!.weight, 95);
  })();
});

test("an unrelated candidate has no relationship evidence", async () => {
  const service = anchor();
  const unrelated = candidate("/repo/src/main/java/demo/Whatever.java", { verifiedBy: ["rg"] });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [unrelated],
    [],
    noopJavaIndex()
  ));
  assert.equal(result.evidence.some(item => item.candidateFile === unrelated.absolutePath), false);
});

test("an AST-resolved CALLS edge from the anchor method protects the target declaration", async () => {
  const service = anchor();
  const target = candidate("/repo/src/main/java/demo/OrderClient.java");
  const anchorMethod: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    methodId: "method:type:demo.OrderService#place()",
    referencedTypes: [],
    relations: []
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [target],
    [target],
    noopJavaIndex({
      methodAt: async () => anchorMethod,
      resolvedCallees: async () => ({
        callees: [{
          sourceId: anchorMethod.methodId!,
          targetId: "method:type:demo.OrderClient#execute()",
          sourceFile: service.path,
          sourceModule: "demo",
          sourceSet: "main",
          kind: "CALLS",
          confidence: 0.98,
          generation: 0
        }],
        truncated: false
      }),
      factsFor: async (file: string) => file === target.absolutePath
        ? facts(file, {
          methods: [{
            name: "execute",
            line: 1,
            endLine: 3,
            methodId: "method:type:demo.OrderClient#execute()",
            referencedTypes: [],
            relations: []
          }]
        })
        : facts(service.absolutePath)
    })
  ));
  const signal = result.evidence.find(item => item.candidateFile === target.absolutePath && item.kind === "CALLS");
  assert.ok(signal);
  assert.equal(signal!.family, "STATIC_STRUCTURE");
  assert.equal(signal!.weight, 120);
  assert.equal(signal!.callDepth, 0);
  assert.equal(signal!.callOrigin, "anchor");
});

test("cold re-evaluation nominates one uniquely resolved wildcard-import receiver target without a pre-existing CALLS edge", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const targetPath = "/repo/src/main/java/demo/ResponseAssembler.java";
  const targetRelativePath = "src/main/java/demo/ResponseAssembler.java";
  const target = facts(targetPath, {
    typeName: "ResponseAssembler",
    qualifiedName: "demo.ResponseAssembler",
    typeId: "type:demo.ResponseAssembler"
  });
  const anchorFrameworkFacts = frameworkFacts({
    methods: [{
      methodId: "method:type:demo.OrderService#check()",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } },
      annotations: [],
      parameters: [],
      callSites: [{
        kind: "METHOD_INVOCATION",
        name: "toResponse",
        arity: 1,
        receiverText: "assembler",
        receiverDeclaredType: {
          text: "ResponseAssembler",
          resolvedFqn: "demo.ResponseAssembler",
          strategy: "WILDCARD_IMPORT",
          typeArguments: [],
          arrayDepth: 0
        },
        argumentTypeHints: [],
        range: { start: { line: 11, column: 5 }, end: { line: 11, column: 30 } }
      }]
    }]
  });
  const targetFrameworkFacts = frameworkFacts({
    relativePath: targetRelativePath,
    types: [{
      typeId: "type:demo.ResponseAssembler",
      fqn: "demo.ResponseAssembler",
      relativePath: targetRelativePath,
      simpleName: "ResponseAssembler",
      kind: "class",
      annotations: [],
      methodIds: ["method:type:demo.ResponseAssembler#toResponse(java.lang.String)"] ,
      fieldIds: [],
      extends: [],
      implements: []
    }],
    methods: [{
      methodId: "method:type:demo.ResponseAssembler#toResponse(java.lang.String)",
      ownerTypeId: "type:demo.ResponseAssembler",
      relativePath: targetRelativePath,
      name: "toResponse",
      constructor: false,
      range: { start: { line: 3, column: 3 }, end: { line: 3, column: 40 } },
      annotations: [],
      parameters: [{
        name: "value",
        type: { text: "String", typeArguments: [], arrayDepth: 0 },
        varargs: false,
        annotations: []
      }],
      callSites: []
    }]
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async () => [target],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async () => [targetFrameworkFacts]
    })
  ));

  assert.deepEqual([...new Set(result.evidence.map(item => item.candidateFile))], [targetPath]);
  assert.ok(result.evidence.some(item => item.candidateFile === targetPath && item.kind === "CALLS"));
});

test("cold direct-call cap retains an exact declared field receiver after earlier value calls", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const repositoryPath = "/repo/src/main/java/demo/OrderRepository.java";
  const repositoryRelativePath = "src/main/java/demo/OrderRepository.java";
  const repository = facts(repositoryPath, {
    typeName: "OrderRepository",
    qualifiedName: "demo.OrderRepository",
    typeId: "type:demo.OrderRepository"
  });
  const valueCalls = Array.from({ length: 12 }, (_, index) => ({
    kind: "METHOD_INVOCATION" as const,
    name: "value",
    arity: 0,
    receiverText: `input${index}`,
    receiverDeclaredType: {
      text: `Input${index}`,
      resolvedFqn: `demo.Input${index}`,
      strategy: "EXPLICIT_IMPORT" as const,
      typeArguments: [],
      arrayDepth: 0
    },
    argumentTypeHints: [],
    range: { start: { line: index + 11, column: 5 }, end: { line: index + 11, column: 20 } }
  }));
  const anchorFrameworkFacts = frameworkFacts({
    fields: [{
      fieldId: "field:type:demo.OrderService#repository",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "repository",
      type: {
        text: "OrderRepository",
        resolvedFqn: "demo.OrderRepository",
        strategy: "WILDCARD_IMPORT",
        typeArguments: [],
        arrayDepth: 0
      },
      annotations: []
    }],
    methods: [{
      methodId: "method:type:demo.OrderService#check()",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 30, column: 3 } },
      annotations: [],
      parameters: [],
      callSites: [...valueCalls, {
        kind: "METHOD_INVOCATION",
        name: "save",
        arity: 0,
        receiverText: "repository",
        receiverDeclaredType: {
          text: "OrderRepository",
          resolvedFqn: "demo.OrderRepository",
          strategy: "WILDCARD_IMPORT",
          typeArguments: [],
          arrayDepth: 0
        },
        argumentTypeHints: [],
        range: { start: { line: 28, column: 5 }, end: { line: 28, column: 22 } }
      }]
    }]
  });
  const repositoryFrameworkFacts = frameworkFacts({
    relativePath: repositoryRelativePath,
    types: [{
      typeId: "type:demo.OrderRepository",
      fqn: "demo.OrderRepository",
      relativePath: repositoryRelativePath,
      simpleName: "OrderRepository",
      kind: "interface",
      annotations: [],
      methodIds: ["method:type:demo.OrderRepository#save()"],
      fieldIds: [],
      extends: [],
      implements: []
    }],
    methods: [{
      methodId: "method:type:demo.OrderRepository#save()",
      ownerTypeId: "type:demo.OrderRepository",
      relativePath: repositoryRelativePath,
      name: "save",
      constructor: false,
      range: { start: { line: 3, column: 3 }, end: { line: 3, column: 20 } },
      annotations: [],
      parameters: [],
      callSites: []
    }]
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async (names: readonly string[]) => names.includes("demo.OrderRepository") ? [repository] : [],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async () => [repositoryFrameworkFacts]
    })
  ));

  assert.ok(result.evidence.some(item => item.candidateFile === repositoryPath && item.kind === "CALLS"),
    "a declared field receiver must not fall behind an arbitrary number of value calls");
});

test("cold re-evaluation refuses an overloaded resolved receiver target", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const targetPath = "/repo/src/main/java/demo/ResponseAssembler.java";
  const targetRelativePath = "src/main/java/demo/ResponseAssembler.java";
  const target = facts(targetPath, {
    typeName: "ResponseAssembler",
    qualifiedName: "demo.ResponseAssembler",
    typeId: "type:demo.ResponseAssembler"
  });
  const anchorFrameworkFacts = frameworkFacts({
    methods: [{
      methodId: "method:type:demo.OrderService#check()",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } },
      annotations: [],
      parameters: [],
      callSites: [{
        kind: "METHOD_INVOCATION",
        name: "toResponse",
        arity: 1,
        receiverDeclaredType: {
          text: "ResponseAssembler",
          resolvedFqn: "demo.ResponseAssembler",
          strategy: "EXPLICIT_IMPORT",
          typeArguments: [],
          arrayDepth: 0
        },
        argumentTypeHints: [],
        range: { start: { line: 11, column: 5 }, end: { line: 11, column: 30 } }
      }]
    }]
  });
  const targetFrameworkFacts = frameworkFacts({
    relativePath: targetRelativePath,
    types: [{
      typeId: "type:demo.ResponseAssembler",
      fqn: "demo.ResponseAssembler",
      relativePath: targetRelativePath,
      simpleName: "ResponseAssembler",
      kind: "class",
      annotations: [],
      methodIds: [],
      fieldIds: [],
      extends: [],
      implements: []
    }],
    methods: ["one", "two"].map(methodId => ({
      methodId,
      ownerTypeId: "type:demo.ResponseAssembler",
      relativePath: targetRelativePath,
      name: "toResponse",
      constructor: false,
      range: { start: { line: 3, column: 3 }, end: { line: 3, column: 40 } },
      annotations: [],
      parameters: [{
        name: "value",
        type: { text: "String", typeArguments: [], arrayDepth: 0 },
        varargs: false,
        annotations: []
      }],
      callSites: []
    }))
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async () => [target],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async () => [targetFrameworkFacts]
    })
  ));

  assert.equal(Object.hasOwn(result, "candidates"), false);
  assert.equal(result.evidence.some(item => item.kind === "CALLS"), false);
});

test("parsed method signatures nominate uniquely resolved wildcard parameters and concrete generic return collaborators without promoting the wrapper", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const requestPath = "/repo/src/main/java/demo/CheckRequest.java";
  const responsePath = "/repo/src/main/java/demo/CheckResponse.java";
  const request = facts(requestPath, { typeName: "CheckRequest", qualifiedName: "demo.CheckRequest" });
  const response = facts(responsePath, { typeName: "CheckResponse", qualifiedName: "demo.CheckResponse" });
  const anchorFrameworkFacts = frameworkFacts({
    methods: [{
      methodId: "method:type:demo.OrderService#check(CheckRequest)",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } },
      annotations: [],
      parameters: [{
        name: "request",
        type: { text: "CheckRequest", resolvedFqn: "demo.CheckRequest", strategy: "WILDCARD_IMPORT", typeArguments: [], arrayDepth: 0 },
        varargs: false,
        annotations: []
      }],
      returnType: {
        text: "Envelope<CheckResponse>",
        resolvedFqn: "demo.Envelope",
        strategy: "EXPLICIT_IMPORT",
        typeArguments: [{ text: "CheckResponse", resolvedFqn: "demo.CheckResponse", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 }],
        arrayDepth: 0
      },
      callSites: []
    }]
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async (typeFqns: string[]) => {
        assert.deepEqual(typeFqns, ["demo.CheckRequest", "demo.CheckResponse"]);
        return [request, response];
      },
      frameworkFactsFor: async () => anchorFrameworkFacts
    })
  ));

  assert.deepEqual([...new Set(result.evidence.map(item => item.candidateFile))].sort(), [requestPath, responsePath]);
  assert.deepEqual(
    result.evidence.filter(item => item.kind === "METHOD_RELATION").map(item => item.candidateFile).sort(),
    [requestPath, responsePath]
  );
});

test("cold re-evaluation rejects a generic wrapper with an unknown argument", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const targetPath = "/repo/src/main/java/demo/Envelope.java";
  const target = facts(targetPath, { typeName: "Envelope", qualifiedName: "demo.Envelope", typeId: "type:demo.Envelope" });
  const anchorFrameworkFacts = frameworkFacts({
    methods: [{
      methodId: "method:type:demo.OrderService#check()",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } },
      annotations: [],
      parameters: [],
      callSites: [{
        kind: "METHOD_INVOCATION",
        name: "success",
        arity: 1,
        receiverDeclaredType: { text: "Envelope", resolvedFqn: "demo.Envelope", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 },
        argumentTypeHints: [{ text: "", typeArguments: [], arrayDepth: 0 }],
        range: { start: { line: 11, column: 5 }, end: { line: 11, column: 30 } }
      }]
    }]
  });
  const targetFrameworkFacts = frameworkFacts({
    relativePath: "src/main/java/demo/Envelope.java",
    types: [{
      typeId: "type:demo.Envelope",
      fqn: "demo.Envelope",
      relativePath: "src/main/java/demo/Envelope.java",
      simpleName: "Envelope",
      kind: "class",
      annotations: [],
      methodIds: ["method:type:demo.Envelope#success(T)"],
      fieldIds: [],
      extends: [],
      implements: []
    }],
    methods: [{
      methodId: "method:type:demo.Envelope#success(T)",
      ownerTypeId: "type:demo.Envelope",
      relativePath: "src/main/java/demo/Envelope.java",
      name: "success",
      constructor: false,
      range: { start: { line: 3, column: 3 }, end: { line: 3, column: 40 } },
      annotations: [],
      parameters: [{ name: "value", type: { text: "T", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }],
      callSites: []
    }]
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async () => [target],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async () => [targetFrameworkFacts]
    })
  ));

  assert.equal(Object.hasOwn(result, "candidates"), false);
  assert.equal(result.evidence.some(item => item.kind === "CALLS"), false);
});

test("cold re-evaluation disambiguates an overloaded outer call from one resolved nested return", async () => {
  const service = anchor({ kind: "method", methodName: "check", line: 10 });
  const assemblerPath = "/repo/src/main/java/demo/ResponseAssembler.java";
  const appPath = "/repo/src/main/java/demo/OrderApplication.java";
  const assembler = facts(assemblerPath, { typeName: "ResponseAssembler", qualifiedName: "demo.ResponseAssembler", typeId: "type:demo.ResponseAssembler" });
  const app = facts(appPath, { typeName: "OrderApplication", qualifiedName: "demo.OrderApplication", typeId: "type:demo.OrderApplication" });
  const anchorFrameworkFacts = frameworkFacts({
    methods: [{
      methodId: "method:type:demo.OrderService#check()",
      ownerTypeId: "type:demo.OrderService",
      relativePath: "src/main/java/demo/OrderService.java",
      name: "check",
      constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } },
      annotations: [],
      parameters: [],
      callSites: [
        {
          kind: "METHOD_INVOCATION", name: "toResponse", arity: 1,
          receiverDeclaredType: { text: "ResponseAssembler", resolvedFqn: "demo.ResponseAssembler", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 },
          argumentTypeHints: [{ text: "", typeArguments: [], arrayDepth: 0 }],
          range: { start: { line: 11, column: 5 }, end: { line: 11, column: 50 } }
        },
        {
          kind: "METHOD_INVOCATION", name: "check", arity: 1,
          receiverDeclaredType: { text: "OrderApplication", resolvedFqn: "demo.OrderApplication", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 },
          argumentTypeHints: [{ text: "CheckCommand", resolvedFqn: "demo.CheckCommand", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 }],
          range: { start: { line: 11, column: 25 }, end: { line: 11, column: 45 } }
        }
      ]
    }]
  });
  const assemblerFrameworkFacts = frameworkFacts({
    relativePath: "src/main/java/demo/ResponseAssembler.java",
    types: [{ typeId: "type:demo.ResponseAssembler", fqn: "demo.ResponseAssembler", relativePath: "src/main/java/demo/ResponseAssembler.java", simpleName: "ResponseAssembler", kind: "class", annotations: [], methodIds: ["first", "second"], fieldIds: [], extends: [], implements: [] }],
    methods: [
      { methodId: "first", ownerTypeId: "type:demo.ResponseAssembler", relativePath: "src/main/java/demo/ResponseAssembler.java", name: "toResponse", constructor: false, range: { start: { line: 3, column: 3 }, end: { line: 3, column: 40 } }, annotations: [], parameters: [{ name: "value", type: { text: "FirstResult", resolvedFqn: "demo.FirstResult", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }], callSites: [] },
      { methodId: "second", ownerTypeId: "type:demo.ResponseAssembler", relativePath: "src/main/java/demo/ResponseAssembler.java", name: "toResponse", constructor: false, range: { start: { line: 4, column: 3 }, end: { line: 4, column: 40 } }, annotations: [], parameters: [{ name: "value", type: { text: "SecondResult", resolvedFqn: "demo.SecondResult", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }], callSites: [] }
    ]
  });
  const appFrameworkFacts = frameworkFacts({
    relativePath: "src/main/java/demo/OrderApplication.java",
    types: [{ typeId: "type:demo.OrderApplication", fqn: "demo.OrderApplication", relativePath: "src/main/java/demo/OrderApplication.java", simpleName: "OrderApplication", kind: "class", annotations: [], methodIds: ["check"], fieldIds: [], extends: [], implements: [] }],
    methods: [{ methodId: "check", ownerTypeId: "type:demo.OrderApplication", relativePath: "src/main/java/demo/OrderApplication.java", name: "check", constructor: false, range: { start: { line: 3, column: 3 }, end: { line: 3, column: 40 } }, annotations: [], parameters: [{ name: "command", type: { text: "CheckCommand", resolvedFqn: "demo.CheckCommand", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }], returnType: { text: "FirstResult", resolvedFqn: "demo.FirstResult", typeArguments: [], arrayDepth: 0 }, callSites: [] }]
  });
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [],
    noopJavaIndex({
      findTypeDefinitions: async () => [assembler, app],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async () => [assemblerFrameworkFacts, appFrameworkFacts]
    })
  ));

  assert.ok(result.evidence.some(item => item.candidateFile === assemblerPath && item.kind === "CALLS" && item.callDepth === 0 && item.callOrigin === "anchor"));
  assert.ok(result.evidence.some(item => item.candidateFile === appPath && item.kind === "CALLS" && item.callDepth === 1 && item.callOrigin === "anchor"));
});

test("an interface anchor follows one exact implementation override to its resolved receiver call", async () => {
  const port = anchor({
    kind: "method",
    methodName: "findByOwner",
    line: 10,
    absolutePath: "/repo/src/main/java/demo/UploadPort.java",
    path: "src/main/java/demo/UploadPort.java",
    className: "UploadPort"
  });
  const implementationPath = "/repo/src/main/java/demo/SqlUploadPort.java";
  const mapperPath = "/repo/src/main/java/demo/UploadMapper.java";
  const implementation = candidate(implementationPath, {
    // Discovery provenance is not used as semantic proof: this candidate
    // deliberately arrives through importGraph and is validated below by its
    // resolved implements clause and exact override signature.
    reasons: ["importGraph"],
    verifiedBy: ["importGraph"]
  });
  const mapper = facts(mapperPath, { typeName: "UploadMapper", qualifiedName: "demo.UploadMapper", typeId: "type:demo.UploadMapper" });
  const anchorFrameworkFacts = frameworkFacts({
    relativePath: port.path!,
    types: [{ typeId: "type:demo.UploadPort", fqn: "demo.UploadPort", relativePath: port.path!, simpleName: "UploadPort", kind: "interface", annotations: [], methodIds: ["portMethod"], fieldIds: [], extends: [], implements: [] }],
    methods: [{
      methodId: "portMethod", ownerTypeId: "type:demo.UploadPort", relativePath: port.path!, name: "findByOwner", constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } }, annotations: [],
      parameters: [
        { name: "ownerId", type: { text: "Long", resolvedFqn: "java.lang.Long", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] },
        { name: "key", type: { text: "String", resolvedFqn: "java.lang.String", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }
      ],
      callSites: []
    }]
  });
  const implementationFrameworkFacts = frameworkFacts({
    relativePath: "src/main/java/demo/SqlUploadPort.java",
    types: [{
      typeId: "type:demo.SqlUploadPort", fqn: "demo.SqlUploadPort", relativePath: "src/main/java/demo/SqlUploadPort.java", simpleName: "SqlUploadPort", kind: "class", annotations: [], methodIds: ["implementationMethod"], fieldIds: [], extends: [],
      implements: [{ text: "UploadPort", resolvedFqn: "demo.UploadPort", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 }]
    }],
    methods: [{
      methodId: "implementationMethod", ownerTypeId: "type:demo.SqlUploadPort", relativePath: "src/main/java/demo/SqlUploadPort.java", name: "findByOwner", constructor: false,
      range: { start: { line: 9, column: 3 }, end: { line: 14, column: 3 } }, annotations: [],
      parameters: [
        { name: "ownerId", type: { text: "Long", resolvedFqn: "java.lang.Long", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] },
        { name: "key", type: { text: "String", resolvedFqn: "java.lang.String", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 }, varargs: false, annotations: [] }
      ],
      callSites: [
        // A real implementation can make many trivial JDK calls before its
        // repository collaborator. The continuation must retain the later
        // exact local call instead of silently capping at twelve AST nodes.
        ...Array.from({ length: 12 }, (_, index) => ({
          kind: "METHOD_INVOCATION" as const,
          name: `noise${index}`,
          arity: 0,
          receiverDeclaredType: { text: "String", resolvedFqn: "java.lang.String", strategy: "JAVA_LANG" as const, typeArguments: [], arrayDepth: 0 },
          argumentTypeHints: [],
          range: { start: { line: 10, column: index }, end: { line: 10, column: index + 1 } }
        })),
        {
        kind: "METHOD_INVOCATION", name: "findByOwner", arity: 2,
        receiverDeclaredType: { text: "UploadMapper", resolvedFqn: "demo.UploadMapper", strategy: "EXPLICIT_IMPORT", typeArguments: [], arrayDepth: 0 },
        argumentTypeHints: [
          { text: "Long", resolvedFqn: "java.lang.Long", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 },
          { text: "String", resolvedFqn: "java.lang.String", strategy: "JAVA_LANG", typeArguments: [], arrayDepth: 0 }
        ],
          range: { start: { line: 11, column: 5 }, end: { line: 11, column: 40 } }
        }
      ]
    }]
  });
  const mapperFrameworkFacts = frameworkFacts({
    relativePath: "src/main/java/demo/UploadMapper.java",
    // The operation is inherited from an external base interface, so this
    // repository declaration intentionally contains no matching method.
    types: [{ typeId: "type:demo.UploadMapper", fqn: "demo.UploadMapper", relativePath: "src/main/java/demo/UploadMapper.java", simpleName: "UploadMapper", kind: "interface", annotations: [], methodIds: [], fieldIds: [], extends: [], implements: [] }],
    methods: []
  });
  const result = await collectRelationshipEvidence(providerInput(
    [port],
    [implementation],
    [implementation],
    noopJavaIndex({
      findTypeDefinitions: async (typeFqns: readonly string[]) => typeFqns.includes("demo.UploadMapper") ? [mapper] : [],
      frameworkFactsFor: async () => anchorFrameworkFacts,
      frameworkFactsForFiles: async (paths: readonly string[]) => paths.includes(implementationPath)
        ? [implementationFrameworkFacts]
        : paths.includes(mapperPath) ? [mapperFrameworkFacts] : []
    })
  ));

  assert.ok(result.evidence.some(item => item.candidateFile === mapperPath && item.kind === "CALLS" && item.callDepth === 1 && item.callOrigin === "implementation"));
});

test("a candidate type in the anchor's own method relations earns a METHOD_RELATION signal", async () => {
  const service = anchor();
  const paramType = candidate("/repo/src/main/java/demo/OrderRequest.java");
  const method: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    referencedTypes: [],
    relations: [{ kind: "parameter", typeName: "OrderRequest", typeId: "type:demo.OrderRequest", line: 1, confidence: "high", source: "ast" }]
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [paramType],
    noopJavaIndex({
      methodAt: async () => method,
      factsFor: async (file: string) => file === paramType.absolutePath
        ? facts(file, { typeId: "type:demo.OrderRequest" })
        : undefined
    })
  ));
  const signal = result.evidence.find(item => item.candidateFile === paramType.absolutePath && item.kind === "METHOD_RELATION");
  assert.ok(signal, "expected a METHOD_RELATION signal for a candidate the anchor's own method references");
  assert.equal(signal!.family, "STATIC_STRUCTURE");
  assert.equal(signal!.weight, 160);
});

test("a local receiver alone is not promoted into Task 30 protected method evidence", async () => {
  const service = anchor();
  const receiverType = candidate("/repo/src/main/java/demo/OrderClient.java");
  const method: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    referencedTypes: [],
    relations: [{ kind: "local-receiver", typeName: "OrderClient", typeId: "type:demo.OrderClient", line: 3, confidence: "medium", source: "ast" }]
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [receiverType],
    noopJavaIndex({
      methodAt: async () => method,
      factsFor: async (file: string) => file === receiverType.absolutePath
        ? facts(file, { typeId: "type:demo.OrderClient" })
        : undefined
    })
  ));
  assert.equal(result.evidence.some(item => item.candidateFile === receiverType.absolutePath && item.kind === "METHOD_RELATION"), false);
});

test("a method relation never binds a same-simple-name candidate from another package", async () => {
  const service = anchor();
  const collision = candidate("/repo/src/main/java/other/OrderRequest.java");
  const method: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    referencedTypes: [],
    relations: [{ kind: "parameter", typeName: "OrderRequest", line: 1, confidence: "high", source: "ast" }]
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [collision],
    noopJavaIndex({
      methodAt: async () => method,
      factsFor: async (file: string) => file === collision.absolutePath
        ? facts(file, { packageName: "other", typeId: "type:other.OrderRequest" })
        : facts(service.absolutePath, { typeId: "type:demo.OrderService" })
    })
  ));

  assert.equal(result.evidence.some(item => item.candidateFile === collision.absolutePath && item.kind === "METHOD_RELATION"), false);
});

test("a candidate implementing the anchor's type earns a TYPE_RELATION signal even when it is not verifiedBy typeGraph", () => {
  return (async () => {
    const port = anchor({ profile: "port", className: "OrderPort", kind: "interface" });
    const impl = candidate("/repo/src/main/java/demo/OrderPortImpl.java");
    const result = await collectRelationshipEvidence(providerInput(
      [port],
      [],
      [impl],
      noopJavaIndex({
        factsFor: async (file: string) => file === port.absolutePath
          ? facts(port.absolutePath, { typeName: "OrderPort", kind: "interface" })
          : facts(impl.absolutePath, { implementsTypes: ["demo.OrderPort"] })
      })
    ));
    const signal = result.evidence.find(item => item.candidateFile === impl.absolutePath && item.kind === "TYPE_RELATION");
    assert.ok(signal, "expected a TYPE_RELATION signal for a candidate implementing the anchor's own type");
    assert.equal(signal!.weight, 95);
  })();
});

test("the facts-based checks do not run for a candidate outside staticVerifiedCandidates", async () => {
  const service = anchor();
  const notVerified = candidate("/repo/src/main/java/demo/OrderRequest.java", { verifiedBy: ["rg"] });
  const method: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    referencedTypes: [],
    relations: [{ kind: "parameter", typeName: "demo.OrderRequest", line: 1, confidence: "high", source: "ast" }]
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [notVerified],
    [], // not in staticVerifiedCandidates
    noopJavaIndex({ methodAt: async () => method })
  ));
  assert.equal(result.evidence.some(item => item.kind === "METHOD_RELATION"), false);
});
