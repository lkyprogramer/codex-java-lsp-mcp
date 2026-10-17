import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { QueryPool, waitForSharedBuild, type QueryLease, type QueryPoolEvent, type QueryPoolOptions } from "./query-pool.js";

// A persistent worker speaking the QueryWorker protocol. Each run waits for the
// test to answer it, or runs a deliberately long native SQLite step. This proves
// process cancellation and lease accounting, not the production query ops.
const workerScript = `import { setTimeout as delay } from 'node:timers/promises';
const stubborn = process.argv[2] === 'stubborn';
if (stubborn) setInterval(() => {}, 1000);
const open = new Set();
let current;
process.on('disconnect', () => { if (!stubborn) process.exit(0); });
process.on('message', async message => {
  if (message.type === 'run') {
    current = message;
    process.send({ kind: 'run', id: message.id, name: message.payload.name, key: message.key });
    return;
  }
  if (message.type === 'exit') {
    if (!stubborn) process.exit(0);
    return;
  }
  if (message.type === 'close') {
    for (const key of message.keys) open.delete(key);
    process.send({ type: 'closed', open: [...open] });
    return;
  }
  if (message.fixture === 'busy') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    process.send({ kind: 'busy' }, () => {
      db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();
      db.close();
      process.exit(3); // Finishing instead of cancellation fails the signal assertion.
    });
  }
  if (message.fixture === 'result') {
    const run = current;
    current = undefined;
    if (run.payload.keep) open.add(run.key);
    process.send({ type: 'result', id: run.id, value: run.payload.name, open: [...open] });
  }
});
process.send({ kind: 'ready' });
`;
// A request-owned builder process (BuildScheduler's adapter shape) for the shared-build test.
const builderScript = `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
process.on('message', async message => {
  if (message === 'result') {
    process.send({ kind: 'result' });
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
  await writeFile(path.join(root, "query-pool.json"), JSON.stringify({ fixture: "real fork; persistent worker protocol; long native SQLite step; not production query ops/file lease integration", events }, null, 2));
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
type WorkerRec = {
  index: number; child: ChildProcess; ready: Promise<void>; closed: Promise<void>; isClosed: boolean;
  closeAt?: number; closeSignal?: NodeJS.Signals | null; busy: boolean;
  /** The keys this worker last reported open. */
  open: Set<string>;
};
type Run = { name: string; id: number; key: string; worker: WorkerRec; answered: boolean };
type FixtureOptions = Omit<QueryPoolOptions, "queueMax" | "spawn"> & { execPathFor?: (index: number) => string | undefined; stubborn?: boolean };
async function fixture(t: TestContext, queueMax = 32, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ilv2-query-pool-"));
  const script = path.join(root, "worker.mjs");
  await writeFile(script, workerScript);
  const workers: WorkerRec[] = [];
  const runs: Run[] = [];
  const acquisitions: string[] = [];
  const releases: string[] = [];
  const held = new Set<string>();
  function spawnWorker(): ChildProcess {
    const index = workers.length;
    const execPath = options.execPathFor?.(index) ?? process.execPath;
    const child = fork(script, options.stubborn ? ["stubborn"] : [], { execPath, execArgv: [], serialization: "advanced", stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) });
    let ready!: () => void;
    const worker: WorkerRec = { index, child, ready: new Promise<void>(resolve => { ready = resolve; }), closed: Promise.resolve(), isClosed: false, busy: false, open: new Set() };
    // Registered before the pool's handlers so release() can prove actual close or a reported key close.
    worker.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      worker.isClosed = true;
      worker.closeAt = performance.now();
      worker.closeSignal = signal;
      record(t.name, "close", { index, pid: child.pid, code, signal, open: [...worker.open] });
      resolve();
    }));
    child.on("error", error => record(t.name, "child-error", { index, error: error.message }));
    child.on("message", message => {
      const received = message as { kind?: string; type?: string; id?: number; name?: string; key?: string; open?: string[] };
      record(t.name, `ipc-${received.kind ?? received.type}`, { index, pid: child.pid, name: received.name });
      if (received.open) worker.open = new Set(received.open);
      if (received.kind === "ready") ready();
      if (received.kind === "busy") worker.busy = true;
      if (received.kind === "run") runs.push({ name: received.name!, id: received.id!, key: received.key!, worker, answered: false });
      if (received.type === "result") { const run = runs.find(value => value.id === received.id); if (run) run.answered = true; }
    });
    workers.push(worker);
    record(t.name, "fork", { index, pid: child.pid, execPath });
    return child;
  }
  const { execPathFor: _execPathFor, stubborn: _stubborn, ...poolOptions } = options;
  const pool = new QueryPool<string>({ ...poolOptions, queueMax, spawn: spawnWorker });
  function acquire(name: string): QueryLease {
    acquisitions.push(name);
    held.add(name);
    record(t.name, "lease-acquire", { name });
    const key = `snapshot-${name}`;
    return { snapshotId: key, release() {
      const run = [...runs].reverse().find(value => value.name === name);
      // A lease ends only once the connection it covers is gone: the worker closed, or no longer reports the key open.
      if (run) assert.ok(run.worker.isClosed || !run.worker.open.has(key), `lease ${name} released while its worker still holds it`);
      assert.equal(held.delete(name), true, `duplicate release: ${name}`);
      releases.push(name);
      record(t.name, "lease-release", { name, pid: run?.worker.child.pid });
    } };
  }
  function submit(name: string, budget = DeadlineBudget.fromTimeout(10_000), signal?: AbortSignal, keep = false) {
    return pool.submit({ budget, signal, acquire: () => acquire(name), payload: lease => {
      assert.equal(lease.snapshotId, `snapshot-${name}`);
      return { name, keep };
    } });
  }
  async function started(name: string): Promise<Run> {
    await until(() => runs.some(run => run.name === name), `start ${name}`);
    const run = runs.find(value => value.name === name)!;
    await bounded(run.worker.ready, `ready ${name}`);
    const status = pool.status();
    assert.ok(status.workers <= 2);
    assert.ok(status.queued <= queueMax);
    assert.ok(status.reaping <= status.workers);
    record(t.name, "status", { status });
    return run;
  }
  async function result(run: Run) {
    run.worker.child.send({ fixture: "result" });
    await until(() => run.answered, `result ${run.name}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function busy(run: Run) {
    run.worker.child.send({ fixture: "busy" });
    await until(() => run.worker.busy, `busy ${run.name}`);
  }
  t.after(async () => {
    const stopping = pool.stop();
    try { await bounded(stopping, "pool stop"); }
    finally {
      for (const worker of workers) if (!worker.isClosed) worker.child.kill("SIGKILL");
      await bounded(Promise.all(workers.map(worker => worker.closed)), "fixture actual close");
      await bounded(stopping, "pool stop after cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, pool, workers, runs, acquisitions, releases, held, acquire, submit, started, result, busy };
}

test("hung-query-is-terminated-and-reaped", async t => {
  const f = await fixture(t);
  const budget = DeadlineBudget.fromTimeout(1500);
  const completion = f.submit("deadline-busy", budget);
  const run = await f.started("deadline-busy");
  await f.busy(run);
  await bounded(new Promise<void>(resolve => setImmediate(resolve)), "parent event loop responsive", 500);
  const outcome = await bounded(completion, "hung query deadline", 2500);
  const returnedAt = performance.now();
  record(t.name, "caller-settled", { status: outcome.status, deadlineAtMs: budget.deadlineAtMs, returnedAt });
  assert.equal(outcome.status, "deadline");
  assert.ok(returnedAt <= budget.deadlineAtMs + 1000);
  assert.equal(run.worker.isClosed, false);
  assert.equal(f.held.has(run.name), true);
  assert.equal(f.pool.status().workers, 1);
  assert.equal(f.pool.status().reaping, 1);
  await bounded(run.worker.closed, "deadline SIGKILL close", 2000);
  record(t.name, "reap-window", { name: run.name, deadlineAtMs: budget.deadlineAtMs, closeAt: run.worker.closeAt, elapsedMs: run.worker.closeAt! - budget.deadlineAtMs });
  assert.ok(run.worker.closeAt! - budget.deadlineAtMs <= 2000);
  assert.equal(run.worker.closeSignal, "SIGKILL");
  await until(() => f.pool.status().workers === 0, "slot freed at close");
  assert.equal(f.held.size, 0);
  assert.deepEqual(f.releases, [run.name]);

  const controller = new AbortController();
  const cancelled = f.submit("cancel-busy", DeadlineBudget.fromTimeout(10_000), controller.signal);
  const second = await f.started("cancel-busy");
  assert.notEqual(second.worker, run.worker, "a killed worker is replaced, never reused");
  await f.busy(second);
  const abortedAt = performance.now();
  controller.abort();
  assert.equal((await bounded(cancelled, "cancel busy query")).status, "cancelled");
  assert.equal(second.worker.isClosed, false);
  assert.equal(f.held.has(second.name), true);
  await bounded(second.worker.closed, "cancel SIGKILL close", 2000);
  record(t.name, "reap-window", { name: second.name, abortedAt, closeAt: second.worker.closeAt, elapsedMs: second.worker.closeAt! - abortedAt });
  assert.equal(second.worker.closeSignal, "SIGKILL");
  assert.ok(second.worker.closeAt! - abortedAt <= 2000);
  await until(() => f.held.size === 0, "lease released at close");
  assert.deepEqual(f.releases, [run.name, second.name]);
});

test("two persistent workers and a bounded FIFO queue reject overflow without acquiring", async t => {
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
  assert.deepEqual([...f.pool.status().pids].sort(), [a.worker.child.pid, b.worker.child.pid].sort());
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  await f.result(a);
  const c = await f.started("c");
  assert.equal(c.worker, a.worker, "the next task reuses the idle worker");
  assert.deepEqual(f.acquisitions, ["a", "b", "c"]);
  assert.equal(f.held.has("d"), false);
  await f.result(b);
  const d = await f.started("d");
  assert.equal(d.worker, b.worker);
  await f.result(c);
  await f.result(d);
  assert.deepEqual(await Promise.all([first, second, third, fourth]), ["a", "b", "c", "d"].map(value => ({ status: "ok", value })));
  assert.equal(f.workers.length, 2, "four tasks, two processes");
  assert.equal(f.held.size, 0, "a task whose connection was not kept releases its lease at the reply");
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

test("a worker's leases follow the connections it reports open", async t => {
  const retained = new Set(["snapshot-a", "snapshot-b"]);
  const f = await fixture(t, 32, { retain: key => retained.has(key) });
  const first = f.submit("a", undefined, undefined, true);
  const a = await f.started("a");
  await f.result(a);
  assert.deepEqual(await bounded(first, "result returned"), { status: "ok", value: "a" });
  assert.equal(a.worker.isClosed, false);
  assert.equal(f.held.has("a"), true, "the kept connection keeps its lease");
  assert.equal(f.pool.status().leases, 1);
  const second = f.submit("b", undefined, undefined, true);
  const b = await f.started("b");
  assert.equal(b.worker, a.worker);
  await f.result(b);
  assert.equal((await second).status, "ok");
  assert.deepEqual([...f.held].sort(), ["a", "b"]);
  retained.delete("snapshot-a");
  f.pool.trim();
  await until(() => f.releases.includes("a"), "trimmed key released");
  assert.equal(a.worker.isClosed, false, "released after the worker closed the connection, not the process");
  const third = f.submit("c");
  await f.result(await f.started("c"));
  assert.equal((await third).status, "ok");
  assert.deepEqual(f.releases, ["a", "c"]);
  await bounded(f.pool.stop(), "stop");
  assert.deepEqual(f.releases, ["a", "c", "b"]);
  assert.equal(f.held.size, 0);
});

test("OS fork ENOENT settles error and releases its lease only after close", async t => {
  const f = await fixture(t, 32, { execPathFor: index => index === 0 ? path.join(tmpdir(), "ilv2-missing-node-executable") : undefined });
  const outcome = await bounded(f.submit("missing"), "OS ENOENT");
  assert.equal(outcome.status, "error");
  await bounded(Promise.all(f.workers.map(worker => worker.closed)), "failed fork close");
  await until(() => f.pool.status().workers === 0, "slot freed");
  assert.deepEqual(f.releases, ["missing"]);
  assert.equal(f.held.size, 0);
  const recovered = f.submit("recovered");
  await f.result(await f.started("recovered"));
  assert.equal((await recovered).status, "ok");
});

test("synchronous acquire and payload throws release reserved worker capacity", async t => {
  const f = await fixture(t);
  const acquireFailure = await bounded(f.pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => { throw new Error("fixture acquire failure"); }, payload: () => { throw new Error("unreachable payload"); } }), "acquire throw");
  assert.equal(acquireFailure.status, "error");
  assert.match(acquireFailure.status === "error" ? acquireFailure.error ?? "" : "", /fixture acquire failure/);
  const payloadFailure = await bounded(f.pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => f.acquire("payload-failure"), payload: () => { throw new Error("fixture payload failure"); } }), "payload throw");
  assert.equal(payloadFailure.status, "error");
  assert.deepEqual(f.releases, ["payload-failure"]);
  assert.equal(f.pool.status().workers, 0);
  assert.equal(f.workers.length, 0, "no process is started for a task that never ran");
  assert.equal(f.held.size, 0);
  const recovered = f.submit("recovered");
  await f.result(await f.started("recovered"));
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
  assert.ok(f.workers.every(worker => worker.isClosed));
  assert.equal(f.held.size, 0);
  assert.deepEqual(f.pool.status(), { admitted: true, workers: 0, queued: 0, acquiring: 0, running: 0, leases: 0, reaping: 0, reapOverdue: 0, pids: [] });
  assert.equal((await f.submit("after-stop")).status, "stopped");
  assert.deepEqual(f.acquisitions, ["a", "b"]);
  await f.pool.stop();
});

test("caller-timeout-preserves-shared-build", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ilv2-shared-build-"));
  const script = path.join(root, "builder.mjs");
  await writeFile(script, builderScript);
  const releaseFile = path.join(root, "release");
  const child = fork(script, [releaseFile], { execArgv: [], stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) });
  let isClosed = false;
  const closed = new Promise<void>(resolve => child.once("close", () => { isClosed = true; resolve(); }));
  const ready = new Promise<void>(resolve => child.on("message", (message: { kind?: string }) => { if (message.kind === "ready") resolve(); }));
  let resultReceived = false;
  const result = new Promise<void>(resolve => child.on("message", (message: { kind?: string }) => { if (message.kind === "result") { resultReceived = true; resolve(); } }));
  let startedBuild = false;
  const scheduler = new BuildScheduler({ select: () => ({ kind: "full", start: () => {
    startedBuild = true;
    return { child, result: result.then(() => ({ kind: "result" as const, result: { id: 1, ok: true, files: 1, indexedGeneration: 1 } })) };
  } }) });
  t.after(async () => {
    if (!isClosed) child.kill("SIGKILL");
    await bounded(closed, "builder close");
    await bounded(scheduler.stop(), "shared builder stop");
    await rm(root, { recursive: true, force: true });
  });
  const shared = scheduler.submit({ workspaceId: "shared-workspace", kind: "full", generation: 1 });
  await bounded(ready, "builder ready");
  await until(() => startedBuild, "builder started");
  const impatient = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(60));
  const patient = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(5000));
  const controller = new AbortController();
  const cancelling = waitForSharedBuild(shared, DeadlineBudget.fromTimeout(5000), controller.signal);
  const cancelledAssertion = assert.rejects(cancelling, classified("CANCELLED"));
  controller.abort();
  await cancelledAssertion;
  await assert.rejects(impatient, classified("DEADLINE_EXCEEDED"));
  assert.equal(isClosed, false);
  assert.equal(child.killed, false);
  assert.equal(scheduler.status().builders, 1);
  let patientSettled = false;
  void patient.then(() => { patientSettled = true; });
  child.send("result");
  await until(() => resultReceived, "builder result");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(patientSettled, false);
  assert.equal(child.killed, false);
  await writeFile(releaseFile, "release");
  await bounded(closed, "shared build actual exit");
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

test("a result after the deadline returns deadline and the worker keeps serving", async t => {
  const f = await fixture(t);
  let now = 0;
  const completion = f.submit("late", DeadlineBudget.fromTimeout(10_000, () => now), undefined, true);
  const late = await f.started("late");
  now = 10_001;
  await f.result(late);
  assert.equal((await bounded(completion, "late result")).status, "deadline");
  assert.equal(late.worker.isClosed, false, "an answered run needs no kill");
  assert.equal(f.held.has("late"), true, "the kept connection keeps its lease");
  const next = f.submit("next");
  const run = await f.started("next");
  assert.equal(run.worker, late.worker);
  await f.result(run);
  assert.deepEqual(await next, { status: "ok", value: "next" });
});

test("a stopped idle worker that ignores exit is killed after the exit grace", async t => {
  const poolEvents: QueryPoolEvent[] = [];
  const f = await fixture(t, 32, { stubborn: true, timing: { exitGraceMs: 300 }, onEvent: event => poolEvents.push(event) });
  const completion = f.submit("idle", undefined, undefined, true);
  const run = await f.started("idle");
  await f.result(run);
  assert.deepEqual(await completion, { status: "ok", value: "idle" });
  const stoppedAt = performance.now();
  await bounded(f.pool.stop(), "stop", 3000);
  record(t.name, "forced-exit-window", { elapsedMs: run.worker.closeAt! - stoppedAt });
  assert.equal(run.worker.closeSignal, "SIGKILL");
  assert.ok(run.worker.closeAt! - stoppedAt >= 250);
  assert.deepEqual(poolEvents.filter(event => event.type === "forced-exit").length, 1);
  assert.deepEqual(f.releases, ["idle"], "released at the actual close");
});

test("an asynchronous acquire holds its slot and a cancelled caller's late lease is released unstarted", async t => {
  const f = await fixture(t);
  const deliveries = new Map<string, { resolve(lease: QueryLease): void; reject(error: Error): void; signal: AbortSignal }>();
  const submitAsync = (name: string, signal?: AbortSignal) => f.pool.submit({ budget: DeadlineBudget.fromTimeout(10_000), signal,
    acquire: abort => new Promise<QueryLease>((resolve, reject) => { deliveries.set(name, { resolve, reject, signal: abort }); }),
    payload: lease => ({ name: lease.snapshotId.replace("snapshot-", ""), keep: false }) });
  const controller = new AbortController();
  const a = submitAsync("a", controller.signal);
  const b = submitAsync("b");
  const c = f.submit("c");
  await until(() => deliveries.size === 2, "two acquisitions in flight");
  assert.deepEqual(f.pool.status().workers, 2);
  assert.equal(f.pool.status().acquiring, 2);
  assert.equal(f.pool.status().queued, 1);
  assert.equal(f.workers.length, 0, "no process before a lease");
  controller.abort();
  assert.equal((await bounded(a, "cancel during acquire")).status, "cancelled");
  assert.equal(deliveries.get("a")!.signal.aborted, true);
  assert.equal(f.pool.status().workers, 2, "the slot stays taken until the lease arrives");
  deliveries.get("a")!.resolve(f.acquire("a"));
  await until(() => f.releases.includes("a"), "late lease released");
  assert.equal(f.runs.some(run => run.name === "a"), false, "a cancelled caller never starts");
  const cRun = await f.started("c");
  deliveries.get("b")!.reject(new Error("fixture lease unavailable"));
  assert.equal((await bounded(b, "rejected acquire")).status, "error");
  await f.result(cRun);
  assert.equal((await c).status, "ok");
  await until(() => f.pool.status().acquiring === 0 && f.held.size === 0, "all leases free");
});

test("closed admission takes no lease until wake", async t => {
  let open = false;
  const f = await fixture(t, 32, { admitted: () => open });
  const completion = f.submit("gated");
  await delay(50);
  assert.deepEqual(f.acquisitions, []);
  assert.equal(f.pool.status().queued, 1);
  open = true;
  f.pool.wake();
  await f.result(await f.started("gated"));
  assert.equal((await completion).status, "ok");
});

function fakeChild(pid: number, reap: boolean, killError?: string) {
  const sent: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { pid, kills: 0, sent, connected: true,
    send(message: unknown, callback?: (error: Error | null) => void) { sent.push(message); if (callback) setImmediate(() => callback(null)); return true; },
    disconnect() { child.connected = false; },
    kill() {
      child.kills += 1;
      // Node emits a failed kill (other than ESRCH) as a synchronous "error".
      if (killError) { child.emit("error", Object.assign(new Error(`kill ${killError}`), { code: killError })); return false; }
      if (reap) setImmediate(() => { child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); });
      return true;
    } });
  return child;
}

test("a kill that is not reaped in time is reported and keeps the worker slot and lease", async () => {
  const poolEvents: QueryPoolEvent[] = [];
  const child = fakeChild(424242, false);
  const pool = new QueryPool<string>({ spawn: () => child as unknown as ChildProcess, timing: { reapWatchMs: 100 }, onEvent: event => poolEvents.push(event) });
  let released = 0;
  const completion = pool.submit({ budget: DeadlineBudget.fromTimeout(100), acquire: () => ({ snapshotId: "s", release: () => { released += 1; } }), payload: () => "never answered" });
  assert.equal((await bounded(completion, "deadline")).status, "deadline");
  await until(() => poolEvents.some(event => event.type === "reap-overdue"), "reap overdue reported");
  assert.deepEqual(poolEvents.filter(event => event.type === "reap-overdue"), [{ type: "reap-overdue", pid: 424242, exited: false }]);
  assert.equal(pool.status().workers, 1);
  assert.equal(pool.status().reapOverdue, 1);
  assert.equal(released, 0);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await until(() => pool.status().workers === 0, "slot freed at actual close");
  assert.equal(released, 1);
});

test("a kill that fails synchronously is sent once and reported, not re-entered", async () => {
  const poolEvents: QueryPoolEvent[] = [];
  const child = fakeChild(444444, false, "EPERM");
  const pool = new QueryPool<string>({ spawn: () => child as unknown as ChildProcess, timing: { reapWatchMs: 100 }, onEvent: event => poolEvents.push(event) });
  let released = 0;
  const completion = pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => ({ snapshotId: "s", release: () => { released += 1; } }), payload: () => "never answered" });
  await until(() => child.sent.length === 1, "run sent");
  child.emit("error", new Error("send failed"));
  const outcome = await bounded(completion, "error settles");
  assert.equal(outcome.status, "error");
  assert.equal(child.kills, 1);
  const stopping = pool.stop();
  assert.equal(child.kills, 1);
  await until(() => poolEvents.some(event => event.type === "reap-overdue"), "reap overdue");
  assert.deepEqual(poolEvents.filter(event => event.type === "reap-overdue"), [{ type: "reap-overdue", pid: 444444, exited: false }]);
  assert.equal(pool.status().workers, 1);
  assert.equal(released, 0);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await bounded(stopping, "stop after actual close");
  assert.equal(released, 1);
});

test("repeated child errors settle once without an unhandled error", async () => {
  const child = fakeChild(434343, true);
  const pool = new QueryPool<string>({ spawn: () => child as unknown as ChildProcess });
  const completion = pool.submit({ budget: DeadlineBudget.fromTimeout(5000), acquire: () => ({ snapshotId: "s", release() {} }), payload: () => "never answered" });
  await until(() => child.sent.length === 1, "run sent");
  child.emit("error", new Error("send failed"));
  child.emit("error", new Error("kill failed"));
  const outcome = await bounded(completion, "error settles");
  assert.equal(outcome.status, "error");
  await until(() => pool.status().workers === 0, "reaped");
  await pool.stop();
});
