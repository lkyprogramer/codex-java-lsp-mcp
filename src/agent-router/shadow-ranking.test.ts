import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { EvidenceSignal, ProviderOutcome } from "./evidence.js";
import { genericFamilyRankPolicy } from "./family-ranker.js";
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
    outcomes: [],
    ranked: [],
    productionSelectedPaths: new Set<string>(),
    familyRankPolicy: genericFamilyRankPolicy,
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
    productionSelectedPaths: new Set([candidateA.absolutePath]),
    options: { ...baseInput().options, readPlanMaxItems: 2 }
  }));

  assert.equal(result.categoryFidelity, "preserved");
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
  assert.deepEqual(a.providers, ["test-static"], "providers reflects the real providerId of each candidate's evidence signals");
  assert.deepEqual(b.providers, ["test-lexical"]);

  // B is sourceSet=test with testReadMode=defer, so selectReadPlanFiles's
  // priority tier (P1 main vs P2 deferred-test) always keeps A ahead of B
  // regardless of family score - ablation can move B to rank 1 without ever
  // giving it A's read-plan slot. The dedicated cross-family-flip test below
  // covers the case where ablation *does* change the read-plan outcome.
  assert.equal(a.selectedByReadPlanWithoutEachFamily, undefined, "range-aware read-plan ablation is explicitly unmeasured");
  assert.equal(b.selectedByReadPlanWithoutEachFamily, undefined, "range-aware read-plan ablation is explicitly unmeasured");
  assert.deepEqual(result.productionCandidatesWithoutEvidence, [], "A and B both have evidence, so nothing should be reported missing");
});

test("ablating a candidate's sole family can flip which of two same-tier candidates wins the shared read-plan slot", async () => {
  const candidateC = candidate(`${repoRoot}/src/main/java/demo/Charlie.java`);
  const candidateD = candidate(`${repoRoot}/src/main/java/demo/Delta.java`);
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateC.absolutePath, family: "STATIC_STRUCTURE", weight: 100, providerId: "p-static" })]),
    outcome([signal({ candidateFile: candidateD.absolutePath, family: "FRAMEWORK", weight: 30, providerId: "p-framework" })])
  ];

  const result = await buildShadowRanking(baseInput({
    outcomes,
    ranked: [candidateC, candidateD],
    productionSelectedPaths: new Set([candidateC.absolutePath]),
    options: { ...baseInput().options, readPlanMaxItems: 2 }
  }));

  const byPath = new Map(result.candidates.map(item => [item.path, item]));
  const c = byPath.get(candidateC.absolutePath)!;
  const d = byPath.get(candidateD.absolutePath)!;

  assert.equal(c.selectedByReadPlan, true, "C's stronger STATIC_STRUCTURE evidence wins the one shared slot under the 2-item budget (anchor + 1)");
  assert.equal(d.selectedByReadPlan, false);

  assert.equal(c.selectedByReadPlanWithoutEachFamily, undefined, "rank ablation remains available but range-aware read-plan ablation is unmeasured");
  assert.equal(d.selectedByReadPlanWithoutEachFamily, undefined);
});

test("base read-plan attribution follows production buildReadPlan selectedPaths instead of the shadow selector", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/Alpha.java`);
  const candidateB = candidate(`${repoRoot}/src/main/java/demo/Beta.java`);
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "STATIC_STRUCTURE", weight: 100 })]),
    outcome([signal({ candidateFile: candidateB.absolutePath, family: "LEXICAL", weight: 20 })])
  ];
  const input = {
    ...baseInput({
      outcomes,
      ranked: [candidateA, candidateB],
      options: { ...baseInput().options, readPlanMaxItems: 2 }
    }),
    // The token/range-aware production planner selected B. The old in-memory
    // selector would choose higher-ranked A, which is exactly the attribution
    // mismatch this regression test must catch.
    productionSelectedPaths: new Set([anchor().absolutePath, candidateB.absolutePath])
  } as BuildShadowRankingInput;

  const result = await buildShadowRanking(input);
  const byPath = new Map(result.candidates.map(item => [item.path, item]));

  assert.equal(byPath.get(candidateA.absolutePath)?.selectedByReadPlan, false);
  assert.equal(byPath.get(candidateB.absolutePath)?.selectedByReadPlan, true);
  assert.equal(
    byPath.get(candidateB.absolutePath)?.selectedByReadPlanWithoutEachFamily,
    undefined,
    "without a real range-aware replay, read-plan ablations must stay unmeasured"
  );
});

test("shadow attribution accepts the production selection without a JavaIndex dependency", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, { verifiedBy: ["rg"] });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "LEXICAL", kind: "NAME_MATCH", weight: 40, confidence: 0.6 })])
  ];
  const defaults = baseInput();
  const input = baseInput({
    outcomes,
    ranked: [candidateA],
    productionSelectedPaths: new Set([candidateA.absolutePath]),
    options: { ...defaults.options, readPlanMaxItems: 2 }
  });

  const result = await buildShadowRanking(input);

  assert.equal(result.candidates[0]?.selectedByReadPlan, true);
});

test("required-policy requests reuse production selection and leave read-plan ablation unmeasured", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, { verifiedBy: ["typeGraph"] });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "STATIC_STRUCTURE", weight: 100 })])
  ];
  const defaults = baseInput();

  const result = await buildShadowRanking({
    ...baseInput({
      outcomes,
      ranked: [candidateA],
      options: { ...defaults.options, semanticPolicy: "required" }
    }),
    productionSelectedPaths: new Set([candidateA.absolutePath])
  } as BuildShadowRankingInput);

  const a = result.candidates.find(item => item.path === candidateA.absolutePath)!;
  assert.equal(a.selectedByReadPlan, true);
  assert.equal(a.selectedByReadPlanWithoutEachFamily, undefined, "required-policy ablation is skipped entirely, not computed with an empty per-family map");
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

test("production relationship evidence folds into the same shadow ranking without duplicating other providers' identities", async () => {
  const candidateA = candidate(`${repoRoot}/src/main/java/demo/AlphaWidget.java`, { verifiedBy: ["typeGraph"] });
  const outcomes: ProviderOutcome[] = [
    outcome([signal({ candidateFile: candidateA.absolutePath, family: "LEXICAL", kind: "NAME_MATCH", weight: 40, confidence: 0.6, providerId: "test-lexical" })])
  ];

  const result = await buildShadowRanking(baseInput({ outcomes, ranked: [candidateA] }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.path, candidateA.absolutePath);
});
