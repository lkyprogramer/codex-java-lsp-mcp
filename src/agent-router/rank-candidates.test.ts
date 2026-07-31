import assert from "node:assert/strict";
import test from "node:test";
import * as candidateRanking from "./rank-candidates.js";
import { familyReadPlanProtectedPaths, foldProviderCandidates, rankCandidates } from "./rank-candidates.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { CandidateEvidence, EvidenceSignal, ProviderOutcome } from "./evidence.js";

function candidate(absolutePath: string, score: number): CandidateFile {
  return {
    absolutePath,
    path: absolutePath.slice(1),
    score,
    matchCount: 0,
    positions: [],
    categories: ["semantic"],
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"],
    scoreBreakdown: []
  };
}

function outcome(overrides: Partial<ProviderOutcome>): ProviderOutcome {
  return {
    providerId: "static",
    providerVersion: "1",
    evidence: [],
    candidates: [],
    completion: "COMPLETE",
    elapsedMs: 0,
    ...overrides
  };
}

test("rank fold ignores a provider fragment without retained evidence", () => {
  const orphan = candidate("/repo/Orphan.java", 55);

  const folded = foldProviderCandidates([], [outcome({ candidates: [orphan] })]);

  assert.equal(
    folded.has(orphan.absolutePath),
    false,
    "a provider cannot nominate a scored candidate after the evidence normalizer rejected or omitted its evidence"
  );
});

test("rank fold applies one provider contribution when its evidence was deduplicated", () => {
  const duplicate = candidate("/repo/Duplicate.java", 55);
  const evidence = {
    signalId: "first",
    candidateFile: duplicate.absolutePath,
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE" as const,
    provenance: "AST_RESOLVED" as const,
    confidence: 0.8,
    completeness: "COMPLETE" as const,
    weight: 55,
    sourceFile: duplicate.absolutePath,
    positions: [],
    providerId: "static",
    providerVersion: "1",
    generation: 0
  };

  const folded = foldProviderCandidates([], [
    outcome({ candidates: [duplicate], evidence: [evidence] }),
    outcome({ candidates: [duplicate], evidence: [{ ...evidence, signalId: "duplicate" }] })
  ]);

  assert.equal(folded.get(duplicate.absolutePath)?.score, 55);
});

// Task 25 cutover: rankCandidates() now scores from family-ranker.ts instead
// of finalizeRank/finalizeScore. The three-repo shadow benchmark that gated
// this cutover never exercised excludeModules/truncateCandidateTail/
// candidateLimit (shadow-ranking.ts's diagnostics list every evidenced
// candidate, untruncated) - these tests cover exactly that gap.

let nextSignalId = 0;

function signal(overrides: Partial<EvidenceSignal>): EvidenceSignal {
  nextSignalId += 1;
  return {
    signalId: `signal-${nextSignalId}`,
    candidateFile: "/repo/module-a/src/main/java/demo/A.java",
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: 0.8,
    completeness: "COMPLETE",
    weight: 1,
    sourceFile: "/repo/module-a/src/main/java/demo/A.java",
    positions: [],
    providerId: "test",
    providerVersion: "1",
    generation: 1,
    ...overrides
  };
}

function evidenceCandidate(
  file: string,
  signals: EvidenceSignal[],
  overrides: Partial<CandidateEvidence> = {}
): CandidateEvidence {
  return { file, signals, familyScores: {}, finalScore: 0, confidence: "low", degradation: [], ...overrides };
}

function anchor(overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: "/repo/module-a/src/main/java/demo/Anchor.java",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Anchor",
    kind: "class",
    module: "module-a",
    ...overrides
  };
}

function options(overrides: Partial<ImpactOptions> = {}): ImpactOptions {
  return {
    anchors: [],
    mode: "minimal",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 200,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  };
}

function emptySuppressed(): Record<string, number> {
  return { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 };
}

test("rankCandidates always returns the anchor, even with zero evidence", async () => {
  const anchorEntry = anchor();
  const ranked = await rankCandidates(new Map(), [], {
    anchors: [anchorEntry],
    options: options(),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.absolutePath, anchorEntry.absolutePath);
});

test("rankCandidates filters excluded modules before scoring and counts them as suppressed", async () => {
  const excludedFile = "/repo/module-b/src/main/java/demo/Excluded.java";
  const keptFile = "/repo/module-a/src/main/java/demo/Kept.java";
  const normalized = new Map<string, CandidateEvidence>([
    [excludedFile, evidenceCandidate(excludedFile, [signal({ candidateFile: excludedFile, weight: 90 })], { module: "module-b" })],
    [keptFile, evidenceCandidate(keptFile, [signal({ candidateFile: keptFile, weight: 90 })], { module: "module-a" })]
  ]);
  const suppressed = emptySuppressed();

  const ranked = await rankCandidates(normalized, [], {
    anchors: [anchor()],
    options: options({ excludeModules: ["module-b"] }),
    suppressed,
    repoRoot: "/repo"
  });

  assert.equal(ranked.some(file => file.absolutePath === excludedFile), false);
  assert.equal(ranked.some(file => file.absolutePath === keptFile), true);
  assert.equal(suppressed.excludedModules, 1);
});

test("rankCandidates mirrors family-ranker's cross-module and deferred-test penalties into suppressed counters", async () => {
  const crossModuleFile = "/repo/module-b/src/main/java/demo/CrossModule.java";
  const deferredTestFile = "/repo/module-a/src/test/java/demo/DeferredTest.java";
  const normalized = new Map<string, CandidateEvidence>([
    [crossModuleFile, evidenceCandidate(crossModuleFile, [signal({ candidateFile: crossModuleFile, weight: 80 })], { module: "module-b" })],
    [deferredTestFile, evidenceCandidate(deferredTestFile, [signal({ candidateFile: deferredTestFile, weight: 80 })], { module: "module-a", sourceSet: "test" })]
  ]);
  const suppressed = emptySuppressed();

  await rankCandidates(normalized, [], {
    anchors: [anchor({ module: "module-a" })],
    options: options({ crossModulePolicy: "auto", testReadMode: "defer" }),
    suppressed,
    repoRoot: "/repo"
  });

  assert.equal(suppressed.crossModuleConsumers, 1);
  assert.equal(suppressed.deferredTests, 1);
});

test("rankCandidates truncates the candidate tail by family-ranker score while protecting structural evidence", async () => {
  const entries: [string, CandidateEvidence][] = [];
  const structuralPaths: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const file = `/repo/module-a/src/main/java/demo/Structural${i}.java`;
    structuralPaths.push(file);
    entries.push([file, evidenceCandidate(file, [
      signal({ candidateFile: file, family: "STATIC_STRUCTURE", kind: "METHOD_RELATION", weight: 120, confidence: 0.9 })
    ], { module: "module-a" })]);
  }
  const lexicalPaths: string[] = [];
  for (let i = 0; i < 15; i += 1) {
    const file = `/repo/module-a/src/main/java/demo/Lexical${i}.java`;
    lexicalPaths.push(file);
    entries.push([file, evidenceCandidate(file, [
      signal({ candidateFile: file, family: "LEXICAL", kind: "LEXICAL:java", weight: 10 + i, confidence: 0.6 })
    ], { module: "module-a" })]);
  }
  const normalized = new Map(entries);
  const anchorEntry = anchor();

  const ranked = await rankCandidates(normalized, [], {
    anchors: [anchorEntry],
    options: options({ mode: "minimal" }),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });

  // candidateLimit("minimal", ...) is 18 regardless of profile (read-plan.ts).
  assert.ok(ranked.length <= 18, `expected candidateLimit to bound the result, got ${ranked.length}`);
  assert.ok(
    ranked.length < 1 + structuralPaths.length + lexicalPaths.length,
    "truncation should have dropped at least one low-value lexical candidate"
  );
  assert.equal(ranked[0]?.absolutePath, anchorEntry.absolutePath, "the anchor's fixed high score must still sort first");
  for (const file of structuralPaths) {
    assert.ok(
      ranked.some(candidate => candidate.absolutePath === file),
      `structural evidence at ${file} must survive tail truncation`
    );
  }
});

test("candidate tail retains bounded main-source representatives from every explicit focus module", async () => {
  const anchorEntry = anchor({
    absolutePath: "/repo/benefits/src/main/java/demo/Anchor.java",
    module: "benefits",
    profile: "dto"
  });
  const entries: [string, CandidateEvidence][] = [];
  for (let index = 0; index < 30; index += 1) {
    const file = `/repo/benefits/src/main/java/demo/Dominant${index}.java`;
    entries.push([file, evidenceCandidate(file, [
      signal({ candidateFile: file, family: "STATIC_STRUCTURE", kind: "REFERENCE", weight: 70, confidence: 0.9 })
    ], { module: "benefits", sourceSet: "main" })]);
  }
  const focusPaths = ["ProductView", "ProductQueryService", "ProductAssembler"].map(name =>
    `/repo/product/src/main/java/demo/${name}.java`
  );
  for (const file of focusPaths) {
    entries.push([file, evidenceCandidate(file, [
      signal({ candidateFile: file, family: "LEXICAL", kind: "LEXICAL:java", weight: 56, confidence: 0.6 }),
      signal({ candidateFile: file, family: "TASK_CONTEXT", kind: "FOCUS_MODULE", weight: 55, confidence: 0.9 })
    ], { module: "product", sourceSet: "main" })]);
  }

  const ranked = await rankCandidates(new Map(entries), [], {
    anchors: [anchorEntry],
    options: options({ mode: "balanced", focusModules: ["benefits", "product"] }),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });

  assert.ok(ranked.length <= 24, "dto balanced candidate limit remains bounded");
  for (const file of focusPaths) {
    assert.ok(
      ranked.some(candidate => candidate.absolutePath === file),
      `explicit focus module representative ${file} must survive tail truncation`
    );
  }
});

test("pre-semantic protection ignores a score that exists only in the retired additive policy", async () => {
  const familyReadPlanProtectedPaths = (candidateRanking as unknown as {
    familyReadPlanProtectedPaths?: (
      normalized: ReadonlyMap<string, CandidateEvidence>,
      outcomes: readonly ProviderOutcome[],
      context: Parameters<typeof rankCandidates>[2]
    ) => Promise<ReadonlySet<string>>;
  }).familyReadPlanProtectedPaths;
  assert.equal(
    typeof familyReadPlanProtectedPaths,
    "function",
    "production must derive pre-semantic protection from family ranking rather than finalizeRank"
  );

  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "ZLegacyBoost"];
  const files = names.map(name => `/repo/module-a/src/main/java/demo/${name}.java`);
  const signals = files.map(file => signal({
    candidateFile: file,
    family: "LEXICAL",
    kind: "LEXICAL:java",
    provenance: "LEXICAL_RG",
    confidence: 0.6,
    weight: 56
  }));
  const normalized = new Map(files.map((file, index) => [file, evidenceCandidate(file, [signals[index]!], {
    module: "module-a",
    sourceSet: "main"
  })]));
  const fragments = files.map((absolutePath, index) => ({
    ...candidate(absolutePath, index === files.length - 1 ? 10_000 : 1),
    categories: ["java"],
    reasons: ["rg:java"],
    verifiedBy: ["rg"]
  }));
  const protectedPaths = await familyReadPlanProtectedPaths!(normalized, [outcome({ evidence: signals, candidates: fragments })], {
    anchors: [anchor()],
    options: options({ mode: "minimal", readPlanMaxItems: 4 }),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });

  assert.equal(
    protectedPaths.has(files.at(-1)!),
    false,
    "the high legacy fragment score must not reserve a read-plan slot when its family evidence ties the other lexical candidates"
  );
});

test("pre-semantic protection admits exact Spring injection but not framework response metadata-like relations", async () => {
  const injectionFile = "/repo/module-a/src/main/java/demo/InjectedService.java";
  const responseFile = "/repo/module-a/src/main/java/demo/OrderResponse.java";
  const injectionSignal = signal({
    candidateFile: injectionFile,
    kind: "SPRING_INJECTION",
    family: "FRAMEWORK",
    provenance: "FRAMEWORK_INFERRED",
    weight: 90,
    confidence: 0.97
  });
  const responseSignal = signal({
    candidateFile: responseFile,
    kind: "SPRING_RESPONSE_TYPE",
    family: "FRAMEWORK",
    provenance: "FRAMEWORK_INFERRED",
    weight: 70,
    confidence: 0.95
  });
  const normalized = new Map<string, CandidateEvidence>([
    [injectionFile, evidenceCandidate(injectionFile, [injectionSignal], { module: "module-a", sourceSet: "main" })],
    [responseFile, evidenceCandidate(responseFile, [responseSignal], { module: "module-a", sourceSet: "main" })]
  ]);
  const fragments = [
    { ...candidate(injectionFile, 1), categories: ["framework"], reasons: ["SPRING_INJECTION"], verifiedBy: ["SPRING_INJECTION"] },
    { ...candidate(responseFile, 1), categories: ["framework"], reasons: ["SPRING_RESPONSE_TYPE"], verifiedBy: ["SPRING_RESPONSE_TYPE"] }
  ];

  const protectedPaths = await familyReadPlanProtectedPaths(normalized, [outcome({ evidence: [injectionSignal, responseSignal], candidates: fragments })], {
    anchors: [anchor()],
    options: options({ mode: "minimal", readPlanMaxItems: 3 }),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });

  assert.equal(protectedPaths.has(injectionFile), true);
  assert.equal(protectedPaths.has(responseFile), false);
});

test("pre-semantic protection admits exact MyBatis namespace/statement matches but not parameter-type relations", async () => {
  const namespaceFile = "/repo/module-a/src/main/java/demo/OrderMapper.java";
  const paramTypeFile = "/repo/module-a/src/main/java/demo/OrderEntity.java";
  const namespaceSignal = signal({
    candidateFile: namespaceFile,
    kind: "MYBATIS_NAMESPACE",
    family: "FRAMEWORK",
    provenance: "FRAMEWORK_INFERRED",
    weight: 100,
    confidence: 0.98
  });
  const paramTypeSignal = signal({
    candidateFile: paramTypeFile,
    kind: "MYBATIS_PARAMETER_TYPE",
    family: "FRAMEWORK",
    provenance: "FRAMEWORK_INFERRED",
    weight: 75,
    confidence: 0.95
  });
  const normalized = new Map<string, CandidateEvidence>([
    [namespaceFile, evidenceCandidate(namespaceFile, [namespaceSignal], { module: "module-a", sourceSet: "main" })],
    [paramTypeFile, evidenceCandidate(paramTypeFile, [paramTypeSignal], { module: "module-a", sourceSet: "main" })]
  ]);
  const fragments = [
    { ...candidate(namespaceFile, 1), categories: ["framework"], reasons: ["MYBATIS_NAMESPACE"], verifiedBy: ["MYBATIS_NAMESPACE"] },
    { ...candidate(paramTypeFile, 1), categories: ["framework"], reasons: ["MYBATIS_PARAMETER_TYPE"], verifiedBy: ["MYBATIS_PARAMETER_TYPE"] }
  ];

  const protectedPaths = await familyReadPlanProtectedPaths(normalized, [outcome({ evidence: [namespaceSignal, paramTypeSignal], candidates: fragments })], {
    anchors: [anchor()],
    options: options({ mode: "minimal", readPlanMaxItems: 3 }),
    suppressed: emptySuppressed(),
    repoRoot: "/repo"
  });

  assert.equal(protectedPaths.has(namespaceFile), true);
  assert.equal(protectedPaths.has(paramTypeFile), false);
});
