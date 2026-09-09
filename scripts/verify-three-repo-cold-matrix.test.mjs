import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildEnvLock,
  COMPARISON_POLICY_ENV_LOCKED,
  FORMAL_REQUEST_DEADLINE_MS,
  MATRIX_PROJECTS,
  MATRIX_ROUNDS,
  MATRIX_VARIANTS,
  MatrixValidationError,
  parseEnvAssignment,
  VERIFIER_VERSION,
  verifyMatrix
} from "./verify-three-repo-cold-matrix.mjs";

test("verifier accepts a complete frozen-scenario matrix that satisfies every paired gate", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });

  assert.equal(result.passed, true);
  assert.equal(result.cells.length, 18);
  assert.ok(result.projects.every(project => project.new.minReadMust === 1));
  assert.ok(result.projects.every(project => project.delta.p95Ratio <= 1.10));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.line.status === "MEASURED"));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.coordinate.status === "UNMEASURED"));
  assert.ok(result.projects.every(project => project.new.rangeEvidence.line.min === 1));
  assert.ok(result.projects.every(project => project.new.rangeEvidence.coordinate.min === 1));
  assert.ok(result.projects.every(project => project.new.splits.tuning.attempts === 120));
  assert.ok(result.projects.every(project => project.new.splits.holdout.attempts === 30));
  assert.equal(result.summaryFile, undefined);
  await assert.rejects(() => readFile(path.join(matrixDir, "matrix-summary.json")), /ENOENT/);
});

test("verifier allows the Task36 P_read tolerance but rejects a larger regression", async t => {
  const toleratedMatrix = await fixtureMatrix({ cipherlink: { newPRead: 0.49 } });
  const failingMatrix = await fixtureMatrix({ cipherlink: { newPRead: 0.47 } });
  t.after(() => Promise.all([
    rm(path.dirname(toleratedMatrix), { recursive: true, force: true }),
    rm(path.dirname(failingMatrix), { recursive: true, force: true })
  ]));

  const tolerated = verifyMatrix({ matrixDir: toleratedMatrix });
  const failed = verifyMatrix({ matrixDir: failingMatrix });
  const toleratedCipherlink = tolerated.projects.find(project => project.project === "cipherlink");
  const failedCipherlink = failed.projects.find(project => project.project === "cipherlink");

  assert.equal(toleratedCipherlink.gate.pRead, true);
  assert.equal(failed.passed, false);
  assert.equal(failedCipherlink.gate.rReadMust, true);
  assert.equal(failedCipherlink.gate.pRead, false);
});

test("verifier gates task-blocking recall and standard estimated tokens", async t => {
  const matrixDir = await fixtureMatrix({ lishuedu: { newRTaskBlocking: 0.79, newEstimatedTokens: 101 } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });
  const lishuedu = result.projects.find(project => project.project === "lishuedu");

  assert.equal(result.passed, false);
  assert.equal(lishuedu.gate.rTaskBlocking, false);
  assert.equal(lishuedu.gate.estimatedTokens, false);
});

test("verifier rejects a matrix whose old and new cells use different scenario files", async t => {
  const matrixDir = await fixtureMatrix({ lishuedu: { newScenarioFile: "/tmp/different-lishuedu-scenarios.jsonl" } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(() => verifyMatrix({ matrixDir }), MatrixValidationError);
});

test("verifier rejects old and new cells from the same runtime commit and tree", async t => {
  const matrixDir = await fixtureMatrix({}, { sameRuntime: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /runtime.*different|same runtime/i.test(error.message)
  );
});

test("verifier accepts env-locked-same-tree when treatments differ", async t => {
  const matrixDir = await fixtureMatrix({}, { envLocked: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });
  assert.equal(result.passed, true);
  assert.equal(result.manifest.comparisonPolicy.baseline, COMPARISON_POLICY_ENV_LOCKED);
  assert.equal(result.manifest.runtimes.old.executableTree, result.manifest.runtimes.new.executableTree);
  assert.notEqual(
    result.manifest.comparisonPolicy.envLock.old.fingerprint,
    result.manifest.comparisonPolicy.envLock.new.fingerprint
  );
});

test("verifier rejects env-locked-same-tree when treatments are identical", async t => {
  const matrixDir = await fixtureMatrix({}, {
    envLocked: true,
    newTreatment: { env: {}, benchArgs: [] }
  });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /treatments must differ/i.test(error.message)
  );
});

test("verifier rejects env-locked-same-tree when executable trees differ", async t => {
  const matrixDir = await fixtureMatrix({}, { envLocked: true, envLockedDifferentTrees: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /identical old\/new commit and executable trees/i.test(error.message)
  );
});

test("parseEnvAssignment rejects unknown keys and empty values", () => {
  assert.throws(() => parseEnvAssignment("JAVA_LSP_EXAMPLE_FLAG=off", "--candidate-env"), /allowlisted/);
  assert.throws(() => parseEnvAssignment("JAVA_LSP_JAVA_INDEX_DUAL_WORKER=1", "--candidate-env"), /allowlisted/);
  assert.throws(() => parseEnvAssignment("JAVA_LSP_EXAMPLE_FLAG=", "--candidate-env"), /KEY=VAL/);
  assert.deepEqual(parseEnvAssignment("JAVA_LSP_ENGINE=jin", "--candidate-env"), { key: "JAVA_LSP_ENGINE", value: "jin" });
});

test("verifier accepts a source-locked candidate patch on the same base commit", async t => {
  const matrixDir = await fixtureMatrix({}, { sameBaseCommit: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });

  assert.equal(result.passed, true);
  assert.equal(result.manifest.runtimes.old.commit, result.manifest.runtimes.new.commit);
  assert.notEqual(result.manifest.runtimes.old.executableTree, result.manifest.runtimes.new.executableTree);
});

test("verifier rejects a frozen scenario replaced at the same absolute path", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(path.dirname(matrixDir), "run-manifest.json"), "utf8"));
  const scenarioFile = manifest.scenarios.lishuedu.file;
  await writeFile(scenarioFile, `${JSON.stringify({ id: "replacement-row" })}\n`);

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /scenario.*sha256|hash/i.test(error.message)
  );
});

test("verifier rejects a candidate cell that omits one frozen scenario row", async t => {
  const matrixDir = await fixtureMatrix({}, { missingCandidateRow: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /row|scenario ids/i.test(error.message)
  );
});

test("verifier rejects a candidate patch whose bytes no longer match the manifest", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  await writeFile(path.join(path.dirname(matrixDir), "candidate.patch"), "changed after the run\n");

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /candidate patch.*sha256|patch.*hash/i.test(error.message)
  );
});

test("verifier rejects drifted candidate TAP evidence or mismatched test counts", async t => {
  const driftedMatrix = await fixtureMatrix();
  const mismatchedMatrix = await fixtureMatrix();
  t.after(() => Promise.all([
    rm(path.dirname(driftedMatrix), { recursive: true, force: true }),
    rm(path.dirname(mismatchedMatrix), { recursive: true, force: true })
  ]));

  const driftedManifest = JSON.parse(await readFile(path.join(path.dirname(driftedMatrix), "run-manifest.json"), "utf8"));
  await writeFile(driftedManifest.candidateTests.dist.stdout.file, "tampered TAP\n");
  assert.throws(() => verifyMatrix({ matrixDir: driftedMatrix }), /candidate dist test stdout.*sha256|TAP/i);

  const mismatchedManifestFile = path.join(path.dirname(mismatchedMatrix), "run-manifest.json");
  const mismatchedManifest = JSON.parse(await readFile(mismatchedManifestFile, "utf8"));
  mismatchedManifest.candidateTests.scripts.discoveredTests += 1;
  mismatchedManifest.candidateTests.scripts.passedTests += 1;
  await writeFile(mismatchedManifestFile, `${JSON.stringify(mismatchedManifest, null, 2)}\n`);
  assert.throws(() => verifyMatrix({ matrixDir: mismatchedMatrix }), /TAP summary/i);
});

test("verifier requires a valid private dependency inventory", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifestFile = path.join(path.dirname(matrixDir), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.dependencies.inventory.algorithm = "unbound";
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(() => verifyMatrix({ matrixDir }), /dependency inventory/i);
});

test("verifier rejects a candidate patch whose replay tree is not the declared executable tree", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifestFile = path.join(path.dirname(matrixDir), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.candidatePatch.resultingExecutableTree = "dddddddddddddddddddddddddddddddddddddddd";
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /resulting.*tree|executable tree/i.test(error.message)
  );
});

test("verifier rejects a hash-bound untracked source input changed after the run", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(path.dirname(matrixDir), "run-manifest.json"), "utf8"));
  await writeFile(manifest.candidatePatch.untrackedInputs[0].file, "tampered\n");

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /untracked.*sha256|input.*hash/i.test(error.message)
  );
});

test("verifier rejects a repository manifest without a clean tree identity", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifestFile = path.join(path.dirname(matrixDir), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.repositories.lishuedu.clean = false;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /repository manifest|clean/i.test(error.message)
  );
});

test("verifier rejects an invalid or drifted tuning and holdout partition", async t => {
  const manifestMatrix = await fixtureMatrix();
  const frozenMatrix = await fixtureMatrix();
  t.after(() => Promise.all([
    rm(path.dirname(manifestMatrix), { recursive: true, force: true }),
    rm(path.dirname(frozenMatrix), { recursive: true, force: true })
  ]));

  const manifestFile = path.join(path.dirname(manifestMatrix), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.scenarios.lishuedu.holdoutRowIds[0] = manifest.scenarios.lishuedu.tuningRowIds[0];
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyMatrix({ matrixDir: manifestMatrix }), /split|partition|holdout/i);

  const frozenManifestFile = path.join(path.dirname(frozenMatrix), "run-manifest.json");
  const frozenManifest = JSON.parse(await readFile(frozenManifestFile, "utf8"));
  const scenarioFile = frozenManifest.scenarios.cipherlink.file;
  const rows = (await readFile(scenarioFile, "utf8")).trim().split("\n").map(JSON.parse);
  rows[0].evaluationSplit = "holdout";
  const contents = `${rows.map(JSON.stringify).join("\n")}\n`;
  await writeFile(scenarioFile, contents);
  frozenManifest.scenarios.cipherlink.sha256 = sha256(contents);
  frozenManifest.scenarios.cipherlink.bytes = Buffer.byteLength(contents);
  await writeFile(frozenManifestFile, `${JSON.stringify(frozenManifest, null, 2)}\n`);
  assert.throws(() => verifyMatrix({ matrixDir: frozenMatrix }), /frozen scenario split|split.*manifest/i);
});

test("verifier requires an explicit executable-baseline comparison policy", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const manifestFile = path.join(path.dirname(matrixDir), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.comparisonPolicy;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /comparison policy|baseline/i.test(error.message)
  );
});

test("verifier reports missing real range evidence as UNMEASURED instead of folding it into PASS", async t => {
  const matrixDir = await fixtureMatrix({}, { unmeasuredRanges: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });

  assert.equal(result.passed, false);
  assert.ok(result.projects.every(project => project.old.rangeEvidence.line.status === "UNMEASURED"));
  assert.ok(result.projects.every(project => project.new.rangeEvidence.coordinate.measuredAttempts === 0));
  assert.ok(result.projects.every(project => project.gate.rangeLineRecall === false));
  assert.ok(result.projects.every(project => project.gate.rangeCoordinateRecall === false));
});

test("verifier rejects candidate coordinate loss even when legacy line recall remains complete", async t => {
  const matrixDir = await fixtureMatrix({ cipherlink: { newCoordinateRecall: 0.99 } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });
  const cipherlink = result.projects.find(project => project.project === "cipherlink");

  assert.equal(result.passed, false);
  assert.equal(cipherlink.gate.rangeLineRecall, true);
  assert.equal(cipherlink.gate.rangeCoordinateRecall, false);
});

test("verifier gates holdout quality independently from the tuning aggregate", async t => {
  const matrixDir = await fixtureMatrix({ lishuedu: { newTuningRecall: 0.73, newHoldoutRecall: 0.60 } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });
  const lishuedu = result.projects.find(project => project.project === "lishuedu");

  assert.equal(result.passed, false);
  assert.equal(lishuedu.gate.recall, true);
  assert.equal(lishuedu.gate.holdoutRecall, false);
});

test("verifier rejects a cell whose runtime build stamp does not match its manifest variant", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const file = path.join(matrixDir, "lishuedu-r1-new.json");
  const payload = JSON.parse(await readFile(file, "utf8"));
  payload.metadata.runtimeBuild.gitSha = "111111111111";
  await writeFile(file, JSON.stringify(payload));

  assert.throws(
    () => verifyMatrix({ matrixDir }),
    error => error instanceof MatrixValidationError && /runtime build stamp/i.test(error.message)
  );
});

test("verifier binds the formal request deadline in both manifest and cells", async t => {
  const manifestMatrix = await fixtureMatrix();
  const cellMatrix = await fixtureMatrix();
  t.after(() => Promise.all([
    rm(path.dirname(manifestMatrix), { recursive: true, force: true }),
    rm(path.dirname(cellMatrix), { recursive: true, force: true })
  ]));

  const manifestFile = path.join(path.dirname(manifestMatrix), "run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.requestDeadlineMs = 15_000;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyMatrix({ matrixDir: manifestMatrix }), /requestDeadlineMs must be 2000/);

  const cellFile = path.join(cellMatrix, "cipherlink-r1-new.json");
  const cell = JSON.parse(await readFile(cellFile, "utf8"));
  cell.metadata.deadlineMs = 15_000;
  await writeFile(cellFile, JSON.stringify(cell));
  assert.throws(() => verifyMatrix({ matrixDir: cellMatrix }), /metadata\.deadlineMs must be 2000/);
});

test("verifier no longer waives isolated cold-build-child-disabled parse-cap stderr", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  await writeFile(
    path.join(matrixDir, "cipherlink-r1-old.json.stderr"),
    "[codex-java-lsp] in-process parse files=6086 (cold-build child disabled; cap waived)\n"
  );
  assert.throws(() => verifyMatrix({ matrixDir }), /stderr must be empty/);
});

test("verifier rejects non-empty stderr and an illegal cold semantic completion", async t => {
  const stderrMatrix = await fixtureMatrix();
  const completionMatrix = await fixtureMatrix();
  t.after(() => Promise.all([
    rm(path.dirname(stderrMatrix), { recursive: true, force: true }),
    rm(path.dirname(completionMatrix), { recursive: true, force: true })
  ]));
  await writeFile(path.join(stderrMatrix, "cipherlink-r1-old.json.stderr"), "unexpected warning\n");
  const completionFile = path.join(completionMatrix, "exam-parent-v3-r1-new.json");
  const payload = JSON.parse(await readFile(completionFile, "utf8"));
  payload.rows[0].attempts[0].timing.semantic.used = true;
  await writeFile(completionFile, JSON.stringify(payload));

  assert.throws(() => verifyMatrix({ matrixDir: stderrMatrix }), /stderr must be empty/);
  assert.throws(() => verifyMatrix({ matrixDir: completionMatrix }), /semantic completion policy/);
});

test("verifier accepts the standard projection's deterministic cold semantic proof", async t => {
  const matrixDir = await fixtureMatrix({}, { standardSemanticSnapshot: true });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });

  assert.equal(result.passed, true);
});

test("verifier rejects an unsafe standard semantic snapshot", async t => {
  const timeoutMatrix = await fixtureMatrix({}, { standardSemanticSnapshot: true });
  const usedMatrix = await fixtureMatrix({}, { standardSemanticSnapshot: true });
  t.after(() => Promise.all([
    rm(path.dirname(timeoutMatrix), { recursive: true, force: true }),
    rm(path.dirname(usedMatrix), { recursive: true, force: true })
  ]));
  const timeoutFile = path.join(timeoutMatrix, "lishuedu-r1-old.json");
  const timeoutPayload = JSON.parse(await readFile(timeoutFile, "utf8"));
  timeoutPayload.rows[0].attempts[0].determinism.completion.semantic = "PARTIAL_TIMEOUT";
  await writeFile(timeoutFile, JSON.stringify(timeoutPayload));
  const usedFile = path.join(usedMatrix, "lishuedu-r1-old.json");
  const usedPayload = JSON.parse(await readFile(usedFile, "utf8"));
  usedPayload.rows[0].attempts[0].determinism.completion.semanticUsed = true;
  await writeFile(usedFile, JSON.stringify(usedPayload));

  assert.throws(() => verifyMatrix({ matrixDir: timeoutMatrix }), /semantic completion policy/);
  assert.throws(() => verifyMatrix({ matrixDir: usedMatrix }), /semantic completion policy/);
});

test("verifier rejects out-of-domain quality, token, and latency metrics", async t => {
  const invalidValues = [
    ["recall", 1.01],
    ["pRead", -0.01],
    ["rReadMust", 2],
    ["rTaskBlocking", -1],
    ["estimatedTokens", -1],
    ["elapsedMs", -0.001],
    ["RangeLineRecall", 1.01],
    ["RangeCoordinateRecall", -0.01]
  ];

  for (const [metric, value] of invalidValues) {
    const matrixDir = await fixtureMatrix();
    t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
    const file = path.join(matrixDir, "lishuedu-r1-new.json");
    const payload = JSON.parse(await readFile(file, "utf8"));
    payload.rows[0].attempts[0][metric] = value;
    await writeFile(file, JSON.stringify(payload));

    assert.throws(
      () => verifyMatrix({ matrixDir }),
      error => error instanceof MatrixValidationError && error.message.includes(`invalid ${metric}`),
      `${metric}=${value} must be rejected`
    );
  }
});

test("verifier rejects inconsistent legacy and canonical line-range metrics", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));
  const file = path.join(matrixDir, "exam-parent-v3-r1-new.json");
  const payload = JSON.parse(await readFile(file, "utf8"));
  payload.rows[0].attempts[0].RangeLineRecall = 0.9;
  await writeFile(file, JSON.stringify(payload));

  assert.throws(() => verifyMatrix({ matrixDir }), /readPlanRangeRecall and RangeLineRecall disagree/);
});

async function fixtureMatrix(overrides = {}, fixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-matrix-test-"));
  const matrixDir = path.join(root, "matrix");
  const scenarioDir = path.join(root, "frozen-scenarios");
  await mkdir(matrixDir, { recursive: true });
  await mkdir(scenarioDir, { recursive: true });
  const oldRuntime = {
    commit: "1111111111111111111111111111111111111111",
    commitTree: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    executableTree: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    buildStamp: { gitSha: "111111111111", generatedAt: "2026-08-09T00:00:00.000Z", defaultsFingerprint: "old-defaults" }
  };
  const envLocked = fixtureOptions.envLocked === true;
  const newRuntime = envLocked && !fixtureOptions.envLockedDifferentTrees
    ? oldRuntime
    : fixtureOptions.sameRuntime
    ? oldRuntime
    : fixtureOptions.sameBaseCommit
      ? {
          commit: oldRuntime.commit,
          commitTree: oldRuntime.commitTree,
          executableTree: "cccccccccccccccccccccccccccccccccccccccc",
          buildStamp: { gitSha: "111111111111", generatedAt: "2026-08-09T00:01:00.000Z", defaultsFingerprint: "new-defaults" }
        }
      : {
        commit: "2222222222222222222222222222222222222222",
        commitTree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        executableTree: "cccccccccccccccccccccccccccccccccccccccc",
        buildStamp: { gitSha: "222222222222", generatedAt: "2026-08-09T00:01:00.000Z", defaultsFingerprint: "new-defaults" }
      };
  const oldTreatment = fixtureOptions.oldTreatment || { env: {}, benchArgs: [] };
  const newTreatment = fixtureOptions.newTreatment || { env: {}, benchArgs: ["--placeholder"] };
  const envLock = envLocked ? buildEnvLock(oldTreatment, newTreatment) : undefined;
  const candidatePatch = "candidate patch fixture\n";
  const candidatePatchFile = path.join(root, "candidate.patch");
  await writeFile(candidatePatchFile, candidatePatch);
  const untrackedInputFile = path.join(root, "candidate-untracked", "src", "new.ts");
  await mkdir(path.dirname(untrackedInputFile), { recursive: true });
  await writeFile(untrackedInputFile, "export const added = true;\n");
  const candidateTestRoot = path.join(root, "candidate-tests");
  await mkdir(candidateTestRoot, { recursive: true });
  const candidateTests = {};
  for (const [suite, count] of [["dist", 10], ["scripts", 5]]) {
    const stdoutFile = path.join(candidateTestRoot, `${suite}.tap`);
    const stderrFile = path.join(candidateTestRoot, `${suite}.stderr`);
    const stdout = `TAP version 13\n1..${count}\n# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
    await Promise.all([writeFile(stdoutFile, stdout), writeFile(stderrFile, "")]);
    candidateTests[suite] = {
      discoveredTests: count,
      passedTests: count,
      stdout: { file: stdoutFile, bytes: Buffer.byteLength(stdout), sha256: sha256(stdout) },
      stderr: { file: stderrFile, bytes: 0, sha256: sha256("") }
    };
  }
  const repositories = {};
  const scenarios = {};
  for (const project of MATRIX_PROJECTS) {
    const scenarioFile = path.join(scenarioDir, `${project}.scenarios.jsonl`);
    const rowIds = Array.from({ length: 10 }, (_, index) => `${project}-scenario-${index + 1}`);
    const tuningRowIds = rowIds.slice(0, 8);
    const holdoutRowIds = rowIds.slice(8);
    const scenarioContents = rowIds.map((id, index) => JSON.stringify({
      id,
      evaluationSplit: index < 8 ? "tuning" : "holdout",
      golden: {
        mustReadRanges: { "src/main/java/demo/Anchor.java": [{ startLine: 1, endLine: 2 }] },
        mustReadCoordinateRangesV2: [{
          file: "src/main/java/demo/Anchor.java",
          start: { line: 1, column: 1 },
          end: { line: 2, column: 1 }
        }]
      }
    })).join("\n") + "\n";
    await writeFile(scenarioFile, scenarioContents);
    repositories[project] = {
      root: path.join(root, "repositories", project),
      head: `${project.charCodeAt(0).toString(16)}`.repeat(40).slice(0, 40),
      tree: `${(project.charCodeAt(0) + 1).toString(16)}`.repeat(40).slice(0, 40),
      clean: true,
      statusSha256: sha256("")
    };
    scenarios[project] = { file: scenarioFile, sha256: sha256(scenarioContents), rowIds, tuningRowIds, holdoutRowIds };
  }
  const manifest = {
    version: VERIFIER_VERSION,
    verifierVersion: VERIFIER_VERSION,
    createdAt: "2026-08-09T00:02:00.000Z",
    runs: 5,
    requestDeadlineMs: FORMAL_REQUEST_DEADLINE_MS,
    p95Limit: 1.25,
    comparisonPolicy: envLocked
      ? {
          baseline: COMPARISON_POLICY_ENV_LOCKED,
          baselineRevision: oldRuntime.commit,
          goldenSchema: "java-intelligence-v32-range-holdout-v2",
          pReadTolerance: 0.02,
          p95AbsoluteSlackMs: 50,
          taskBlockingBaseline: "attempt-or-derived-attribution",
          envLock
        }
      : {
          baseline: "executable-code-baseline",
          baselineRevision: oldRuntime.commit,
          goldenSchema: "java-intelligence-v32-range-holdout-v2",
          pReadTolerance: 0.02,
          p95AbsoluteSlackMs: 50,
          taskBlockingBaseline: "attempt-or-derived-attribution"
        },
    rounds: ["old/new", "new/old", "old/new"],
    runtimes: { old: oldRuntime, new: newRuntime },
    candidateTests,
    dependencies: {
      copyMode: "private-content-verified-copy",
      inventory: {
        schemaVersion: 1,
        algorithm: "sha256-path-type-size-content-v1",
        fileCount: 100,
        directoryCount: 20,
        symlinkCount: 3,
        totalBytes: 1024,
        sha256: sha256("node_modules fixture")
      }
    },
    candidatePatch: {
      file: candidatePatchFile,
      sha256: sha256(candidatePatch),
      appliedToCommit: newRuntime.commit,
      appliedToCommitTree: newRuntime.commitTree,
      resultingExecutableTree: newRuntime.executableTree,
      untrackedInputs: [{
        path: "src/new.ts",
        file: untrackedInputFile,
        sha256: sha256("export const added = true;\n"),
        bytes: Buffer.byteLength("export const added = true;\n")
      }]
    },
    repositories,
    scenarios
  };
  const manifestFile = path.join(root, "run-manifest.json");
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestFile, manifestContents);
  const manifestSha256 = sha256(manifestContents);

  for (const project of MATRIX_PROJECTS) {
    const projectOverride = overrides[project] || {};
    const scenarioFile = scenarios[project].file;
    for (const round of MATRIX_ROUNDS) {
      for (const variant of MATRIX_VARIANTS) {
        const old = variant === "old";
        const runtime = old ? oldRuntime : newRuntime;
        const pRead = old ? 0.50 : (projectOverride.newPRead ?? 0.60);
        const elapsedMs = old ? 100 : (projectOverride.newElapsedMs ?? 105);
        const rowIds = fixtureOptions.missingCandidateRow && project === "cipherlink" && variant === "new" && round === 2
          ? scenarios[project].rowIds.slice(0, 1)
          : scenarios[project].rowIds;
        const payload = {
          metadata: {
            repoRoot: repositories[project].root,
            repoCommit: repositories[project].head.slice(0, 12),
            projectId: project,
            warmState: "cold-nolsp",
            semanticPolicy: "fast",
            strategy: "impact",
            verbosity: "standard",
            deadlineMs: FORMAL_REQUEST_DEADLINE_MS,
            runs: 5,
            scenarioFile: old ? scenarioFile : (projectOverride.newScenarioFile ?? scenarioFile),
            runtimeBuild: { ...runtime.buildStamp, stampPath: `/tmp/${variant}/dist/build-stamp.json` },
            matrixProvenance: {
              manifestSha256,
              variant,
              runtimeCommit: runtime.commit,
              runtimeCommitTree: runtime.commitTree,
              runtimeExecutableTree: runtime.executableTree,
              candidatePatchSha256: manifest.candidatePatch.sha256,
              ...(envLock ? { treatmentFingerprint: envLock[variant].fingerprint } : {}),
              repoHead: repositories[project].head,
              repoTree: repositories[project].tree,
              repoStatusSha256: repositories[project].statusSha256,
              scenarioSha256: scenarios[project].sha256,
              scenarioIds: scenarios[project].rowIds
            }
          },
          rows: rowIds.map(id => ({
            id,
            attempts: Array.from({ length: 5 }, () => {
              const holdout = scenarios[project].holdoutRowIds.includes(id);
              const recall = old
                ? 0.70
                : holdout
                  ? (projectOverride.newHoldoutRecall ?? 0.70)
                  : (projectOverride.newTuningRecall ?? 0.70);
              const rangeMetrics = fixtureOptions.unmeasuredRanges
                ? {}
                : old
                  ? { readPlanRangeRecall: 1 }
                  : {
                      readPlanRangeRecall: 1,
                      RangeLineRecall: 1,
                      RangeCoordinateRecall: projectOverride.newCoordinateRecall ?? 1
                    };
              return {
                strategy: "impact",
                recall,
                pRead,
                rReadMust: 1,
                rTaskBlocking: old ? 0.80 : (projectOverride.newRTaskBlocking ?? 0.80),
                estimatedTokens: old ? 100 : (projectOverride.newEstimatedTokens ?? 100),
                elapsedMs,
                ...rangeMetrics,
                ...(fixtureOptions.standardSemanticSnapshot
                  ? {
                      timing: { sessionPhaseMs: {} },
                      determinism: {
                        completion: {
                          semantic: "COMPLETE",
                          semanticUsed: false
                        }
                      }
                    }
                  : { timing: { semantic: { policy: "fast", used: false, timeout: false } } })
              };
            })
          }))
        };
        const file = path.join(matrixDir, `${project}-r${round}-${variant}.json`);
        await writeFile(file, JSON.stringify(payload));
        await writeFile(`${file}.stderr`, "");
      }
    }
  }
  return matrixDir;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
