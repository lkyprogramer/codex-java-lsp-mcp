import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProgressiveMatrixCli,
  progressiveAttemptEnvironment,
  validateProgressiveScenarioDocument
} from "./run-progressive-index-three-repo.mjs";

test("progressive matrix requires the formal three repositories and five runs", () => {
  const cli = parseProgressiveMatrixCli([
    "--output-dir", "/tmp/out",
    "--lishuedu", "/tmp/lishu",
    "--cipherlink", "/tmp/cipher",
    "--exam-parent-v3", "/tmp/exam"
  ]);
  assert.equal(cli.runs, 5);
  assert.equal(cli.generation, 1);
  assert.throws(() => parseProgressiveMatrixCli([
    "--output-dir", "/tmp/out",
    "--lishuedu", "/tmp/lishu",
    "--cipherlink", "/tmp/cipher",
    "--exam-parent-v3", "/tmp/exam",
    "--runs", "4"
  ]), /requires --runs 5/);
});

test("progressive scenario lock requires one exact-commit scenario per project", () => {
  const scenario = project => ({
    projectId: project,
    repoCommit: "a".repeat(40),
    anchorScenarioId: `${project}-anchor`,
    anchor: { file: "src/A.java", line: 1, column: 1 },
    requiredTypeDefinitions: [{ typeText: "demo.B", expectedFile: "src/B.java" }],
    missingTypeFqn: "missing.Type"
  });
  assert.doesNotThrow(() => validateProgressiveScenarioDocument({
    schemaVersion: 1,
    scenarios: [scenario("lishuedu"), scenario("cipherlink"), scenario("exam-parent-v3")]
  }));
  assert.throws(() => validateProgressiveScenarioDocument({
    schemaVersion: 1,
    scenarios: [scenario("lishuedu"), scenario("cipherlink")]
  }), /exactly one/);
});

test("progressive attempts scrub host runtime selectors and use private JDT/cache roots", () => {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousCache = process.env.JAVA_LSP_CACHE_ROOT;
  process.env.NODE_OPTIONS = "--require=/active/mutator.cjs";
  process.env.JAVA_LSP_CACHE_ROOT = "/active/cache";
  try {
    const environment = progressiveAttemptEnvironment("/tmp/progressive-state");
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.JDTLS_BIN, "/usr/bin/false");
    assert.equal(environment.JAVA_LSP_CACHE_ROOT, "/tmp/progressive-state/process-cache");
    assert.equal(environment.HOME, "/tmp/progressive-state/home");
    assert.equal(environment.JAVA_LSP_ISOLATED_VALIDATION, "1");
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    if (previousCache === undefined) delete process.env.JAVA_LSP_CACHE_ROOT;
    else process.env.JAVA_LSP_CACHE_ROOT = previousCache;
  }
});
