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
