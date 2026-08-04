// input: Family-derived protected paths and the ranked candidate pool before V6 planning.
// output: The bounded compatibility core passed to the token-aware ReadPlan planner.
// pos: Task 30 regression coverage for the final V6 protected-core boundary.
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { genericFamilyRankPolicy } from "./family-ranker.js";
import { readPlanProtectedPaths } from "./index.js";
import type { RankCandidatesContext } from "./rank-candidates.js";

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
  absolutePath: "/repo/src/main/java/demo/ClientUpdateController.java",
  path: "src/main/java/demo/ClientUpdateController.java",
  module: "demo",
  sourceSet: "main",
  line: 1,
  column: 1,
  profile: "controller",
  symbolName: "check",
  className: "ClientUpdateController",
  kind: "class"
};

function candidate(absolutePath: string, overrides: Partial<CandidateFile> = {}): CandidateFile {
  return {
    absolutePath,
    path: absolutePath.slice("/repo/".length),
    module: "demo",
    sourceSet: "main",
    score: 100,
    matchCount: 1,
    positions: [{ line: 1, column: 1 }],
    categories: ["semantic"],
    reasons: ["reference"],
    verifiedBy: ["reference"],
    ...overrides
  };
}

test("generic seed references stay outside the V6 protected core", () => {
  const target = candidate(anchor.absolutePath, {
    score: 1_000,
    reasons: ["target"],
    verifiedBy: ["anchor"]
  });
  const exactReference = candidate("/repo/src/main/java/demo/ClientResponseAssembler.java");
  const lexicalOnly = candidate("/repo/src/main/java/demo/ClientUpdateSearch.java", {
    score: 95,
    categories: ["java"],
    reasons: ["rg:java"],
    verifiedBy: ["rg"]
  });
  const context: RankCandidatesContext = {
    anchors: [anchor],
    options,
    suppressed: { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 },
    repoRoot: "/repo",
    familyRankPolicy: genericFamilyRankPolicy
  };

  const protectedPaths = readPlanProtectedPaths(
    [target, exactReference, lexicalOnly],
    new Set<string>(),
    context
  );

  assert.equal(
    protectedPaths.has(exactReference.absolutePath),
    false,
    "a generic type reference must remain candidate evidence, not consume Task 30's protected core"
  );
  assert.equal(
    protectedPaths.has(lexicalOnly.absolutePath),
    false,
    "lexical-only evidence must not gain a compatibility protected slot"
  );
});
