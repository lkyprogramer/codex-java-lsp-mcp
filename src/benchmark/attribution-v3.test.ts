import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ShadowRankingCandidate, ShadowRankingDiagnostics } from "../agent-router/shadow-ranking.js";
import { type AttributionV3Context, buildGoldenAttributionV3 } from "./attribution-v3.js";
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
  return { categoryFidelity: "preserved", productionCandidatesWithoutEvidence: [], candidates };
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
