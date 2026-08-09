import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildImpactDeterminismSnapshot,
  verifyImpactDeterminismPayload
} from "./determinism.js";

function result(overrides: Record<string, unknown> = {}) {
  return {
    version: 6 as const,
    target: {
      file: "src/main/java/demo/OrderService.java",
      symbol: "OrderService#submit",
      profile: "service",
      range: { start: { line: 10, column: 3 }, end: { line: 12, column: 4 } }
    },
    freshness: {
      requestGeneration: 7,
      indexedGeneration: 7,
      coverage: "COMPLETE" as const,
      changedDuringRequest: false
    },
    semantic: {
      policy: "fast" as const,
      used: false,
      completion: "COMPLETE" as const,
      readiness: "STOPPED"
    },
    files: [
      {
        id: "F1",
        path: "src/main/java/demo/OrderService.java",
        role: "target",
        confidence: "high" as const,
        evidence: ["anchor file"],
        locations: [{ line: 10, column: 3 }]
      },
      {
        id: "F2",
        path: "src/main/java/demo/OrderRepository.java",
        role: "collaborator",
        confidence: "high" as const,
        evidence: ["exact AST-resolved reference"],
        locations: [{ line: 22, column: 5 }]
      }
    ],
    readPlan: [
      {
        priority: "must" as const,
        fileId: "F1",
        ranges: [{ startLine: 8, endLine: 16, reason: "anchor", estimatedBytes: 512 }],
        reason: "anchor",
        expectedEvidence: ["anchor"],
        estimatedBytes: 512
      },
      {
        priority: "high" as const,
        fileId: "F2",
        ranges: [{ startLine: 20, endLine: 28, reason: "CALLS", estimatedBytes: 420 }],
        reason: "CALLS",
        expectedEvidence: ["CALLS"],
        estimatedBytes: 420
      }
    ],
    evidenceGaps: [],
    cost: { resultBytes: 1, readBytes: 932, estimatedTokens: 1, suppressedRawBytes: 0 },
    metrics: {
      routingVersion: 6,
      elapsedMs: 12,
      shadowRanking: {
        candidates: [
          {
            path: "/repo/src/main/java/demo/OrderRepository.java",
            finalScore: 123.456789,
            rank: 2,
            familyScores: { STATIC_STRUCTURE: 98.7654321 },
            rankWithoutEachFamily: {},
            selectedByReadPlan: true,
            providers: ["static"]
          }
        ]
      }
    },
    ...overrides
  };
}

test("buildImpactDeterminismSnapshot records only semantic ordering and rounds scores", () => {
  const snapshot = buildImpactDeterminismSnapshot(result() as never, "/repo");

  assert.deepEqual(snapshot.candidatePaths, [
    "src/main/java/demo/OrderService.java",
    "src/main/java/demo/OrderRepository.java"
  ]);
  assert.deepEqual(snapshot.readPlan, [
    {
      path: "src/main/java/demo/OrderService.java",
      priority: "must",
      ranges: [{ startLine: 8, endLine: 16, reason: "anchor" }]
    },
    {
      path: "src/main/java/demo/OrderRepository.java",
      priority: "high",
      ranges: [{ startLine: 20, endLine: 28, reason: "CALLS" }]
    }
  ]);
  assert.deepEqual(snapshot.familyScores, [{
    path: "src/main/java/demo/OrderRepository.java",
    finalScore: 123.4568,
    families: { STATIC_STRUCTURE: 98.7654 }
  }]);
  assert.deepEqual(snapshot.completion, {
    semantic: "COMPLETE",
    semanticUsed: false,
    readiness: "STOPPED",
    coverage: "COMPLETE",
    requestGeneration: 7,
    indexedGeneration: 7,
    changedDuringRequest: false
  });
  assert.equal("elapsedMs" in snapshot, false);
});

test("verifyImpactDeterminismPayload accepts 20 identical semantic snapshots despite diagnostic drift", () => {
  const snapshot = buildImpactDeterminismSnapshot(result() as never, "/repo");
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    elapsedMs: 10 + index,
    cacheHits: index,
    determinism: snapshot
  }));

  assert.deepEqual(verifyImpactDeterminismPayload({
    metadata: { runs: 20, warmState: "cold-nolsp" },
    rows: [{ id: "order-submit", attempts }]
  }), {
    rows: 1,
    attempts: 20,
    expectedRuns: 20,
    stable: true
  });
});

test("verifyImpactDeterminismPayload rejects candidate, readPlan, score or completion drift", () => {
  const snapshot = buildImpactDeterminismSnapshot(result() as never, "/repo");
  const changed = structuredClone(snapshot);
  changed.readPlan.reverse();

  assert.throws(() => verifyImpactDeterminismPayload({
    metadata: { runs: 20, warmState: "cold-nolsp" },
    rows: [{
      id: "order-submit",
      attempts: Array.from({ length: 20 }, (_, index) => ({
        determinism: index === 13 ? changed : snapshot
      }))
    }]
  }), /order-submit.*attempt 14.*readPlan/i);
});

test("verifyImpactDeterminismPayload rejects missing snapshots, wrong run count and non-cold input", () => {
  assert.throws(() => verifyImpactDeterminismPayload({
    metadata: { runs: 1, warmState: "cold-nolsp" },
    rows: [{ id: "missing", attempts: [{}] }]
  }), /metadata\.runs=20/i);

  assert.throws(() => verifyImpactDeterminismPayload({
    metadata: { runs: 20, warmState: "warm-auto" },
    rows: [{ id: "wrong-state", attempts: Array.from({ length: 20 }, () => ({})) }]
  }), /cold-nolsp/i);
});

test("verify-determinism CLI returns a machine-readable PASS summary", () => {
  const snapshot = buildImpactDeterminismSnapshot(result() as never, "/repo");
  const root = mkdtempSync(path.join(tmpdir(), "impact-determinism-"));
  const input = path.join(root, "cold-20.json");
  writeFileSync(input, JSON.stringify({
    metadata: { runs: 20, warmState: "cold-nolsp" },
    rows: [{ id: "order-submit", attempts: Array.from({ length: 20 }, () => ({ determinism: snapshot })) }]
  }));

  const run = spawnSync(process.execPath, [
    path.join(import.meta.dirname, "verify-determinism.js"),
    "--input", input,
    "--expected-runs", "20"
  ], { encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    version: 1,
    input,
    rows: 1,
    attempts: 20,
    expectedRuns: 20,
    stable: true,
    gate: "PASS"
  });
});
