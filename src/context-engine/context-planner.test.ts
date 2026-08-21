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
  assert.ok(large.covered.length >= small.covered.length);
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

test("hop<=2 files are not force-filled; budget greedy can skip a large near file", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({ id: "near-huge", path: "src/Huge.java", role: "CALLEE", closes: ["O2"], tokenCost: 400, hops: 1 }),
      bundle({ id: "far-cheap", path: "src/Far.java", role: "PERSISTENCE", closes: ["O3"], tokenCost: 20, hops: 3 })
    ],
    tokenBudget: 80
  });
  assert.equal(planned.selected.some(item => item.id === "near-huge"), false);
  assert.ok(planned.selected.some(item => item.id === "far-cheap"));
  assert.ok(planned.tokenCost <= 80);
});

test("near hop-1 that fits is packed before a cheaper hop-3 file", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({ id: "near", path: "src/Near.java", role: "CALLEE", closes: ["O2"], tokenCost: 40, hops: 1 }),
      bundle({ id: "far", path: "src/Far.java", role: "PERSISTENCE", closes: ["O3"], tokenCost: 20, hops: 3 })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "near"));
  assert.equal(planned.selected.some(item => item.id === "far"), false);
  assert.ok(planned.tokenCost <= 55);
});

test("hop-1 IMPLEMENTS pack before hop-1 CALLS when leftover fits only one", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "callee",
        path: "src/AaaCallee.java",
        role: "CALLEE",
        closes: ["O2"],
        tokenCost: 40,
        hops: 1,
        proof: ["CALLS_EXACT"],
        provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java", toId: "src/AaaCallee.java#C#run#n" }]
      }),
      bundle({
        id: "impl",
        path: "src/Zimpl.java",
        role: "IMPLEMENTATION",
        closes: ["O3"],
        tokenCost: 40,
        hops: 1,
        proof: ["IMPLEMENTS"],
        provingPath: [{ kind: "IMPLEMENTS", fromId: "src/A.java", toId: "src/Zimpl.java#Z#run#n" }]
      })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "impl"));
  assert.equal(planned.selected.some(item => item.id === "callee"), false);
});

test("cross-layout hop-1 CALLS pack before same-layout hop-1 CALLS", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "modules/exam/src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "near",
        path: "modules/exam/src/Near.java",
        role: "CALLEE",
        closes: ["O2"],
        tokenCost: 40,
        hops: 1,
        proof: ["CALLS_EXACT"],
        provingPath: [{ kind: "CALLS_EXACT", fromId: "modules/exam/src/A.java", toId: "modules/exam/src/Near.java#N#run#n" }]
      }),
      bundle({
        id: "far",
        path: "modules/school/src/Far.java",
        role: "CALLEE",
        closes: ["O2"],
        tokenCost: 40,
        hops: 1,
        proof: ["CALLS_EXACT"],
        provingPath: [{ kind: "CALLS_EXACT", fromId: "modules/exam/src/A.java", toId: "modules/school/src/Far.java#F#run#n" }]
      })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "far"));
  assert.equal(planned.selected.some(item => item.id === "near"), false);
});

test("hop>2 ANNOTATED_WITH noise is skipped even when it fits", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "noise",
        path: "src/Noise.java",
        role: "DATAFLOW",
        closes: ["O1"],
        tokenCost: 20,
        hops: 3,
        proof: ["ANNOTATED_WITH"],
        provingPath: [{ kind: "ANNOTATED_WITH", fromId: "src/A.java", toId: "src/Noise.java" }]
      })
    ],
    tokenBudget: 80
  });
  assert.equal(planned.selected.some(item => item.id === "noise"), false);
});

test("named CALLS pack before signature IMPORTS when leftover fits only one", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "dto",
        path: "src/Dto.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 40,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java", toId: "src/Dto.java#Dto" }]
      }),
      bundle({
        id: "callee",
        path: "src/ZCallee.java",
        role: "CALLEE",
        closes: ["O2"],
        tokenCost: 40,
        hops: 1,
        proof: ["CALLS_EXACT"],
        provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java", toId: "src/ZCallee.java#Z#run#n" }]
      })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "callee"));
  assert.equal(planned.selected.some(item => item.id === "dto"), false);
});

test("distinct IMPORTS from the same fromId are not capped at two", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "one",
        path: "src/One.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 20,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java#A", toId: "src/One.java#One" }]
      }),
      bundle({
        id: "two",
        path: "src/Two.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 20,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java#A", toId: "src/Two.java#Two" }]
      }),
      bundle({
        id: "three",
        path: "src/Three.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 20,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java#A", toId: "src/Three.java#Three" }]
      })
    ],
    tokenBudget: 80
  });
  assert.deepEqual(planned.selected.map(item => item.id).sort(), ["a", "one", "three", "two"]);
});

test("signature IMPORTS attached from a file path pack before ordinary hop-1 IMPORTS", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({
        id: "delete",
        path: "src/DeleteCommand.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 40,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java#A", toId: "src/DeleteCommand.java#DeleteCommand" }]
      }),
      bundle({
        id: "signed",
        path: "src/SignedUrlCommand.java",
        role: "CONTRACT",
        closes: ["O5"],
        tokenCost: 40,
        hops: 1,
        proof: ["IMPORTS"],
        provingPath: [{ kind: "IMPORTS", fromId: "src/A.java", toId: "src/SignedUrlCommand.java#SignedUrlCommand" }]
      })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "signed"));
  assert.equal(planned.selected.some(item => item.id === "delete"), false);
});

test("hop-1 IMPLEMENTS that fits is packed before a cheaper CONTAINS sibling", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({ id: "sib", path: "src/AaaSibling.java", role: "CONTRACT", closes: ["O5"], tokenCost: 20, hops: 1, proof: ["CONTAINS"] }),
      bundle({ id: "impl", path: "src/Zimpl.java", role: "IMPLEMENTATION", closes: ["O3"], tokenCost: 40, hops: 1, proof: ["IMPLEMENTS"] })
    ],
    tokenBudget: 55
  });
  assert.ok(planned.selected.some(item => item.id === "impl"));
  assert.equal(planned.selected.some(item => item.id === "sib"), false);
  assert.ok(planned.tokenCost <= 55);
});

test("in-budget hop-1 files are kept; hop-order does not skip them for a later cheaper file", () => {
  const planned = planEvidenceBundles({
    bundles: [
      bundle({ id: "a", path: "src/A.java", role: "ANCHOR", closes: ["O1"], tokenCost: 10, hops: 0 }),
      bundle({ id: "n1", path: "src/N1.java", role: "CALLEE", closes: ["O2"], tokenCost: 20, hops: 1 }),
      bundle({ id: "n2", path: "src/N2.java", role: "CALLER", closes: ["O3"], tokenCost: 20, hops: 1 }),
      bundle({ id: "n3", path: "src/N3.java", role: "IMPLEMENTATION", closes: ["O4"], tokenCost: 20, hops: 1 })
    ],
    tokenBudget: 80
  });
  assert.deepEqual(planned.selected.map(item => item.id).sort(), ["a", "n1", "n2", "n3"]);
  assert.ok(planned.tokenCost <= 80);
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
