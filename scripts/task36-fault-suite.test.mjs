import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EXPECTED_CASES = [
  {
    id: "concurrent-jdt-start",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^concurrent ensureStarted shares one transactional start$",
    expectedInvariant: "concurrent callers share exactly one transactional JDT start"
  },
  {
    id: "initialize-timeout",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^a short caller deadline does not cancel a shared JDT startup$",
    expectedInvariant: "one initialize caller timing out does not cancel shared startup"
  },
  {
    id: "child-exits-initialize",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^failed initialize disposes the attempt and permits a clean retry$",
    expectedInvariant: "an initialize failure disposes its child and permits a clean retry"
  },
  {
    id: "child-exits-ready",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^a READY child that exits marks the session BROKEN and restartable$",
    expectedInvariant: "a READY child exit marks the session BROKEN and restartable"
  },
  {
    id: "rg-partial-timeout",
    testFile: "dist/search/rg-runner.test.js",
    testNamePattern: "^rg timeout returns partial evidence but is not complete$",
    expectedInvariant: "timeout returns PARTIAL_TIMEOUT rather than COMPLETE"
  },
  {
    id: "rg-partial-limit",
    testFile: "dist/search/rg-runner.test.js",
    testNamePattern: "^the match cap makes the result PARTIAL_LIMIT$",
    expectedInvariant: "a match limit returns PARTIAL_LIMIT rather than COMPLETE",
    accepted_variance: "limit seam only; this does not claim a real OS ENOBUFS condition"
  },
  {
    id: "java-index-crash",
    testFile: "dist/java-index/sql/sql-client-lifecycle.test.js",
    testNamePattern: "^failed sibling reconcile marks DEGRADED$",
    expectedInvariant: "a worker crash rejects pending requests and degrades the client"
  },
  {
    id: "snapshot-corruption",
    testFile: "dist/java-index/sql/sql-client-lifecycle.test.js",
    testNamePattern: "^failed sibling copy does not leave dest and allows a later open$",
    expectedInvariant: "a corrupt sibling snapshot falls back to an empty OPEN store"
  },
  {
    id: "watcher-error",
    testFile: "dist/repo-change-coordinator.test.js",
    testNamePattern: "^degrade catches an async listener rejection and records the listener failure$",
    expectedInvariant: "a watcher listener error is recorded without escaping the coordinator"
  },
  {
    id: "dirty-reconcile",
    testFile: "dist/repo-runtime-manager.test.js",
    testNamePattern: "^reconcileIfDirty leaves dirty set when reconcile fails, without failing the request$",
    expectedInvariant: "failed dirty reconciliation remains dirty for a later retry"
  },
  {
    id: "outside-repo-result",
    testFile: "dist/semantic-location.test.js",
    testNamePattern: "^semantic locations outside canonical repo root are rejected$",
    expectedInvariant: "outside-repository semantic results are rejected"
  },
  {
    id: "semantic-one-waiter-cancel",
    testFile: "dist/semantic-gateway.test.js",
    testNamePattern: "^one caller deadline does not cancel another caller sharing backend work$",
    expectedInvariant: "one cancelled semantic waiter does not cancel shared backend work"
  },
  {
    id: "semantic-all-cancel",
    testFile: "dist/semantic-gateway.test.js",
    testNamePattern: "^the last hierarchy waiter returns without post-deadline settlement grace when it aborts the transport$",
    expectedInvariant: "the final cancelled waiter aborts backend transport, returns at its own deadline, and cannot populate the complete cache"
  }
];

test("Task 36 fault suite records the authority manifest, per-case evidence hashes, and a passing aggregate gate", async t => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "task36-fault-suite-"));
  const output = path.join(artifactDir, "result.json");
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ["scripts/task36-fault-suite.mjs", "--output", output], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 90_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));

  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(payload.gate, {
    requiredCaseCount: EXPECTED_CASES.length,
    passed: true
  });
  assert.deepEqual(payload.cases.map(({ id, testFile, testNamePattern, expectedInvariant, accepted_variance }) => ({
    id,
    testFile,
    testNamePattern,
    expectedInvariant,
    ...(accepted_variance ? { accepted_variance } : {})
  })), EXPECTED_CASES);
  assert.ok(payload.cases.every(item => item.status === "passed"));
  assert.ok(payload.cases.every(item => item.exitCode === 0));
  assert.ok(payload.cases.every(item => item.signal === null));
  assert.ok(payload.cases.every(item => item.selectedTestCount === 1));
  assert.ok(payload.cases.every(item => item.selectedTestNames.length === 1));
  assert.ok(payload.cases.every(item => new RegExp(item.testNamePattern).test(item.selectedTestNames[0])));
  assert.ok(payload.cases.every(item => /^[a-f0-9]{64}$/.test(item.stdoutSha256)));
  assert.ok(payload.cases.every(item => /^[a-f0-9]{64}$/.test(item.stderrSha256)));
});

test("Task 36 fault suite bounds every child test and records a timeout as a failed case", async t => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "task36-fault-timeout-"));
  const output = path.join(artifactDir, "result.json");
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    "scripts/task36-fault-suite.mjs",
    "--output", output,
    "--case-timeout-ms", "1"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 10_000
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.manifest.caseTimeoutMs, 1);
  assert.equal(payload.gate.passed, false);
  assert.equal(payload.cases[0].status, "failed");
  assert.equal(payload.cases[0].timedOut, true);
});
