// input: Lightweight Java source facts and ranked candidates.
// output: Unit coverage for cold-path ranking structural signals and truncation.
// pos: Tests pure ranking helpers used by agent-router finalize scoring.
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ScoreBreakdownItem } from "./agent-types.js";
import {
  annotationCollaborationDelta,
  hasProtectedStructuralSignal,
  kindPairingDelta,
  packageProximityDelta,
  symmetricTypeRelationDelta,
  truncateCandidateTail
} from "./agent-router/ranking-signals.js";
import type { JavaSourceFacts } from "./source-index.js";

function facts(partial: Partial<JavaSourceFacts>): JavaSourceFacts {
  return {
    absolutePath: "/x.java",
    implementsTypes: [],
    annotations: [],
    methods: [],
    factSource: "regex",
    ...partial
  };
}

function cand(absolutePath: string, score: number, breakdown: ScoreBreakdownItem[]): CandidateFile {
  return {
    absolutePath,
    score,
    matchCount: 0,
    positions: [],
    categories: [],
    reasons: [],
    scoreBreakdown: breakdown
  };
}

function strong(absolutePath: string, score: number): CandidateFile {
  return cand(absolutePath, score, [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "x" }]);
}

function noise(absolutePath: string, score: number): CandidateFile {
  return cand(absolutePath, score, [{ id: "finalize.match-count", source: "finalize", delta: 10, reason: "x" }]);
}

test("annotationCollaborationDelta rewards known stereotype collaboration (symmetric)", () => {
  assert.equal(annotationCollaborationDelta(["@Service"], ["@Repository"]), 50);
  assert.equal(annotationCollaborationDelta(["@RestController"], ["@Service"]), 50);
  assert.equal(annotationCollaborationDelta(["@Repository"], ["@Service"]), 50);
});

test("annotationCollaborationDelta ignores non-collaborating or missing stereotypes", () => {
  assert.equal(annotationCollaborationDelta(["@Repository"], ["@Controller"]), 0);
  assert.equal(annotationCollaborationDelta(["@Service"], ["@Override", "@GetMapping"]), 0);
  assert.equal(annotationCollaborationDelta(["@org.springframework.stereotype.Service"], ["@Repository"]), 50);
});

test("packageProximityDelta grades by shared package prefix depth", () => {
  assert.equal(packageProximityDelta("a.b.c.d.e", "a.b.c.d.e"), 30);
  assert.equal(packageProximityDelta("a.b.c.d.e", "a.b.c.d.f"), 18);
  assert.equal(packageProximityDelta("a.b.x", "a.b.y"), 0);
  assert.equal(packageProximityDelta("a.b.c.d.e.f.g", "a.b.c.d.x.y.z"), 8);
  assert.equal(packageProximityDelta("a.b.c", "x.y.z"), 0);
  assert.equal(packageProximityDelta(undefined, "a.b"), 0);
});

test("symmetricTypeRelationDelta rewards when anchor is a subtype of the candidate", () => {
  const anchor = facts({ typeName: "OrderServiceImpl", implementsTypes: ["OrderService"] });
  const candidate = facts({ typeName: "OrderService", kind: "interface" });
  assert.equal(symmetricTypeRelationDelta(anchor, candidate), 95);
  assert.equal(symmetricTypeRelationDelta(candidate, anchor), 0);
});

test("kindPairingDelta rewards interface x impl only under port profile", () => {
  const port = facts({ typeName: "StorageGateway", kind: "interface" });
  const impl = facts({ typeName: "OssStorageGateway", kind: "class", implementsTypes: ["StorageGateway"] });
  assert.equal(kindPairingDelta(port, impl, "port"), 20);
  assert.equal(kindPairingDelta(port, impl, "service"), 0);
  const unrelated = facts({ typeName: "Foo", kind: "class", implementsTypes: ["Bar"] });
  assert.equal(kindPairingDelta(port, unrelated, "port"), 0);
});

test("hasProtectedStructuralSignal reads positive protected deltas from scoreBreakdown", () => {
  assert.equal(hasProtectedStructuralSignal(strong("/a.java", 100)), true);
  assert.equal(hasProtectedStructuralSignal(noise("/b.java", 100)), false);
  const zero = cand("/c.java", 1, [{ id: "finalize.structural.package", source: "finalize", delta: 0, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(zero), false);
  const weakPackage = cand("/d.java", 10, [{ id: "finalize.structural.package", source: "finalize", delta: 8, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakPackage), false);
  const weakFocus = cand("/e.java", 10, [{ id: "finalize.focus-module", source: "finalize", delta: 35, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakFocus), false);
  const weakAnnotation = cand("/f.java", 10, [{ id: "finalize.structural.annotation", source: "finalize", delta: 50, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakAnnotation), false);
});

test("truncateCandidateTail returns input unchanged when 10 or fewer candidates", () => {
  const ranked = Array.from({ length: 9 }, (_, i) => noise(`/n/N${i}.java`, 50 - i));
  assert.equal(truncateCandidateTail(ranked, new Set()).length, 9);
});

test("truncateCandidateTail keeps protected/structural, trims pure-string tail, honors floor", () => {
  const struct = Array.from({ length: 8 }, (_, i) => strong(`/a/S${i}.java`, 200 - i));
  const tail = Array.from({ length: 12 }, (_, i) => noise(`/n/N${i}.java`, 50 - i));
  const ranked = [...struct, ...tail];
  const readPlanCovered = new Set<CandidateFile>([struct[0], tail[0]]);
  const result = truncateCandidateTail(ranked, readPlanCovered);
  assert.ok(struct.every(file => result.includes(file)));
  assert.equal(result.length, 13);
  assert.ok(result.length < ranked.length);
});

test("truncateCandidateTail cuts at a score cliff inside the discardable tail", () => {
  const struct = Array.from({ length: 8 }, (_, i) => strong(`/s/S${i}.java`, 300 - i));
  const tail = [noise("/n/A.java", 100), noise("/n/B.java", 95), noise("/n/C.java", 20)];
  const ranked = [...struct, ...tail];
  const result = truncateCandidateTail(ranked, new Set<CandidateFile>());
  assert.ok(result.some(file => file.absolutePath === "/n/A.java"));
  assert.ok(result.some(file => file.absolutePath === "/n/B.java"));
  assert.ok(!result.some(file => file.absolutePath === "/n/C.java"));
});

test("truncateCandidateTail skips tail trimming when structural evidence is too thin", () => {
  const struct = Array.from({ length: 3 }, (_, i) => strong(`/s/S${i}.java`, 300 - i));
  const tail = Array.from({ length: 9 }, (_, i) => noise(`/n/N${i}.java`, 100 - i));
  const ranked = [...struct, ...tail];
  const result = truncateCandidateTail(ranked, new Set<CandidateFile>(), 20);
  assert.equal(result.length, 12);
});

test("truncateCandidateTail applies limit to focus-only candidates", () => {
  const focusOnly = Array.from({ length: 12 }, (_, i) =>
    cand(`/f/F${i}.java`, 120 - i, [{ id: "finalize.focus-module", source: "finalize", delta: 35, reason: "x" }])
  );
  const readPlanCovered = new Set<CandidateFile>([focusOnly[0]]);
  const result = truncateCandidateTail(focusOnly, readPlanCovered, 5);
  assert.equal(result.length, 5);
  assert.ok(result.includes(focusOnly[0]));
});
