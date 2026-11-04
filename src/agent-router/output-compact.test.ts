import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactResultV6 } from "../agent-types.js";
import { toCompactImpact, viewDistinctReadFiles, viewImpactFiles, viewSelectedRangesByFile } from "./output-compact.js";
import { roleOf } from "./output-v6.js";

function v6(): ImpactResultV6 {
  return {
    version: 6,
    target: {
      file: "src/A.java",
      symbol: "A",
      type: "A",
      method: "m",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    freshness: {
      requestGeneration: 1,
      indexedGeneration: 1,
      coverage: "COMPLETE",
      changedDuringRequest: false
    },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [
      {
        id: "F1",
        path: "src/A.java",
        role: "target",
        confidence: "high",
        evidence: ["calls or is called by the anchor"],
        locations: [{ line: 1, column: 1 }],
        reasons: ["target", "CALLS"]
      },
      {
        id: "F2",
        path: "src/B.java",
        role: "implementation",
        confidence: "medium",
        evidence: ["implements a type related to the anchor"],
        locations: [{ line: 10, column: 1 }],
        reasons: ["IMPLEMENTS"]
      }
    ],
    readPlan: [
      {
        fileId: "F1",
        priority: "P0",
        estimatedBytes: 40,
        reason: "anchor",
        expectedEvidence: ["signature"],
        ranges: [{ startLine: 1, endLine: 8, estimatedBytes: 40 }]
      },
      {
        fileId: "F2",
        priority: "P1",
        estimatedBytes: 20,
        reason: "implementation",
        expectedEvidence: ["body"],
        ranges: [{ startLine: 10, endLine: 12, estimatedBytes: 20 }]
      }
    ],
    evidenceGaps: [
      "Run Gradle compile/test before claiming behavior.",
      "LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.",
      "Review persistence/config evidence in the returned files (role=config or framework) before changing behavior.",
      "Lombok is detected but the JDT javaagent is missing/disabled; generated members (getters/setters/builders) on types in scope may not resolve - verify with a full compile before assuming a member is absent."
    ],
    cost: { resultBytes: 100, readBytes: 60, estimatedTokens: 40, suppressedRawBytes: 0 }
  };
}

test("compact serializer keeps file set and ranges and shrinks the wire", () => {
  const source = v6();
  const oldBytes = Buffer.byteLength(JSON.stringify(source), "utf8");
  const compact = toCompactImpact(source);
  assert.equal(compact.version, 1);
  assert.equal(Object.hasOwn(compact, "files"), false);
  assert.equal(Object.hasOwn(compact, "readPlan"), false);
  assert.deepEqual(viewImpactFiles(compact), ["src/A.java", "src/B.java"]);
  assert.deepEqual(viewDistinctReadFiles(compact), ["src/A.java", "src/B.java"]);
  assert.deepEqual(viewSelectedRangesByFile(compact).get("src/A.java"), [{ startLine: 1, endLine: 8 }]);
  assert.deepEqual(viewSelectedRangesByFile(compact).get("src/B.java"), [{ startLine: 10, endLine: 12 }]);
  const newBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  assert.ok(newBytes < oldBytes * 0.6, `new ${newBytes} should be < 60% of old ${oldBytes}`);
  assert.equal(compact.semantic.completion, "COMPLETE");
  assert.equal(compact.semantic.used, false);
  assert.equal(compact.freshness.coverage, "COMPLETE");
  assert.equal(compact.contexts[0]?.role, "TGT");
  assert.deepEqual(compact.contexts[0]?.proof, ["CALLS"]);
  assert.ok(compact.unresolved.some(gap => gap.includes("Lombok")));
  assert.ok(!JSON.stringify(compact).includes("calls or is called by the anchor"));
});

test("explicit compact preserves ranges, unreadable anchors and request gaps with bounded supplemental context", () => {
  const source = v6();
  const anchorReasons = ["target", "SPRING_INJECTION"];
  const unreadableAnchors = Array.from({ length: 4 }, (_, index) => ({
    ...source.files[0]!,
    id: `F${index + 7}`,
    path: `src/Anchor${index}.java`,
    role: roleOf(anchorReasons),
    reasons: anchorReasons
  }));
  source.files.push(
    ...["C", "D", "E", "F"].map((name, i) => ({
      ...source.files[1]!,
      id: `F${i + 3}`,
      path: `src/${name}.java`
    })),
    ...unreadableAnchors,
    { ...source.files[1]!, id: "F11", path: "mapper.xml", role: "framework", reasons: ["MYBATIS_STATEMENT_METHOD"] }
  );
  source.readPlan.push(...unreadableAnchors.map(file => ({
    ...source.readPlan[0]!,
    fileId: file.id,
    ranges: [],
    estimatedBytes: 0
  })));
  source.evidenceGaps = [
    "Semantic timed out; using JavaIndex plus rg.",
    "Some source facts used fallback evidence.",
    "Read range unavailable for anchor src/Anchor3.java.",
    "Lombok agent missing; generated members may not resolve."
  ];
  source.metrics = { routingVersion: 6, elapsedMs: 10, generatedSemantics: "INCOMPLETE" };

  const standard = toCompactImpact(source);
  const compact = toCompactImpact(source, "compact");
  assert.equal(standard.contexts.length, 11);
  assert.equal(Object.hasOwn(standard, "omittedContexts"), false);
  assert.deepEqual(viewImpactFiles(compact), [
    "src/A.java", "src/B.java", "src/C.java", "src/D.java", ...unreadableAnchors.map(file => file.path), "mapper.xml"
  ]);
  for (const anchor of unreadableAnchors) {
    const context = compact.contexts.find(item => item.path === anchor.path);
    assert.equal(context?.role, "FW");
    assert.deepEqual(context?.spans, []);
  }
  assert.equal(compact.omittedContexts, 2);
  assert.deepEqual(viewSelectedRangesByFile(compact), viewSelectedRangesByFile(standard));
  assert.deepEqual(compact.contexts.at(-1)?.proof, ["MYBATIS_STATEMENT_METHOD"]);
  assert.deepEqual(compact.unresolved, source.evidenceGaps);
  assert.equal(compact.metrics?.generatedSemantics, "INCOMPLETE");
  assert.equal(compact.cost.resultBytes, Buffer.byteLength(JSON.stringify(compact), "utf8"));
});
