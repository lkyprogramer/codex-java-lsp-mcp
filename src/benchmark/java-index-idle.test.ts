import assert from "node:assert/strict";
import test from "node:test";
import { isJavaIndexQuiescent } from "./java-index-idle.js";
import type { JavaIndexStatus } from "../java-index/index-types.js";

function status(overrides: Partial<JavaIndexStatus> = {}): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: 1,
    files: 1,
    types: 1,
    methods: 1,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [],
    resourceCoverage: [],
    ...overrides
  };
}

test("JavaIndex is not quiescent while any source root is still BUILDING", () => {
  assert.equal(isJavaIndexQuiescent(status({
    coverage: [{
      root: "src/main/java",
      generation: 1,
      state: "BUILDING",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }]
  })), false);
});

test("JavaIndex may quiesce with no pending jobs once roots are no longer BUILDING", () => {
  assert.equal(isJavaIndexQuiescent(status({
    coverage: [{
      root: "src/main/java",
      generation: 1,
      state: "DEGRADED",
      discoveredFiles: 1,
      indexedFiles: 0,
      failedFiles: 1,
      recoveredFiles: 0,
      extractorVersion: "test"
    }]
  })), true, "DEGRADED is terminal and must not make benchmark preparation hang");
  assert.equal(isJavaIndexQuiescent(status({ pendingForeground: 1 })), false);
  assert.equal(isJavaIndexQuiescent(status({ pendingBackground: 1 })), false);
});
