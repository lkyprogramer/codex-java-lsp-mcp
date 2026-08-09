import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ImpactResult } from "../agent-types.js";
import type { ShadowRankingCandidate, ShadowRankingDiagnostics } from "../agent-router/shadow-ranking.js";
import { type AttributionV3Context, buildGoldenAttributionV3, buildGoldenCounterfactualV3, buildImpactPayloadProjectionV3 } from "./attribution-v3.js";
import type { Scenario } from "./golden-scenario.js";

function shadowCandidate(overrides: Partial<ShadowRankingCandidate>): ShadowRankingCandidate {
  return {
    path: "",
    finalScore: 10,
    rank: 1,
    familyScores: {},
    rankWithoutEachFamily: {},
    selectedByReadPlan: false,
    providers: [],
    ...overrides
  };
}

function diagnostics(candidates: ShadowRankingCandidate[]): ShadowRankingDiagnostics {
  return {
    categoryFidelity: "preserved",
    productionCandidatesWithoutEvidence: [],
    productionSelectedPaths: candidates.filter(candidate => candidate.selectedByReadPlan).map(candidate => candidate.path),
    candidates
  };
}

function baseContext(overrides: Partial<AttributionV3Context> = {}): AttributionV3Context {
  return {
    repoRoot: "/repo",
    mode: "minimal",
    profile: "service",
    semanticUsed: true,
    semanticTimeout: false,
    coverage: [],
    ...overrides
  };
}

function scenario(golden: Scenario["golden"]): Scenario {
  return {
    id: "s1",
    name: "Scenario",
    anchor: { file: "src/main/java/demo/Anchor.java", line: 1, column: 1, profile: "service" },
    golden
  };
}

test("blockedBy distinguishes hit, readplan-budget, and candidate-limit using the real production candidateLimit boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/A.java"), "package demo; class A {}\n");
  await writeFile(path.join(root, "src/main/java/demo/B.java"), "package demo; class B {}\n");
  await writeFile(path.join(root, "src/main/java/demo/C.java"), "package demo; class C {}\n");

  const scenarioV3 = scenario({
    mustHit: ["src/main/java/demo/A.java"],
    taskBlocking: ["src/main/java/demo/B.java"],
    shouldHit: ["src/main/java/demo/C.java"],
    support: []
  });

  const shadow = diagnostics([
    shadowCandidate({ path: path.join(root, "src/main/java/demo/A.java"), rank: 1, selectedByReadPlan: true, familyScores: { LEXICAL: 5 }, providers: ["lexical"] }),
    shadowCandidate({ path: path.join(root, "src/main/java/demo/B.java"), rank: 5, selectedByReadPlan: false, familyScores: { STATIC_STRUCTURE: 3 }, providers: ["static"] }),
    // mode "minimal" -> candidateLimit(...) === 18; rank 40 is beyond it.
    shadowCandidate({ path: path.join(root, "src/main/java/demo/C.java"), rank: 40, selectedByReadPlan: false, familyScores: { LEXICAL: 1 }, providers: ["lexical"] })
  ]);

  const rows = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  const byFile = new Map(rows.map(row => [row.file, row]));

  assert.equal(byFile.get("src/main/java/demo/A.java")?.blockedBy, "hit");
  assert.equal(byFile.get("src/main/java/demo/A.java")?.kind, "must");
  assert.deepEqual(byFile.get("src/main/java/demo/A.java")?.sourceFamilies, ["LEXICAL"]);
  assert.deepEqual(byFile.get("src/main/java/demo/A.java")?.providers, ["lexical"]);

  assert.equal(byFile.get("src/main/java/demo/B.java")?.blockedBy, "readplan-budget");
  assert.equal(byFile.get("src/main/java/demo/B.java")?.kind, "taskBlocking");
  assert.equal(byFile.get("src/main/java/demo/B.java")?.inCandidates, true);
  assert.equal(byFile.get("src/main/java/demo/B.java")?.inReadPlan, false);

  assert.equal(byFile.get("src/main/java/demo/C.java")?.blockedBy, "candidate-limit");
  assert.equal(byFile.get("src/main/java/demo/C.java")?.kind, "should");
});

test("a relative context.repoRoot still matches shadowRanking's absolute candidate paths instead of silently reporting every golden file absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-relative-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/A.java"), "package demo; class A {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/A.java"], taskBlocking: [], shouldHit: [], support: [] });
  const shadow = diagnostics([
    // ShadowRankingCandidate.path is always absolute in production (candidateFile is always
    // set from CandidateFile.absolutePath by every provider) - a relative repoRoot must not
    // be joined against it as if both were the same kind of path.
    shadowCandidate({ path: path.join(root, "src/main/java/demo/A.java"), rank: 1, selectedByReadPlan: true, familyScores: { LEXICAL: 5 } })
  ]);

  const relativeRoot = path.relative(process.cwd(), root);
  const rows = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: relativeRoot }));
  assert.equal(rows[0]!.inCandidates, true, "a relative repoRoot must resolve to the same absolute path shadowRanking already uses, not silently fail every lookup");
  assert.equal(rows[0]!.blockedBy, "hit");
});

test("a family with a zero score is excluded from sourceFamilies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-zero-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/A.java"), "package demo; class A {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/A.java"], taskBlocking: [], shouldHit: [], support: [] });
  const shadow = diagnostics([
    shadowCandidate({
      path: path.join(root, "src/main/java/demo/A.java"),
      rank: 1,
      selectedByReadPlan: true,
      familyScores: { LEXICAL: 5, FRAMEWORK: 0 },
      providers: ["lexical"]
    })
  ]);
  const rows = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  assert.deepEqual(rows[0]!.sourceFamilies, ["LEXICAL"], "a zero-score family entry must not be reported as a real source");
});

test("inReadPlan is projected from production selectedPaths even when shadow selection disagrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-production-plan-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  const file = "src/main/java/demo/A.java";
  const absolutePath = path.join(root, file);
  await writeFile(absolutePath, "package demo; class A {}\n");
  const scenarioV3 = scenario({ mustHit: [file], taskBlocking: [], shouldHit: [], support: [] });
  const shadow = {
    ...diagnostics([
      shadowCandidate({ path: absolutePath, rank: 1, selectedByReadPlan: false, familyScores: { STATIC_STRUCTURE: 5 } })
    ]),
    productionSelectedPaths: [absolutePath]
  } as ShadowRankingDiagnostics;

  const rows = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root }));

  assert.equal(rows[0]!.inReadPlan, true);
  assert.equal(rows[0]!.blockedBy, "hit");
});

test("absentReason: support kind and missing-on-disk both take the low-value fast path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-absent-"));
  const scenarioV3 = scenario({
    mustHit: ["src/main/java/demo/Missing.java"],
    taskBlocking: [],
    shouldHit: [],
    support: ["src/main/java/demo/SideNote.java"]
  });
  const shadow = diagnostics([]);
  const rows = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  const byFile = new Map(rows.map(row => [row.file, row]));
  assert.equal(byFile.get("src/main/java/demo/Missing.java")?.blockedBy, "absent");
  assert.equal(byFile.get("src/main/java/demo/Missing.java")?.absentReason, "golden-stale-or-low-value");
  assert.equal(byFile.get("src/main/java/demo/SideNote.java")?.absentReason, "golden-stale-or-low-value");
});

test("absentReason: semantic-not-used and semantic-timeout come from the real request's semantic completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-semantic-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/Impl.java"), "package demo; class Impl {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/Impl.java"], taskBlocking: [], shouldHit: [], support: [] });
  const shadow = diagnostics([]);

  const notUsed = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root, semanticUsed: false }));
  assert.equal(notUsed[0]!.absentReason, "semantic-not-used");

  const timedOut = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({ repoRoot: root, semanticUsed: true, semanticTimeout: true }));
  assert.equal(timedOut[0]!.absentReason, "semantic-timeout");
});

test("counterfactual readPlanHitLost only records a real selection flip, not a rank-only movement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-counterfactual-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/C.java"), "package demo; class C {}\n");
  await writeFile(path.join(root, "src/main/java/demo/D.java"), "package demo; class D {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/C.java", "src/main/java/demo/D.java"], taskBlocking: [], shouldHit: [], support: [] });

  // Mirrors an empirically observed shadow-ranking.ts result: C wins the
  // shared read-plan slot on STATIC_STRUCTURE; ablating it hands the slot to D.
  const shadow = diagnostics([
    shadowCandidate({
      path: path.join(root, "src/main/java/demo/C.java"),
      rank: 1,
      selectedByReadPlan: true,
      rankWithoutEachFamily: { STATIC_STRUCTURE: 2, FRAMEWORK: 1 },
      selectedByReadPlanWithoutEachFamily: { STATIC_STRUCTURE: false, FRAMEWORK: true }
    }),
    shadowCandidate({
      path: path.join(root, "src/main/java/demo/D.java"),
      rank: 2,
      selectedByReadPlan: false,
      rankWithoutEachFamily: { STATIC_STRUCTURE: 1, FRAMEWORK: 2 },
      selectedByReadPlanWithoutEachFamily: { STATIC_STRUCTURE: true, FRAMEWORK: false }
    })
  ]);

  const counterfactual = buildGoldenCounterfactualV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  assert.deepEqual(counterfactual.withoutStaticStructure.readPlanHitLost, ["src/main/java/demo/C.java"], "C's rank moving is not enough by itself - only losing its actual selection counts as a task-output-changing loss");
  assert.equal(counterfactual.withoutStaticStructure.measured, true);
  assert.deepEqual(counterfactual.withoutFramework.readPlanHitLost, [], "D was never selected primarily, so ablating its own family cannot lose a hit it never had");
});

test("counterfactual candidateHitLost fires when ablation pushes a candidate's rank past the real production candidateLimit boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-limit-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/E.java"), "package demo; class E {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/E.java"], taskBlocking: [], shouldHit: [], support: [] });

  // mode "minimal" -> candidateLimit(...) === 18.
  const shadow = diagnostics([
    shadowCandidate({
      path: path.join(root, "src/main/java/demo/E.java"),
      rank: 18,
      selectedByReadPlan: false,
      rankWithoutEachFamily: { LEXICAL: 19 }
    })
  ]);

  const counterfactual = buildGoldenCounterfactualV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  assert.deepEqual(counterfactual.withoutLexical.candidateHitLost, ["src/main/java/demo/E.java"], "rank 18 is within the limit, rank 19 is not - ablation demotes E out of the usable candidate pool");
});

test("counterfactual reports measured=false instead of a false readPlanHitLost=[] when read-plan ablation was skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-unmeasured-"));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/F.java"), "package demo; class F {}\n");
  const scenarioV3 = scenario({ mustHit: ["src/main/java/demo/F.java"], taskBlocking: [], shouldHit: [], support: [] });

  const shadow = diagnostics([
    shadowCandidate({
      path: path.join(root, "src/main/java/demo/F.java"),
      rank: 1,
      selectedByReadPlan: true,
      selectedByReadPlanWithoutEachFamily: undefined
    })
  ]);

  const counterfactual = buildGoldenCounterfactualV3(scenarioV3, shadow, baseContext({ repoRoot: root }));
  assert.equal(counterfactual.withoutStaticStructure.measured, false, "semanticPolicy=required requests skip ablated read-plan selection entirely");
  assert.deepEqual(counterfactual.withoutStaticStructure.readPlanHitLost, [], "an empty array here must be read as unmeasured, not as a verified zero-gain result");
});

test("absentReason: coverage-partial when the file's source root has not finished indexing, no-static-edge otherwise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "attribution-v3-coverage-"));
  await mkdir(path.join(root, "modules/school/src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "modules/school/src/main/java/demo/Impl.java"), "package demo; class Impl {}\n");
  const scenarioV3 = scenario({ mustHit: ["modules/school/src/main/java/demo/Impl.java"], taskBlocking: [], shouldHit: [], support: [] });
  const shadow = diagnostics([]);

  const partial = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({
    repoRoot: root,
    coverage: [{ root: "modules/school/src/main/java", generation: 0, state: "BUILDING", discoveredFiles: 1, indexedFiles: 0, failedFiles: 0, recoveredFiles: 0, extractorVersion: "1" }]
  }));
  assert.equal(partial[0]!.absentReason, "coverage-partial");

  const complete = buildGoldenAttributionV3(scenarioV3, shadow, baseContext({
    repoRoot: root,
    coverage: [{ root: "modules/school/src/main/java", generation: 0, state: "COMPLETE", discoveredFiles: 1, indexedFiles: 1, failedFiles: 0, recoveredFiles: 0, extractorVersion: "1" }]
  }));
  assert.equal(complete[0]!.absentReason, "no-static-edge");
});

test("payload attribution derives three byte projections from one canonical candidate/read-plan result", () => {
  const canonical = payloadFixture();
  const projection = buildImpactPayloadProjectionV3(canonical);

  assert.equal(projection.canonicalExecutions, 1);
  assert.equal(projection.defaultToolResponse, "standard");
  assert.equal(projection.defaultToolSerializedBytes, projection.projections.standard.serializedBytes);
  assert.equal(projection.defaultToolEstimatedTokens, Math.ceil(projection.defaultToolSerializedBytes / 4));
  assert.equal(projection.diagnosticSerializedBytes, projection.projections.diagnostic.serializedBytes);
  assert.equal(projection.diagnosticEstimatedTokens, Math.ceil(projection.diagnosticSerializedBytes / 4));
  assert.ok(projection.standardToDiagnosticBytesRatio > 0 && projection.standardToDiagnosticBytesRatio < 1);
  assert.equal(new Set(Object.values(projection.projections).map(item => item.candidateReadPlanSha256)).size, 1);
  for (const item of Object.values(projection.projections)) {
    assert.equal(item.serializedBytes, item.costResultBytes);
  }
  assert.equal(projection.projections.standard.fields["files.reasons"]?.occurrences, 0);
  assert.equal(projection.projections.compact.fields["files.scoreBreakdown"]?.omitDeltaBytes, 0);
  assert.equal(projection.projections.diagnostic.fields["files.reasons"]?.occurrences, 1);
  assert.ok((projection.projections.diagnostic.fields["files.reasons"]?.omitDeltaBytes ?? 0) > 0);
  assert.ok(projection.projections.standard.serializedBytes < projection.projections.diagnostic.serializedBytes);
  assert.deepEqual(canonical.files[0]!.reasons, ["CALLS"], "measurement must not mutate the diagnostic canonical result");
});

function payloadFixture(): ImpactResult {
  return {
    version: 6,
    target: {
      file: "src/main/java/demo/Anchor.java",
      symbol: "Anchor#run",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    freshness: { requestGeneration: 1, indexedGeneration: 1, coverage: "COMPLETE", changedDuringRequest: false },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [{
      id: "F1",
      path: "src/main/java/demo/Collaborator.java",
      role: "collaborator",
      confidence: "high",
      evidence: ["calls anchor"],
      locations: [{ line: 2, column: 3 }],
      reasons: ["CALLS"],
      verifiedBy: ["CALLS"],
      scoreBreakdown: [{ id: "family", source: "policy", delta: 10, reason: "test" }]
    }],
    readPlan: [{
      priority: "P0",
      fileId: "F1",
      ranges: [{ startLine: 1, endLine: 10, reason: "method", estimatedBytes: 100 }],
      reason: "method",
      expectedEvidence: ["calls anchor"],
      estimatedBytes: 100
    }],
    evidenceGaps: ["Run Gradle compile/test before claiming behavior."],
    cost: { resultBytes: 0, readBytes: 100, estimatedTokens: 0, suppressedRawBytes: 1000 },
    metrics: {
      routingVersion: 6,
      elapsedMs: 1,
      semantic: { used: false },
      cache: { hits: 1 }
    }
  };
}
