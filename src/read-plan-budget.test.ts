import assert from "node:assert/strict";
import test from "node:test";
import { evidenceClassOf, selectWithEvidenceBudget } from "./agent-router/read-plan-budget.js";
import type { CandidateFile } from "./agent-types.js";

function candidate(overrides: Partial<CandidateFile> & { absolutePath: string }): CandidateFile {
  return {
    path: overrides.absolutePath.replace(/^\//, ""),
    module: "demo",
    layer: "application",
    sourceSet: "main",
    score: 100,
    matchCount: 0,
    positions: [{ line: 1, column: 1 }],
    categories: ["java"],
    reasons: ["rg:java"],
    verifiedBy: ["rg"],
    ...overrides
  };
}

test("evidenceClassOf classifies anchor, verified, structural, naming, and support", () => {
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/a", reasons: ["target"], verifiedBy: ["anchor"] })), "anchor");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/b", reasons: ["reference"], verifiedBy: ["reference"] })), "verified");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/c", reasons: ["persisted-reference"], verifiedBy: ["persisted-reference"] })), "verified");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/d", reasons: ["importGraph"], verifiedBy: ["importGraph"], categories: ["semantic"] })), "structural");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/e" })), "naming");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/f", sourceSet: "test" })), "support");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/g", categories: ["persistence"] })), "support");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/h", sourceSet: "test", verifiedBy: ["reference"] })), "support");
});

test("protected paths always enter the plan regardless of quota", () => {
  const naming = Array.from({ length: 6 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const protectedFile = candidate({ absolutePath: "/protected-structural", verifiedBy: ["typeGraph"], reasons: ["typeGraph"], categories: ["semantic"], score: 10 });
  const sorted = [...naming, protectedFile];
  const selected = selectWithEvidenceBudget(sorted, 4, new Set(["/protected-structural"]));
  assert.ok(selected.some(file => file.absolutePath === "/protected-structural"));
  assert.equal(selected.length, 4);
});

test("anchor is protected even when structural protected paths fill the budget", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const structural = Array.from({ length: 4 }, (_, i) =>
    candidate({ absolutePath: `/structural-${i}`, verifiedBy: ["typeGraph"], reasons: ["typeGraph"], categories: ["semantic"], score: 900 - i })
  );
  const selected = selectWithEvidenceBudget([anchor, ...structural], 2, new Set(structural.map(file => file.absolutePath)));
  assert.deepEqual(
    selected.map(file => file.absolutePath),
    ["/anchor", "/structural-0"]
  );
});

test("structural candidates keep quota slots under naming flood", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const naming = Array.from({ length: 5 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const structural = candidate({ absolutePath: "/structural", verifiedBy: ["typeReference"], reasons: ["typeReference"], categories: ["semantic"], score: 50 });
  const sorted = [anchor, ...naming, structural];
  const selected = selectWithEvidenceBudget(sorted, 4, new Set<string>());
  const paths = selected.map(file => file.absolutePath);
  assert.ok(paths.includes("/anchor"));
  assert.ok(paths.includes("/structural"));
  assert.equal(paths.filter(item => item.startsWith("/naming-")).length, 2);
});

test("unused quota backfills by sorted order", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const naming = Array.from({ length: 6 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const selected = selectWithEvidenceBudget([anchor, ...naming], 6, new Set<string>());
  assert.equal(selected.length, 6);
  assert.deepEqual(
    selected.map(file => file.absolutePath),
    ["/anchor", "/naming-0", "/naming-1", "/naming-2", "/naming-3", "/naming-4"]
  );
});

test("maxItems=1 keeps only the first sorted candidate", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const other = candidate({ absolutePath: "/other" });
  assert.deepEqual(
    selectWithEvidenceBudget([anchor, other], 1, new Set<string>()).map(file => file.absolutePath),
    ["/anchor"]
  );
});
