import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { call, childPids, closeRecoveryOwner, command, copyEvidence, eventually, evidence, gradleRepo, processAlive, startRecoveryOwner } from "./ilv2-mac-recovery-fixture.mjs";

// MAC-09 fault matrix: one isolated launchd owner (the real HTTP daemon under the owner launcher) is
// SIGKILLed from outside while held at each store boundary, and launchd restarts it. Every cell checks
// the same oracle: the old group exits, the new owner starts only after it, the binding on disk is the
// old or the new one and complete, the edit is served once FRESH, and the store converges within two
// GC cycles. The last cell replays the native wake signal: its round is a full hash, not FRESH until
// it confirms.
const GC_CYCLE_MS = 1500;
const PHASES = ["base-cloned", "builder-graph-search", "sealed-checkpointed", "manifest-written", "binding-tmp-written", "binding-renamed", "reclaim-marked", "query-leased"];
const query = (repoRoot, name) => ({ repoRoot, operation: "query", query: name, searchMode: "exact", preview: "none" });
const pgidOf = pid => Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());

async function until(probe, from, boundMs = 20000) {
  for (;;) {
    if (await probe()) return performance.now() - from;
    if (performance.now() - from > boundMs) return Infinity;
    await delay(10);
  }
}
async function served(client, repoRoot, name, timeoutMs = 120000) {
  return eventually(async () => {
    const value = await call(client, "java_symbol", query(repoRoot, name));
    if (value.exact !== "match") return false;
    const status = await call(client, "java_status", { repoRoot });
    return status.indexView?.state === "FRESH" ? { view: status.indexView, value } : false;
  }, timeoutMs);
}

test("fault-matrix-sigkill-at-each-store-boundary-and-wake", { timeout: 1200000 }, async t => {
  let repo;
  const owner = await startRecoveryOwner(t, "matrix", { gcCycleMs: GC_CYCLE_MS, env: { ILV2_NATIVE_TEST_HOOKS: "1" },
    repos: async dir => [repo = await gradleRepo(dir, "repo")] });
  const record = { name: t.name, gcCycleMs: GC_CYCLE_MS, cells: [] };
  try {
    let current = await owner.incarnation();
    let http = await owner.http();
    await served(http, repo, "demo.Greeter");
    for (const [index, phase] of PHASES.entries()) {
      const cell = { phase };
      record.cells.push(cell);
      const before = (await owner.bindings())[repo];
      const symbol = `demo.Fault${index}`;
      await owner.arm(phase);
      let pending;
      if (phase === "query-leased") pending = call(http, "java_symbol", query(repo, "demo.Greeter"));
      else await writeFile(path.join(repo, `src/main/java/demo/Fault${index}.java`), `package demo;\n\npublic class Fault${index} {}\n`);
      cell.held = await owner.held(phase);
      assert.equal(pgidOf(cell.held.pid), current.pgid, `${phase}: the held process is in the owner's group`);
      cell.atFault = { binding: (await owner.bindings())[repo], objects: await owner.storeObjects() };
      const faultAt = owner.kill(current);
      let atExit;
      cell.faultToOwnerGroupExitMs = await until(async () => {
        if (processAlive(-current.pgid)) return false;
        atExit = (await owner.bindings())[repo];
        return true;
      }, faultAt);
      assert.ok(cell.faultToOwnerGroupExitMs <= 10000, `${phase}: group exit ${cell.faultToOwnerGroupExitMs} ms`);
      if (pending) cell.pendingSettledMs = await pending.then(value => { cell.pending = value.error?.slice(0, 200) ?? "answered"; return performance.now() - faultAt; });
      // The binding on disk is complete: the old one, or (once renamed) the new one.
      assert.ok(atExit, `${phase}: a binding exists`);
      cell.bindingAtExit = atExit.snapshotId === before.snapshotId ? "old" : "new";
      // binding-renamed: the new binding is in place; reclaim-marked: the publish finished, its predecessor was being reclaimed.
      assert.equal(cell.bindingAtExit, ["binding-renamed", "reclaim-marked"].includes(phase) ? "new" : "old", `${phase}: binding at exit`);
      cell.boundSnapshot = await owner.verifySnapshot(atExit.snapshotId);
      assert.equal(cell.boundSnapshot.matches, true);

      const next = await owner.incarnation(current.pid);
      assert.deepEqual(next.previousGroupsAlive, [], `${phase}: the new owner started after the old group exited`);
      current = next;
      http = await owner.http();
      const restarted = performance.now();
      const result = await served(http, repo, phase === "query-leased" ? "demo.Greeter" : symbol);
      cell.servedAfterRestartMs = performance.now() - restarted;
      const binding = (await owner.bindings())[repo];
      assert.equal(result.view.snapshotId, binding.snapshotId);
      assert.equal((await owner.verifySnapshot(binding.snapshotId)).matches, true);
      const started = performance.now();
      cell.convergedMs = await until(async () => {
        const objects = await owner.storeObjects();
        cell.final = objects;
        return objects.jobs.length === 0 && JSON.stringify(objects.snapshots) === JSON.stringify([binding.snapshotId])
          && Object.values(objects.workspaceFiles).every(files => files.length === 1 && files[0] === "binding.json");
      }, started, 2 * GC_CYCLE_MS + 1500);
      assert.ok(Number.isFinite(cell.convergedMs), `${phase}: store did not converge: ${JSON.stringify(cell.final)}`);
    }

    // Wake: the native helper's resume path (its test hook replays the IOKit callback).
    const helper = childPids(current.pid).find(pid => / watch /.test(command(pid)));
    assert.ok(helper, "the owner runs its native watch helper");
    const roundsBefore = (await call(http, "java_status", {})).index.workspaces[0].rounds;
    await owner.arm("round-full-hash");
    process.kill(helper, "SIGUSR1");
    const wake = { helper };
    wake.held = await owner.held("round-full-hash", 10000);
    wake.whileHeld = (await call(http, "java_status", { repoRoot: repo })).indexView;
    assert.notEqual(wake.whileHeld.state, "FRESH", "not FRESH before the wake's full hash confirms");
    await owner.release("round-full-hash");
    wake.after = await eventually(async () => {
      const status = await call(http, "java_status", { repoRoot: repo });
      return status.indexView?.state === "FRESH" && status.indexView;
    }, 30000);
    wake.rounds = (await call(http, "java_status", {})).index.workspaces[0].rounds - roundsBefore;
    assert.ok(wake.rounds >= 1);
    assert.equal(processAlive(helper), true, "a wake does not restart the helper");
    record.wake = wake;
  } catch (error) {
    record.primaryError = { message: String(error), stack: error.stack };
    throw error;
  } finally {
    await copyEvidence(owner, t.name).catch(error => { record.copyError = String(error); });
    try { record.closeout = await closeRecoveryOwner(owner); } finally { await evidence(t.name, record); }
  }
});
