import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
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
