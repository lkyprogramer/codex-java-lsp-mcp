import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { acquireFixtureSlot, acquireLaunchdFixtureSlot, fixtureQuotaFile, inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";
import { isolatedJdtBenchmarkEnvironment } from "./run-isolated-jdt-benchmark.mjs";
import { isolatedValidationEnvironment } from "./run-isolated-validation.mjs";
import { matrixRuntimeEnvironment } from "./run-three-repo-cold-matrix.mjs";
import { createIsolatedTestEnvironment } from "./run-isolated-tests.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";

test("permission-denial-never-proves-owned-process-exit", async () => {
  const original = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error("injected probe denial"), { code: "EPERM" }); };
    assert.equal(processAlive(-42), true);
    await assert.rejects(eventually(() => !processAlive(-42), 40), /observation deadline exceeded/);
    process.kill = () => { throw Object.assign(new Error("injected absence"), { code: "ESRCH" }); };
    assert.equal(processAlive(-42), false);
    process.kill = () => { throw Object.assign(new Error("injected probe fault"), { code: "EIO" }); };
    assert.throws(() => processAlive(-42), /injected probe fault/);
  } finally { process.kill = original; }
});

test("nested validation and JDT domains replace inherited service state", () => {
  const previous = process.env.JAVA_LSP_SERVICE_STATE_ROOT;
  process.env.JAVA_LSP_SERVICE_STATE_ROOT = "/private/foreign-domain";
  try {
    for (const env of [isolatedValidationEnvironment("/private/broker", { JAVA_LSP_SERVICE_STATE_ROOT: "/private/injected" }),
      isolatedJdtBenchmarkEnvironment("/private/nested-jdt", "/private/repo", { JAVA_LSP_SERVICE_STATE_ROOT: "/private/injected" }),
      matrixRuntimeEnvironment("/private/matrix")]) {
      assert.notEqual(env.JAVA_LSP_SERVICE_STATE_ROOT, "/private/foreign-domain");
      assert.notEqual(env.JAVA_LSP_SERVICE_STATE_ROOT, "/private/injected");
      assert.equal(env.GRADLE_USER_HOME, path.join(env.JAVA_LSP_SERVICE_STATE_ROOT, "jdt-gradle-home"));
    }
    const isolated = createIsolatedTestEnvironment(process.env);
    try {
      assert.equal(isolated.environment.JAVA_LSP_SERVICE_STATE_ROOT, path.join(isolated.root, "service-state"));
      assert.equal(isolated.environment.GRADLE_USER_HOME, path.join(isolated.root, "service-state/jdt-gradle-home"));
    } finally { isolated.cleanup(); }
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_SERVICE_STATE_ROOT; else process.env.JAVA_LSP_SERVICE_STATE_ROOT = previous;
  }
});

test("external reservation pins the pre-bootstrap window against legacy delete and release", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "external-quota-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runRoot = path.join(root, "runs/fixture"); await mkdir(runRoot, { recursive: true });
  const lease = await acquireLaunchdFixtureSlot(root, { runRoot, label: `com.lky.ilv2-mac02b.${randomUUID()}` });
  try {
    await assert.rejects(lease.release(), /requires bootout closeout/);
    // A pre-exec publication may still show launchd's shared group 1. It is
    // never an owned group; a ready owner must lead its own group.
    assert.throws(() => lease.observe(1, 1), /invalid external incarnation/);
    assert.throws(() => lease.observe(2147483647, 1), /lead its own process group/);
    assert.throws(() => lease.observe(2147483647, 2, "launchctl"), /lead its own process group/);
    lease.observe(2147483647, 1, "launchctl");
    const db = new DatabaseSync(fixtureQuotaFile(root));
    try {
      assert.throws(() => db.prepare("DELETE FROM fixture_slots WHERE slot=?").run(lease.slot), /external_fixture_requires_closeout/);
      // The old client's dead-controller reclaim also executes DELETE.
      assert.throws(() => db.exec("DELETE FROM fixture_slots WHERE child_pid IS NULL"), /external_fixture_requires_closeout/);
    } finally { db.close(); }
    const other = await acquireFixtureSlot(root);
    try { await assert.rejects(acquireFixtureSlot(root, { timeoutMs: 100 }), /quota wait timed out/); }
    finally { await other.release(); }
    assert.equal(inspectFixtureSlots(root).length, 1);
  } finally { await lease.close(); }
  assert.equal(inspectFixtureSlots(root).length, 0);
});
