import test from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { call, childPids, closeRecoveryOwner, command, copyEvidence, eventually, evidence, frozenToolchains, gradleRepo, greetCall, liveDaemons,
  processAlive, startRecoveryOwner, writeGradleConfig } from "./ilv2-mac-recovery-fixture.mjs";

// MAC-09 formal recovery (contract §2.1, G09): the real HTTP daemon under the owner launcher as an
// isolated launchd job, real FSEvents trackers, builders, query workers, JDT and a Gradle import in
// the daemon's private Gradle home. The owner is SIGKILLed from outside; launchd restarts it.
const SEMANTIC_RETRY_MS = 30_000;
/** The JDT wrapper or its JVM (an owner's query workers and builders also run from a "java-*" source path). */
const JDT_COMMAND = /\/jdtls(\s|$)|org\.eclipse\.equinox\.launcher/;
const query = (repoRoot, name) => ({ repoRoot, operation: "query", query: name, searchMode: "exact", preview: "none" });
const position = repoRoot => ({ repoRoot, operation: "position", file: path.join(repoRoot, greetCall.file), line: greetCall.line, column: greetCall.column, semanticTimeoutMs: 10000 });
const pgidOf = pid => Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());

/** Elapsed ms from `from` until `probe` holds (polled every 10 ms), or Infinity past the bound. */
async function until(probe, from, boundMs = 20000) {
  for (;;) {
    if (await probe()) return performance.now() - from;
    if (performance.now() - from > boundMs) return Infinity;
    await delay(10);
  }
}
async function freshView(client, repoRoot, timeoutMs = 120000) {
  return eventually(async () => {
    const status = await call(client, "java_status", { repoRoot, detail: "diagnostic" });
    return status.indexView?.state === "FRESH" && !status.error ? status : false;
  }, timeoutMs);
}
/** A JDT definition at App's call of greet resolves to Greeter.java (polls through the import). */
async function semanticDefinition(client, repoRoot) {
  const attempts = [];
  const result = await eventually(async () => {
    const value = await call(client, "java_symbol", position(repoRoot));
    attempts.push(value.error ? value.error.slice(0, 200) : "ok");
    if (value.error) { await delay(2000); return false; }
    return JSON.stringify(value.definitions ?? []).includes("Greeter.java") ? value : false;
  }, 300000);
  return { result, attempts: attempts.length };
}
async function tree(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const relative = path.join(prefix, entry.name);
    out.push(relative);
    if (entry.isDirectory()) out.push(...await tree(path.join(dir, entry.name), relative));
  }
  return out.sort();
}
/** The served snapshot is the bound one, still hashes to its manifest, and covers every root. */
async function staticOracle(owner, client, repoRoot) {
  // A read first: status reports a snapshot's index status only once a request opened that snapshot.
  assert.equal((await call(client, "java_symbol", query(repoRoot, "demo.Greeter"))).exact, "match");
  const status = await freshView(client, repoRoot);
  const binding = (await owner.bindings())[repoRoot];
  const snapshot = await owner.verifySnapshot(binding.snapshotId);
  const coverage = status.javaIndex?.coverage ?? [];
  assert.equal(status.indexView.snapshotId, binding.snapshotId, "the view serves the bound snapshot");
  assert.equal(snapshot.matches, true, "the bound database still hashes to its manifest");
  assert.deepEqual(snapshot.sidecars, [], "a sealed snapshot has no WAL/SHM");
  assert.ok(coverage.length > 0 && coverage.every(entry => entry.state === "COMPLETE" && entry.failedFiles === 0), JSON.stringify(coverage));
  return { view: status.indexView, binding, snapshot, coverage };
}
/** Dead jobs, unbound snapshots and binding temporaries are gone; only bound snapshots remain. */
async function converged(owner, boundMs) {
  const started = performance.now();
  let last;
  const ms = await until(async () => {
    const objects = await owner.storeObjects();
    const bound = Object.values(await owner.bindings()).map(binding => binding.snapshotId).sort();
    last = { objects, bound };
    return objects.jobs.length === 0 && JSON.stringify(objects.snapshots) === JSON.stringify(bound)
      && Object.values(objects.workspaceFiles).every(files => files.length === 1 && files[0] === "binding.json");
  }, started, boundMs);
  assert.ok(Number.isFinite(ms), `store did not converge within ${boundMs} ms: ${JSON.stringify(last)}`);
  return { ms, ...last };
}

test("owner-kill-during-builder-query-base-lease-full-recovery", { timeout: 900000 }, async t => {
  const frozen = await frozenToolchains();
  let main, side;
  const gcCycleMs = 1500;
  const owner = await startRecoveryOwner(t, "full", { frozen, gcCycleMs, pins: roots => [roots[0]],
    repos: async dir => { main = await gradleRepo(dir, "main"); side = await gradleRepo(dir, "side"); return [main, side]; } });
  const record = { name: t.name, gcCycleMs };
  let primary;
  try {
    const first = await owner.incarnation();
    const http = await owner.http();
    record.before = { owner: first, fresh: (await freshView(http, main)).indexView };
    record.before.semantic = await semanticDefinition(http, main);
    const daemon = await eventually(async () => (await liveDaemons(owner.home))[0], 120000);
    const daemonPgid = pgidOf(daemon);
    assert.notEqual(daemonPgid, first.pgid, "the Gradle daemon is an EXTERNAL_BUILD_DAEMON");
    const jdt = childPids(first.pid).filter(pid => JDT_COMMAND.test(command(pid)));
    assert.ok(jdt.length > 0, "the daemon runs JDT as its own child");
    Object.assign(record.before, { daemon, daemonPgid, jdt, daemonCommand: command(daemon) });

    // Builder: the side repo's first full build holds in the builder process, mid SQL.
    await owner.arm("builder-graph-search");
    const sideStart = await call(http, "java_symbol", query(side, "demo.Greeter"));
    const builder = await owner.held("builder-graph-search");
    assert.notEqual(builder.pid, first.pid); assert.equal(pgidOf(builder.pid), first.pgid, "the builder is in the owner's group");
    // Query: a request holds its view and a query-worker lease on main's bound snapshot.
    await owner.arm("query-leased");
    const pending = call(http, "java_symbol", query(main, "demo.Greeter"));
    const queryHeld = await owner.held("query-leased");
    // Base: main's next round holds a base lease with its clone in a new job.
    await owner.arm("base-cloned");
    const bindingBefore = (await owner.bindings())[main];
    await writeFile(path.join(main, "src/main/java/demo/Farewell.java"), "package demo;\n\npublic class Farewell {\n  public String bye() { return \"bye\"; }\n}\n");
    const baseHeld = await owner.held("base-cloned");
    assert.deepEqual([queryHeld.pid, baseHeld.pid], [first.pid, first.pid]);
    const atFault = await owner.storeObjects();
    assert.ok(atFault.snapshots.includes(bindingBefore.snapshotId), "leased snapshot present while held");
    assert.ok(atFault.jobs.length >= 2, `builder and base-clone jobs at fault: ${atFault.jobs}`);
    Object.assign(record, { sideStart: sideStart.error ?? sideStart.exact, held: { builder, queryHeld, baseHeld }, bindingBefore, atFault });

    const faultAt = owner.kill(first);
    let bindingAtExit;
    const [ownerGoneMs, daemonGoneMs, pendingMs] = await Promise.all([
      until(async () => {
        if (processAlive(-first.pgid)) return false;
        bindingAtExit = (await owner.bindings())[main];
        return true;
      }, faultAt),
      until(() => !processAlive(daemon), faultAt),
      pending.then(value => { record.pending = value; return performance.now() - faultAt; })
    ]);
    Object.assign(record, { faultToOwnerGroupExitMs: ownerGoneMs, faultToGradleDaemonExitMs: daemonGoneMs, faultToPendingSettledMs: pendingMs, bindingAtExit });
    assert.ok(ownerGoneMs <= 10000, `OWNER_PROCESS group exit ${ownerGoneMs} ms`);
    assert.ok(daemonGoneMs <= 10000, `EXTERNAL_BUILD_DAEMON exit ${daemonGoneMs} ms`);
    assert.ok(pendingMs <= 10000, "the held request settled");
    assert.deepEqual(bindingAtExit, bindingBefore, "the fault came before seal/bind: the old complete binding stands");
    for (const pid of [builder.pid, ...jdt]) assert.equal(processAlive(pid), false, `owner child ${pid} gone`);

    const second = await owner.incarnation(first.pid);
    assert.deepEqual(second.previousGroupsAlive, [], "the new owner started only after the old group was gone");
    const http2 = await owner.http();
    const semantic = await eventually(async () => {
      const status = await call(http2, "java_status", {});
      return status.semantic?.semanticState === "READY" ? status.semantic : false;
    }, 30000);
    record.semanticReadyAfterFaultMs = performance.now() - faultAt;
    assert.equal(semantic.staticAdmission, "OPEN");

    // Static: binding restored, the edit made before the fault is published by the first round.
    await eventually(async () => (await freshView(http2, main)).indexView.snapshotId !== bindingBefore.snapshotId, 120000);
    record.static = await staticOracle(owner, http2, main);
    assert.notEqual(record.static.view.snapshotId, bindingBefore.snapshotId);
    const farewell = await call(http2, "java_symbol", query(main, "demo.Farewell"));
    assert.equal(farewell.exact, "match", JSON.stringify(farewell));
    const { client: stdio, pid: stdioPid } = await owner.stdio(main);
    const viaStdio = await call(stdio, "java_symbol", query(main, "demo.Farewell"));
    assert.deepEqual(viaStdio.candidates, farewell.candidates, "stdio relays the same owner's answer");
    assert.deepEqual(childPids(stdioPid), [], "stdio starts nothing of its own");
    const sideFresh = await eventually(async () => {
      const value = await call(http2, "java_symbol", query(side, "demo.Greeter"));
      return value.exact === "match" && value;
    }, 120000);
    record.sideRecovered = sideFresh.exact;
    record.gc = await converged(owner, 2 * gcCycleMs + 1500);

    // Semantic: a new JDT and import in the cleaned domain.
    record.after = { semantic: await semanticDefinition(http2, main) };
    record.after.daemons = await eventually(async () => { const pids = await liveDaemons(owner.home); return pids.length && !pids.includes(daemon) && pids; }, 120000);
  } catch (error) {
    primary = error;
    record.primaryError = { message: String(error), stack: error.stack };
    throw error;
  } finally {
    await copyEvidence(owner, t.name).catch(error => { record.copyError = String(error); });
    try {
      record.closeout = await closeRecoveryOwner(owner, frozen);
    } finally { await evidence(t.name, record); }
    if (!primary) assert.deepEqual(record.closeout.daemonsAfterNormalStop, [], "the daemon's normal stop stopped and confirmed its Gradle daemons");
  }
});

test("gradle-stop-failure-static-recovers-semantic-blocks-then-recovers", { timeout: 900000 }, async t => {
  const frozen = await frozenToolchains();
  let main;
  const owner = await startRecoveryOwner(t, "blocked", { frozen, pins: roots => [roots[0]], repos: async dir => [main = await gradleRepo(dir, "main")] });
  const record = { name: t.name };
  let primary;
  try {
    const first = await owner.incarnation();
    const http = await owner.http();
    await freshView(http, main);
    record.before = { semantic: await semanticDefinition(http, main) };
    const daemon = await eventually(async () => (await liveDaemons(owner.home))[0], 120000);
    const homeBefore = await tree(owner.home);
    // The injected failure: the restarted daemon's cleanup finds the frozen launcher's digest changed.
    await writeGradleConfig(owner.gradleConfig, frozen, { launcherSha256: "0".repeat(64) });

    const faultAt = owner.kill(first);
    const ownerGoneMs = await until(() => !processAlive(-first.pgid), faultAt);
    assert.ok(ownerGoneMs <= 10000, `OWNER_PROCESS group exit ${ownerGoneMs} ms`);
    const second = await owner.incarnation(first.pid);
    assert.deepEqual(second.previousGroupsAlive, [], "no admission before the old OWNER_PROCESS group exited");
    const http2 = await owner.http();
    const blocked = await eventually(async () => {
      const status = await call(http2, "java_status", {});
      return status.semantic?.semanticState === "RECOVERY_BLOCKED" ? status.semantic : false;
    }, 30000);
    const blockedAt = performance.now();
    assert.match(blocked.failure ?? "", /frozen Gradle launcher changed/);
    assert.equal(blocked.staticAdmission, "OPEN");
    assert.equal(processAlive(daemon), true, "a failed cleanup kills nothing by pid");
    Object.assign(record, { daemon, faultToOwnerGroupExitMs: ownerGoneMs, second, blocked });

    // Static service is independent of the blocked semantic domain.
    record.static = await staticOracle(owner, http2, main);
    // Required: a bounded, explicit block. Auto: static facts with an explicit semantic gap.
    const required = await call(http2, "java_symbol", position(main));
    record.required = required;
    // The tool error carries the admission message (JavaIntelligenceError JDT_NOT_READY).
    assert.match(required.error ?? "", /^semanticState=RECOVERY_BLOCKED: frozen Gradle launcher changed/);
    assert.ok(required.elapsedMs < 10000, `required semantic answered in ${required.elapsedMs} ms`);
    const auto = await call(http2, "java_impact", { repoRoot: main, file: path.join(main, "src/main/java/demo/Greeter.java"), line: 4, column: 17,
      profile: "service", semanticPolicy: "auto" });
    record.auto = auto;
    assert.equal(auto.error, undefined, auto.error);
    assert.deepEqual(auto.semantic, { used: true, completion: "FAILED" }, "auto does not claim semantic evidence");
    assert.ok(auto.unresolved.some(gap => /JDT_NOT_READY/.test(gap)), "auto names the static-only gap");
    assert.ok(auto.contexts.some(context => context.path === "src/main/java/demo/App.java"), "auto still delivers the static facts");
    const jdtChildren = childPids(second.pid).filter(pid => JDT_COMMAND.test(command(pid)));
    assert.deepEqual(jdtChildren, [], "no new JDT import while blocked");
    assert.deepEqual(await liveDaemons(owner.home), [daemon], "no new Gradle daemon while blocked");
    const homeBlocked = await tree(owner.home);
    assert.deepEqual(homeBefore.filter(entry => !homeBlocked.includes(entry)), [], "nothing in the Gradle home was deleted");

    // Repair: only a later semantic request (past the retry floor) runs one more cleanup; semantic
    // admission reopens once that cleanup stopped the old daemon.
    await writeGradleConfig(owner.gradleConfig, frozen);
    const early = await call(http2, "java_symbol", position(main));
    assert.match(early.error ?? "", /RECOVERY_BLOCKED/, "no retry inside the floor");
    await delay(Math.max(0, SEMANTIC_RETRY_MS - (performance.now() - blockedAt)) + 1000);
    const trigger = await call(http2, "java_symbol", position(main));
    assert.match(trigger.error ?? "", /^semanticState=(RECOVERY_BLOCKED|RECOVERING)/);
    const ready = await eventually(async () => {
      const status = await call(http2, "java_status", {});
      return status.semantic?.semanticState === "READY" ? { daemonAlive: processAlive(daemon) } : false;
    }, 30000);
    assert.equal(ready.daemonAlive, false, "the old daemon was stopped before semantic admission reopened");
    record.after = { ready, trigger: trigger.error.slice(0, 300), semantic: await semanticDefinition(http2, main) };
    record.after.daemons = await liveDaemons(owner.home);
    assert.ok(!record.after.daemons.includes(daemon));
  } catch (error) {
    primary = error;
    record.primaryError = { message: String(error), stack: error.stack };
    throw error;
  } finally {
    await copyEvidence(owner, t.name).catch(error => { record.copyError = String(error); });
    try {
      record.closeout = await closeRecoveryOwner(owner, frozen);
    } finally { await evidence(t.name, record); }
    if (!primary) assert.deepEqual(record.closeout.daemonsAfterNormalStop, [], "the daemon's normal stop stopped and confirmed its Gradle daemons");
  }
});
