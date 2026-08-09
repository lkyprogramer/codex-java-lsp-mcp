import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildManifestFromCold,
  createOptimizationManifest,
  optimizationCommandResult,
  validateOptimizationManifest,
  verifyOptimizationManifest
} from "./run-v32-optimization-matrix.mjs";

const exec = promisify(execFile);

test("optimization manifest binds source inventories, runtime inputs, environment, and cold gate", () => {
  const oldInventory = productionInventory("old", [{ path: "src/a.ts", bytes: 10, loc: 100, sha256: hash("a") }]);
  const newInventory = productionInventory("new", [
    { path: "src/a.ts", bytes: 10, loc: 100, sha256: hash("a") },
    { path: "src/b.ts", bytes: 20, loc: 2, sha256: hash("b") }
  ], { commitTree: "new-tree", executableTree: "candidate-tree" });
  const manifest = createOptimizationManifest({
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 5,
      runtimes: {
        old: { commit: "old", commitTree: "old-tree", executableTree: "old-tree" },
        new: { commit: "new", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { file: "/tmp/candidate.patch", sha256: hash("patch"), untrackedInputs: [{ path: "scripts/new.mjs", sha256: hash("input"), bytes: 1 }] },
      repositories: { repo: { head: "head", tree: "tree" } },
      scenarios: { repo: { sha256: hash("scenario"), rowIds: ["s1"] } },
      dependencies: dependencyEvidence()
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: { expectedCells: 18, expectedRuns: 5 } },
    coldEvidence: { manifestFile: "/tmp/run-manifest.json", matrixDir: "/tmp/matrix", p95Limit: 1.25 },
    environment: { node: { version: "v22" } },
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedger: [ledgerEntry("V3.2-01", [{ path: "src/b.ts", oldLoc: 0, newLoc: 2 }])],
    taskLedgerEvidence: ledgerEvidence()
  });

  assert.equal(validateOptimizationManifest(manifest), true);
  assert.deepEqual(manifest.productionTs.delta, { files: 1, bytes: 20, loc: 2 });
  assert.equal(manifest.productionTs.limits.sprintMaximumLoc, 105);
  assert.equal(manifest.comparison.candidateExecutableTree, "candidate-tree");
  assert.equal(manifest.comparison.runtimeInputs.length, 1);
  assert.deepEqual(manifest.dependencies, dependencyEvidence());
  assert.equal(manifest.taskLedgerEvidence.sha256, ledgerEvidence().sha256);
});

test("optimization manifest rejects drift in its payload or LOC totals", () => {
  const oldInventory = productionInventory("same", [{ path: "src/a.ts", bytes: 10, loc: 1, sha256: hash("a") }]);
  const newInventory = productionInventory("same", [{ path: "src/a.ts", bytes: 10, loc: 1, sha256: hash("a") }], {
    commitTree: "new-tree",
    executableTree: "candidate-tree"
  });
  const manifest = createOptimizationManifest({
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 5,
      runtimes: {
        old: { commit: "same", commitTree: "same-tree", executableTree: "same-tree" },
        new: { commit: "same", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { file: "/tmp/candidate.patch", sha256: hash("patch"), untrackedInputs: [] },
      repositories: {},
      scenarios: {},
      dependencies: dependencyEvidence()
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: { expectedRuns: 5 } },
    coldEvidence: { manifestFile: "/tmp/run-manifest.json", matrixDir: "/tmp/matrix", p95Limit: 1.25 },
    environment: {},
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedgerEvidence: ledgerEvidence()
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

  const dependencyDrift = structuredClone(manifest);
  dependencyDrift.dependencies.inventory.algorithm = "unbound";
  resign(dependencyDrift);
  assert.throws(() => validateOptimizationManifest(dependencyDrift), /dependency evidence/);

  const ledgerEvidenceDrift = structuredClone(manifest);
  ledgerEvidenceDrift.taskLedgerEvidence.sha256 = "invalid";
  resign(ledgerEvidenceDrift);
  assert.throws(() => validateOptimizationManifest(ledgerEvidenceDrift), /ledger evidence/);
});

test("optimization manifest requires a path-complete and repayment-bound LOC ledger", () => {
  const oldInventory = productionInventory("old", [{ path: "src/a.ts", bytes: 10, loc: 100, sha256: hash("a") }]);
  const newInventory = productionInventory("new", [
    { path: "src/a.ts", bytes: 10, loc: 102, sha256: hash("b") },
    { path: "src/b.ts", bytes: 20, loc: 3, sha256: hash("c") }
  ], { commitTree: "new-tree", executableTree: "candidate-tree" });
  const input = {
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 5,
      runtimes: {
        old: { commit: "old", commitTree: "old-tree", executableTree: "old-tree" },
        new: { commit: "new", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { file: "/tmp/candidate.patch", sha256: hash("patch"), untrackedInputs: [] },
      repositories: {},
      scenarios: {},
      dependencies: dependencyEvidence()
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: { expectedRuns: 5 } },
    coldEvidence: { manifestFile: "/tmp/run-manifest.json", matrixDir: "/tmp/matrix", p95Limit: 1.25 },
    environment: {},
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedgerEvidence: ledgerEvidence()
  };

  assert.throws(() => validateOptimizationManifest(createOptimizationManifest(input)), /does not cover production paths/);
  const missingRepayment = createOptimizationManifest({
    ...input,
    taskLedger: [{ ...ledgerEntry("V3.2-01", [locPath("src/a.ts", 100, 102), locPath("src/b.ts", 0, 3)]), repaymentTask: "", repaymentDecision: "" }]
  });
  assert.throws(() => validateOptimizationManifest(missingRepayment), /no repayment gate/);
  const complete = createOptimizationManifest({
    ...input,
    taskLedger: [ledgerEntry("V3.2-01", [locPath("src/a.ts", 100, 102), locPath("src/b.ts", 0, 3)])]
  });
  assert.equal(validateOptimizationManifest(complete), true);
  const duplicate = structuredClone(complete);
  duplicate.taskLedger.push(ledgerEntry("V3.2-02", [locPath("src/a.ts", 100, 102)]));
  resign(duplicate);
  assert.throws(() => validateOptimizationManifest(duplicate), /more than once/);
});

test("optimization baseline records a failed cold gate only with an explicit gap decision", () => {
  const oldInventory = productionInventory("old", [{ path: "src/a.ts", bytes: 10, loc: 1, sha256: hash("a") }]);
  const newInventory = productionInventory("new", [{ path: "src/a.ts", bytes: 10, loc: 1, sha256: hash("a") }], {
    commitTree: "new-tree",
    executableTree: "candidate-tree"
  });
  const input = {
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 5,
      runtimes: {
        old: { commit: "old", commitTree: "old-tree", executableTree: "old-tree" },
        new: { commit: "new", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { file: "/tmp/candidate.patch", sha256: hash("patch"), untrackedInputs: [] },
      repositories: {},
      scenarios: {},
      dependencies: dependencyEvidence()
    },
    coldSummary: { passed: false, inputSha256: hash("cold"), projects: [], configuration: { expectedRuns: 5 } },
    coldEvidence: { manifestFile: "/tmp/run-manifest.json", matrixDir: "/tmp/matrix", p95Limit: 1.25 },
    environment: {},
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedgerEvidence: ledgerEvidence()
  };

  assert.throws(() => createOptimizationManifest(input), /--allow-gate-failure/);
  const manifest = createOptimizationManifest({ ...input, allowColdGateFailure: true });
  assert.equal(manifest.status, "BASELINE_RECORDED_WITH_GAPS");
  assert.equal(manifest.coldGate.passed, false);
  assert.equal(validateOptimizationManifest(manifest), true);
  assert.deepEqual(optimizationCommandResult(manifest), {
    verificationStatus: "PASS",
    resultStatus: "BASELINE_RECORDED_WITH_GAPS",
    coldGatePassed: false,
    manifestPayloadSha256: manifest.manifestPayloadSha256
  });
});

test("optimization LOC ledger owns equal-line content replacements", () => {
  const oldInventory = productionInventory("old", [{ path: "src/a.ts", bytes: 10, loc: 2, sha256: hash("old") }]);
  const newInventory = productionInventory("new", [{ path: "src/a.ts", bytes: 10, loc: 2, sha256: hash("new") }], {
    commitTree: "new-tree",
    executableTree: "candidate-tree"
  });
  const input = {
    baselineProductionTs: oldInventory,
    candidateProductionTs: newInventory,
    coldManifest: {
      version: 5,
      runtimes: {
        old: { commit: "old", commitTree: "old-tree", executableTree: "old-tree" },
        new: { commit: "new", commitTree: "new-tree", executableTree: "candidate-tree" }
      },
      candidatePatch: { file: "/tmp/candidate.patch", sha256: hash("patch"), untrackedInputs: [] },
      repositories: {},
      scenarios: {},
      dependencies: dependencyEvidence()
    },
    coldSummary: { passed: true, inputSha256: hash("cold"), projects: [], configuration: { expectedRuns: 5 } },
    coldEvidence: { manifestFile: "/tmp/run-manifest.json", matrixDir: "/tmp/matrix", p95Limit: 1.25 },
    environment: {},
    artifacts: [{ file: "/tmp/cold.json", bytes: 2, sha256: hash("{}") }],
    taskLedgerEvidence: ledgerEvidence()
  };

  assert.throws(() => validateOptimizationManifest(createOptimizationManifest(input)), /does not cover production paths/);
  const manifest = createOptimizationManifest({
    ...input,
    taskLedger: [ledgerEntry("V3.2-03", [locPath("src/a.ts", 2, 2)])]
  });
  assert.equal(validateOptimizationManifest(manifest), true);
});

test("optimization inventory replays the tested patch instead of reading later candidate-root edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v32-manifest-replay-"));
  const repo = path.join(root, "repo");
  const coldDir = path.join(root, "cold");
  try {
    await Promise.all([mkdir(path.join(repo, "src"), { recursive: true }), mkdir(coldDir, { recursive: true })]);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.name", "Manifest Test"]);
    await git(repo, ["config", "user.email", "manifest@example.invalid"]);
    await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { typescript: "1.0.0" } }));
    await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/typescript": { version: "1.0.0" } } }));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "baseline"]);
    const commit = (await git(repo, ["rev-parse", "HEAD^{commit}"])).trim();
    const commitTree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).trim();
    await writeFile(path.join(repo, "src", "b.ts"), "export const b = 2;\n");
    await git(repo, ["add", "src/b.ts"]);
    const executableTree = (await git(repo, ["write-tree"])).trim();
    const patch = await git(repo, ["diff", "--cached", "--binary", "HEAD"]);
    const patchFile = path.join(coldDir, "candidate.patch");
    await writeFile(patchFile, patch);
    await writeFile(path.join(repo, "src", "c.ts"), "export const later = 3;\n");

    const coldManifest = {
      version: 5,
      runtimes: {
        old: { commit, commitTree, executableTree: commitTree },
        new: { commit, commitTree, executableTree }
      },
      candidatePatch: { file: patchFile, sha256: hash(patch), untrackedInputs: [] },
      repositories: {},
      scenarios: {},
      dependencies: dependencyEvidence()
    };
    const coldSummary = {
      passed: false,
      inputSha256: hash("cold"),
      projects: [],
      cells: [],
      configuration: { expectedRuns: 5 }
    };
    await writeFile(path.join(coldDir, "run-manifest.json"), JSON.stringify(coldManifest));
    await writeFile(path.join(coldDir, "matrix-summary.json"), JSON.stringify(coldSummary));

    const taskLedger = [ledgerEntry("V3.2-01", [locPath("src/b.ts", 0, 1)])];
    const taskLedgerBytes = Buffer.from(`${JSON.stringify(taskLedger, null, 2)}\n`);
    const taskLedgerFile = path.join(coldDir, "task-ledger.json");
    await writeFile(taskLedgerFile, taskLedgerBytes);
    const taskLedgerEvidence = {
      file: taskLedgerFile,
      sourceFile: null,
      bytes: taskLedgerBytes.byteLength,
      sha256: hash(taskLedgerBytes)
    };
    const manifest = await buildManifestFromCold({
      candidateRoot: repo,
      baseline: commit,
      coldDir,
      taskLedger,
      taskLedgerEvidence,
      allowColdGateFailure: true,
      p95Limit: 1.25
    });
    assert.deepEqual(manifest.productionTs.new.files.map(file => file.path), ["src/a.ts", "src/b.ts"]);
    assert.equal(manifest.productionTs.new.source.executableTree, executableTree);
    assert.deepEqual(manifest.dependencies, dependencyEvidence());
    assert.ok(manifest.artifacts.some(artifact => artifact.file === taskLedgerFile));

    const manifestFile = path.join(root, "optimization-manifest.json");
    manifest.productionTs.limits.sprintMaximumLoc = manifest.productionTs.new.totalLoc;
    resign(manifest);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(taskLedgerFile, "[]\n");
    await assert.rejects(
      () => verifyOptimizationManifest({ manifestFile, candidateRoot: repo }),
      /task LOC ledger evidence drift/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function locPath(filePath, oldLoc, newLoc) {
  return {
    path: filePath,
    oldLoc,
    newLoc,
    addedLoc: Math.max(0, newLoc - oldLoc),
    removedLoc: Math.max(0, oldLoc - newLoc),
    netLoc: newLoc - oldLoc,
    contentChanged: true
  };
}

function ledgerEntry(task, paths) {
  const entries = paths.map(entry => "addedLoc" in entry ? entry : locPath(entry.path, entry.oldLoc, entry.newLoc));
  const productionLocAdded = entries.reduce((sum, entry) => sum + entry.addedLoc, 0);
  const productionLocRemoved = entries.reduce((sum, entry) => sum + entry.removedLoc, 0);
  return {
    task,
    productionLocAdded,
    productionLocRemoved,
    netProductionLoc: productionLocAdded - productionLocRemoved,
    paths: entries,
    repaymentTask: "V3.2-35",
    repaymentDecision: "Retain only after the final value gate; otherwise remove or merge."
  };
}

function dependencyEvidence() {
  return {
    copyMode: "private-content-verified-copy",
    inventory: {
      schemaVersion: 1,
      algorithm: "sha256-path-type-size-content-v1",
      fileCount: 10,
      directoryCount: 2,
      symlinkCount: 1,
      totalBytes: 100,
      sha256: hash("fixture node_modules")
    }
  };
}

function ledgerEvidence() {
  return {
    file: "/tmp/task-ledger.json",
    sourceFile: null,
    bytes: 3,
    sha256: hash("[]\n")
  };
}

function resign(manifest) {
  const { manifestPayloadSha256: _ignored, ...payload } = manifest;
  manifest.manifestPayloadSha256 = hash(stableJson(payload));
}

function productionInventory(commit, files, identity = {}) {
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
    source: {
      kind: identity.executableTree && identity.executableTree !== identity.commitTree ? "worktree" : "git-revision",
      commit,
      commitTree: identity.commitTree ?? `${commit}-tree`,
      executableTree: identity.executableTree ?? `${commit}-tree`
    },
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

async function git(root, args) {
  const result = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout;
}
