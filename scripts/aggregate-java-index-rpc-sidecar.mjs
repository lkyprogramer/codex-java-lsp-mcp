#!/usr/bin/env node
// input: A source-locked cold manifest and matching diagnostic benchmark cells.
// output: A hash-bound JavaIndex RPC telemetry sidecar that is separate from the standard Token gate.
// pos: Sprint 2 diagnostic-only evidence extractor; never changes public ImpactResultV6 or standard matrix accounting.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMAL_REQUEST_DEADLINE_MS,
  MATRIX_PROJECTS,
  VERIFIER_VERSION
} from "./verify-three-repo-cold-matrix.mjs";

export const JAVA_INDEX_RPC_SIDECAR_SCHEMA_VERSION = 1;
export const JAVA_INDEX_RPC_SIDECAR_ROLE = "DIAGNOSTIC_ONLY_NOT_STANDARD_TOKEN_GATE";
const RUNTIME_STATE_KEYS = [
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "JAVA_LSP_CACHE_ROOT",
  "JDTLS_DATA_DIR",
  "JDTLS_LOG_DIR",
  "JAVA_LSP_PROJECTS_JSON",
  "GRADLE_USER_HOME",
  "MAVEN_USER_HOME"
];
export const DIAGNOSTIC_RPC_GATE_POLICY = Object.freeze({
  schemaVersion: 1,
  selection: "ALL_BASELINE_ROWS_WITH_TOTAL_JAVA_INDEX_RPC_GT_ZERO",
  latencyMetric: "REQUEST_ELAPSED_MS",
  minimumRpcCountReduction: 0.30,
  minimumAffectedP95Improvement: 0.20,
  implementerBatch: Object.freeze({
    baselineOperation: "QUERY_IMPLEMENTERS",
    minimumMedianFanoutExclusive: 1,
    minimumCallerWaitP95Ms: 10
  })
});

export async function aggregateJavaIndexRpcSidecar({ manifestFile, diagnosticDir, outputFile }) {
  const resolvedOutput = path.resolve(outputFile);
  const sidecar = await buildJavaIndexRpcSidecar({
    manifestFile: path.resolve(manifestFile),
    diagnosticDir: path.resolve(diagnosticDir),
    createdAt: new Date().toISOString()
  });
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  try {
    await writeFile(resolvedOutput, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`JavaIndex RPC sidecar already exists: ${resolvedOutput}`, { cause: error });
    }
    throw error;
  }
  return sidecar;
}

export async function verifyJavaIndexRpcSidecar({ sidecarFile }) {
  const file = path.resolve(sidecarFile);
  const observed = JSON.parse(await readFile(file, "utf8"));
  validateSidecarHeader(observed);
  const { payloadSha256, ...observedPayload } = observed;
  if (sha256(stableJson(observedPayload)) !== payloadSha256) {
    throw new Error("JavaIndex RPC sidecar payload hash mismatch");
  }
  validateCellMatrix(observed.cells);
  const coldManifestBytes = await readFile(observed.sourceLock.coldManifest.file);
  if (sha256(coldManifestBytes) !== observed.sourceLock.coldManifest.sha256) {
    throw new Error("JavaIndex RPC sidecar cold manifest hash drift");
  }
  const coldManifest = JSON.parse(coldManifestBytes.toString("utf8"));
  validateColdManifest(coldManifest);
  assertSourceIdentity(observed, coldManifest);
  const rebuilt = await buildFromDescriptors({
    coldManifest,
    manifestFile: observed.sourceLock.coldManifest.file,
    manifestSha256: observed.sourceLock.coldManifest.sha256,
    cells: observed.cells,
    createdAt: observed.createdAt
  });
  if (stableJson(rebuilt.cells) !== stableJson(observed.cells)) {
    throw new Error("JavaIndex RPC sidecar cell descriptor drift");
  }
  if (stableJson(rebuilt.aggregates) !== stableJson(observed.aggregates)) {
    throw new Error("JavaIndex RPC sidecar aggregate drift");
  }
  if (stableJson(rebuilt.diagnosticRpcGate) !== stableJson(observed.diagnosticRpcGate)) {
    throw new Error("JavaIndex RPC sidecar diagnostic gate drift");
  }
  if (rebuilt.payloadSha256 !== observed.payloadSha256) {
    throw new Error("JavaIndex RPC sidecar payload hash mismatch");
  }
  return observed;
}

async function buildJavaIndexRpcSidecar({ manifestFile, diagnosticDir, createdAt }) {
  const manifestBytes = await readFile(manifestFile);
  const coldManifest = JSON.parse(manifestBytes.toString("utf8"));
  validateColdManifest(coldManifest);
  const cells = [];
  for (let round = 1; round <= 3; round += 1) {
    for (const variant of ["old", "new"]) {
      for (const project of MATRIX_PROJECTS) {
        const file = path.join(diagnosticDir, "raw", `${project}-r${round}-${variant}.json`);
        cells.push({ project, round, variant, file, stderrFile: `${file}.stderr` });
      }
    }
  }
  return buildFromDescriptors({
    coldManifest,
    manifestFile,
    manifestSha256: sha256(manifestBytes),
    cells,
    createdAt
  });
}

function validateColdManifest(manifest) {
  if (!manifest
    || manifest.version !== VERIFIER_VERSION
    || manifest.verifierVersion !== VERIFIER_VERSION
    || !Number.isInteger(manifest.runs) || manifest.runs < 1
    || manifest.requestDeadlineMs !== FORMAL_REQUEST_DEADLINE_MS
    || stableJson(manifest.rounds) !== stableJson(["old/new", "new/old", "old/new"])
    || manifest.diagnosticRpc?.requested !== true
    || stableJson(manifest.diagnosticRpc?.gatePolicy) !== stableJson(DIAGNOSTIC_RPC_GATE_POLICY)
    || !sha256Value(manifest.candidatePatch?.sha256)) {
    throw new Error("JavaIndex RPC sidecar cold manifest is invalid");
  }
  validateRuntimeStateIsolation(manifest.diagnosticRpc);
  for (const variant of ["old", "new"]) {
    const runtime = manifest.runtimes?.[variant];
    if (!runtime
      || !nonEmpty(runtime.commit)
      || !nonEmpty(runtime.commitTree)
      || !nonEmpty(runtime.executableTree)
      || !runtime.buildStamp || typeof runtime.buildStamp !== "object") {
      throw new Error(`JavaIndex RPC sidecar cold manifest runtime is invalid: ${variant}`);
    }
  }
  for (const project of MATRIX_PROJECTS) {
    const repository = manifest.repositories?.[project];
    const scenario = manifest.scenarios?.[project];
    if (!repository
      || !nonEmpty(repository.root)
      || !nonEmpty(repository.head)
      || !nonEmpty(repository.tree)
      || !sha256Value(repository.statusSha256)
      || !scenario
      || !nonEmpty(scenario.file)
      || !sha256Value(scenario.sha256)
      || !Array.isArray(scenario.rowIds)
      || scenario.rowIds.length === 0
      || new Set(scenario.rowIds).size !== scenario.rowIds.length
      || scenario.rowIds.some(rowId => !nonEmpty(rowId))) {
      throw new Error(`JavaIndex RPC sidecar cold manifest project is invalid: ${project}`);
    }
  }
}

async function buildFromDescriptors({ coldManifest, manifestFile, manifestSha256, cells, createdAt }) {
  validateCellMatrix(cells);
  const parsedCells = [];
  for (const descriptor of cells) parsedCells.push(await readDiagnosticCell(descriptor, coldManifest, manifestSha256));
  const aggregates = aggregateCells(parsedCells);
  const diagnosticRpcGate = evaluateDiagnosticRpcGate(parsedCells, coldManifest.diagnosticRpc.gatePolicy);
  const payload = {
    schemaVersion: JAVA_INDEX_RPC_SIDECAR_SCHEMA_VERSION,
    kind: "java-index-rpc-diagnostic-sidecar",
    role: JAVA_INDEX_RPC_SIDECAR_ROLE,
    scope: "STEADY_IMPACT_REQUESTS_ONLY_EXCLUDES_INDEX_PREPARE",
    createdAt,
    sourceLock: {
      coldManifest: { file: path.resolve(manifestFile), sha256: manifestSha256 },
      runtimes: coldManifest.runtimes,
      repositories: coldManifest.repositories,
      scenarios: coldManifest.scenarios,
      runtimeState: coldManifest.diagnosticRpc.runtimeState,
      execution: {
        rounds: coldManifest.rounds,
        runs: coldManifest.runs,
        warmState: "cold-nolsp",
        strategy: "impact",
        verbosity: "diagnostic",
        semanticPolicy: "fast",
        deadlineMs: coldManifest.requestDeadlineMs,
        telemetry: coldManifest.diagnosticRpc.telemetryMode,
        cachePolicy: "private-diagnostic-cache-per-cell"
      }
    },
    cells: parsedCells.map(cell => cell.descriptor),
    aggregates,
    diagnosticRpcGate
  };
  return { ...payload, payloadSha256: sha256(stableJson(payload)) };
}

async function readDiagnosticCell(descriptor, coldManifest, manifestSha256) {
  const [rawBytes, stderrBytes] = await Promise.all([
    readFile(descriptor.file),
    readFile(descriptor.stderrFile)
  ]);
  if (stderrBytes.byteLength !== 0) throw new Error(`${descriptor.stderrFile}: diagnostic stderr must be empty`);
  const payload = JSON.parse(rawBytes.toString("utf8"));
  if (payload?.metadata?.verbosity !== "diagnostic"
    || payload.metadata.warmState !== "cold-nolsp"
    || payload.metadata.strategy !== "impact"
    || payload.metadata.semanticPolicy !== "fast"
    || payload.metadata.runs !== coldManifest.runs
    || payload.metadata.deadlineMs !== coldManifest.requestDeadlineMs) {
    throw new Error(`${descriptor.file}: diagnostic benchmark metadata is inconsistent`);
  }
  const provenance = payload.metadata.matrixProvenance;
  const runtime = coldManifest.runtimes?.[descriptor.variant];
  const repository = coldManifest.repositories?.[descriptor.project];
  const scenario = coldManifest.scenarios?.[descriptor.project];
  if (!provenance
    || provenance.manifestSha256 !== manifestSha256
    || provenance.round !== descriptor.round
    || provenance.variant !== descriptor.variant
    || provenance.runtimeCommit !== runtime?.commit
    || provenance.runtimeCommitTree !== runtime?.commitTree
    || provenance.runtimeExecutableTree !== runtime?.executableTree
    || provenance.candidatePatchSha256 !== coldManifest.candidatePatch?.sha256
    || provenance.repoHead !== repository?.head
    || provenance.repoTree !== repository?.tree
    || provenance.repoStatusSha256 !== repository?.statusSha256
    || provenance.scenarioSha256 !== scenario?.sha256
    || stableJson(provenance.scenarioIds) !== stableJson(scenario?.rowIds)) {
    throw new Error(`${descriptor.file}: diagnostic provenance does not match the cold manifest`);
  }
  if (payload.metadata.projectId !== descriptor.project
    || path.resolve(payload.metadata.repoRoot || "") !== path.resolve(repository?.root || "")
    || !(typeof payload.metadata.repoCommit === "string"
      && payload.metadata.repoCommit.length >= 12
      && repository?.head?.startsWith(payload.metadata.repoCommit))
    || path.resolve(payload.metadata.scenarioFile || "") !== path.resolve(scenario?.file || "")
    || stableJson(normalizeBuildStamp(payload.metadata.runtimeBuild)) !== stableJson(normalizeBuildStamp(runtime?.buildStamp))) {
    throw new Error(`${descriptor.file}: diagnostic metadata does not match the source lock`);
  }
  if (!Array.isArray(payload.rows)
    || stableJson(payload.rows.map(row => row.id)) !== stableJson(scenario?.rowIds)) {
    throw new Error(`${descriptor.file}: diagnostic row set does not match the cold manifest`);
  }
  const attempts = [];
  for (const row of payload.rows) {
    if (!Array.isArray(row.attempts) || row.attempts.length !== coldManifest.runs) {
      throw new Error(`${descriptor.file}: diagnostic run count does not match the cold manifest`);
    }
    for (let run = 0; run < row.attempts.length; run += 1) {
      const attempt = row.attempts[run];
      const rpc = attempt?.timing?.javaIndex?.rpc;
      if (rpc?.enabled !== true
        || rpc.payloadBytes !== "JSON_UTF8_ENVELOPE_ESTIMATE"
        || !rpc.operations
        || Array.isArray(rpc.operations)
        || typeof rpc.operations !== "object") {
        throw new Error(`${descriptor.file}: ${row.id} run ${run + 1} has no JavaIndex RPC telemetry`);
      }
      if (attempt.strategy !== "impact"
        || attempt.timing?.semantic?.policy !== "fast"
        || attempt.timing.semantic.used !== false
        || attempt.timing.semantic.timeout !== false) {
        throw new Error(`${descriptor.file}: ${row.id} run ${run + 1} violates diagnostic cold semantics`);
      }
      attempts.push({ scenarioId: row.id, run: run + 1, elapsedMs: nonNegativeFinite(attempt.elapsedMs), rpc });
    }
  }
  return {
    descriptor: {
      project: descriptor.project,
      round: descriptor.round,
      variant: descriptor.variant,
      file: path.resolve(descriptor.file),
      bytes: rawBytes.byteLength,
      sha256: sha256(rawBytes),
      stderrFile: path.resolve(descriptor.stderrFile),
      stderrBytes: stderrBytes.byteLength,
      stderrSha256: sha256(stderrBytes)
    },
    attempts
  };
}

function evaluateDiagnosticRpcGate(cells, policy) {
  const groups = new Map();
  for (const cell of cells) {
    for (const attempt of cell.attempts) {
      const key = `${cell.descriptor.project}\0${attempt.scenarioId}`;
      const group = groups.get(key) ?? {
        project: cell.descriptor.project,
        scenarioId: attempt.scenarioId,
        old: [],
        new: []
      };
      group[cell.descriptor.variant].push(attempt);
      groups.set(key, group);
    }
  }
  const selected = [...groups.values()]
    .filter(group => group.old.reduce((total, attempt) => total + totalRpcCount(attempt.rpc), 0) > 0)
    .sort((left, right) => left.project.localeCompare(right.project) || left.scenarioId.localeCompare(right.scenarioId));
  if (selected.length === 0) throw new Error("diagnostic JavaIndex RPC gate selected no affected baseline scenarios");

  const oldAttempts = [];
  const newAttempts = [];
  const perScenario = [];
  for (const group of selected) {
    if (group.old.length === 0 || group.old.length !== group.new.length) {
      throw new Error(`diagnostic JavaIndex RPC gate sample parity mismatch: ${group.project}/${group.scenarioId}`);
    }
    oldAttempts.push(...group.old);
    newAttempts.push(...group.new);
    perScenario.push(gateScenarioSummary(group));
  }

  const oldElapsed = distribution(oldAttempts.map(attempt => attempt.elapsedMs));
  const newElapsed = distribution(newAttempts.map(attempt => attempt.elapsedMs));
  if (!(oldElapsed.state === "MEASURED" && oldElapsed.p95 > 0)) {
    throw new Error("diagnostic JavaIndex RPC gate baseline P95 is not measurable");
  }
  const oldRpcCount = oldAttempts.reduce((total, attempt) => total + totalRpcCount(attempt.rpc), 0);
  const newRpcCount = newAttempts.reduce((total, attempt) => total + totalRpcCount(attempt.rpc), 0);
  if (oldRpcCount <= 0) throw new Error("diagnostic JavaIndex RPC gate baseline RPC count is zero");
  const rpcCountReduction = (oldRpcCount - newRpcCount) / oldRpcCount;
  const p95Improvement = (oldElapsed.p95 - newElapsed.p95) / oldElapsed.p95;
  const rpcCountPassed = rpcCountReduction >= policy.minimumRpcCountReduction;
  const affectedP95Passed = p95Improvement >= policy.minimumAffectedP95Improvement;
  const checks = {
    sampleParity: true,
    rpcCountReduction: rpcCountPassed,
    affectedP95Improvement: affectedP95Passed
  };
  const passed = Object.values(checks).every(Boolean);
  return {
    schemaVersion: 1,
    policy,
    selection: {
      policy: policy.selection,
      scenarios: selected.map(group => ({ project: group.project, scenarioId: group.scenarioId })),
      selectedScenarioCount: selected.length,
      attemptsPerVariant: oldAttempts.length
    },
    metrics: {
      old: { rpcCount: oldRpcCount, requestElapsedMs: oldElapsed },
      new: { rpcCount: newRpcCount, requestElapsedMs: newElapsed },
      rpcCountReduction,
      p95Improvement,
      perScenario
    },
    implementerBatch: implementerBatchDecision(oldAttempts, policy.implementerBatch),
    checks,
    passed,
    decision: passed
      ? "PASS"
      : !rpcCountPassed && !affectedP95Passed
        ? "REJECT_RPC_COUNT_AND_P95"
        : !rpcCountPassed
          ? "REJECT_RPC_COUNT"
          : "REJECT_AFFECTED_P95"
  };
}

function gateScenarioSummary(group) {
  const summarize = attempts => ({
    attempts: attempts.length,
    rpcCount: attempts.reduce((total, attempt) => total + totalRpcCount(attempt.rpc), 0),
    requestElapsedMs: distribution(attempts.map(attempt => attempt.elapsedMs))
  });
  return {
    project: group.project,
    scenarioId: group.scenarioId,
    old: summarize(group.old),
    new: summarize(group.new)
  };
}

function implementerBatchDecision(oldAttempts, policy) {
  const fanout = distribution(oldAttempts.map(attempt => operationMetric(attempt.rpc, policy.baselineOperation)?.count ?? 0));
  const callerWaitMs = distribution(oldAttempts.map(
    attempt => operationMetric(attempt.rpc, policy.baselineOperation)?.callerWait?.totalMs ?? 0
  ));
  const eligible = fanout.p50 > policy.minimumMedianFanoutExclusive
    && callerWaitMs.p95 >= policy.minimumCallerWaitP95Ms;
  return {
    state: "MEASURED",
    baselineOperation: policy.baselineOperation,
    fanout,
    callerWaitMs,
    exitDecision: eligible
      ? "ELIGIBLE_FOR_V3_2_12"
      : fanout.p50 <= policy.minimumMedianFanoutExclusive
        ? "DO_NOT_IMPLEMENT_MEDIAN_FANOUT_LE_ONE"
        : "DO_NOT_IMPLEMENT_CALLER_WAIT_LT_10MS"
  };
}

function totalRpcCount(rpc) {
  return Object.values(rpc.operations).reduce((total, operation) => total + operation.count, 0);
}

function operationMetric(rpc, operation) {
  return rpc.operations[operation];
}

function aggregateCells(cells) {
  const perCell = [];
  const scenarioGroups = new Map();
  const projectVariantGroups = new Map();
  for (const cell of cells) {
    perCell.push(finalizeAggregate(
      aggregateAttempts(cell.attempts),
      { project: cell.descriptor.project, round: cell.descriptor.round, variant: cell.descriptor.variant }
    ));
    for (const attempt of cell.attempts) {
      const scenarioKey = `${cell.descriptor.project}\0${cell.descriptor.variant}\0${attempt.scenarioId}`;
      appendGroup(scenarioGroups, scenarioKey, attempt, {
        project: cell.descriptor.project,
        variant: cell.descriptor.variant,
        scenarioId: attempt.scenarioId
      });
      const projectKey = `${cell.descriptor.project}\0${cell.descriptor.variant}`;
      appendGroup(projectVariantGroups, projectKey, attempt, {
        project: cell.descriptor.project,
        variant: cell.descriptor.variant
      });
    }
  }
  return {
    perCell,
    perScenario: [...scenarioGroups.values()].map(group => finalizeAggregate(aggregateAttempts(group.attempts), group.identity)),
    perProjectVariant: [...projectVariantGroups.values()].map(group => finalizeAggregate(aggregateAttempts(group.attempts), group.identity))
  };
}

function appendGroup(groups, key, attempt, identity) {
  const group = groups.get(key) ?? { identity, attempts: [] };
  group.attempts.push(attempt);
  groups.set(key, group);
}

function aggregateAttempts(attempts) {
  const operationNames = [...new Set(attempts.flatMap(attempt => Object.keys(attempt.rpc.operations)))].sort();
  const aggregate = {
    attempts: attempts.length,
    elapsedMs: attempts.map(attempt => attempt.elapsedMs),
    rpcCounts: [],
    operations: new Map()
  };
  for (const operation of operationNames) {
    aggregate.operations.set(operation, emptyOperationAggregate(attempts.length));
  }
  for (const attempt of attempts) {
    let attemptRpcCount = 0;
    for (const operation of operationNames) {
      const value = attempt.rpc.operations[operation];
      const operationAggregate = aggregate.operations.get(operation);
      if (value === undefined) {
        addAbsentOperation(operationAggregate);
        continue;
      }
      validateOperation(value, operation);
      attemptRpcCount += value.count;
      addOperation(operationAggregate, value);
    }
    aggregate.rpcCounts.push(attemptRpcCount);
  }
  return aggregate;
}

function addAbsentOperation(target) {
  target.countSamples.push(0);
  addKnownZeroDuration(target.callerWait);
  addKnownZeroDuration(target.workerQueue);
  addKnownZeroDuration(target.workerProcessing);
}

function addKnownZeroDuration(target) {
  target.measuredAttempts += 1;
  target.samples.push(0);
}

function emptyOperationAggregate(totalAttempts) {
  return {
    totalAttempts,
    measuredAttempts: 0,
    count: 0,
    inputJsonBytes: 0,
    outputJsonBytes: 0,
    outputMeasuredCount: 0,
    countSamples: [],
    callerWait: emptyDurationAggregate(totalAttempts),
    workerQueue: emptyDurationAggregate(totalAttempts),
    workerProcessing: emptyDurationAggregate(totalAttempts),
    maxWorkerQueueDepth: undefined,
    completed: 0,
    cancelled: 0,
    deadlineExceeded: 0,
    failed: 0,
    retired: 0,
    lateResponses: 0,
    retireReasons: {}
  };
}

function emptyDurationAggregate(totalAttempts) {
  return { totalAttempts, measuredAttempts: 0, measuredCalls: 0, totalMs: 0, maxMs: 0, samples: [] };
}

function addOperation(target, value) {
  target.measuredAttempts += 1;
  target.count += value.count;
  target.inputJsonBytes += value.inputJsonBytes;
  target.outputJsonBytes += value.outputJsonBytes;
  target.outputMeasuredCount += value.outputMeasuredCount;
  target.countSamples.push(value.count);
  addDurationAggregate(target.callerWait, value.callerWait, value.count === 0);
  addDurationAggregate(target.workerQueue, value.workerQueue, value.count === 0);
  addDurationAggregate(target.workerProcessing, value.workerProcessing, value.count === 0);
  if (Number.isFinite(value.maxWorkerQueueDepth)) {
    target.maxWorkerQueueDepth = Math.max(target.maxWorkerQueueDepth ?? 0, value.maxWorkerQueueDepth);
  }
  for (const field of ["completed", "cancelled", "deadlineExceeded", "failed", "retired", "lateResponses"]) {
    target[field] += value[field];
  }
  for (const [reason, count] of Object.entries(value.retireReasons ?? {})) {
    target.retireReasons[reason] = (target.retireReasons[reason] ?? 0) + count;
  }
}

function addDurationAggregate(target, value, knownZero) {
  if (!value) return;
  if (value.measuredCount === 0) {
    if (knownZero) addKnownZeroDuration(target);
    return;
  }
  target.measuredAttempts += 1;
  target.measuredCalls += value.measuredCount;
  target.totalMs += value.totalMs;
  target.maxMs = Math.max(target.maxMs, value.maxMs);
  target.samples.push(value.totalMs);
}

function finalizeAggregate(aggregate, identity) {
  return {
    ...identity,
    attempts: aggregate.attempts,
    diagnosticElapsedMs: distribution(aggregate.elapsedMs),
    rpcCount: distribution(aggregate.rpcCounts),
    operations: Object.fromEntries([...aggregate.operations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operation, value]) => [operation, finalizeOperation(value)]))
  };
}

function finalizeOperation(value) {
  return {
    totalAttempts: value.totalAttempts,
    measuredAttempts: value.measuredAttempts,
    count: value.count,
    perAttemptCount: distribution(value.countSamples),
    inputJsonBytes: value.inputJsonBytes,
    outputJsonBytes: value.outputJsonBytes,
    outputMeasuredCount: value.outputMeasuredCount,
    callerWait: finalizeDuration(value.callerWait),
    workerQueue: finalizeDuration(value.workerQueue),
    workerProcessing: finalizeDuration(value.workerProcessing),
    ...(value.maxWorkerQueueDepth === undefined ? {} : { maxWorkerQueueDepth: value.maxWorkerQueueDepth }),
    completed: value.completed,
    cancelled: value.cancelled,
    deadlineExceeded: value.deadlineExceeded,
    failed: value.failed,
    retired: value.retired,
    lateResponses: value.lateResponses,
    retireReasons: value.retireReasons
  };
}

function finalizeDuration(value) {
  if (value.measuredAttempts === 0) {
    return { state: "UNMEASURED", totalAttempts: value.totalAttempts, measuredAttempts: 0, measuredCalls: 0 };
  }
  return {
    state: value.measuredAttempts === value.totalAttempts ? "MEASURED" : "PARTIAL",
    totalAttempts: value.totalAttempts,
    measuredAttempts: value.measuredAttempts,
    measuredCalls: value.measuredCalls,
    totalMs: value.totalMs,
    maxMs: value.maxMs,
    perAttemptTotalMs: distribution(value.samples)
  };
}

function distribution(values) {
  if (values.length === 0) return { state: "UNMEASURED", count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    state: "MEASURED",
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function validateOperation(value, operation) {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || !nonNegativeInteger(value.count)
    || !nonNegativeInteger(value.inputJsonBytes)
    || !nonNegativeInteger(value.outputJsonBytes)
    || !nonNegativeInteger(value.outputMeasuredCount)
    || !duration(value.callerWait)
    || !["completed", "cancelled", "deadlineExceeded", "failed", "retired", "lateResponses"]
      .every(field => nonNegativeInteger(value[field]))
    || (value.maxWorkerQueueDepth !== undefined && !nonNegativeInteger(value.maxWorkerQueueDepth))
    || !Object.values(value.retireReasons ?? {}).every(nonNegativeInteger)) {
    throw new Error(`invalid JavaIndex RPC operation telemetry: ${operation}`);
  }
  if (value.workerQueue !== undefined && !duration(value.workerQueue)) throw new Error(`invalid workerQueue telemetry: ${operation}`);
  if (value.workerProcessing !== undefined && !duration(value.workerProcessing)) throw new Error(`invalid workerProcessing telemetry: ${operation}`);
  const terminalCount = value.completed + value.cancelled + value.deadlineExceeded + value.failed + value.retired;
  const observableResponseCount = value.count + value.lateResponses;
  const retireReasonCount = Object.values(value.retireReasons ?? {}).reduce((total, count) => total + count, 0);
  if (terminalCount !== value.count
    || value.callerWait.measuredCount !== value.count
    || value.outputMeasuredCount > observableResponseCount
    || (value.workerQueue?.measuredCount ?? 0) > observableResponseCount
    || (value.workerProcessing?.measuredCount ?? 0) > observableResponseCount
    || retireReasonCount > value.count) {
    throw new Error(`inconsistent JavaIndex RPC operation telemetry: ${operation}`);
  }
}

function duration(value) {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || !nonNegativeInteger(value.measuredCount)) return false;
  const totalMs = nonNegativeFinite(value.totalMs);
  const maxMs = nonNegativeFinite(value.maxMs);
  return value.measuredCount === 0 ? totalMs === 0 && maxMs === 0 : maxMs <= totalMs;
}

function validateSidecarHeader(sidecar) {
  if (!sidecar
    || sidecar.schemaVersion !== JAVA_INDEX_RPC_SIDECAR_SCHEMA_VERSION
    || sidecar.kind !== "java-index-rpc-diagnostic-sidecar"
    || sidecar.role !== JAVA_INDEX_RPC_SIDECAR_ROLE
    || sidecar.scope !== "STEADY_IMPACT_REQUESTS_ONLY_EXCLUDES_INDEX_PREPARE"
    || typeof sidecar.sourceLock?.coldManifest?.file !== "string"
    || !/^[a-f0-9]{64}$/.test(sidecar.sourceLock?.coldManifest?.sha256 ?? "")
    || !sidecar.sourceLock?.execution
    || !Array.isArray(sidecar.cells)
    || sidecar.cells.length !== MATRIX_PROJECTS.length * 6
    || typeof sidecar.createdAt !== "string" || !Number.isFinite(Date.parse(sidecar.createdAt))
    || typeof sidecar.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sidecar.payloadSha256)) {
    throw new Error("invalid JavaIndex RPC sidecar header");
  }
  validateDiagnosticRpcGate(sidecar.diagnosticRpcGate);
}

export function validateDiagnosticRpcGate(gate) {
  if (!gate
    || gate.schemaVersion !== 1
    || stableJson(gate.policy) !== stableJson(DIAGNOSTIC_RPC_GATE_POLICY)
    || gate.selection?.policy !== DIAGNOSTIC_RPC_GATE_POLICY.selection
    || !Array.isArray(gate.selection?.scenarios)
    || gate.selection.scenarios.length === 0
    || gate.selection.selectedScenarioCount !== gate.selection.scenarios.length
    || !nonNegativeInteger(gate.selection.attemptsPerVariant)
    || gate.selection.attemptsPerVariant === 0
    || !nonNegativeInteger(gate.metrics?.old?.rpcCount)
    || gate.metrics.old.rpcCount === 0
    || !nonNegativeInteger(gate.metrics?.new?.rpcCount)
    || !Number.isFinite(gate.metrics?.rpcCountReduction)
    || !Number.isFinite(gate.metrics?.p95Improvement)
    || gate.metrics?.old?.requestElapsedMs?.state !== "MEASURED"
    || gate.metrics?.new?.requestElapsedMs?.state !== "MEASURED"
    || typeof gate.passed !== "boolean"
    || typeof gate.decision !== "string"
    || typeof gate.checks?.sampleParity !== "boolean"
    || typeof gate.checks?.rpcCountReduction !== "boolean"
    || typeof gate.checks?.affectedP95Improvement !== "boolean"
    || gate.passed !== Object.values(gate.checks).every(Boolean)
    || gate.implementerBatch?.state !== "MEASURED"
    || gate.implementerBatch?.baselineOperation !== DIAGNOSTIC_RPC_GATE_POLICY.implementerBatch.baselineOperation
    || !["ELIGIBLE_FOR_V3_2_12", "DO_NOT_IMPLEMENT_MEDIAN_FANOUT_LE_ONE", "DO_NOT_IMPLEMENT_CALLER_WAIT_LT_10MS"]
      .includes(gate.implementerBatch?.exitDecision)) {
    throw new Error("invalid diagnostic JavaIndex RPC gate");
  }
  return true;
}

function validateCellMatrix(cells) {
  if (!Array.isArray(cells) || cells.length !== MATRIX_PROJECTS.length * 6) {
    throw new Error("JavaIndex RPC sidecar must contain exactly 18 diagnostic cells");
  }
  const expected = [];
  for (let round = 1; round <= 3; round += 1) {
    for (const variant of ["old", "new"]) {
      for (const project of MATRIX_PROJECTS) expected.push(`${project}\0${round}\0${variant}`);
    }
  }
  const observed = cells.map(cell => {
    if (!cell || !MATRIX_PROJECTS.includes(cell.project)
      || ![1, 2, 3].includes(cell.round)
      || !["old", "new"].includes(cell.variant)
      || typeof cell.file !== "string"
      || typeof cell.stderrFile !== "string") {
      throw new Error("JavaIndex RPC sidecar contains an invalid cell descriptor");
    }
    return `${cell.project}\0${cell.round}\0${cell.variant}`;
  });
  if (stableJson([...observed].sort()) !== stableJson([...expected].sort())) {
    throw new Error("JavaIndex RPC sidecar diagnostic cell matrix is incomplete or duplicated");
  }
}

function assertSourceIdentity(sidecar, coldManifest) {
  if (!sidecar.sourceLock || !sidecar.sourceLock.execution || !sidecar.sourceLock.coldManifest
    || stableJson(sidecar.sourceLock.runtimes) !== stableJson(coldManifest.runtimes)
    || stableJson(sidecar.sourceLock.repositories) !== stableJson(coldManifest.repositories)
    || stableJson(sidecar.sourceLock.scenarios) !== stableJson(coldManifest.scenarios)
    || stableJson(sidecar.sourceLock.runtimeState) !== stableJson(coldManifest.diagnosticRpc.runtimeState)
    || sidecar.sourceLock.execution.runs !== coldManifest.runs
    || stableJson(sidecar.sourceLock.execution.rounds) !== stableJson(coldManifest.rounds)
    || sidecar.sourceLock.execution.warmState !== "cold-nolsp"
    || sidecar.sourceLock.execution.strategy !== "impact"
    || sidecar.sourceLock.execution.verbosity !== "diagnostic"
    || sidecar.sourceLock.execution.semanticPolicy !== "fast"
    || sidecar.sourceLock.execution.deadlineMs !== coldManifest.requestDeadlineMs
    || stableJson(sidecar.sourceLock.execution.telemetry) !== stableJson({ standard: "0", diagnostic: "1" })
    || sidecar.sourceLock.execution.cachePolicy !== "private-diagnostic-cache-per-cell") {
    throw new Error("JavaIndex RPC sidecar source identity drift");
  }
}

function validateRuntimeStateIsolation(diagnosticRpc) {
  const standard = diagnosticRpc?.runtimeState?.standard;
  const diagnostic = diagnosticRpc?.runtimeState?.diagnostic;
  if (!validRuntimeStateDescriptor(standard) || !validRuntimeStateDescriptor(diagnostic)
    || stableJson(diagnosticRpc?.telemetryMode) !== stableJson({ standard: "0", diagnostic: "1" })) {
    throw new Error("JavaIndex RPC sidecar cold manifest runtime state is invalid");
  }
  const standardPaths = RUNTIME_STATE_KEYS.map(key => path.resolve(standard[key]));
  const diagnosticPaths = RUNTIME_STATE_KEYS.map(key => path.resolve(diagnostic[key]));
  for (const standardPath of standardPaths) {
    for (const diagnosticPath of diagnosticPaths) {
      if (pathsOverlap(standardPath, diagnosticPath)) {
        throw new Error(`JavaIndex RPC sidecar runtime state overlaps: ${standardPath} <-> ${diagnosticPath}`);
      }
    }
  }
}

function validRuntimeStateDescriptor(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...RUNTIME_STATE_KEYS].sort())
    && RUNTIME_STATE_KEYS.every(key => typeof value[key] === "string" && path.isAbsolute(value[key]));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function finite(value) {
  if (!Number.isFinite(value)) throw new Error(`expected a finite number, received ${String(value)}`);
  return value;
}

function nonNegativeFinite(value) {
  const observed = finite(value);
  if (observed < 0) throw new Error(`expected a non-negative number, received ${String(value)}`);
  return observed;
}

function normalizeBuildStamp(value) {
  if (!value || typeof value !== "object") return value;
  const { stampPath: _stampPath, ...stamp } = value;
  return stamp;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function sha256Value(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key]) ]));
}

export function parseCli(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const allowed = new Set(["--manifest", "--diagnostic-dir", "--output"]);
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new Error("JavaIndex RPC sidecar options must be provided as flag/value pairs");
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`unknown JavaIndex RPC sidecar option: ${name}`);
    if (options.has(name)) throw new Error(`duplicate JavaIndex RPC sidecar option: ${name}`);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options.set(name, value);
  }
  const required = name => {
    const value = options.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    manifestFile: required("--manifest"),
    diagnosticDir: required("--diagnostic-dir"),
    outputFile: required("--output")
  };
}

function printUsage() {
  console.log("Usage: node scripts/aggregate-java-index-rpc-sidecar.mjs --manifest FILE --diagnostic-dir DIR --output FILE");
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  const sidecar = await aggregateJavaIndexRpcSidecar(cli);
  console.log(JSON.stringify({ sidecarFile: path.resolve(cli.outputFile), payloadSha256: sidecar.payloadSha256 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
