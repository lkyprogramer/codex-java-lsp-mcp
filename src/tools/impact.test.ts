import assert from "node:assert/strict";
import test from "node:test";
import { javaImpact } from "./impact.js";
import type { ToolContext } from "./context.js";
import type { ImpactOptions, ImpactResult } from "../agent-types.js";

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

function args(verbosity: NonNullable<ImpactOptions["verbosity"]>): Parameters<typeof javaImpact>[1] {
  return {
    anchors: [{ file: "src/main/java/demo/Demo.java", line: 1, column: 1 }],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1500,
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
    sourceIndex: {},
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
