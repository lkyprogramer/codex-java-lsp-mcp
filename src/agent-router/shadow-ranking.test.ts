import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { EvidenceSignal, ProviderOutcome } from "./evidence.js";
import { buildShadowRanking, type BuildShadowRankingInput } from "./shadow-ranking.js";

const repoRoot = "/repo";

let nextSignalId = 0;

function signal(overrides: Partial<EvidenceSignal>): EvidenceSignal {
  nextSignalId += 1;
  return {
    signalId: `signal-${nextSignalId}`,
    candidateFile: "",
    anchorId: "A1",
    kind: "TEST_KIND",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: 0.9,
    completeness: "COMPLETE",
    weight: 100,
    sourceFile: "",
    positions: [{ line: 1, column: 1 }],
    providerId: "test-provider",
    providerVersion: "1",
    generation: 1,
    ...overrides
  };
}

function outcome(evidence: EvidenceSignal[]): ProviderOutcome {
  return {
    providerId: evidence[0]?.providerId ?? "test-provider",
    providerVersion: "1",
    evidence,
    candidates: [],
    completion: "COMPLETE",
    elapsedMs: 0
  };
}

function anchor(): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: `${repoRoot}/src/main/java/demo/OrderService.java`,
    path: "src/main/java/demo/OrderService.java",
    module: "demo",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "OrderService",
    className: "OrderService",
    kind: "class"
  };
}

function candidate(absolutePath: string, overrides: Partial<CandidateFile> = {}): CandidateFile {
  return {
    absolutePath,
    path: absolutePath.slice(`${repoRoot}/`.length),
    module: "demo",
    score: 60,
    matchCount: 0,
    positions: [{ line: 1, column: 1 }],
    categories: [],
    reasons: ["rg"],
    confidence: "medium",
    verifiedBy: ["rg"],
    ...overrides
  };
}

function noopJavaIndex(): Record<string, unknown> {
  return {
    factsFor: async () => undefined,
    methodAt: async () => undefined
  };
}

function baseInput(overrides: Partial<BuildShadowRankingInput> = {}): BuildShadowRankingInput {
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
  return {
    repoRoot,
    anchors: [anchor()],
    options,
    javaIndex: noopJavaIndex() as never,
    generation: 1,
    outcomes: [],
    ranked: [],
    protectedReadPlanPaths: new Set<string>(),
    relationshipProviderInput: {
      repoRoot,
      anchors: [anchor()],
      options,
      javaIndex: noopJavaIndex(),
      routingPolicy: {} as never,
      existingCandidatePaths: [],
      generation: 1,
      layoutContext: {} as never,
      budget: {} as never,
      phaseMs: {},
      session: {} as never,
      edgeStore: {} as never,
      concurrency: 1,
      loadRgSummary: async () => ({}) as never,
      metrics: {} as never
    } as never,
    ...overrides
  };
}

test("a candidate whose only evidence is in one family ranks below a candidate carrying that family once it is ablated", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, {
    verifiedBy: ["typeGraph"],
    sourceSet: "main"
  });
  const candidateB = candidate(`${repoRoot}/src/test/java/demo/BetaGadgetTest.java`, {
    verifiedBy: ["rg"],
    sourceSet: "test"
  });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "STATIC_STRUCTURE", weight: 100, providerId: "test-static" })]),
    outcome([signal({ candidateFile: candidateB.absolutePath, family: "LEXICAL", kind: "NAME_MATCH", weight: 40, confidence: 0.6, providerId: "test-lexical" })])
  ];

  const result = await buildShadowRanking(baseInput({
    outcomes,
    ranked: [candidateA, candidateB],
    options: { ...baseInput().options, readPlanMaxItems: 2 }
  }));

  assert.equal(result.categoryFidelity, "approximate");
  const byPath = new Map(result.candidates.map(item => [item.path, item]));
  const a = byPath.get(candidateA.absolutePath)!;
  const b = byPath.get(candidateB.absolutePath)!;

  assert.equal(a.rank, 1, "the STATIC_STRUCTURE candidate should outrank the LEXICAL-only candidate");
  assert.equal(b.rank, 2);

  assert.equal(a.rankWithoutEachFamily.STATIC_STRUCTURE, 2, "ablating A's only family must drop it below B");
  assert.equal(b.rankWithoutEachFamily.STATIC_STRUCTURE, 1, "B moves up to rank 1 once A's family is ablated");

  assert.equal(a.rankWithoutEachFamily.LEXICAL, 1, "ablating a family A has no evidence in must not change A's rank");
  assert.equal(a.rankWithoutEachFamily.EXACT_SEMANTIC, 1, "ablating an unrelated, unused family must not change A's rank");

  assert.equal(a.selectedByReadPlan, true, "A is picked by the shadow read-plan under a 2-item budget (anchor + A)");
  assert.equal(b.selectedByReadPlan, false, "B (lower priority, lower rank) is not picked under a 2-item budget");
  assert.deepEqual(result.productionCandidatesWithoutEvidence, [], "A and B both have evidence, so nothing should be reported missing");
});

test("a production candidate the shadow pass never received evidence for (e.g. the anchor itself) is reported, not silently dropped", async () => {
  const anchorFile = anchor();
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, { verifiedBy: ["typeGraph"] });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "STATIC_STRUCTURE", weight: 100, providerId: "test-static" })])
  ];
  // The anchor itself is folded into production's `ranked` (candidateFromAnchor,
  // called separately in index.ts/materialize-candidates.ts) but never carries
  // an EvidenceSignal - this is the one guaranteed, by-design case where a
  // production candidate has no shadow evidence row.
  const anchorAsCandidate = candidate(anchorFile.absolutePath, { reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });

  const result = await buildShadowRanking(baseInput({
    outcomes,
    ranked: [anchorAsCandidate, candidateA]
  }));

  assert.deepEqual(result.productionCandidatesWithoutEvidence, [anchorFile.absolutePath]);
  assert.equal(result.candidates.some(item => item.path === anchorFile.absolutePath), false);
});

test("relationship-provider evidence for the candidate set folds into the same shadow ranking without duplicating other providers' identities", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, { verifiedBy: ["typeGraph"] });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "LEXICAL", kind: "NAME_MATCH", weight: 40, confidence: 0.6, providerId: "test-lexical" })])
  ];

  const result = await buildShadowRanking(baseInput({ outcomes, ranked: [candidateA] }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.path, candidateA.absolutePath);
});
