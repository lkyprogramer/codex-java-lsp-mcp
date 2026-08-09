import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactOptions, ResolvedAnchor, RgPlanSection } from "../agent-types.js";
import { genericJavaPolicy } from "../routing-policy.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import { executeRgPlan } from "./rg-execution.js";
import { summaryFromSearchResult } from "./rg-plan.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "service",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

const anchor: ResolvedAnchor = {
  id: "A1",
  absolutePath: "/repo/src/main/java/demo/OrderService.java",
  path: "src/main/java/demo/OrderService.java",
  module: ".",
  sourceSet: "main",
  line: 1,
  column: 1,
  profile: "service",
  symbolName: "OrderService",
  className: "OrderService",
  kind: "class"
};

const invalidSection: RgPlanSection = {
  anchorId: "A2",
  category: "java",
  reason: "invalid attribution fixture",
  pattern: "OrderService",
  paths: ["src/main/java"],
  globs: ["*.java"]
};

function isInvalidInput(error: unknown): boolean {
  return error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT";
}

test("rg summary rejects an unknown anchor instead of attributing it to A1", () => {
  assert.throws(
    () => summaryFromSearchResult({
      policy: genericJavaPolicy,
      repoRoot: "/repo",
      section: invalidSection,
      result: {
        files: [],
        completion: "COMPLETE",
        rawBytes: 0,
        totalMatches: 0,
        elapsedMs: 0
      },
      anchors: [anchor],
      options
    }),
    isInvalidInput
  );
});

test("rg execution rejects an unknown anchor before running the section", async () => {
  let loadCalls = 0;

  await assert.rejects(
    executeRgPlan({
      plan: [invalidSection],
      options,
      anchors: [anchor],
      concurrency: 1,
      loadSummary: async () => {
        loadCalls += 1;
        return {
          rawBytes: 0,
          totalMatches: 0,
          elapsedMs: 0,
          files: [],
          cacheHit: false,
          completion: "COMPLETE"
        };
      }
    }),
    isInvalidInput
  );
  assert.equal(loadCalls, 0);
});

test("rg summary and execution reject a missing anchor instead of defaulting to A1", async () => {
  const missingSection: RgPlanSection = { ...invalidSection, anchorId: undefined };
  assert.throws(
    () => summaryFromSearchResult({
      policy: genericJavaPolicy,
      repoRoot: "/repo",
      section: missingSection,
      result: {
        files: [],
        completion: "COMPLETE",
        rawBytes: 0,
        totalMatches: 0,
        elapsedMs: 0
      },
      anchors: [anchor],
      options
    }),
    isInvalidInput
  );

  let loadCalls = 0;
  await assert.rejects(
    executeRgPlan({
      plan: [missingSection],
      options,
      anchors: [anchor],
      concurrency: 1,
      loadSummary: async () => {
        loadCalls += 1;
        return {
          rawBytes: 0,
          totalMatches: 0,
          elapsedMs: 0,
          files: [],
          cacheHit: false,
          completion: "COMPLETE"
        };
      }
    }),
    isInvalidInput
  );
  assert.equal(loadCalls, 0);
});
