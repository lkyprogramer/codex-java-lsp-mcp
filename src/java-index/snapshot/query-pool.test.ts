import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BuildScheduler } from "../../index-builder/build-scheduler.js";
import { ownerChildStdio } from "../../mac-platform/owner-lock.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { QueryPool, waitForSharedBuild, type QueryLease } from "./query-pool.js";

// Run a deliberately long native SQLite step in the child. This proves process
// cancellation, not the MAC-06C production query adapter or file snapshot lease.
const childScript = `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
process.on('message', async message => {
  if (message === 'busy') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    process.send({ kind: 'busy' }, () => {
      db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();
      db.close();
      process.exit(3); // Finishing instead of cancellation fails the signal assertion.
    });
  }
  if (message === 'result') {
    process.send({ kind: 'result', value: process.argv[3] });
    const deadline = Date.now() + 15000;
    while (!existsSync(process.argv[2]) && Date.now() < deadline) await delay(5);
    process.exit(existsSync(process.argv[2]) ? 0 : 2);
  }
});
process.send({ kind: 'ready' });
`;
const events: Array<Record<string, unknown>> = [];
function record(testName: string, event: string, details: Record<string, unknown> = {}) {
  events.push({ test: testName, event, atMs: performance.now(), wallTimeMs: Date.now(), ...details });
}
after(async () => {
  const root = process.env.ILV2_EVIDENCE_ROOT;
  if (!root) return;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "query-pool.json"), JSON.stringify({ fixture: "real fork; long native SQLite step; not production query adapter/file lease integration", events }, null, 2));
  await writeFile(path.join(root, "query-pool-pids.json"), JSON.stringify(events.filter(event => event.event === "fork" || event.event === "close"), null, 2));
});
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(condition: () => boolean, label: string) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}
const classified = (code: "DEADLINE_EXCEEDED" | "CANCELLED") => (error: unknown) => error instanceof JavaIntelligenceError && error.code === code;
type Attempt = {
  name: string; child: ChildProcess; ready: Promise<void>; closed: Promise<void>;
  result: Promise<string>; resultReceived: boolean; busy: boolean;
  isClosed: boolean; closeAt?: number; closeSignal?: NodeJS.Signals | null; releaseFile: string;
};
async function fixture(t: TestContext, queueMax = 32) {
  const root = await mkdtemp(path.join(tmpdir(), "ilv2-query-pool-"));
  const script = path.join(root, "query.mjs");
  await writeFile(script, childScript);
  const pool = new QueryPool<string>(queueMax);
  const attempts: Attempt[] = [];
  const acquisitions: string[] = [];
  const releases: string[] = [];
  const held = new Set<string>();
  function spawn(name: string, execPath = process.execPath): Attempt {
    const releaseFile = path.join(root, `release-${attempts.length}`);
    const child = fork(script, [releaseFile, name], { execPath, execArgv: [], stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) });
    let ready!: () => void;
    let result!: (value: string) => void;
    const attempt: Attempt = { name, child, releaseFile, ready: new Promise<void>(resolve => { ready = resolve; }), result: new Promise<string>(resolve => { result = resolve; }), closed: Promise.resolve(), resultReceived: false, busy: false, isClosed: false };
    // Registered before the pool's handler so release() can prove actual close.
    attempt.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      attempt.isClosed = true;
      attempt.closeAt = performance.now();
      attempt.closeSignal = signal;
      record(t.name, "close", { name, pid: child.pid, code, signal, leaseHeld: held.has(name) });
      resolve();
    }));
    child.on("error", error => record(t.name, "child-error", { name, error: error.message }));
    child.on("message", message => {
      const received = message as { kind?: string; value?: string };
      record(t.name, `ipc-${received.kind}`, { name, pid: child.pid });
      if (received.kind === "ready") ready();
      if (received.kind === "busy") attempt.busy = true;
      if (received.kind === "result") {
        attempt.resultReceived = true;
        result(received.value!);
      }
    });
    attempts.push(attempt);
    record(t.name, "fork", { name, pid: child.pid, execPath });
    return attempt;
  }
  function acquire(name: string): QueryLease {
    acquisitions.push(name);
    held.add(name);
    record(t.name, "lease-acquire", { name });
    return { snapshotId: `snapshot-${name}`, release() {
      const attempt = attempts.find(value => value.name === name);
      if (attempt) assert.equal(attempt.isClosed, true, `lease ${name} released before actual close`);
      assert.equal(held.delete(name), true, `duplicate release: ${name}`);
      releases.push(name);
      record(t.name, "lease-release", { name, pid: attempt?.child.pid });
    } };
  }
  function submit(name: string, budget = DeadlineBudget.fromTimeout(10_000), signal?: AbortSignal) {
    return pool.submit({ budget, signal, acquire: () => acquire(name), start: lease => {
      assert.equal(lease.snapshotId, `snapshot-${name}`);
      const attempt = spawn(name);
      return { child: attempt.child, result: attempt.result };
    } });
  }
  async function started(name: string): Promise<Attempt> {
    await until(() => attempts.some(attempt => attempt.name === name), `start ${name}`);
    const attempt = attempts.find(attempt => attempt.name === name)!;
    await bounded(attempt.ready, `ready ${name}`);
    const status = pool.status();
    assert.ok(status.workers <= 2);
    assert.ok(status.queued <= queueMax);
    assert.ok(status.reaping <= status.workers);
    record(t.name, "status", { status });
    return attempt;
  }
  async function result(attempt: Attempt) {
    await bounded(attempt.ready, `ready result ${attempt.name}`);
    attempt.child.send("result");
    await until(() => attempt.resultReceived, `result ${attempt.name}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function finish(attempt: Attempt) {
    await result(attempt);
    await writeFile(attempt.releaseFile, "release");
    await bounded(attempt.closed, `close ${attempt.name}`);
  }
  async function busy(attempt: Attempt) {
    attempt.child.send("busy");
    await until(() => attempt.busy, `busy ${attempt.name}`);
  }
  t.after(async () => {
    const stopping = pool.stop();
    try { await bounded(stopping, "pool stop"); }
    finally {
      for (const attempt of attempts) if (!attempt.isClosed) attempt.child.kill("SIGKILL");
      await bounded(Promise.all(attempts.map(attempt => attempt.closed)), "fixture actual close");
      await bounded(stopping, "pool stop after cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, pool, attempts, acquisitions, releases, held, spawn, acquire, submit, started, result, finish, busy };
}

test("hung-query-is-terminated-and-reaped", async t => {
  const f = await fixture(t);
  const budget = DeadlineBudget.fromTimeout(1500);
  const completion = f.submit("deadline-busy", budget);
  const attempt = await f.started("deadline-busy");
  await f.busy(attempt);
  await bounded(new Promise<void>(resolve => setImmediate(resolve)), "parent event loop responsive", 500);
  const outcome = await bounded(completion, "hung query deadline", 2500);
  const returnedAt = performance.now();
  record(t.name, "caller-settled", { status: outcome.status, deadlineAtMs: budget.deadlineAtMs, returnedAt });
  assert.equal(outcome.status, "deadline");
  assert.ok(returnedAt <= budget.deadlineAtMs + 1000);
  assert.equal(attempt.isClosed, false);
  assert.equal(f.held.has(attempt.name), true);
  assert.equal(f.pool.status().workers, 1);
  assert.equal(f.pool.status().reaping, 1);
  await bounded(attempt.closed, "deadline SIGKILL close", 2000);
  record(t.name, "reap-window", { name: attempt.name, deadlineAtMs: budget.deadlineAtMs, closeAt: attempt.closeAt, elapsedMs: attempt.closeAt! - budget.deadlineAtMs });
  assert.ok(attempt.closeAt! - budget.deadlineAtMs <= 2000);
  assert.equal(attempt.closeSignal, "SIGKILL");
  assert.equal(f.held.size, 0);
  assert.deepEqual(f.releases, [attempt.name]);
  assert.equal(f.pool.status().workers, 0);

  const controller = new AbortController();
  const cancelled = f.submit("cancel-busy", DeadlineBudget.fromTimeout(10_000), controller.signal);
  const second = await f.started("cancel-busy");
  await f.busy(second);
  const abortedAt = performance.now();
  controller.abort();
  assert.equal((await bounded(cancelled, "cancel busy query")).status, "cancelled");
  assert.equal(second.isClosed, false);
  assert.equal(f.held.has(second.name), true);
  await bounded(second.closed, "cancel SIGKILL close", 2000);
  record(t.name, "reap-window", { name: second.name, abortedAt, closeAt: second.closeAt, elapsedMs: second.closeAt! - abortedAt });
  assert.equal(second.closeSignal, "SIGKILL");
  assert.ok(second.closeAt! - abortedAt <= 2000);
  assert.equal(f.held.size, 0);
  assert.deepEqual(f.releases, [attempt.name, second.name]);
});

test("two workers and bounded FIFO queue reject overflow without acquiring", async t => {
  const f = await fixture(t, 2);
  const first = f.submit("a");
  const a = await f.started("a");
  const second = f.submit("b");
  const b = await f.started("b");
  const third = f.submit("c");
  const fourth = f.submit("d");
  assert.equal((await f.submit("overflow")).status, "queue_full");
  assert.equal(f.pool.status().workers, 2);
  assert.equal(f.pool.status().queued, 2);
  assert.deepEqual([...f.pool.status().pids].sort(), [a.child.pid, b.child.pid].sort());
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  await f.finish(a);
  const c = await f.started("c");
  assert.deepEqual(f.acquisitions, ["a", "b", "c"]);
  assert.equal(f.held.has("d"), false);
  await f.finish(b);
  const d = await f.started("d");
  assert.deepEqual(f.attempts.map(attempt => attempt.name), ["a", "b", "c", "d"]);
  await f.finish(c);
  await f.finish(d);
  assert.deepEqual(await Promise.all([first, second, third, fourth]), ["a", "b", "c", "d"].map(value => ({ status: "ok", value })));
  assert.equal(f.held.size, 0);
});

test("queued deadline and abort never acquire a snapshot lease", async t => {
  const f = await fixture(t);
  const a = f.submit("a");
  await f.started("a");
  const b = f.submit("b");
  await f.started("b");
  const expired = f.submit("expired", DeadlineBudget.fromTimeout(80));
  const controller = new AbortController();
  const aborted = f.submit("aborted", DeadlineBudget.fromTimeout(10_000), controller.signal);
  controller.abort();
  assert.equal((await bounded(aborted, "queued cancellation")).status, "cancelled");
  assert.equal((await bounded(expired, "queued deadline")).status, "deadline");
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  assert.equal(f.pool.status().queued, 0);
  await f.pool.stop();
  assert.deepEqual((await Promise.all([a, b])).map(value => value.status), ["stopped", "stopped"]);
});

test("result before close keeps both snapshot lease and worker slot", async t => {
  const f = await fixture(t);
  let settled = false;
  const first = f.submit("a").then(value => { settled = true; return value; });
  const a = await f.started("a");
  const second = f.submit("b");
  const b = await f.started("b");
  const queued = f.submit("c");
  await f.result(a);
  assert.equal(settled, false);
  assert.equal(a.isClosed, false);
  assert.equal(f.held.has("a"), true);
  assert.equal(f.pool.status().workers, 2);
  assert.equal(f.pool.status().queued, 1);
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  await writeFile(a.releaseFile, "release");
  await bounded(a.closed, "result holder actual close");
  assert.deepEqual(await first, { status: "ok", value: "a" });
  assert.equal(f.held.has("a"), false);
  await f.finish(await f.started("c"));
  await f.finish(b);
  assert.equal((await second).status, "ok");
  assert.equal((await queued).status, "ok");
});

test("OS fork ENOENT settles error and releases its lease only after close", async t => {
  const f = await fixture(t);
  const completion = f.pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => f.acquire("missing"), start: () => {
    const attempt = f.spawn("missing", path.join(f.root, "missing-node-executable"));
    return { child: attempt.child, result: attempt.result };
  } });
  const outcome = await bounded(completion, "OS ENOENT");
  assert.equal(outcome.status, "error");
  await bounded(Promise.all(f.attempts.map(attempt => attempt.closed)), "failed fork close");
  assert.deepEqual(f.releases, ["missing"]);
  assert.equal(f.pool.status().workers, 0);
  assert.equal(f.held.size, 0);
  const recovered = f.submit("recovered");
  await f.finish(await f.started("recovered"));
  assert.equal((await recovered).status, "ok");
});

test("synchronous acquire and start throws release reserved worker capacity", async t => {
  const f = await fixture(t);
  const acquireFailure = await bounded(f.pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => { throw new Error("fixture acquire failure"); }, start: () => { throw new Error("unreachable start"); } }), "acquire throw");
  assert.equal(acquireFailure.status, "error");
  assert.match(acquireFailure.status === "error" ? acquireFailure.error ?? "" : "", /fixture acquire failure/);
  const startFailure = await bounded(f.pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => f.acquire("start-failure"), start: () => { throw new Error("fixture start failure"); } }), "start throw");
  assert.equal(startFailure.status, "error");
  assert.deepEqual(f.releases, ["start-failure"]);
  assert.equal(f.pool.status().workers, 0);
  assert.equal(f.held.size, 0);
  const recovered = f.submit("recovered");
  await f.finish(await f.started("recovered"));
  assert.equal((await recovered).status, "ok");
});

test("stop settles running and queued callers and awaits real child close", async t => {
  const f = await fixture(t);
  const first = f.submit("a");
  await f.busy(await f.started("a"));
  const second = f.submit("b");
  await f.started("b");
  const queued = f.submit("queued");
  await bounded(f.pool.stop(), "pool stop real children");
  assert.deepEqual((await Promise.all([first, second, queued])).map(value => value.status), ["stopped", "stopped", "stopped"]);
  assert.ok(f.attempts.every(attempt => attempt.isClosed));
  assert.equal(f.held.size, 0);
  assert.deepEqual(f.pool.status(), { workers: 0, queued: 0, reaping: 0, pids: [] });
  assert.equal((await f.submit("after-stop")).status, "stopped");
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  await f.pool.stop();
});

test("caller-timeout-preserves-shared-build", async t => {
  const f = await fixture(t);
  const scheduler = new BuildScheduler({ select: () => ({ kind: "full", start: () => {
    const attempt = f.spawn("shared-build");
    return { child: attempt.child, result: attempt.result.then(() => ({ kind: "result" as const, result: { id: 1, ok: true, files: 1, indexedGeneration: 1 } })) };
  } }) });
  t.after(() => bounded(scheduler.stop(), "shared builder stop"));
  const shared = scheduler.submit({ workspaceId: "shared-workspace", kind: "full", generation: 1 });
  const attempt = await f.started("shared-build");
  const impatient = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(60));
  const patient = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(5000));
  const controller = new AbortController();
  const cancelling = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(5000), controller.signal);
  const cancelledAssertion = assert.rejects(cancelling, classified("CANCELLED"));
  controller.abort();
  await cancelledAssertion;
  await assert.rejects(impatient, classified("DEADLINE_EXCEEDED"));
  assert.equal(attempt.isClosed, false);
  assert.equal(attempt.child.killed, false);
  assert.equal(scheduler.status().builders, 1);
  let patientSettled = false;
  void patient.then(() => { patientSettled = true; });
  await f.result(attempt);
  assert.equal(patientSettled, false);
  assert.equal(attempt.child.killed, false);
  await writeFile(attempt.releaseFile, "release");
  await bounded(attempt.closed, "shared build actual exit");
  assert.equal((await bounded(patient, "patient shared build")).ok, true);
  assert.equal((await shared).ok, true);
});

test("deadline is checked at shared promise delivery before its timer runs", async () => {
  let now = 0;
  let resolve!: (value: string) => void;
  const shared = new Promise<string>(finish => { resolve = finish; });
  const waiting = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(10_000, () => now));
  const rejected = assert.rejects(waiting, classified("DEADLINE_EXCEEDED"));
  now = 10_001;
  resolve("late success");
  await rejected;
});

test("deadline is checked at real child close before its timer runs", async t => {
  const f = await fixture(t);
  let now = 0;
  const completion = f.submit("late", DeadlineBudget.fromTimeout(10_000, () => now));
  const attempt = await f.started("late");
  await f.result(attempt);
  now = 10_001;
  await writeFile(attempt.releaseFile, "release");
  await bounded(attempt.closed, "late child actual close");
  assert.equal((await completion).status, "deadline");
  assert.equal(f.held.size, 0);
});
