import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
import type { ProviderInput } from "../evidence.js";
import type { JavaSourceFacts } from "../../java-index/router-facts.js";
import { collectStaticEvidence } from "./static-provider.js";

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

function anchor(id: string, className: string, profile: ResolvedAnchor["profile"] = "service"): ResolvedAnchor {
  const absolutePath = `/repo/src/main/java/demo/${className}.java`;
  return {
    id,
    absolutePath,
    path: absolutePath.slice("/repo/".length),
    sourceSet: "main",
    line: 1,
    column: 1,
    profile,
    symbolName: className,
    className,
    kind: "interface"
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

function providerInput(anchors: ResolvedAnchor[], javaIndex: Record<string, unknown>): ProviderInput {
  return {
    repoRoot: "/repo",
    anchors,
    options,
    javaIndex,
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    metrics: {
      importGraph: { scannedAnchors: 0, addedCandidates: 0, skippedExisting: 0, elapsedMs: 0 },
      typeReference: {
        scannedPatterns: 0,
        addedCandidates: 0,
        skippedExisting: 0,
        elapsedMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheMissElapsedMs: 0,
        indexHits: 0,
        indexMisses: 0
      }
    }
  } as unknown as ProviderInput;
}

function emptyRouterStatus(): Record<string, number> {
  return { entries: 0, hits: 0, misses: 0, typeLookupIndexHits: 0, typeLookupIndexMisses: 0 };
}

test("static provider keeps each implementation evidence tied to its own anchor", async () => {
  const first = anchor("A1", "FirstPort");
  const second = anchor("A2", "SecondPort");
  const firstImplementation = facts("/repo/src/main/java/demo/FirstPortImpl.java");
  const secondImplementation = facts("/repo/src/main/java/demo/SecondPortImpl.java");
  const result = await collectStaticEvidence(providerInput([first, second], {
    factsFor: async (file: string) => facts(file, { kind: "interface" }),
    findImplementers: async (typeName: string) => typeName === "FirstPort" ? [firstImplementation] : [secondImplementation],
    findTypeDefinitions: async () => [],
    findImporters: async () => [],
    findTypeReferences: async () => [],
    methodAt: async () => undefined,
    routerStatus: async () => emptyRouterStatus()
  }));

  assert.deepEqual(
    result.evidence.map(signal => [signal.candidateFile, signal.anchorId]),
    [
      [firstImplementation.absolutePath, "A1"],
      [secondImplementation.absolutePath, "A2"]
    ]
  );
});

test("static provider classifies direct imported declarations as exact AST evidence", async () => {
  const request = anchor("A1", "Request", "dto");
  const directDeclaration = facts("/repo/src/main/java/demo/DirectCollaborator.java");
  const result = await collectStaticEvidence(providerInput([request], {
    factsFor: async (file: string) => facts(file, { imports: ["demo.DirectCollaborator"] }),
    findImplementers: async () => [],
    findTypeDefinitions: async () => [directDeclaration],
    findImporters: async () => [],
    findTypeReferences: async () => [],
    methodAt: async () => undefined,
    routerStatus: async () => emptyRouterStatus()
  }));

  const evidence = result.evidence.find(signal => signal.candidateFile === directDeclaration.absolutePath);
  assert.equal(evidence?.kind, "DIRECT_DECLARATION");
  assert.equal(evidence?.provenance, "AST_EXACT");
  assert.equal(evidence?.confidence, 0.98);
});
