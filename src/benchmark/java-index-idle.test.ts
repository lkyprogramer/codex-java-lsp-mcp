import assert from "node:assert/strict";
import test from "node:test";
import {
  areJavaSourceRootsCompleteAt,
  isJavaIndexCompleteAt,
  isJavaIndexQuiescent,
  isJavaIndexSnapshotDurableAt
} from "./java-index-idle.js";
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

test("strict completion rejects degraded, recovered, wrong-generation, resource and pending states", () => {
  const complete = status({
    snapshotBytes: 128,
    snapshot: { state: "DURABLE", durableGeneration: 3, durableManifestFingerprint: "manifest" },
    indexedGeneration: 3,
    coverage: [{
      root: "src/main/java",
      generation: 3,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }],
    resourceCoverage: [{
      root: "src/main/resources",
      generation: 3,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0
    }]
  });
  assert.equal(isJavaIndexCompleteAt(complete, 3), true);
  assert.equal(areJavaSourceRootsCompleteAt(complete, 3, ["src/main/java"]), true);
  assert.equal(isJavaIndexCompleteAt({ ...complete, indexedGeneration: 2 }, 3), false);
  assert.equal(isJavaIndexCompleteAt({ ...complete, pendingBackground: 1 }, 3), false);
  assert.equal(isJavaIndexCompleteAt({
    ...complete,
    coverage: [{ ...complete.coverage[0]!, state: "DEGRADED" }]
  }, 3), false);
  assert.equal(isJavaIndexCompleteAt({
    ...complete,
    coverage: [{ ...complete.coverage[0]!, recoveredFiles: 1 }]
  }, 3), false);
  assert.equal(isJavaIndexCompleteAt({
    ...complete,
    resourceCoverage: [{ ...complete.resourceCoverage[0]!, failedFiles: 1 }]
  }, 3), false);
});

test("snapshot durability requires an exact current-generation atomic publication", () => {
  const complete = status({
    indexedGeneration: 4,
    snapshotBytes: 256,
    snapshot: { state: "DURABLE", durableGeneration: 4, durableManifestFingerprint: "manifest" },
    coverage: [{
      root: "src/main/java",
      generation: 4,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }]
  });
  assert.equal(isJavaIndexSnapshotDurableAt(complete, 4), true);
  assert.equal(isJavaIndexSnapshotDurableAt({ ...complete, snapshot: { state: "PENDING" } }, 4), false);
  assert.equal(isJavaIndexSnapshotDurableAt({
    ...complete,
    snapshot: { state: "FAILED", failure: "WRITE_FAILED" }
  }, 4), false);
  assert.equal(isJavaIndexSnapshotDurableAt({
    ...complete,
    snapshot: { state: "DURABLE", durableGeneration: 3, durableManifestFingerprint: "manifest" }
  }, 4), false);
});
