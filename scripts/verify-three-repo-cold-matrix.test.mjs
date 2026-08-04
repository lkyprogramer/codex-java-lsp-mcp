import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

test("verifier rejects a candidate P_read regression even when must coverage remains complete", async t => {
  const matrixDir = await fixtureMatrix({ cipherlink: { newPRead: 0.49 } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  const result = verifyMatrix({ matrixDir });
  const cipherlink = result.projects.find(project => project.project === "cipherlink");

  assert.equal(result.passed, false);
  assert.equal(cipherlink.gate.rReadMust, true);
  assert.equal(cipherlink.gate.pRead, false);
});

test("verifier rejects a matrix whose old and new cells use different scenario files", async t => {
  const matrixDir = await fixtureMatrix({ lishuedu: { newScenarioFile: "/tmp/different-lishuedu-scenarios.jsonl" } });
  t.after(() => rm(path.dirname(matrixDir), { recursive: true, force: true }));

  assert.throws(() => verifyMatrix({ matrixDir }), MatrixValidationError);
});

async function fixtureMatrix(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "three-repo-matrix-test-"));
  const matrixDir = path.join(root, "matrix");
  await mkdir(matrixDir, { recursive: true });
  for (const project of MATRIX_PROJECTS) {
    const projectOverride = overrides[project] || {};
    const scenarioFile = path.join(root, "frozen-scenarios", `${project}.scenarios.jsonl`);
    for (const round of MATRIX_ROUNDS) {
      for (const variant of MATRIX_VARIANTS) {
        const old = variant === "old";
        const pRead = old ? 0.50 : (projectOverride.newPRead ?? 0.60);
        const recall = old ? 0.70 : 0.70;
        const elapsedMs = old ? 100 : 105;
        const payload = {
          metadata: {
            projectId: project,
            warmState: "cold-nolsp",
            strategy: "impact",
            verbosity: "diagnostic",
            runs: 5,
            scenarioFile: old ? scenarioFile : (projectOverride.newScenarioFile ?? scenarioFile)
          },
          rows: [{
            id: `${project}-scenario`,
            attempts: Array.from({ length: 5 }, () => ({ recall, pRead, rReadMust: 1, elapsedMs }))
          }]
        };
        const file = path.join(matrixDir, `${project}-r${round}-${variant}.json`);
        await writeFile(file, JSON.stringify(payload));
      }
    }
  }
  return matrixDir;
}
