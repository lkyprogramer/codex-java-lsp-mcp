import assert from "node:assert/strict";
import test from "node:test";
import { planEvidenceBundles } from "./context-planner.js";
import type { EvidenceBundle, EvidenceRole } from "./evidence-bundle.js";

function bundle(partial: Partial<EvidenceBundle> & Pick<EvidenceBundle, "id" | "path" | "role" | "closes" | "tokenCost">): EvidenceBundle {
  return {
    proof: [],
    spans: [{ start: 1, end: 4, bytes: partial.tokenCost * 4 }],
    confidence: 0.8,
    latencyCost: partial.hops ?? 1,
    hops: partial.hops ?? 1,
    provingPath: [],
    ...partial
  };
}

function fixtures(): EvidenceBundle[] {
  const roles: EvidenceRole[] = ["ANCHOR", "CALLEE", "CALLER", "IMPLEMENTATION", "PERSISTENCE", "FRAMEWORK", "TEST", "CONTRACT", "DATAFLOW", "CHANGE_SITE"];
  const items: EvidenceBundle[] = [
    bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 40, hops: 0 })
  ];
  for (let index = 0; index < 12; index += 1) {
    items.push(bundle({
      id: `b${index}`,
      path: `src/F${index}.java`,
      role: roles[(index % (roles.length - 1)) + 1]!,
      closes: [`O${index + 2}`],
      tokenCost: 30 + index,
      hops: 1 + (index % 3)
    }));
  }
  return items;
}

test("larger token budget does not drop obligation coverage", () => {
  const bundles = fixtures();
  const small = planEvidenceBundles({ bundles, tokenBudget: 120 });
  const large = planEvidenceBundles({ bundles, tokenBudget: 400 });
  for (const id of small.covered) assert.ok(large.covered.includes(id), id);
  assert.ok(large.selected.length >= small.selected.length);
});

test("deleting a redundant bundle leaves coverage unchanged", () => {
  const bundles = [
    bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 20, hops: 0 }),
    bundle({ id: "b", path: "src/B.java", role: "CALLEE", closes: ["O2"], tokenCost: 20, hops: 1 }),
    bundle({ id: "dup", path: "src/B.java", role: "CALLEE", closes: ["O2"], tokenCost: 20, hops: 1 })
  ];
  const full = planEvidenceBundles({ bundles, tokenBudget: 200 });
  const trimmed = planEvidenceBundles({ bundles: bundles.filter(item => item.id !== "dup"), tokenBudget: 200 });
  assert.deepEqual(full.covered, trimmed.covered);
});

test("over-budget non-P0 bundles are never accepted", () => {
  const bundles = [
    bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
    bundle({ id: "huge", path: "src/Z.java", role: "CALLEE", closes: ["O2"], tokenCost: 500, hops: 1 })
  ];
  const planned = planEvidenceBundles({ bundles, tokenBudget: 40 });
  assert.equal(planned.selected.some(item => item.id === "huge"), false);
  assert.ok(planned.tokenCost <= 40 || planned.selected.every(item => item.hops === 0));
});

test("anchor is not starved even when the budget is tight", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 80, hops: 0 }),
      bundle({ id: "b", path: "src/B.java", role: "CALLEE", closes: ["O2"], tokenCost: 10, hops: 1 })
    ],
    tokenBudget: 50
  });
  assert.ok(planned.selected.some(item => item.role === "ANCHOR"));
});

test("same input is deterministic and file count is not a binding cap", () => {
  const bundles = fixtures();
  const first = planEvidenceBundles({ bundles, tokenBudget: 800 });
  const second = planEvidenceBundles({ bundles, tokenBudget: 800 });
  assert.deepEqual(first.selected.map(item => item.id), second.selected.map(item => item.id));
  assert.ok(first.distinctFiles > 6, `expected more than the old maxFiles=6 binding, got ${first.distinctFiles}`);
});

test("duplicate path saturates instead of paying twice for the same closes", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({ id: "b1", path: "src/B.java", role: "CALLEE", closes: ["O2"], tokenCost: 20, hops: 1 }),
      bundle({ id: "b2", path: "src/B.java", role: "CALLEE", closes: ["O2"], tokenCost: 20, hops: 1 })
    ],
    tokenBudget: 200
  });
  const pathB = planned.selected.filter(item => item.path === "src/B.java");
  assert.ok(pathB.length <= 1);
});
