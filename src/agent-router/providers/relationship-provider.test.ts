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

test("a name-matched direct collaborator earns a DIRECT_COLLABORATOR signal for any already-known candidate", () => {
  return (async () => {
    const service = anchor();
    const controller = candidate("/repo/src/main/java/demo/OrderController.java", { verifiedBy: ["rg"] });
    const result = await collectRelationshipEvidence(providerInput(
      [service],
      [controller],
      [],
      noopJavaIndex()
    ));
    const signal = result.evidence.find(item => item.candidateFile === controller.absolutePath);
    assert.equal(signal?.kind, "DIRECT_COLLABORATOR");
    assert.equal(signal?.family, "FRAMEWORK");
    assert.ok(signal!.weight > 0);
  })();
});

test("an unrelated candidate name earns no DIRECT_COLLABORATOR signal", async () => {
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

test("a candidate type in the anchor's own method relations earns a METHOD_RELATION signal", async () => {
  const service = anchor();
  const paramType = candidate("/repo/src/main/java/demo/OrderRequest.java");
  const method: JavaMethodFact = {
    name: "place",
    line: 1,
    endLine: 5,
    referencedTypes: [],
    relations: [{ kind: "parameter", typeName: "demo.OrderRequest", line: 1, confidence: "high", source: "ast" }]
  };
  const result = await collectRelationshipEvidence(providerInput(
    [service],
    [],
    [paramType],
    noopJavaIndex({ methodAt: async () => method })
  ));
  const signal = result.evidence.find(item => item.candidateFile === paramType.absolutePath && item.kind === "METHOD_RELATION");
  assert.ok(signal, "expected a METHOD_RELATION signal for a candidate the anchor's own method references");
  assert.equal(signal!.family, "STATIC_STRUCTURE");
  assert.equal(signal!.weight, 160);
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
