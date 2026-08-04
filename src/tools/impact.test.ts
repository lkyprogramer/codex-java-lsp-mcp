import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { impactSchema, javaImpact } from "./impact.js";
import type { ToolContext } from "./context.js";
import type { ImpactOptions, ImpactResult } from "../agent-types.js";

test("impact accepts one absolute deadline and rejects values above 15 seconds", () => {
  const good = z.object(impactSchema).safeParse({
    file: "src/main/java/demo/Demo.java",
    line: 1,
    column: 1,
    deadlineMs: 5000
  });
  assert.equal(good.success, true);

  const bad = z.object(impactSchema).safeParse({
    file: "src/main/java/demo/Demo.java",
    line: 1,
    column: 1,
    deadlineMs: 15001
  });
  assert.equal(bad.success, false);
});

test("impact exposes exactly one timeout control", () => {
  assert.equal(Object.hasOwn(impactSchema, "deadlineMs"), true);
  assert.equal(Object.hasOwn(impactSchema, "semanticTimeoutMs"), false);
});

test("impact projects the absolute deadline onto the internal semantic stage timeout", async () => {
  const seen: ImpactOptions[] = [];
  const context = capturingContext(seen);

  await javaImpact(context, { ...args("standard"), deadlineMs: 200 });
  assert.equal(seen[0].semanticTimeoutMs <= 200, true);
  assert.equal(seen[0].semanticTimeoutMs > 0, true);

  await javaImpact(context, { ...args("standard"), deadlineMs: 15000 });
  assert.equal(seen[1].semanticTimeoutMs, 1500);
});

test("java_impact wrapper respects verbosity when adding phase metrics", async () => {
  const standard = await javaImpact(contextFor("standard"), args("standard")) as ImpactResult;
  const diagnostic = await javaImpact(contextFor("diagnostic"), args("diagnostic")) as ImpactResult;

  assert.equal(Object.hasOwn(standard.metrics ?? {}, "phaseMs"), false);
  assert.equal(Object.hasOwn(standard.metrics ?? {}, "cache"), false);
  assert.equal(Object.hasOwn(standard.metrics ?? {}, "sourceFacts"), false);
  assert.equal(standard.cost.resultBytes, Buffer.byteLength(JSON.stringify(standard), "utf8"));
  assert.equal(Object.hasOwn(diagnostic.metrics ?? {}, "phaseMs"), true);
  assert.equal((diagnostic.metrics?.phaseMs as Record<string, number>).sessionDrain, 2);
  assert.equal(diagnostic.cost.resultBytes, Buffer.byteLength(JSON.stringify(diagnostic), "utf8"));
});

function capturingContext(seen: ImpactOptions[]): ToolContext {
  return {
    repoRoot: "/tmp/demo",
    session: {
      drainPhaseMetrics() {
        return {};
      }
    },
    router: {
      async impact(options: ImpactOptions) {
        seen.push(options);
        return sampleResult({ routingVersion: 6, elapsedMs: 1 });
      }
    }
  } as unknown as ToolContext;
}

function args(verbosity: NonNullable<ImpactOptions["verbosity"]>): Parameters<typeof javaImpact>[1] {
  return {
    anchors: [{ file: "src/main/java/demo/Demo.java", line: 1, column: 1 }],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    verbosity
  };
}

function contextFor(verbosity: NonNullable<ImpactOptions["verbosity"]>): ToolContext {
  return {
    repoRoot: "/tmp/demo",
    session: {
      drainPhaseMetrics() {
        return { sessionDrain: 1 };
      }
    },
    router: {
      async impact(options: ImpactOptions) {
        const payload = sampleResult(
          verbosity === "diagnostic"
            ? { routingVersion: 6, elapsedMs: 1, phaseMs: {}, cache: {}, sourceFacts: {} }
            : { routingVersion: 6, elapsedMs: 1 }
        );
        payload.semantic.policy = options.semanticPolicy;
        return payload;
      }
    }
  } as unknown as ToolContext;
}

function sampleResult(metrics: NonNullable<ImpactResult["metrics"]>): ImpactResult {
  const payload: ImpactResult = {
    version: 6,
    target: {
      file: "src/main/java/demo/Demo.java",
      symbol: "Demo",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    freshness: { requestGeneration: 0, indexedGeneration: 0, coverage: "COMPLETE", changedDuringRequest: false },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [],
    readPlan: [],
    evidenceGaps: [],
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 },
    metrics
  };
  payload.cost.resultBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return payload;
}
