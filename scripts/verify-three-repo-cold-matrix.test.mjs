import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MATRIX_PROJECTS, MATRIX_ROUNDS, MATRIX_VARIANTS, MatrixValidationError, verifyMatrix } from "./verify-three-repo-cold-matrix.mjs";

test("verifier accepts a complete frozen-scenario matrix that satisfies every paired gate", async t => {
  const matrixDir = await fixtureMatrix();
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });

  assert.equal(result.passed, true);
  assert.equal(result.cells.length, 18);
  assert.ok(result.projects.every(project => project.new.minReadMust === 1));
  assert.ok(result.projects.every(project => project.delta.p95Ratio <= 1.10));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.status === "PARTIAL"));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.measuredAttempts === 15));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.unmeasuredAttempts === 15));
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

  assert.ok(result.projects.every(project => project.old.rangeEvidence.status === "UNMEASURED"));
  assert.ok(result.projects.every(project => project.old.rangeEvidence.measuredAttempts === 0));
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

test("verifier rejects out-of-domain quality, token, and latency metrics", async t => {
  const invalidValues = [
    ["recall", 1.01],
    ["pRead", -0.01],
    ["rReadMust", 2],
    ["rTaskBlocking", -1],
    ["estimatedTokens", -1],
    ["elapsedMs", -0.001]
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
  const newRuntime = fixtureOptions.sameRuntime
    ? oldRuntime
    : {
        commit: "2222222222222222222222222222222222222222",
        commitTree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        executableTree: "cccccccccccccccccccccccccccccccccccccccc",
        buildStamp: { gitSha: "222222222222", generatedAt: "2026-08-09T00:01:00.000Z", defaultsFingerprint: "new-defaults" }
      };
  const candidatePatch = "candidate patch fixture\n";
  const candidatePatchFile = path.join(root, "candidate.patch");
  await writeFile(candidatePatchFile, candidatePatch);
  const untrackedInputFile = path.join(root, "candidate-untracked", "src", "new.ts");
  await mkdir(path.dirname(untrackedInputFile), { recursive: true });
  await writeFile(untrackedInputFile, "export const added = true;\n");
  const repositories = {};
  const scenarios = {};
  for (const project of MATRIX_PROJECTS) {
    const scenarioFile = path.join(scenarioDir, `${project}.scenarios.jsonl`);
    const rowIds = [`${project}-scenario-a`, `${project}-scenario-b`];
    const scenarioContents = rowIds.map((id, index) => JSON.stringify({
      id,
      ...(index === 0 ? { golden: { mustReadRanges: { "src/main/java/demo/Anchor.java": [{ startLine: 1, endLine: 2 }] } } } : {})
    })).join("\n") + "\n";
    await writeFile(scenarioFile, scenarioContents);
    repositories[project] = {
      root: path.join(root, "repositories", project),
      head: `${project.charCodeAt(0).toString(16)}`.repeat(40).slice(0, 40),
      tree: `${(project.charCodeAt(0) + 1).toString(16)}`.repeat(40).slice(0, 40),
      clean: true,
      statusSha256: sha256("")
    };
    scenarios[project] = { file: scenarioFile, sha256: sha256(scenarioContents), rowIds };
  }
  const manifest = {
    version: 4,
    verifierVersion: 4,
    createdAt: "2026-08-09T00:02:00.000Z",
    runs: 5,
    p95Limit: 1.25,
    comparisonPolicy: {
      baseline: "executable-code-baseline",
      baselineRevision: oldRuntime.commit,
      goldenSchema: "task36-cross-version-v1",
      pReadTolerance: 0.02,
      p95AbsoluteSlackMs: 50,
      taskBlockingBaseline: "attempt-or-derived-attribution"
    },
    rounds: ["old/new", "new/old", "old/new"],
    runtimes: { old: oldRuntime, new: newRuntime },
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
        const recall = old ? 0.70 : 0.70;
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
            strategy: "impact",
            verbosity: "diagnostic",
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
              repoHead: repositories[project].head,
              repoTree: repositories[project].tree,
              repoStatusSha256: repositories[project].statusSha256,
              scenarioSha256: scenarios[project].sha256,
              scenarioIds: scenarios[project].rowIds
            }
          },
          rows: rowIds.map(id => ({
            id,
            attempts: Array.from({ length: 5 }, () => ({
              strategy: "impact",
              recall,
              pRead,
              rReadMust: 1,
              rTaskBlocking: old ? 0.80 : (projectOverride.newRTaskBlocking ?? 0.80),
              estimatedTokens: old ? 100 : (projectOverride.newEstimatedTokens ?? 100),
              elapsedMs,
              ...(!fixtureOptions.unmeasuredRanges && id.endsWith("-scenario-a") ? { readPlanRangeRecall: 1 } : {}),
              timing: { semantic: { policy: "fast", used: false, timeout: false } }
            }))
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
