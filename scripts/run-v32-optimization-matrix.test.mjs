import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createOptimizationManifest,
  validateOptimizationManifest
} from "./run-v32-optimization-matrix.mjs";

test("optimization manifest binds source inventories, runtime inputs, environment, and cold gate", () => {
  const oldInventory = productionInventory("old", [{ path: "src/a.ts", bytes: 10, loc: 100, sha256: hash("a") }]);
  const newInventory = productionInventory("new", [
    { path: "src/a.ts", bytes: 10, loc: 100, sha256: hash("a") },
    { path: "src/b.ts", bytes: 20, loc: 2, sha256: hash("b") }
  ]);
  const manifest = createOptimizationManifest({
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 4,
      runtimes: {
        old: { commit: "old", commitTree: "old-tree", executableTree: "old-tree" },
        new: { commit: "new", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { sha256: hash("patch"), untrackedInputs: [{ path: "scripts/new.mjs", sha256: hash("input"), bytes: 1 }] },
      repositories: { repo: { head: "head", tree: "tree" } },
      scenarios: { repo: { sha256: hash("scenario"), rowIds: ["s1"] } }
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: { expectedCells: 18 } },
    environment: { node: { version: "v22" } },
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedger: [{ task: "V3.2-01", productionLocAdded: 0 }]
  });

  assert.equal(validateOptimizationManifest(manifest), true);
  assert.deepEqual(manifest.productionTs.delta, { files: 1, bytes: 20, loc: 2 });
  assert.equal(manifest.productionTs.limits.sprintMaximumLoc, 105);
  assert.equal(manifest.comparison.candidateExecutableTree, "candidate-tree");
  assert.equal(manifest.comparison.runtimeInputs.length, 1);
});

test("optimization manifest rejects drift in its payload or LOC totals", () => {
  const inventory = productionInventory("same", [{ path: "src/a.ts", bytes: 10, loc: 1, sha256: hash("a") }]);
  const manifest = createOptimizationManifest({
    baselineProductionTs: inventory,
    candidateProductionTs: inventory,
    coldManifest: {
      version: 4,
      runtimes: {
        old: { commit: "same", commitTree: "same-tree", executableTree: "same-tree" },
        new: { commit: "same", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { sha256: hash("patch"), untrackedInputs: [] },
      repositories: {},
      scenarios: {}
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: {} },
    environment: {},
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }]
  });
  const payloadDrift = structuredClone(manifest);
  payloadDrift.environment.node = "changed";
  assert.throws(() => validateOptimizationManifest(payloadDrift), /payload hash mismatch/);

  const totalDrift = structuredClone(manifest);
  totalDrift.productionTs.old.totalLoc += 1;
  const { manifestPayloadSha256: _ignored, ...payload } = totalDrift;
  totalDrift.manifestPayloadSha256 = hash(stableJson(payload));
  assert.throws(() => validateOptimizationManifest(totalDrift), /totals are inconsistent/);

  const ceilingDrift = structuredClone(manifest);
  ceilingDrift.productionTs.limits.sprintMaximumLoc = 0;
  const { manifestPayloadSha256: _hash, ...ceilingPayload } = ceilingDrift;
  ceilingDrift.manifestPayloadSha256 = hash(stableJson(ceilingPayload));
  assert.throws(() => validateOptimizationManifest(ceilingDrift), /\+5% sprint ceiling/);
});

function productionInventory(commit, files) {
  const payload = {
    scope: { include: "src/**/*.ts", exclude: ["src/**/*.test.ts", "dist/**", "generated output"] },
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalLoc: files.reduce((sum, file) => sum + file.loc, 0),
    files
  };
  return {
    schemaVersion: 1,
    scope: payload.scope,
    source: { kind: "git-revision", commit, commitTree: `${commit}-tree`, executableTree: `${commit}-tree` },
    fileCount: payload.fileCount,
    totalBytes: payload.totalBytes,
    totalLoc: payload.totalLoc,
    files,
    inventorySha256: hash(stableJson(payload))
  };
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
