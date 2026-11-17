import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { acquireFixtureSlot, acquireLaunchdFixtureSlot, fixtureQuotaFile, inspectFixtureSlots, reclaimAbandonedExternalFixtures } from "./ilv2-mac-fixture-quota.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

async function deadPid() {
  const child = execFile(process.execPath, ["-e", ""]);
  await new Promise(resolve => child.once("exit", resolve));
  return child.pid;
}
async function abandonedExternal(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "abandoned-quota-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await reclaimAbandonedExternalFixtures(root, { probe: () => assert.fail("no candidates") }), []);
  const insert = (slot, pid) => {
    const token = randomUUID();
    const db = new DatabaseSync(fixtureQuotaFile(root));
    try {
      db.prepare("INSERT INTO fixture_slots(slot,token,pid) VALUES(?,?,?)").run(slot, token, pid);
      db.prepare("INSERT INTO external_fixture_jobs VALUES(?,?,?,?)").run(token, `gui/${process.getuid()}`, `com.lky.ilv2-mac-test.${token}`, path.join(root, "runs", token));
    } finally { db.close(); }
    return token;
  };
  return { root, insert };
}

test("an abandoned external fixture is reclaimed only with a dead controller, no launchd job and no process", async t => {
  const { root, insert } = await abandonedExternal(t);
  insert(0, await deadPid());
  insert(1, process.pid);
  const probed = [];
  const reclaimed = await reclaimAbandonedExternalFixtures(root, { probe: async row => { probed.push(row.slot); return { absent: true, processes: 0 }; } });
  assert.deepEqual(probed, [0], "a live controller is never probed");
  assert.deepEqual(reclaimed.map(row => row.slot), [0]);
  assert.deepEqual(inspectFixtureSlots(root).map(row => row.slot), [1]);
  const db = new DatabaseSync(fixtureQuotaFile(root), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM external_fixture_jobs").get().n, 1, "only the reclaimed marker is removed"); }
  finally { db.close(); }
});

test("an external fixture still known to launchd, still running, or unprovable keeps its slot", async t => {
  const { root, insert } = await abandonedExternal(t);
  insert(0, await deadPid());
  for (const probe of [async () => ({ absent: false, processes: 0 }), async () => ({ absent: true, processes: 1 }), async () => { throw new Error("launchctl timed out"); }, async () => undefined]) {
    assert.deepEqual(await reclaimAbandonedExternalFixtures(root, { probe }), []);
    assert.equal(inspectFixtureSlots(root).length, 1);
  }
});

test("acquisition frees a slot left by an aborted launchd fixture run", async t => {
  const { root, insert } = await abandonedExternal(t);
  insert(0, await deadPid());
  // Real probe: the random label was never bootstrapped and nothing references its run root.
  const first = await acquireFixtureSlot(root, { timeoutMs: 5000 });
  const second = await acquireFixtureSlot(root, { timeoutMs: 5000 });
  try { assert.deepEqual(inspectFixtureSlots(root).map(row => row.slot).sort(), [0, 1]); }
  finally { await first.release(); await second.release(); }
  assert.equal(inspectFixtureSlots(root).length, 0);
});
