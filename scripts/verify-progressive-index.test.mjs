import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROGRESSIVE_PROJECTS,
  compareProgressiveManifests,
  nearestRank,
  verifyProgressiveManifest
} from "./verify-progressive-index.mjs";

test("nearest-rank uses the formal ceil rank with five samples", () => {
  assert.equal(nearestRank([1, 2, 3, 4, 5], 0.50), 3);
  assert.equal(nearestRank([1, 2, 3, 4, 5], 0.95), 5);
});

test("progressive verifier binds all attempts and rejects raw tampering", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progressive-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await writeBundle(path.join(root, "baseline"), "a", {
    anchorReady: 100,
    moduleReady: 200,
    complete: 300,
    snapshotDurable: 320
  });
  const result = verifyProgressiveManifest(bundle.manifestFile);
  assert.equal(result.passed, true);
  assert.equal(result.projects.length, 3);
  const raw = path.join(bundle.root, "raw", "lishuedu-r1.json");
  const value = JSON.parse(await readFile(raw, "utf8"));
  value.attempt.negativeLookup.beforeComplete.coverage = "COMPLETE";
  await writeFile(raw, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => verifyProgressiveManifest(bundle.manifestFile), /hash\/bytes mismatch/);
});

test("progressive comparison uses zero slack and exact stage targets", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "progressive-compare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = await writeBundle(path.join(root, "baseline"), "a", {
    anchorReady: 100,
    moduleReady: 200,
    complete: 300,
    snapshotDurable: 320
  });
  const candidate = await writeBundle(path.join(root, "candidate"), "b", {
    anchorReady: 80,
    moduleReady: 199,
    complete: 330,
    snapshotDurable: 350
  });
  const passing = compareProgressiveManifests({
    baselineManifest: baseline.manifestFile,
    candidateManifest: candidate.manifestFile
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.policy.absoluteSlackMs, 0);

  const regressed = await writeBundle(path.join(root, "regressed"), "c", {
    anchorReady: 81,
    moduleReady: 200,
    complete: 331,
    snapshotDurable: 351
  });
  const failing = compareProgressiveManifests({
    baselineManifest: baseline.manifestFile,
    candidateManifest: regressed.manifestFile
  });
  assert.equal(failing.passed, false);
  assert.equal(failing.projects.every(project => !project.passed), true);
});

async function writeBundle(root, runtimeChar, timings) {
  await Promise.all([
    mkdir(path.join(root, "inputs", "runtime-sources"), { recursive: true }),
    mkdir(path.join(root, "raw"), { recursive: true }),
    mkdir(path.join(root, "logs"), { recursive: true })
  ]);
  const scenarioFile = path.join(root, "inputs", "progressive-index-v1.json");
  const patchFile = path.join(root, "inputs", "runtime.patch");
  const sourceFile = path.join(root, "inputs", "runtime-sources", "progressive-index.ts");
  await Promise.all([
    writeFile(scenarioFile, `${JSON.stringify({ schemaVersion: 1, projects: PROGRESSIVE_PROJECTS })}\n`),
    writeFile(patchFile, `runtime-${runtimeChar}\n`),
    writeFile(sourceFile, "source\n")
  ]);
  const scenarioLock = await descriptor(root, scenarioFile);
  const patch = await descriptor(root, patchFile);
  const sourceFiles = [await descriptor(root, sourceFile)];
  const runtime = {
    commit: runtimeChar.repeat(40),
    commitTree: runtimeChar.repeat(40),
    executableTree: runtimeChar.repeat(40),
    statusSha256: runtimeChar.repeat(64),
    changedPaths: [],
    patch,
    buildStamp: { gitSha: runtimeChar.repeat(12), defaultsFingerprint: "fixture" },
    dependencies: { schemaVersion: 1, sha256: runtimeChar.repeat(64) }
  };
  const repositories = Object.fromEntries(PROGRESSIVE_PROJECTS.map((project, index) => [project, {
    sourceRoot: `/source/${project}`,
    head: String(index + 1).repeat(40),
    tree: String(index + 4).repeat(40),
    statusSha256: sha256("")
  }]));
  const protocol = {
    runs: 5,
    generation: 1,
    pollMs: 50,
    timeoutMs: 180000,
    cache: "EMPTY_PRIVATE_PER_ATTEMPT",
    percentile: "nearest-rank-ceil",
    jdtlsDisabled: true,
    runtimeState: "PRIVATE_PER_ATTEMPT",
    scope: "QUIET_PROGRESSIVE_ONLY_STORM_GATE_SEPARATE"
  };
  const runPlanFile = path.join(root, "progressive-run-plan.json");
  await writeFile(runPlanFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: "v32-progressive-index-run-plan",
    verifierVersion: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    runtime,
    scenarioLock: { ...scenarioLock, projectIds: PROGRESSIVE_PROJECTS },
    sourceFiles,
    repositories,
    protocol
  }, null, 2)}\n`);
  const runPlan = await descriptor(root, runPlanFile);
  const artifacts = [];
  for (const project of PROGRESSIVE_PROJECTS) {
    const semanticDigest = sha256(project);
    for (let run = 1; run <= 5; run += 1) {
      const cacheIdentity = sha256(`${root}:cache:${project}:${run}`);
      const runtimeStateIdentity = sha256(`${root}:runtime:${project}:${run}`);
      const rawFile = path.join(root, "raw", `${project}-r${run}.json`);
      const stdoutFile = path.join(root, "logs", `${project}-r${run}.stdout`);
      const stderrFile = path.join(root, "logs", `${project}-r${run}.stderr`);
      const coverage = [{
        root: "src/main/java",
        generation: 1,
        state: "COMPLETE",
        discoveredFiles: 10,
        indexedFiles: 10,
        failedFiles: 0,
        recoveredFiles: 0
      }];
      const raw = {
        schemaVersion: 1,
        sourceLock: {
          runtimeBuild: runtime.buildStamp,
          repoCommit: repositories[project].head,
          repoTree: repositories[project].tree,
          repoStatusSha256: repositories[project].statusSha256,
          scenarioFileSha256: scenarioLock.sha256,
          scenarioId: `${project}-scenario`
        },
        protocol: { cache: protocol.cache, generation: 1, pollMs: 50, timeoutMs: 180000, jdtlsDisabled: true },
        attempt: {
          schemaVersion: 1,
          projectId: project,
          scenarioId: `${project}-scenario`,
          generation: 1,
          stages: {
            open: { state: "REACHED", elapsedMs: 10, proof: {} },
            anchorReady: { state: "REACHED", elapsedMs: timings.anchorReady, proof: { anchorGeneration: 1 } },
            moduleReady: { state: "REACHED", elapsedMs: timings.moduleReady, proof: { roots: ["src/main/java"] } },
            complete: {
              state: "REACHED",
              elapsedMs: timings.complete,
              proof: {
                state: "READY",
                indexedGeneration: 1,
                pendingForeground: 0,
                pendingBackground: 0,
                coverage,
                resourceCoverage: []
              }
            },
            snapshotDurable: {
              state: "REACHED",
              elapsedMs: timings.snapshotDurable,
              proof: { semanticDigest, manifestFingerprint: sha256(`manifest:${project}`), bytes: 100 }
            }
          },
          negativeLookup: {
            beforeComplete: { state: "UNRESOLVED", coverage: "PARTIAL", authoritative: false },
            afterComplete: { state: "UNRESOLVED", coverage: "COMPLETE", authoritative: true }
          },
          finalSemanticDigest: semanticDigest,
          events: [{ elapsedMs: 20, name: "reconcile", status: { coverage: [{ ...coverage[0], state: "BUILDING" }] } }]
        },
        matrixProvenance: {
          runPlanSha256: runPlan.sha256,
          project,
          run,
          runtimeCommit: runtime.commit,
          runtimeCommitTree: runtime.commitTree,
          runtimeExecutableTree: runtime.executableTree,
          runtimePatchSha256: runtime.patch.sha256,
          repoHead: repositories[project].head,
          repoTree: repositories[project].tree,
          repoStatusSha256: repositories[project].statusSha256,
          scenarioLockSha256: scenarioLock.sha256,
          cachePolicy: protocol.cache,
          cacheIdentity,
          runtimeStateIdentity
        }
      };
      await Promise.all([
        writeFile(rawFile, `${JSON.stringify(raw, null, 2)}\n`),
        writeFile(stdoutFile, "ok\n"),
        writeFile(stderrFile, "")
      ]);
      artifacts.push({
        project,
        run,
        exitCode: 0,
        cacheIdentity,
        runtimeStateIdentity,
        raw: await descriptor(root, rawFile),
        stdout: await descriptor(root, stdoutFile),
        stderr: await descriptor(root, stderrFile)
      });
    }
  }
  const manifestFile = path.join(root, "progressive-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: "v32-progressive-index-three-repo",
    verifierVersion: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    platform: { node: process.version, platform: process.platform, arch: process.arch },
    runtime,
    runPlan,
    scenarioLock: { ...scenarioLock, projectIds: PROGRESSIVE_PROJECTS },
    sourceFiles,
    repositories,
    protocol,
    artifacts
  }, null, 2)}\n`);
  return { root, manifestFile };
}

async function descriptor(root, file) {
  const bytes = await readFile(file);
  return {
    file: path.relative(root, file).split(path.sep).join("/"),
    bytes: bytes.length,
    sha256: sha256(bytes)
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
