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

  assert.equal(Object.hasOwn(standard.metrics, "phaseMs"), false);
  assert.equal(Object.hasOwn(standard.metrics, "cache"), false);
  assert.equal(Object.hasOwn(standard.metrics, "sourceFacts"), false);
  assert.equal(standard.metrics.outputBytes, Buffer.byteLength(JSON.stringify(standard), "utf8"));
  assert.equal(Object.hasOwn(diagnostic.metrics, "phaseMs"), true);
  assert.equal((diagnostic.metrics.phaseMs as Record<string, number>).sessionDrain, 2);
  assert.equal(diagnostic.metrics.outputBytes, Buffer.byteLength(JSON.stringify(diagnostic), "utf8"));
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
        return {
          target: {},
          options: {},
          counts: {},
          files: [],
          readPlan: [],
          rgSummary: { sections: [], suppressed: {} },
          suppressed: {},
          evidenceGaps: [],
          metrics: { routingVersion: 5, elapsedMs: 1, outputBytes: 0 }
        } satisfies ImpactResult;
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
        const payload: ImpactResult = {
          target: {},
          options: { verbosity: options.verbosity },
          counts: {},
          files: [],
          readPlan: [],
          rgSummary: { sections: [], suppressed: {} },
          suppressed: {},
          evidenceGaps: [],
          metrics: verbosity === "diagnostic"
            ? {
                routingVersion: 5,
                elapsedMs: 1,
                phaseMs: {},
                cache: {},
                sourceFacts: {},
                outputBytes: 0
              }
            : {
                routingVersion: 5,
                elapsedMs: 1,
                outputBytes: 0
              }
        };
        payload.metrics.outputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        return payload;
      }
    }
  } as unknown as ToolContext;
}
