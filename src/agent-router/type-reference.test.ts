import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { lishueduPolicy } from "../routing-policy.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import { collectTypeReferenceCandidates, type TypeReferenceMetrics } from "./type-reference.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "controller",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

const anchor: ResolvedAnchor = {
  id: "A1",
  absolutePath: "/repo/src/main/java/demo/ConfirmController.java",
  path: "src/main/java/demo/ConfirmController.java",
  sourceSet: "main",
  line: 12,
  column: 1,
  profile: "controller",
  symbolName: "confirm",
  className: "ConfirmController",
  kind: "class"
};

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

function metrics(): TypeReferenceMetrics {
  return {
    scannedPatterns: 0,
    addedCandidates: 0,
    skippedExisting: 0,
    elapsedMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheMissElapsedMs: 0,
    indexHits: 0,
    indexMisses: 0
  };
}

test("lishuedu controller retains an exact direct return-type declaration", async () => {
  const response = facts("/repo/src/main/java/demo/ConfirmResponse.java");
  const candidates = new Map<string, CandidateFile>();

  await collectTypeReferenceCandidates({
    candidates,
    anchors: [anchor],
    options,
    metrics: metrics(),
    javaIndex: {
      factsFor: async () => facts(anchor.absolutePath, { referencedTypes: ["demo.ConfirmResponse"] }),
      findTypeReferences: async () => [],
      findTypeDefinitions: async () => [response],
      methodAt: async () => undefined,
      findImplementers: async () => []
    } as never,
    routingPolicy: lishueduPolicy,
    generation: 1
  });

  const candidate = candidates.get(response.absolutePath);
  assert.ok(candidate, "an AST-resolved direct return type must remain a candidate under the lishuedu policy");
  assert.ok(candidate.reasons.includes("typeReference"));
});
