// input: hand-built ResolvedAnchor/ImpactOptions/semantic-state fixtures - evidenceGaps is pure.
// output: the conditional advisory strings it emits.
import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { evidenceGaps } from "./evidence-gaps.js";

function anchor(overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1", absolutePath: "/repo/Foo.java", line: 1, column: 1, profile: "service", symbolName: "Foo", kind: "class",
    ...overrides
  };
}

const baseOptions = {} as ImpactOptions;
const baseSemantic = { skipped: false, timeout: false };

test("omits the Lombok gap by default", () => {
  const gaps = evidenceGaps([anchor()], baseOptions, baseSemantic);
  assert.ok(!gaps.some(gap => gap.includes("Lombok")));
});

test("adds a Lombok gap only when lombokIncomplete is true", () => {
  const gaps = evidenceGaps([anchor()], baseOptions, { ...baseSemantic, lombokIncomplete: true });
  assert.ok(gaps.some(gap => gap.includes("Lombok") && gap.includes("javaagent")));
});

test("names the static-only fallback when semantic admission refused JDT", () => {
  const gaps = evidenceGaps([anchor()], baseOptions, { ...baseSemantic, errorCode: "JDT_NOT_READY" });
  assert.ok(gaps.slice(0, 3).some(gap => gap.includes("JDT_NOT_READY") && gap.includes("JavaIndex plus rg")), "within the compact output's first three gaps");
  assert.ok(!evidenceGaps([anchor()], baseOptions, { ...baseSemantic, errorCode: "JDT_BACKOFF" }).some(gap => gap.includes("JDT_NOT_READY")));
});

test("explicit compact omits generic advice and keeps request-specific evidence gaps", () => {
  const anchors = [anchor({ profile: "port", factSource: "fallback" })];
  const options = { ...baseOptions, testReadMode: "defer" as const };
  const semantic = { ...baseSemantic, errorCode: "JDT_NOT_READY", timeout: true, lombokIncomplete: true };
  const standard = evidenceGaps(anchors, options, semantic);
  const compact = evidenceGaps(anchors, { ...options, verbosity: "compact" }, semantic);
  assert.ok(standard.length > compact.length);
  assert.equal(compact.length, 4);
  for (const evidence of ["JDT_NOT_READY", "timeout", "degraded fallback", "Lombok"]) {
    assert.ok(compact.some(gap => gap.includes(evidence)), evidence);
  }
});
