import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateJavaIndexRpcSidecar,
  DIAGNOSTIC_RPC_GATE_POLICY,
  parseCli,
  verifyJavaIndexRpcSidecar
} from "./aggregate-java-index-rpc-sidecar.mjs";
import {
  FORMAL_REQUEST_DEADLINE_MS,
  VERIFIER_VERSION
} from "./verify-three-repo-cold-matrix.mjs";

const projects = ["lishuedu", "cipherlink", "exam-parent-v3"];

test("RPC sidecar binds diagnostic cells and aggregates operations separately from the standard gate", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root);
  const sidecarFile = path.join(root, "rpc", "sidecar.json");

  const sidecar = await aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: sidecarFile
  });
  const old = sidecar.aggregates.perProjectVariant.find(row => row.project === "lishuedu" && row.variant === "old");
  const current = sidecar.aggregates.perProjectVariant.find(row => row.project === "lishuedu" && row.variant === "new");
  assert.equal(sidecar.cells.length, 18);
  assert.equal(sidecar.role, "DIAGNOSTIC_ONLY_NOT_STANDARD_TOKEN_GATE");
  assert.equal(sidecar.scope, "STEADY_IMPACT_REQUESTS_ONLY_EXCLUDES_INDEX_PREPARE");
  assert.equal(sidecar.diagnosticRpcGate.passed, true);
  assert.equal(sidecar.diagnosticRpcGate.metrics.rpcCountReduction, 8 / 18);
  assert.equal(sidecar.diagnosticRpcGate.metrics.p95Improvement, 0.5);
  assert.equal(sidecar.diagnosticRpcGate.implementerBatch.exitDecision, "DO_NOT_IMPLEMENT_MEDIAN_FANOUT_LE_ONE");
  assert.equal(old.operations.QUERY_FILES.count, 6);
  assert.equal(current.operations.QUERY_FILES.count, 3);
  assert.deepEqual(current.operations.QUERY_FILES.perAttemptCount, {
    state: "MEASURED",
    count: 3,
    p50: 1,
    p95: 1,
    max: 1
  });
  assert.equal(current.operations.QUERY_FILES.workerQueue.state, "MEASURED");
  assert.deepEqual(current.operations.QUERY_TYPE.perAttemptCount, {
    state: "MEASURED",
    count: 3,
    p50: 0,
    p95: 1,
    max: 1
  }, "operation absence is a known zero for the per-attempt distribution");
  assert.equal((await verifyJavaIndexRpcSidecar({ sidecarFile })).payloadSha256, sidecar.payloadSha256);

  const firstCell = sidecar.cells[0];
  await writeFile(firstCell.file, `${await readFile(firstCell.file, "utf8")}\n`);
  await assert.rejects(
    () => verifyJavaIndexRpcSidecar({ sidecarFile }),
    /payload hash|aggregate drift|cell descriptor drift|provenance|JSON/,
  );
});

test("RPC sidecar rejects a diagnostic attempt without request telemetry", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { omitTelemetry: true });
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: path.join(root, "sidecar.json")
  }), /has no JavaIndex RPC telemetry/);
});

test("RPC sidecar marks worker timing partial instead of inventing zero latency", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { omitWorkerTiming: true });
  const sidecar = await aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: path.join(root, "sidecar.json")
  });
  const old = sidecar.aggregates.perProjectVariant.find(row => row.project === "lishuedu" && row.variant === "old");
  assert.equal(old.operations.QUERY_FILES.workerQueue.state, "PARTIAL");
  assert.equal(old.operations.QUERY_FILES.workerQueue.measuredAttempts, 2);
  assert.equal(old.operations.QUERY_FILES.workerQueue.totalAttempts, 3);
});

test("RPC sidecar replay rejects a duplicated 18-cell descriptor set", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root);
  const sidecarFile = path.join(root, "sidecar.json");
  await aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: sidecarFile
  });
  const payload = JSON.parse(await readFile(sidecarFile, "utf8"));
  payload.cells[1] = structuredClone(payload.cells[0]);
  const { payloadSha256: _ignored, ...unsigned } = payload;
  payload.payloadSha256 = hash(stableJson(unsigned));
  await writeFile(sidecarFile, `${JSON.stringify(payload, null, 2)}\n`);
  await assert.rejects(() => verifyJavaIndexRpcSidecar({ sidecarFile }), /incomplete or duplicated/);
});

test("RPC sidecar rejects diagnostic runtime provenance drift", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { driftRuntimeBuild: true });
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: path.join(root, "sidecar.json")
  }), /metadata does not match the source lock/);
});

test("RPC sidecar rejects an empty or unrequested cold manifest before reading cells", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root);
  const manifest = JSON.parse(await readFile(fixture.manifestFile, "utf8"));
  manifest.runs = 0;
  manifest.diagnosticRpc.requested = false;
  await writeFile(fixture.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    manifestFile: fixture.manifestFile,
    diagnosticDir: fixture.diagnosticDir,
    outputFile: path.join(root, "sidecar.json")
  }), /cold manifest is invalid/);
});

test("RPC sidecar rejects missing or overlapping standard and diagnostic runtime state", async t => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-state-missing-"));
  const overlapRoot = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-state-overlap-"));
  t.after(() => Promise.all([
    rm(missingRoot, { recursive: true, force: true }),
    rm(overlapRoot, { recursive: true, force: true })
  ]));

  const missing = await writeFixture(missingRoot);
  const missingManifest = JSON.parse(await readFile(missing.manifestFile, "utf8"));
  delete missingManifest.diagnosticRpc.runtimeState;
  await writeFile(missing.manifestFile, `${JSON.stringify(missingManifest, null, 2)}\n`);
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    ...missing,
    outputFile: path.join(missingRoot, "sidecar.json")
  }), /runtime state is invalid/);

  const overlap = await writeFixture(overlapRoot);
  const overlapManifest = JSON.parse(await readFile(overlap.manifestFile, "utf8"));
  overlapManifest.diagnosticRpc.runtimeState.diagnostic.JAVA_LSP_CACHE_ROOT =
    overlapManifest.diagnosticRpc.runtimeState.standard.JAVA_LSP_CACHE_ROOT;
  await writeFile(overlap.manifestFile, `${JSON.stringify(overlapManifest, null, 2)}\n`);
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    ...overlap,
    outputFile: path.join(overlapRoot, "sidecar.json")
  }), /runtime state overlaps/);
});

test("RPC sidecar output is created atomically and never overwritten", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-exclusive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root);
  const outputFile = path.join(root, "sidecar.json");
  const attempts = await Promise.allSettled([
    aggregateJavaIndexRpcSidecar({ ...fixture, outputFile }),
    aggregateJavaIndexRpcSidecar({ ...fixture, outputFile })
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const rejection = attempts.find(result => result.status === "rejected");
  assert.match(String(rejection?.reason), /already exists/);
  assert.equal((await verifyJavaIndexRpcSidecar({ sidecarFile: outputFile })).cells.length, 18);
});

test("RPC sidecar rejects internally inconsistent operation telemetry", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-inconsistent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { inconsistentTelemetry: true });
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    ...fixture,
    outputFile: path.join(root, "sidecar.json")
  }), /inconsistent JavaIndex RPC operation telemetry/);
});

test("RPC sidecar CLI rejects unknown, duplicate, missing, and positional arguments", () => {
  assert.deepEqual(parseCli(["--help"]), { help: true });
  assert.throws(() => parseCli(["--unknown", "value"]), /unknown/);
  assert.throws(() => parseCli(["--output", "a", "--output", "b"]), /duplicate/);
  assert.throws(() => parseCli(["--output", "--help"]), /requires a value/);
  assert.throws(() => parseCli(["positional"]), /flag\/value pairs/);
});

test("RPC sidecar gate records threshold failure instead of manufacturing a PASS", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-gate-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { oldCount: 10, newCount: 8, oldElapsedMs: 20, newElapsedMs: 17 });
  const sidecar = await aggregateJavaIndexRpcSidecar({
    ...fixture,
    outputFile: path.join(root, "sidecar.json")
  });
  assert.equal(sidecar.diagnosticRpcGate.passed, false);
  assert.equal(sidecar.diagnosticRpcGate.checks.rpcCountReduction, false);
  assert.equal(sidecar.diagnosticRpcGate.checks.affectedP95Improvement, false);
  assert.equal(sidecar.diagnosticRpcGate.decision, "REJECT_RPC_COUNT_AND_P95");
});

test("RPC sidecar gate rejects a baseline with no affected JavaIndex scenario", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-no-affected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { zeroBaselineRpc: true });
  await assert.rejects(() => aggregateJavaIndexRpcSidecar({
    ...fixture,
    outputFile: path.join(root, "sidecar.json")
  }), /selected no affected baseline scenarios/);
});

test("RPC sidecar derives the implementer batch entry decision from baseline fanout and wait", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpc-sidecar-implementer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root, { implementerCount: 2 });
  const sidecar = await aggregateJavaIndexRpcSidecar({
    ...fixture,
    outputFile: path.join(root, "sidecar.json")
  });
  assert.equal(sidecar.diagnosticRpcGate.implementerBatch.fanout.p50, 2);
  assert.equal(sidecar.diagnosticRpcGate.implementerBatch.callerWaitMs.p95, 12);
  assert.equal(sidecar.diagnosticRpcGate.implementerBatch.exitDecision, "ELIGIBLE_FOR_V3_2_12");
});

async function writeFixture(root, {
  omitTelemetry = false,
  omitWorkerTiming = false,
  driftRuntimeBuild = false,
  inconsistentTelemetry = false,
  zeroBaselineRpc = false,
  oldCount = 2,
  newCount = 1,
  oldElapsedMs = 20,
  newElapsedMs = 10,
  implementerCount = 0
} = {}) {
  const diagnosticDir = path.join(root, "diagnostic");
  const rawDir = path.join(diagnosticDir, "raw");
  await mkdir(rawDir, { recursive: true });
  const runtimes = {
    old: { commit: "old", commitTree: "old-tree", executableTree: "old-executable", buildStamp: { gitSha: "old" } },
    new: { commit: "new", commitTree: "new-tree", executableTree: "new-executable", buildStamp: { gitSha: "new" } }
  };
  const repositories = Object.fromEntries(projects.map(project => [project, {
    root: `/repo/${project}`,
    head: `${project}-head`,
    tree: `${project}-tree`,
    statusSha256: hash("")
  }]));
  const scenarios = Object.fromEntries(projects.map(project => [project, {
    file: `/scenarios/${project}.jsonl`,
    sha256: hash(`${project}-scenario`),
    rowIds: ["s1"]
  }]));
  const manifestFile = path.join(root, "run-manifest.json");
  const runtimeState = {
    standard: runtimeStateDescriptor(path.join(root, "standard-runtime")),
    diagnostic: runtimeStateDescriptor(path.join(root, "diagnostic-runtime"))
  };
  const manifest = {
    version: VERIFIER_VERSION,
    verifierVersion: VERIFIER_VERSION,
    runtimes,
    candidatePatch: { sha256: hash("patch") },
    diagnosticRpc: {
      requested: true,
      gatePolicy: DIAGNOSTIC_RPC_GATE_POLICY,
      runtimeState,
      telemetryMode: { standard: "0", diagnostic: "1" }
    },
    runs: 1,
    requestDeadlineMs: FORMAL_REQUEST_DEADLINE_MS,
    rounds: ["old/new", "new/old", "old/new"],
    repositories,
    scenarios
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = hash(await readFile(manifestFile));

  for (let round = 1; round <= 3; round += 1) {
    for (const variant of ["old", "new"]) {
      for (const project of projects) {
        const file = path.join(rawDir, `${project}-r${round}-${variant}.json`);
        const operation = rpcOperation(variant === "old" ? oldCount : newCount);
        if (inconsistentTelemetry && round === 1 && variant === "old" && project === "lishuedu") {
          operation.completed += 1;
        }
        if (omitWorkerTiming && round === 1 && variant === "old" && project === "lishuedu") {
          delete operation.workerQueue;
          delete operation.workerProcessing;
        }
        const operations = variant === "old" && zeroBaselineRpc ? {} : {
          QUERY_FILES: operation,
          ...(implementerCount > 0 && variant === "old"
            ? { QUERY_IMPLEMENTERS: rpcOperation(implementerCount, 6) }
            : {}),
          ...(variant === "new" && project === "lishuedu" && round === 1
            ? { QUERY_TYPE: rpcOperation(1) }
            : {})
        };
        const rpc = omitTelemetry && round === 1 && variant === "old" && project === "lishuedu"
          ? undefined
          : { enabled: true, payloadBytes: "JSON_UTF8_ENVELOPE_ESTIMATE", operations };
        await writeFile(file, `${JSON.stringify({
          metadata: {
            projectId: project,
            repoRoot: repositories[project].root,
            repoCommit: repositories[project].head.slice(0, 12),
            verbosity: "diagnostic",
            warmState: "cold-nolsp",
            strategy: "impact",
            semanticPolicy: "fast",
            deadlineMs: FORMAL_REQUEST_DEADLINE_MS,
            runs: 1,
            scenarioFile: scenarios[project].file,
            runtimeBuild: driftRuntimeBuild && round === 1 && variant === "old" && project === "lishuedu"
              ? { gitSha: "drift" }
              : runtimes[variant].buildStamp,
            matrixProvenance: {
              manifestSha256,
              round,
              variant,
              runtimeCommit: runtimes[variant].commit,
              runtimeCommitTree: runtimes[variant].commitTree,
              runtimeExecutableTree: runtimes[variant].executableTree,
              candidatePatchSha256: manifest.candidatePatch.sha256,
              repoHead: repositories[project].head,
              repoTree: repositories[project].tree,
              repoStatusSha256: repositories[project].statusSha256,
              scenarioSha256: scenarios[project].sha256,
              scenarioIds: scenarios[project].rowIds
            }
          },
          rows: [{ id: "s1", attempts: [{
            strategy: "impact",
            elapsedMs: variant === "old" ? oldElapsedMs : newElapsedMs,
            timing: {
              semantic: { policy: "fast", used: false, timeout: false },
              javaIndex: { rpc }
            }
          }] }]
        }, null, 2)}\n`);
        await writeFile(`${file}.stderr`, "");
      }
    }
  }
  return { manifestFile, diagnosticDir };
}

function runtimeStateDescriptor(root) {
  return {
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    TMPDIR: path.join(root, "tmp"),
    JAVA_LSP_CACHE_ROOT: path.join(root, "process-cache"),
    JDTLS_DATA_DIR: path.join(root, "jdt-data"),
    JDTLS_LOG_DIR: path.join(root, "jdt-logs"),
    JAVA_LSP_PROJECTS_JSON: path.join(root, "projects.json"),
    GRADLE_USER_HOME: path.join(root, "gradle-home"),
    MAVEN_USER_HOME: path.join(root, "maven-home")
  };
}

function rpcOperation(count, waitPerCallMs = 2) {
  return {
    count,
    inputJsonBytes: count * 10,
    outputJsonBytes: count * 20,
    outputMeasuredCount: count,
    callerWait: { measuredCount: count, totalMs: count * waitPerCallMs, maxMs: count === 0 ? 0 : waitPerCallMs },
    workerQueue: { measuredCount: count, totalMs: count, maxMs: count === 0 ? 0 : 1 },
    workerProcessing: { measuredCount: count, totalMs: count * 1.5, maxMs: count === 0 ? 0 : 1.5 },
    maxWorkerQueueDepth: 1,
    completed: count,
    cancelled: 0,
    deadlineExceeded: 0,
    failed: 0,
    retired: 0,
    lateResponses: 0,
    retireReasons: {}
  };
}

function hash(value) {
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
