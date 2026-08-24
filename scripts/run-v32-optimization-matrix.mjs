#!/usr/bin/env node
// input: An immutable old revision, a candidate worktree, and the three formal Java repositories.
// output: The existing source-locked cold matrix plus a V3.2 provenance/LOC/environment manifest.
// pos: Sprint-level V3.2 matrix entrypoint; delegates semantic gates to the V4 cold runner.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { countProductionTs } from "./count-production-ts.mjs";
import {
  JAVA_INDEX_RPC_SIDECAR_ROLE,
  validateDiagnosticRpcGate,
  verifyJavaIndexRpcSidecar
} from "./aggregate-java-index-rpc-sidecar.mjs";
import { createDetachedLocalClone, scrubHostNodeRuntimeState } from "./isolation-utils.mjs";
import { assertOutputOutsideSource } from "./run-three-repo-cold-matrix.mjs";
import { verifyMatrix } from "./verify-three-repo-cold-matrix.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V32_OPTIMIZATION_MANIFEST_VERSION = 3;
/** Archived V3.2 optimization-cycle identity. No longer the active LOC gate. */
export const V32_OPTIMIZATION_BASELINE_COMMIT = "94c4ebfb1c174b2ac3cab615d986c3061accd2ed";
export const V32_OPTIMIZATION_BASELINE_TREE = "60ae785e8af9ac06012452ea41c6b1fe2d3606fd";
export const V32_OPTIMIZATION_BASELINE_INVENTORY_SHA256 = "8c3feaba965ca26a9f076608ad5c4e92dc3d074b3e657afbb32316bc17a6e9ea";
export const V32_OPTIMIZATION_BASELINE_LOC = 31_638;
export const V32_OPTIMIZATION_CYCLE_MAXIMUM_LOC = 33_219;
/** V4 post-merge production TypeScript identity. Active LOC gate from V4-02. */
export const V4_OPTIMIZATION_BASELINE_COMMIT = "4323b3cfead3a368b5a81c880176841d162ceced";
export const V4_OPTIMIZATION_BASELINE_TREE = "1be810da3cc7a2895e143be204542174367e0b30";
export const V4_OPTIMIZATION_BASELINE_INVENTORY_SHA256 = "357952d57b439326da0b0c4dc7bf079f9970cb0f9bec69cb0e4c547c6ffa79a4";
export const V4_OPTIMIZATION_BASELINE_FILE_COUNT = 128;
export const V4_OPTIMIZATION_BASELINE_BYTES = 1_418_751;
export const V4_OPTIMIZATION_BASELINE_LOC = 35_472;
export const V4_OPTIMIZATION_CYCLE_MAXIMUM_LOC = 37_245;

export function createOptimizationManifest({
  optimizationBaselineProductionTs,
  baselineProductionTs,
  candidateProductionTs,
  coldManifest,
  coldSummary,
  environment,
  artifacts,
  taskLedger = [],
  taskLedgerEvidence,
  diagnosticRpcEvidence,
  coldEvidence,
  allowColdGateFailure = false
}) {
  if (typeof coldSummary?.passed !== "boolean") throw new Error("cold matrix summary is missing its gate result");
  const diagnosticRpcGatePassed = diagnosticRpcEvidence?.gate?.passed ?? true;
  validateProductionInventory(optimizationBaselineProductionTs, "optimization baseline");
  validateFrozenOptimizationBaselineInventory(optimizationBaselineProductionTs);
  const optimizationCycleMaximumLoc = Math.floor(optimizationBaselineProductionTs.totalLoc * 1.05);
  const productionLocGatePassed = candidateProductionTs.totalLoc <= optimizationCycleMaximumLoc;
  if (!productionLocGatePassed) {
    throw new Error(
      `production TypeScript LOC ${candidateProductionTs.totalLoc} exceeds the fixed V4 optimization-cycle ceiling ${optimizationCycleMaximumLoc}`
    );
  }
  const sprintGatePassed = coldSummary.passed && diagnosticRpcGatePassed;
  if (!sprintGatePassed && !allowColdGateFailure) {
    throw new Error("cold and diagnostic Sprint gates must pass unless --allow-gate-failure explicitly records a gap");
  }
  const oldRuntime = coldManifest?.runtimes?.old;
  const newRuntime = coldManifest?.runtimes?.new;
  if (!oldRuntime || !newRuntime) throw new Error("cold manifest is missing old/new runtime identities");
  if (baselineProductionTs.source.commit !== oldRuntime.commit
    || baselineProductionTs.source.commitTree !== oldRuntime.commitTree) {
    throw new Error("production TypeScript baseline does not match the cold old runtime");
  }
  if (candidateProductionTs.source.commit !== newRuntime.commit
    || candidateProductionTs.source.commitTree !== newRuntime.commitTree
    || candidateProductionTs.source.executableTree !== newRuntime.executableTree) {
    throw new Error("production TypeScript candidate does not match the cold candidate executable tree");
  }
  const manifest = {
    schemaVersion: V32_OPTIMIZATION_MANIFEST_VERSION,
    status: sprintGatePassed ? "PASS" : "BASELINE_RECORDED_WITH_GAPS",
    comparison: {
      policy: "previous-immutable-sprint-to-source-locked-candidate",
      optimizationBaselineCommit: optimizationBaselineProductionTs.source.commit,
      optimizationBaselineTree: optimizationBaselineProductionTs.source.executableTree,
      coldManifestVersion: coldManifest.version,
      baselineCommit: oldRuntime.commit,
      baselineTree: oldRuntime.executableTree,
      candidateBaseCommit: newRuntime.commit,
      candidateCommitTree: newRuntime.commitTree,
      candidateExecutableTree: newRuntime.executableTree,
      candidatePatchFile: coldManifest.candidatePatch?.file,
      candidatePatchSha256: coldManifest.candidatePatch?.sha256,
      runtimeInputs: coldManifest.candidatePatch?.untrackedInputs ?? []
    },
    repositories: coldManifest.repositories,
    scenarios: coldManifest.scenarios,
    dependencies: coldManifest.dependencies,
    environment,
    productionTs: {
      optimizationBaseline: optimizationBaselineProductionTs,
      old: baselineProductionTs,
      new: candidateProductionTs,
      limits: {
        optimizationCycleMaximumLoc,
        finalTargetLoc: optimizationBaselineProductionTs.totalLoc
      },
      delta: {
        files: candidateProductionTs.fileCount - baselineProductionTs.fileCount,
        bytes: candidateProductionTs.totalBytes - baselineProductionTs.totalBytes,
        loc: candidateProductionTs.totalLoc - baselineProductionTs.totalLoc
      },
      cumulativeDelta: {
        files: candidateProductionTs.fileCount - optimizationBaselineProductionTs.fileCount,
        bytes: candidateProductionTs.totalBytes - optimizationBaselineProductionTs.totalBytes,
        loc: candidateProductionTs.totalLoc - optimizationBaselineProductionTs.totalLoc
      },
      gate: {
        passed: productionLocGatePassed,
        actualLoc: candidateProductionTs.totalLoc,
        maximumLoc: optimizationCycleMaximumLoc,
        excessLoc: Math.max(0, candidateProductionTs.totalLoc - optimizationCycleMaximumLoc)
      }
    },
    taskLedger,
    taskLedgerEvidence,
    ...(diagnosticRpcEvidence ? { diagnosticRpcEvidence } : {}),
    ...(diagnosticRpcEvidence ? { diagnosticRpcGate: diagnosticRpcEvidence.gate } : {}),
    coldGate: {
      passed: coldSummary.passed,
      allowFailure: allowColdGateFailure,
      manifestFile: coldEvidence?.manifestFile,
      matrixDir: coldEvidence?.matrixDir,
      expectedRuns: coldSummary.configuration?.expectedRuns,
      p95Limit: coldEvidence?.p95Limit,
      inputSha256: coldSummary.inputSha256,
      projects: coldSummary.projects,
      configuration: coldSummary.configuration
    },
    artifacts
  };
  return { ...manifest, manifestPayloadSha256: sha256(stableJson(manifest)) };
}

export function validateOptimizationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== V32_OPTIMIZATION_MANIFEST_VERSION
    || !["PASS", "BASELINE_RECORDED_WITH_GAPS"].includes(manifest.status)) {
    throw new Error("invalid V3.2 optimization manifest header");
  }
  const { manifestPayloadSha256, ...payload } = manifest;
  if (manifestPayloadSha256 !== sha256(stableJson(payload))) {
    throw new Error("V3.2 optimization manifest payload hash mismatch");
  }
  for (const side of ["optimizationBaseline", "old", "new"]) {
    validateProductionInventory(manifest.productionTs?.[side], side);
  }
  validateFrozenOptimizationBaselineInventory(manifest.productionTs.optimizationBaseline);
  const expectedDelta = {
    files: manifest.productionTs.new.fileCount - manifest.productionTs.old.fileCount,
    bytes: manifest.productionTs.new.totalBytes - manifest.productionTs.old.totalBytes,
    loc: manifest.productionTs.new.totalLoc - manifest.productionTs.old.totalLoc
  };
  if (stableJson(expectedDelta) !== stableJson(manifest.productionTs.delta)) {
    throw new Error("production TypeScript delta is inconsistent");
  }
  const expectedCumulativeDelta = {
    files: manifest.productionTs.new.fileCount - manifest.productionTs.optimizationBaseline.fileCount,
    bytes: manifest.productionTs.new.totalBytes - manifest.productionTs.optimizationBaseline.totalBytes,
    loc: manifest.productionTs.new.totalLoc - manifest.productionTs.optimizationBaseline.totalLoc
  };
  if (stableJson(expectedCumulativeDelta) !== stableJson(manifest.productionTs.cumulativeDelta)) {
    throw new Error("production TypeScript cumulative delta is inconsistent");
  }
  const expectedCycleMaximumLoc = Math.floor(manifest.productionTs.optimizationBaseline.totalLoc * 1.05);
  const expectedLocGate = {
    passed: manifest.productionTs.new.totalLoc <= expectedCycleMaximumLoc,
    actualLoc: manifest.productionTs.new.totalLoc,
    maximumLoc: expectedCycleMaximumLoc,
    excessLoc: Math.max(0, manifest.productionTs.new.totalLoc - expectedCycleMaximumLoc)
  };
  if (manifest.productionTs.limits?.optimizationCycleMaximumLoc !== expectedCycleMaximumLoc
    || manifest.productionTs.limits?.finalTargetLoc !== manifest.productionTs.optimizationBaseline.totalLoc
    || stableJson(manifest.productionTs.gate) !== stableJson(expectedLocGate)) {
    throw new Error("production TypeScript optimization-cycle LOC gate is inconsistent");
  }
  if (!expectedLocGate.passed) {
    throw new Error(
      `production TypeScript LOC ${expectedLocGate.actualLoc} exceeds the fixed V3.2 optimization-cycle ceiling ${expectedLocGate.maximumLoc}`
    );
  }
  if (manifest.comparison?.optimizationBaselineCommit !== manifest.productionTs.optimizationBaseline.source.commit
    || manifest.comparison?.optimizationBaselineTree !== manifest.productionTs.optimizationBaseline.source.executableTree) {
    throw new Error("production TypeScript optimization baseline identity is inconsistent");
  }
  validateTaskLedger(manifest.taskLedger, manifest.productionTs.old, manifest.productionTs.new);
  validateTaskLedgerEvidenceDescriptor(manifest.taskLedgerEvidence);
  validateDependencyEvidence(manifest.dependencies);
  if (manifest.diagnosticRpcEvidence !== undefined) validateDiagnosticRpcEvidence(manifest.diagnosticRpcEvidence);
  if (manifest.diagnosticRpcEvidence === undefined && manifest.diagnosticRpcGate !== undefined) {
    throw new Error("V3.2 diagnostic JavaIndex RPC gate has no evidence descriptor");
  }
  if (manifest.diagnosticRpcEvidence !== undefined
    && stableJson(manifest.diagnosticRpcGate) !== stableJson(manifest.diagnosticRpcEvidence.gate)) {
    throw new Error("V3.2 diagnostic JavaIndex RPC gate is inconsistent with its evidence");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("V3.2 optimization manifest has no artifact inventory");
  }
  const statusClaimsPass = manifest.status === "PASS";
  const sprintGatePassed = manifest.coldGate?.passed === true
    && (manifest.diagnosticRpcGate?.passed ?? true) === true;
  if (statusClaimsPass !== sprintGatePassed
    || (manifest.status === "BASELINE_RECORDED_WITH_GAPS" && manifest.coldGate?.allowFailure !== true)
    || typeof manifest.coldGate?.manifestFile !== "string"
    || typeof manifest.coldGate?.matrixDir !== "string"
    || !Number.isInteger(manifest.coldGate?.expectedRuns)
    || !(Number.isFinite(manifest.coldGate?.p95Limit) && manifest.coldGate.p95Limit > 0)) {
    throw new Error("V3.2 cold-gate evidence is incomplete or inconsistent");
  }
  return true;
}

function validateTaskLedger(taskLedger, oldInventory, newInventory) {
  if (!Array.isArray(taskLedger)) throw new Error("V3.2 task LOC ledger is missing");
  const oldFiles = new Map(oldInventory.files.map(file => [file.path, file]));
  const newFiles = new Map(newInventory.files.map(file => [file.path, file]));
  const expectedPaths = new Set([...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .filter(filePath => (oldFiles.get(filePath)?.sha256 ?? null) !== (newFiles.get(filePath)?.sha256 ?? null)));
  const coveredPaths = new Set();
  let ledgerAdded = 0;
  let ledgerRemoved = 0;

  for (const entry of taskLedger) {
    if (!entry || typeof entry.task !== "string" || entry.task.length === 0
      || !isNonNegativeInteger(entry.productionLocAdded)
      || !isNonNegativeInteger(entry.productionLocRemoved)
      || !Number.isInteger(entry.netProductionLoc)
      || !Array.isArray(entry.paths)) {
      throw new Error("V3.2 task LOC ledger contains an invalid entry");
    }
    if (entry.productionLocAdded > 0
      && (!(typeof entry.repaymentTask === "string" && entry.repaymentTask.length > 0)
        || !(typeof entry.repaymentDecision === "string" && entry.repaymentDecision.length > 0))) {
      throw new Error(`V3.2 task LOC ledger has no repayment gate: ${entry.task}`);
    }
    let entryAdded = 0;
    let entryRemoved = 0;
    for (const pathEntry of entry.paths) {
      if (!pathEntry || typeof pathEntry.path !== "string"
        || !isNonNegativeInteger(pathEntry.oldLoc)
        || !isNonNegativeInteger(pathEntry.newLoc)
        || !isNonNegativeInteger(pathEntry.addedLoc)
        || !isNonNegativeInteger(pathEntry.removedLoc)
        || !Number.isInteger(pathEntry.netLoc)
        || pathEntry.contentChanged !== true) {
        throw new Error(`V3.2 task LOC ledger contains an invalid path entry: ${entry.task}`);
      }
      if (coveredPaths.has(pathEntry.path)) {
        throw new Error(`V3.2 task LOC ledger covers a path more than once: ${pathEntry.path}`);
      }
      const oldLoc = oldFiles.get(pathEntry.path)?.loc ?? 0;
      const newLoc = newFiles.get(pathEntry.path)?.loc ?? 0;
      const addedLoc = Math.max(0, newLoc - oldLoc);
      const removedLoc = Math.max(0, oldLoc - newLoc);
      if (!expectedPaths.has(pathEntry.path)
        || pathEntry.oldLoc !== oldLoc
        || pathEntry.newLoc !== newLoc
        || pathEntry.addedLoc !== addedLoc
        || pathEntry.removedLoc !== removedLoc
        || pathEntry.netLoc !== newLoc - oldLoc) {
        throw new Error(`V3.2 task LOC ledger path does not match source inventories: ${pathEntry.path}`);
      }
      coveredPaths.add(pathEntry.path);
      entryAdded += addedLoc;
      entryRemoved += removedLoc;
    }
    if (entry.productionLocAdded !== entryAdded
      || entry.productionLocRemoved !== entryRemoved
      || entry.netProductionLoc !== entryAdded - entryRemoved) {
      throw new Error(`V3.2 task LOC ledger totals are inconsistent: ${entry.task}`);
    }
    ledgerAdded += entryAdded;
    ledgerRemoved += entryRemoved;
  }

  const uncovered = [...expectedPaths].filter(filePath => !coveredPaths.has(filePath));
  if (uncovered.length > 0) {
    throw new Error(`V3.2 task LOC ledger does not cover production paths: ${uncovered.join(", ")}`);
  }
  if (ledgerAdded - ledgerRemoved !== newInventory.totalLoc - oldInventory.totalLoc) {
    throw new Error("V3.2 task LOC ledger does not reconcile the production LOC delta");
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export async function verifyOptimizationManifest({ manifestFile, candidateRoot = scriptRoot }) {
  const manifest = JSON.parse(await readFile(path.resolve(manifestFile), "utf8"));
  validateOptimizationManifest(manifest);
  await verifyTaskLedgerEvidence(manifest.taskLedgerEvidence, manifest.taskLedger);
  const optimizationBaseline = await countProductionTs({
    root: candidateRoot,
    revision: V4_OPTIMIZATION_BASELINE_COMMIT
  });
  assertSameInventory(
    manifest.productionTs.optimizationBaseline,
    optimizationBaseline,
    "optimization baseline production TypeScript"
  );
  const baseline = await countProductionTs({ root: candidateRoot, revision: manifest.comparison.baselineCommit });
  assertSameInventory(manifest.productionTs.old, baseline, "old production TypeScript");
  await withReplayedCandidate(candidateRoot, manifest.comparison, async candidateRoot => {
    const candidate = await countProductionTs({ root: candidateRoot });
    assertSameInventory(manifest.productionTs.new, candidate, "new production TypeScript");
    const environment = await environmentIdentity(candidateRoot);
    if (stableJson(manifest.environment) !== stableJson(environment)) {
      throw new Error("runtime environment drift");
    }
  });
  const cold = verifyMatrix({
    matrixDir: manifest.coldGate.matrixDir,
    manifestFile: manifest.coldGate.manifestFile,
    expectedRuns: manifest.coldGate.expectedRuns,
    p95Limit: manifest.coldGate.p95Limit,
    summaryFile: false
  });
  const expectedCold = {
    passed: manifest.coldGate.passed,
    inputSha256: manifest.coldGate.inputSha256,
    projects: manifest.coldGate.projects,
    configuration: manifest.coldGate.configuration
  };
  const actualCold = {
    passed: cold.passed,
    inputSha256: cold.inputSha256,
    projects: cold.projects,
    configuration: cold.configuration
  };
  if (stableJson(expectedCold) !== stableJson(actualCold)) throw new Error("cold matrix verification drift");
  if (manifest.diagnosticRpcEvidence) {
    const coldManifestFile = path.resolve(manifest.coldGate.manifestFile);
    const coldManifestBytes = await readFile(coldManifestFile);
    const coldManifestSha256 = sha256(coldManifestBytes);
    if (path.resolve(manifest.diagnosticRpcEvidence.coldManifestFile) !== coldManifestFile
      || manifest.diagnosticRpcEvidence.coldManifestSha256 !== coldManifestSha256) {
      throw new Error("diagnostic JavaIndex RPC evidence is not bound to the verified cold manifest");
    }
    const sidecarBytes = await readFile(manifest.diagnosticRpcEvidence.file);
    if (sidecarBytes.byteLength !== manifest.diagnosticRpcEvidence.bytes
      || sha256(sidecarBytes) !== manifest.diagnosticRpcEvidence.sha256) {
      throw new Error("diagnostic JavaIndex RPC sidecar descriptor drift");
    }
    const observed = await verifyJavaIndexRpcSidecar({ sidecarFile: manifest.diagnosticRpcEvidence.file });
    if (observed.payloadSha256 !== manifest.diagnosticRpcEvidence.payloadSha256
      || observed.role !== manifest.diagnosticRpcEvidence.role
      || observed.scope !== manifest.diagnosticRpcEvidence.scope
      || observed.cells.length !== manifest.diagnosticRpcEvidence.cellCount
      || stableJson(observed.diagnosticRpcGate) !== stableJson(manifest.diagnosticRpcEvidence.gate)
      || path.resolve(observed.sourceLock.coldManifest.file) !== coldManifestFile
      || observed.sourceLock.coldManifest.sha256 !== coldManifestSha256) {
      throw new Error("diagnostic JavaIndex RPC sidecar payload drift");
    }
  }
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(artifact.file);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`artifact drift: ${artifact.file}`);
    }
  }
  return manifest;
}

export function optimizationCommandResult(manifest, extra = {}) {
  return {
    ...extra,
    verificationStatus: "PASS",
    resultStatus: manifest.status,
    coldGatePassed: manifest.coldGate.passed,
    diagnosticRpcGatePassed: manifest.diagnosticRpcGate?.passed ?? null,
    productionLocGatePassed: manifest.productionTs.gate.passed,
    manifestPayloadSha256: manifest.manifestPayloadSha256
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (cli.verify) {
    const manifest = await verifyOptimizationManifest({ manifestFile: cli.verify, candidateRoot: cli.candidateRoot });
    console.log(JSON.stringify(optimizationCommandResult(manifest)));
    return;
  }

  const outputDir = path.resolve(cli.outputDir);
  await assertOutputOutsideSource(cli.candidateRoot, outputDir);
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  await mkdir(outputDir, { recursive: true });
  const { taskLedger, taskLedgerEvidence } = await snapshotTaskLedger(cli.taskLedgerFile, outputDir);
  const coldDir = path.join(outputDir, "cold");
  await runColdMatrix({ ...cli, outputDir: coldDir });
  const manifest = await buildManifestFromCold({
    candidateRoot: cli.candidateRoot,
    optimizationBaseline: cli.optimizationBaseline,
    baseline: cli.baseline,
    coldDir,
    taskLedger,
    taskLedgerEvidence,
    diagnosticRpcSidecar: cli.diagnosticRpcSidecar,
    allowColdGateFailure: cli.allowColdGateFailure,
    p95Limit: cli.p95Limit
  });
  const manifestFile = path.join(outputDir, "optimization-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyOptimizationManifest({ manifestFile, candidateRoot: cli.candidateRoot });
  console.log(JSON.stringify(optimizationCommandResult(manifest, { manifestFile })));
}

export async function buildManifestFromCold({
  candidateRoot,
  optimizationBaseline,
  baseline,
  coldDir,
  taskLedger = [],
  taskLedgerEvidence,
  diagnosticRpcSidecar = false,
  allowColdGateFailure = false,
  p95Limit = 1.25
}) {
  const coldManifestFile = path.resolve(coldDir, "run-manifest.json");
  const coldSummaryFile = path.resolve(coldDir, "matrix-summary.json");
  const coldManifestBytes = await readFile(coldManifestFile);
  const coldManifestSha256 = sha256(coldManifestBytes);
  const coldManifest = JSON.parse(coldManifestBytes.toString("utf8"));
  const coldSummary = JSON.parse(await readFile(coldSummaryFile, "utf8"));
  const diagnosticRpcFile = path.resolve(coldDir, "diagnostic-java-index-rpc", "java-index-rpc-sidecar.json");
  const coldRequestedDiagnosticRpc = coldManifest?.diagnosticRpc?.requested === true;
  if (coldRequestedDiagnosticRpc !== diagnosticRpcSidecar) {
    throw new Error("diagnostic JavaIndex RPC request does not match the cold manifest");
  }
  if (diagnosticRpcSidecar && !existsSync(diagnosticRpcFile)) {
    throw new Error("diagnostic JavaIndex RPC sidecar was requested but not produced");
  }
  if (!diagnosticRpcSidecar && existsSync(diagnosticRpcFile)) {
    throw new Error("unrequested diagnostic JavaIndex RPC sidecar is present");
  }
  const diagnosticRpc = diagnosticRpcSidecar
    ? await verifyJavaIndexRpcSidecar({ sidecarFile: diagnosticRpcFile })
    : undefined;
  if (diagnosticRpc
    && (path.resolve(diagnosticRpc.sourceLock.coldManifest.file) !== coldManifestFile
      || diagnosticRpc.sourceLock.coldManifest.sha256 !== coldManifestSha256)) {
    throw new Error("diagnostic JavaIndex RPC sidecar is not bound to this cold manifest");
  }
  const diagnosticRpcBytes = diagnosticRpc ? await readFile(diagnosticRpcFile) : undefined;
  const diagnosticRpcEvidence = diagnosticRpc && diagnosticRpcBytes ? {
    file: diagnosticRpcFile,
    bytes: diagnosticRpcBytes.byteLength,
    sha256: sha256(diagnosticRpcBytes),
    payloadSha256: diagnosticRpc.payloadSha256,
    role: diagnosticRpc.role,
    scope: diagnosticRpc.scope,
    cellCount: diagnosticRpc.cells.length,
    coldManifestFile,
    coldManifestSha256,
    gate: diagnosticRpc.diagnosticRpcGate
  } : undefined;
  if (optimizationBaseline !== V4_OPTIMIZATION_BASELINE_COMMIT) {
    throw new Error(`optimization baseline must be ${V4_OPTIMIZATION_BASELINE_COMMIT}`);
  }
  const optimizationBaselineProductionTs = await countProductionTs({
    root: candidateRoot,
    revision: V4_OPTIMIZATION_BASELINE_COMMIT
  });
  validateFrozenOptimizationBaselineInventory(optimizationBaselineProductionTs);
  const baselineProductionTs = await countProductionTs({ root: candidateRoot, revision: baseline });
  let candidateProductionTs;
  let environment;
  await withReplayedCandidate(candidateRoot, {
    candidateBaseCommit: coldManifest.runtimes.new.commit,
    candidateCommitTree: coldManifest.runtimes.new.commitTree,
    candidateExecutableTree: coldManifest.runtimes.new.executableTree,
    candidatePatchFile: coldManifest.candidatePatch.file,
    candidatePatchSha256: coldManifest.candidatePatch.sha256
  }, async replayRoot => {
    candidateProductionTs = await countProductionTs({ root: replayRoot });
    environment = await environmentIdentity(replayRoot);
  });
  const artifacts = await artifactInventory(
    coldManifestFile,
    coldSummaryFile,
    coldSummary,
    coldManifest,
    taskLedgerEvidence,
    diagnosticRpcEvidence,
    diagnosticRpc
  );
  return createOptimizationManifest({
    optimizationBaselineProductionTs,
    baselineProductionTs,
    candidateProductionTs,
    coldManifest,
    coldSummary,
    environment,
    artifacts,
    taskLedger,
    taskLedgerEvidence,
    diagnosticRpcEvidence,
    allowColdGateFailure,
    coldEvidence: {
      manifestFile: coldManifestFile,
      matrixDir: path.resolve(coldDir, "matrix"),
      p95Limit
    }
  });
}

async function environmentIdentity(root) {
  const packageJsonBytes = await readFile(path.join(root, "package.json"));
  const packageLockBytes = await readFile(path.join(root, "package-lock.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  const packageVersion = name => packageLock.packages?.[`node_modules/${name}`]?.version
    ?? packageJson.dependencies?.[name]
    ?? packageJson.devDependencies?.[name]
    ?? "UNMEASURED";
  return {
    node: { version: process.version, execPath: process.execPath },
    platform: process.platform,
    arch: process.arch,
    jdt: { state: "DISABLED_FOR_COLD", binary: "/usr/bin/false", version: "UNMEASURED" },
    treeSitter: {
      runtime: packageVersion("tree-sitter"),
      javaGrammar: packageVersion("tree-sitter-java")
    },
    typescript: packageVersion("typescript"),
    packageJsonSha256: sha256(packageJsonBytes),
    packageLockSha256: sha256(packageLockBytes)
  };
}

async function withReplayedCandidate(sourceRoot, comparison, action) {
  const commit = comparison?.candidateBaseCommit;
  const commitTree = comparison?.candidateCommitTree;
  const executableTree = comparison?.candidateExecutableTree;
  const patchFile = comparison?.candidatePatchFile;
  const patchSha256 = comparison?.candidatePatchSha256;
  if (!(typeof commit === "string" && typeof commitTree === "string" && typeof executableTree === "string"
    && typeof patchFile === "string" && typeof patchSha256 === "string")) {
    throw new Error("candidate replay identity is incomplete");
  }
  const patch = await readFile(path.resolve(patchFile));
  if (sha256(patch) !== patchSha256) throw new Error("candidate replay patch hash mismatch");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-java-v32-candidate-replay-"));
  const replayRoot = path.join(temporaryRoot, "candidate");
  try {
    await createDetachedLocalClone(sourceRoot, replayRoot, commit, runCommand);
    const observedCommit = (await captureCommand("git", ["-C", replayRoot, "rev-parse", "HEAD^{commit}"])).trim();
    const observedCommitTree = (await captureCommand("git", ["-C", replayRoot, "rev-parse", "HEAD^{tree}"])).trim();
    if (observedCommit !== commit || observedCommitTree !== commitTree) {
      throw new Error("candidate replay base commit/tree mismatch");
    }
    if (patch.byteLength > 0) await runCommand("git", ["-C", replayRoot, "apply", "--index", path.resolve(patchFile)]);
    const observedExecutableTree = (await captureCommand("git", ["-C", replayRoot, "write-tree"])).trim();
    if (observedExecutableTree !== executableTree) throw new Error("candidate replay executable tree mismatch");
    return await action(replayRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function artifactInventory(
  coldManifestFile,
  coldSummaryFile,
  coldSummary,
  coldManifest,
  taskLedgerEvidence,
  diagnosticRpcEvidence,
  diagnosticRpc
) {
  const files = new Set([coldManifestFile, coldSummaryFile]);
  if (taskLedgerEvidence?.file) files.add(path.resolve(taskLedgerEvidence.file));
  if (coldManifest?.candidatePatch?.file) files.add(path.resolve(coldManifest.candidatePatch.file));
  for (const input of coldManifest?.candidatePatch?.untrackedInputs ?? []) {
    if (input?.file) files.add(path.resolve(input.file));
  }
  for (const suite of ["dist", "scripts"]) {
    const result = coldManifest?.candidateTests?.[suite];
    if (result?.stdout?.file) files.add(path.resolve(result.stdout.file));
    if (result?.stderr?.file) files.add(path.resolve(result.stderr.file));
  }
  for (const cell of coldSummary.cells ?? []) {
    files.add(path.resolve(cell.file));
    files.add(path.resolve(`${cell.file}.stderr`));
  }
  if (diagnosticRpcEvidence?.file) files.add(path.resolve(diagnosticRpcEvidence.file));
  for (const cell of diagnosticRpc?.cells ?? []) {
    files.add(path.resolve(cell.file));
    files.add(path.resolve(cell.stderrFile));
  }
  const result = [];
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const bytes = await readFile(file);
    result.push({ file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return result;
}

async function snapshotTaskLedger(sourceFile, outputDir) {
  const source = sourceFile ? path.resolve(sourceFile) : undefined;
  const bytes = source ? await readFile(source) : Buffer.from("[]\n");
  let taskLedger;
  try {
    taskLedger = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse V3.2 task LOC ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(taskLedger)) throw new Error("V3.2 task LOC ledger must be a JSON array");
  const file = path.join(outputDir, "task-ledger.json");
  await writeFile(file, bytes);
  return {
    taskLedger,
    taskLedgerEvidence: {
      file,
      sourceFile: source ?? null,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    }
  };
}

function validateTaskLedgerEvidenceDescriptor(evidence) {
  if (!evidence
    || typeof evidence.file !== "string" || !path.isAbsolute(evidence.file)
    || !(evidence.sourceFile === null || (typeof evidence.sourceFile === "string" && path.isAbsolute(evidence.sourceFile)))
    || !isNonNegativeInteger(evidence.bytes)
    || !sha256Value(evidence.sha256)) {
    throw new Error("V3.2 task LOC ledger evidence is invalid");
  }
}

async function verifyTaskLedgerEvidence(evidence, expectedLedger) {
  const bytes = await readFile(evidence.file);
  if (bytes.byteLength !== evidence.bytes || sha256(bytes) !== evidence.sha256) {
    throw new Error("V3.2 task LOC ledger evidence drift");
  }
  let observed;
  try {
    observed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`V3.2 task LOC ledger evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(observed) || stableJson(observed) !== stableJson(expectedLedger)) {
    throw new Error("V3.2 task LOC ledger evidence does not match the manifest ledger");
  }
}

function validateDependencyEvidence(dependencies) {
  const inventory = dependencies?.inventory;
  if (dependencies?.copyMode !== "private-content-verified-copy"
    || !inventory
    || inventory.schemaVersion !== 1
    || inventory.algorithm !== "sha256-path-type-size-content-v1"
    || !isNonNegativeInteger(inventory.fileCount)
    || !isNonNegativeInteger(inventory.directoryCount)
    || !isNonNegativeInteger(inventory.symlinkCount)
    || !isNonNegativeInteger(inventory.totalBytes)
    || !sha256Value(inventory.sha256)) {
    throw new Error("V3.2 isolated dependency evidence is invalid");
  }
}

function validateDiagnosticRpcEvidence(evidence) {
  if (!evidence
    || typeof evidence.file !== "string" || !path.isAbsolute(evidence.file)
    || !isNonNegativeInteger(evidence.bytes)
    || !sha256Value(evidence.sha256)
    || !sha256Value(evidence.payloadSha256)
    || evidence.role !== JAVA_INDEX_RPC_SIDECAR_ROLE
    || evidence.scope !== "STEADY_IMPACT_REQUESTS_ONLY_EXCLUDES_INDEX_PREPARE"
    || evidence.cellCount !== 18
    || typeof evidence.coldManifestFile !== "string" || !path.isAbsolute(evidence.coldManifestFile)
    || !sha256Value(evidence.coldManifestSha256)) {
    throw new Error("V3.2 diagnostic JavaIndex RPC evidence is invalid");
  }
  validateDiagnosticRpcGate(evidence.gate);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors = [];
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}: ${Buffer.concat(errors).toString("utf8")}`)));
  });
}

function captureCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve(Buffer.concat(output).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}: ${Buffer.concat(errors).toString("utf8")}`)));
  });
}

function validateProductionInventory(value, label) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error(`${label} production TypeScript inventory is invalid`);
  }
  const fileCount = value.files.length;
  const totalBytes = value.files.reduce((sum, file) => sum + file.bytes, 0);
  const totalLoc = value.files.reduce((sum, file) => sum + file.loc, 0);
  if (value.fileCount !== fileCount || value.totalBytes !== totalBytes || value.totalLoc !== totalLoc) {
    throw new Error(`${label} production TypeScript totals are inconsistent`);
  }
  const inventoryPayload = {
    scope: value.scope,
    fileCount,
    totalBytes,
    totalLoc,
    files: value.files
  };
  if (value.inventorySha256 !== sha256(stableJson(inventoryPayload))) {
    throw new Error(`${label} production TypeScript inventory hash mismatch`);
  }
}

function validateFrozenOptimizationBaselineInventory(value) {
  if (value?.source?.kind !== "git-revision"
    || value?.source?.revision !== V4_OPTIMIZATION_BASELINE_COMMIT
    || value?.source?.commit !== V4_OPTIMIZATION_BASELINE_COMMIT
    || value?.source?.commitTree !== V4_OPTIMIZATION_BASELINE_TREE
    || value?.source?.executableTree !== V4_OPTIMIZATION_BASELINE_TREE
    || value.fileCount !== V4_OPTIMIZATION_BASELINE_FILE_COUNT
    || value.totalBytes !== V4_OPTIMIZATION_BASELINE_BYTES
    || value.totalLoc !== V4_OPTIMIZATION_BASELINE_LOC
    || value.inventorySha256 !== V4_OPTIMIZATION_BASELINE_INVENTORY_SHA256
    || Math.floor(value.totalLoc * 1.05) !== V4_OPTIMIZATION_CYCLE_MAXIMUM_LOC) {
    throw new Error("production TypeScript optimization baseline does not match the frozen V4 inventory");
  }
}

function assertSameInventory(expected, actual, label) {
  validateProductionInventory(expected, label);
  validateProductionInventory(actual, label);
  if (expected.inventorySha256 !== actual.inventorySha256) throw new Error(`${label} source inventory drift`);
}

function runColdMatrix(cli) {
  const args = [
    path.join(scriptRoot, "scripts", "run-three-repo-cold-matrix.mjs"),
    "--candidate-root", path.resolve(cli.candidateRoot),
    "--baseline", cli.baseline,
    "--lishuedu", cli.repositories.lishuedu,
    "--cipherlink", cli.repositories.cipherlink,
    "--exam-parent-v3", cli.repositories["exam-parent-v3"],
    "--runs", "5",
    "--p95-limit", String(cli.p95Limit),
    "--output-dir", cli.outputDir
  ];
  if (cli.diagnosticRpcSidecar) args.push("--diagnostic-rpc-sidecar");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: cli.candidateRoot,
      env: scrubHostNodeRuntimeState(process.env),
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", async code => {
      if (code === 0) return resolve();
      if (code === 1 && cli.allowColdGateFailure) {
        try {
          const summary = JSON.parse(await readFile(path.join(cli.outputDir, "matrix-summary.json"), "utf8"));
          if (summary?.passed === false) return resolve();
        } catch {
          // Fall through to the original process failure below.
        }
      }
      reject(new Error(`cold matrix exited with ${code}`));
    });
  });
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--allow-gate-failure" || key === "--diagnostic-rpc-sidecar") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  if (flags.has("--help")) return { help: true };
  const candidateRoot = path.resolve(options.get("--candidate-root") || scriptRoot);
  if (options.has("--verify")) {
    return { candidateRoot, verify: options.get("--verify") };
  }
  return {
    candidateRoot,
    optimizationBaseline: frozenOptimizationBaseline(options.get("--optimization-baseline")),
    baseline: required(options.get("--baseline"), "--baseline"),
    outputDir: required(options.get("--output-dir"), "--output-dir"),
    p95Limit: numeric(options.get("--p95-limit"), 1.25, "--p95-limit"),
    allowColdGateFailure: flags.has("--allow-gate-failure"),
    diagnosticRpcSidecar: flags.has("--diagnostic-rpc-sidecar"),
    taskLedgerFile: options.get("--task-ledger"),
    verify: options.get("--verify"),
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function frozenOptimizationBaseline(value) {
  const baseline = required(value, "--optimization-baseline");
  if (baseline !== V4_OPTIMIZATION_BASELINE_COMMIT) {
    throw new Error(`--optimization-baseline must be the frozen V4 baseline ${V4_OPTIMIZATION_BASELINE_COMMIT}`);
  }
  return baseline;
}

function numeric(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be numeric`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function printUsage() {
  console.log("Usage: node scripts/run-v32-optimization-matrix.mjs --optimization-baseline 4323b3cfead3a368b5a81c880176841d162ceced --baseline SHA --output-dir DIR --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--candidate-root DIR] [--task-ledger FILE] [--allow-gate-failure] [--diagnostic-rpc-sidecar]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
