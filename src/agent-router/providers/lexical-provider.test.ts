import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor, RgPlanSection } from "../../agent-types.js";
import type { ProviderInput } from "../evidence.js";
import { collectLexicalEvidence } from "./lexical-provider.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "service",
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
  absolutePath: "/repo/src/main/java/demo/OrderService.java",
  path: "src/main/java/demo/OrderService.java",
  module: ".",
  sourceSet: "main",
  line: 1,
  column: 1,
  profile: "service",
  symbolName: "OrderService",
  className: "OrderService",
  kind: "class"
};

function providerInput(candidate: CandidateFile): ProviderInput {
  return {
    repoRoot: "/repo",
    anchors: [anchor],
    options,
    layoutContext: {
      layout: "single",
      layoutProfile: "generic-java",
      sourceRoots: [
        { relativePath: "src/main/java", module: ".", sourceSet: "main" },
        { relativePath: "src/test/java", module: ".", sourceSet: "test" }
      ],
      resourceRoots: [],
      broadRoots: ["."]
    },
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    concurrency: 1,
    loadRgSummary: async (section: RgPlanSection) => ({
      rawBytes: 0,
      totalMatches: section.category === "java" ? 1 : 0,
      elapsedMs: 0,
      files: section.category === "java" ? [candidate] : [],
      cacheHit: false,
      completion: "COMPLETE"
    })
  } as unknown as ProviderInput;
}

test("lexical provider emits a category evidence weight instead of the legacy policy-composed candidate score", async () => {
  const candidate: CandidateFile = {
    absolutePath: "/repo/src/main/java/demo/OrderFacade.java",
    path: "src/main/java/demo/OrderFacade.java",
    module: ".",
    sourceSet: "main",
    score: 999,
    matchCount: 1,
    positions: [{ line: 1, column: 1 }],
    categories: ["java"],
    reasons: ["rg:java"],
    confidence: "medium",
    verifiedBy: ["rg"]
  };

  const result = await collectLexicalEvidence(providerInput(candidate));

  assert.deepEqual(
    result.evidence.map(signal => ({ kind: signal.kind, weight: signal.weight })),
    [{ kind: "LEXICAL:java", weight: 56 }]
  );
});
