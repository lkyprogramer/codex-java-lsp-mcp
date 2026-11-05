// input: a real cold-built index file and the shared read-only query worker.
// output: R09 regression lock for the worker boundary: same rows as the
//         in-process scan, a bounded queue (<= 32), expired waiters leave
//         without running SQL, a query stuck past its deadline is terminated
//         and settles only after its thread (and read snapshot) is gone, the
//         writer is unaffected, and the main event loop stays responsive.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlEntitySearch } from "../java-index/sql/entity-search.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { QUERY_WORKER_QUEUE_MAX, QueryWorkerPool, absoluteNow } from "./query-worker.js";

async function corpus(files: number): Promise<{ dbPath: string; done: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "r09-worker-"));
  for (let i = 0; i < files; i += 1) {
    const name = `Service${String(i).padStart(3, "0")}`;
    const rel = path.join(root, "src/main/java/demo", `${name}.java`);
    await mkdir(path.dirname(rel), { recursive: true });
    await writeFile(rel, `package demo;\n/** Keeps the order ledger. */\npublic class ${name} {\n    public void refundOrder(long id) {}\n}\n`, "utf8");
  }
  const dbPath = path.join(root, ".index", "index.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ db, repoRoot: root });
  close(db);
  return { dbPath, done: () => rm(root, { recursive: true, force: true }) };
}

const withoutTrace = <T extends { trace?: unknown }>(result: T) => ({ ...result, trace: undefined });

test("R09 worker: returns the same bounded rows as the in-process scan", async () => {
  const fixture = await corpus(10);
  const pool = new QueryWorkerPool();
  try {
    const db = openIndexDb(fixture.dbPath, { readOnly: true });
    const local = new SqlEntitySearch(db).searchDetailed("order ledger", 5, "text", { budget: { remainingMs: () => 60_000 } });
    const exact = new SqlEntitySearch(db).searchDetailed("demo.Service003", 5, "exact", { budget: { remainingMs: () => 60_000 } });
    close(db);
    const remote = await pool.search({ dbPath: fixture.dbPath, task: "order ledger", limit: 5, mode: "text", deadlineAt: absoluteNow() + 60_000 });
    assert.deepEqual(withoutTrace(remote), withoutTrace(local));
    assert.ok(remote.hits.length <= 5, "bounded rows only");
    assert.ok(remote.trace!.some(stage => stage.operation === "postings:identifier"));
    const remoteExact = await pool.search({ dbPath: fixture.dbPath, task: "demo.Service003", limit: 5, mode: "exact", deadlineAt: absoluteNow() + 60_000 });
    assert.deepEqual(withoutTrace(remoteExact), withoutTrace(exact));
    assert.equal(pool.stats().spawned, 1, "one shared thread serves every request");
  } finally {
    await pool.close();
    await fixture.done();
  }
});

test("R09 worker: an expired request never queues; a full queue rejects with queue_full; queuePeak stays <= 32", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  try {
    const expired = await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() - 1 });
    assert.equal(expired.stopReason, "deadline");
    assert.equal(pool.stats().spawned, 0, "no worker, no SQL for an expired entry");
    const deadlineAt = absoluteNow() + 60_000;
    // One running (held 150ms) + 32 queued; the rest are rejected at once.
    const requests = Array.from({ length: 40 }, (_, i) =>
      pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt, ...(i === 0 ? { testBlockMs: 150 } : {}) }));
    const results = await Promise.all(requests);
    const load = pool.stats();
    assert.ok(load.queuePeak <= 32);
    assert.equal(load.queuePeak, QUERY_WORKER_QUEUE_MAX);
    assert.equal(results.filter(r => r.stopReason === "queue_full").length, 40 - 1 - QUERY_WORKER_QUEUE_MAX);
    assert.equal(results.filter(r => r.stopReason === undefined).length, 1 + QUERY_WORKER_QUEUE_MAX);
    assert.deepEqual([load.queued, load.running, load.rejectedQueueFull, load.completed], [0, false, 7, 33]);
  } finally {
    await pool.close();
    await fixture.done();
  }
});

test("R09 worker: waiters whose deadline passes leave the queue without running", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  try {
    const blocker = pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 60_000, testBlockMs: 300 });
    const started = absoluteNow();
    const waiters = await Promise.all(Array.from({ length: 5 }, () =>
      pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 40 })));
    const waited = absoluteNow() - started;
    assert.ok(waiters.every(r => r.stopReason === "deadline" && r.hits.length === 0));
    assert.ok(waited < 250, `expired waiters settle at their deadline, not after the running query (${waited.toFixed(0)}ms)`);
    assert.equal(pool.stats().expiredInQueue, 5);
    assert.equal((await blocker).stopReason, undefined);
    assert.equal(pool.stats().completed, 1, "only the blocker ever ran");
  } finally {
    await pool.close();
    await fixture.done();
  }
});

test("R09 worker: a JS-side stall past deadline+grace is terminated; it settles after the thread exited and the writer can checkpoint", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true, killGraceMs: 30 });
  const writer = openIndexDb(fixture.dbPath);
  try {
    const started = absoluteNow();
    const stuck = await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 40, testBlockMs: 5_000 });
    const elapsed = absoluteNow() - started;
    assert.equal(stuck.stopReason, "deadline");
    assert.ok(elapsed < 2_000, `terminated near deadline+grace, not after the 5s statement (${elapsed.toFixed(0)}ms)`);
    const settled = pool.stats();
    const cancelledBackendSettled = settled.terminated === 1 && settled.threads === 0 && !settled.running && settled.queued === 0;
    assert.ok(cancelledBackendSettled, JSON.stringify(settled));
    // The killed reader held a snapshot; it is gone, so a writer commit can
    // be checkpointed completely.
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE meta SET value=value WHERE key='indexedGeneration'").run();
    writer.exec("COMMIT");
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    assert.equal(checkpoint.busy, 0);
    const next = await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 60_000 });
    assert.equal(next.stopReason, undefined, "the next request respawns the worker");
    assert.equal(pool.stats().spawned, 2);
  } finally {
    close(writer);
    await pool.close();
    await fixture.done();
  }
});

test("R09 worker: a long scan does not block the main event loop", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  const delay = monitorEventLoopDelay({ resolution: 5 });
  try {
    await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" });
    delay.enable();
    await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 60_000, testBlockMs: 250 });
    delay.disable();
    const maxMs = delay.max / 1e6;
    assert.ok(maxMs < 100, `the 250ms worker-side block never reaches this loop (max delay ${maxMs.toFixed(1)}ms)`);
  } finally {
    await pool.close();
    await fixture.done();
  }
});

// Handles this process holds on `file` (the worker is a thread of it).
function openHandles(file: string): number | undefined {
  try {
    const out = execFileSync("lsof", ["-Fn", "-p", String(process.pid)], { encoding: "utf8" });
    const real = realpathSync(file);
    return out.split("\n").filter(line => line === `n${real}` || line === `n${file}`).length;
  } catch {
    return undefined;
  }
}

test("R09 worker: release() resolves only after the worker closed its reader connection", async t => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  try {
    if (openHandles(fixture.dbPath) === undefined) {
      t.skip("lsof unavailable");
      return;
    }
    assert.equal(openHandles(fixture.dbPath), 0);
    await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" });
    assert.ok(openHandles(fixture.dbPath)! > 0, "the worker keeps its reader open between requests");
    // Release while the worker is busy in a 400ms scan: the release can only
    // complete after it, and must not resolve before.
    const busy = pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", testBlockMs: 400 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await pool.release(fixture.dbPath);
    assert.equal(openHandles(fixture.dbPath), 0, "released before the promise resolved");
    await busy;
    assert.equal((await pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" })).stopReason, undefined, "a released path reopens on demand");
    assert.ok(openHandles(fixture.dbPath)! > 0);
    await pool.close();
    assert.equal(openHandles(fixture.dbPath), 0, "closing the pool leaves no handle behind");
  } finally {
    await pool.close();
    await fixture.done();
  }
});

test("R09 worker: while a stalled thread is being terminated, no second thread starts and releases settle per thread", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true, killGraceMs: 20 });
  // Model a terminate() that waits on a native step (Node only stops a
  // worker between native calls): hold the termination for 400ms.
  const internals = pool as unknown as { slots: { worker?: { terminate(): Promise<number> } }[] };
  try {
    const first = pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 30, testBlockMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const stalled = internals.slots[0]!.worker!;
    const realTerminate = stalled.terminate.bind(stalled);
    stalled.terminate = async () => { await new Promise(resolve => setTimeout(resolve, 400)); return realTerminate(); };
    await new Promise(resolve => setTimeout(resolve, 150));
    // The kill is in progress: a new request waits instead of spawning.
    const second = pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 60_000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const during = pool.stats();
    assert.equal(during.spawned, 1, "no second thread while the first is still terminating");
    assert.ok(during.threads <= 1, JSON.stringify(during));
    assert.equal((await first).stopReason, "deadline");
    assert.equal((await second).stopReason, undefined, "the waiter runs on the next thread");
    // A release registered on the new thread is acked by that thread.
    await pool.release(fixture.dbPath);
    assert.equal(pool.stats().spawned, 2);
  } finally {
    await pool.close();
    await fixture.done();
  }
});

// HOL follow-up (low-concurrency design: still one thread, no new lane): a
// waiting exact lookup (an index point read, ~1ms) is served before waiting
// broad scans, FIFO within each class; a scan already running is not
// preempted.
test("worker queue: waiting exact lookups run before waiting broad scans", async () => {
  const fixture = await corpus(5);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  try {
    const deadlineAt = absoluteNow() + 60_000;
    const order: string[] = [];
    const track = (name: string, promise: Promise<unknown>) => promise.then(result => { order.push(name); return result; });
    const running = track("running-scan", pool.search({ dbPath: fixture.dbPath, task: "order ledger", limit: 5, mode: "text", deadlineAt, testBlockMs: 200 }));
    const scanA = track("scan-a", pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt }));
    const pointA = track("point-a", pool.search({ dbPath: fixture.dbPath, task: "demo.Service001", limit: 5, mode: "exact", deadlineAt }));
    const scanB = track("scan-b", pool.search({ dbPath: fixture.dbPath, task: "refund order", limit: 5, mode: "auto", deadlineAt }));
    const pointB = track("point-b", pool.search({ dbPath: fixture.dbPath, task: "Service002", limit: 5, mode: "auto", deadlineAt }));
    const results = await Promise.all([running, scanA, pointA, scanB, pointB]);
    assert.deepEqual(order, ["running-scan", "point-a", "point-b", "scan-a", "scan-b"]);
    assert.ok(results.every(result => (result as { stopReason?: string }).stopReason === undefined));
  } finally {
    await pool.close();
    await fixture.done();
  }
});

test("worker queue: text the classifier rejects is queued as a scan, not a rejection", async () => {
  const fixture = await corpus(2);
  const pool = new QueryWorkerPool();
  try {
    const deadlineAt = absoluteNow() + 60_000;
    const empty = await pool.search({ dbPath: fixture.dbPath, task: "   ", limit: 5, mode: "auto", deadlineAt });
    assert.deepEqual(empty.hits, []);
    // oversized text reaches the scan, which rejects it exactly as in-process
    await assert.rejects(
      pool.search({ dbPath: fixture.dbPath, task: "order ".repeat(120), limit: 5, mode: "auto", deadlineAt }),
      /query length must be 1\.\.512/
    );
    assert.equal(pool.stats().queued, 0);
  } finally {
    await pool.close();
    await fixture.done();
  }
});

for (const workerCount of [1, 2] as const) {
  test(`P3 ${workerCount} readers: global queue, exact priority, and timings`, async () => {
    const fixture = await corpus(3);
    const timings: import("./query-worker.js").QueryWorkerTiming[] = [];
    const pool = new QueryWorkerPool({ workerCount, allowTestHooks: true, onTiming: timing => { timings.push(timing); } });
    const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const };
    try {
      const blockers = Array.from({ length: workerCount }, () => pool.search({ ...request, testBlockMs: 250 }));
      assert.equal(pool.stats().threads, workerCount);
      const queued = Array.from({ length: 31 }, () => pool.search(request));
      const exact = pool.search({ ...request, task: "demo.Service001", mode: "exact" });
      const overflow = await pool.search(request);
      assert.equal(overflow.stopReason, "queue_full");
      assert.equal(pool.stats().queuePeak, 32);
      await Promise.all([...blockers, ...queued, exact]);
      const started = timings.filter(t => t.started).sort((a, b) => a.dispatchedAt! - b.dispatchedAt!);
      assert.equal(started[workerCount]!.request.mode, "exact", "first freed reader takes waiting exact");
      assert.equal(started.length, workerCount + 32);
      for (const timing of started) {
        assert.equal(timing.outcome, "completed");
        assert.ok(timing.enqueueAt <= timing.dispatchedAt!);
        assert.ok(timing.dispatchedAt! <= timing.workerStartedAt!);
        assert.ok(timing.workerStartedAt! <= timing.workerFinishedAt!);
        assert.ok(timing.workerFinishedAt! <= timing.settledAt);
        assert.equal(timing.actualServiceMs, timing.workerFinishedAt! - timing.workerStartedAt!);
      }
      assert.equal(timings.find(t => t.outcome === "queue_full")!.actualServiceMs, null);
    } finally { await pool.close(); await fixture.done(); }
  });
}

test("P3 two readers: terminating slots stay reserved; release and concurrent closes await every settlement", async () => {
  const fixture = await corpus(3);
  const timings: import("./query-worker.js").QueryWorkerTiming[] = [];
  const pool = new QueryWorkerPool({ workerCount: 2, allowTestHooks: true, killGraceMs: 20, onTiming: t => { timings.push(t); } });
  const internals = pool as unknown as { slots: { worker?: { terminate(): Promise<number> } }[] };
  const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const };
  try {
    const stuck = Array.from({ length: 2 }, () => pool.search({ ...request, testBlockMs: 5_000, deadlineAt: absoluteNow() + 100 }));
    for (const slot of internals.slots) {
      const worker = slot.worker!;
      const original = worker.terminate.bind(worker);
      worker.terminate = async () => { await new Promise(resolve => setTimeout(resolve, 300)); return original(); };
    }
    await new Promise(resolve => setTimeout(resolve, 170));
    assert.equal(pool.stats().threads, 2);
    assert.equal(pool.stats().spawned, 2);
    const expired = pool.search({ ...request, deadlineAt: absoluteNow() + 30 });
    assert.equal((await expired).stopReason, "deadline");
    assert.equal(pool.stats().expiredInQueue, 1);
    let released = false;
    const release = pool.release(fixture.dbPath).then(() => { released = true; });
    const closeA = pool.close(); const closeB = pool.close();
    assert.equal(closeA, closeB, "concurrent closes share the complete barrier");
    assert.equal(pool.isClosed(), false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(released, false);
    assert.equal(pool.stats().spawned, 2);
    await Promise.all([release, closeA, ...stuck]);
    assert.equal(pool.stats().threads, 0);
    assert.equal(pool.stats().running, false);
    assert.equal(pool.isClosed(), true);
    assert.equal(timings.length, 3, "exactly one observation per settled request");
    assert.ok(timings.every(t => t.actualServiceMs === null), "cancelled workers have no completed service interval");
    await assert.rejects(pool.search(request), /closed/);
  } finally { await pool.close(); await fixture.done(); }
});

test("P3 two readers: release closes all cached readers and replacement inode reopens both", async () => {
  const fixture = await corpus(3);
  const replacement = await corpus(1);
  const pool = new QueryWorkerPool({ workerCount: 2, allowTestHooks: true });
  const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const, testBlockMs: 50 };
  try {
    const initial = await Promise.all([pool.search(request), pool.search(request)]);
    assert.equal(pool.stats().threads, 2);
    if (openHandles(fixture.dbPath) === undefined) throw new Error("lsof required for reader release verification");
    assert.ok(openHandles(fixture.dbPath)! >= 2);
    await pool.release(fixture.dbPath);
    assert.equal(openHandles(fixture.dbPath), 0);
    await Promise.all([pool.search(request), pool.search(request)]);
    const { rename } = await import("node:fs/promises");
    await rename(replacement.dbPath, fixture.dbPath);
    const rebuilt = await Promise.all([pool.search(request), pool.search(request)]);
    assert.ok(rebuilt.every(result => result.hits.length < initial[0]!.hits.length));
    assert.deepEqual(withoutTrace(rebuilt[0]!), withoutTrace(rebuilt[1]!));
    await pool.release(fixture.dbPath);
    assert.equal(openHandles(fixture.dbPath), 0);
  } finally { await pool.close(); await fixture.done(); await replacement.done(); }
});

test("P3 single/dual readers: exact result and generation parity under concurrent metadata commits", async () => {
  const fixture = await corpus(3);
  const single = new QueryWorkerPool();
  const dual = new QueryWorkerPool({ workerCount: 2 });
  const writer = openIndexDb(fixture.dbPath);
  const request = { dbPath: fixture.dbPath, task: "demo.Service001", limit: 5, mode: "exact" as const };
  try {
    const local = new SqlEntitySearch(writer).searchDetailed(request.task, request.limit, request.mode);
    const baseline = await Promise.all([single.search(request), dual.search(request), dual.search(request)]);
    baseline.forEach(result => assert.deepEqual(withoutTrace(result), withoutTrace(local)));
    writer.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('indexedGeneration','100')").run();
    let generation = 100;
    const updating = setInterval(() => {
      generation += 1;
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE meta SET value=? WHERE key='indexedGeneration'").run(String(generation));
      writer.exec("COMMIT");
    }, 1);
    try {
      const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? single : dual).search(request)));
      for (const result of results) {
        assert.ok(result.generation >= 100 && result.generation <= generation);
        assert.deepEqual({ ...withoutTrace(result), generation: local.generation }, withoutTrace(local));
      }
    } finally { clearInterval(updating); }
    assert.ok(generation > 100, "metadata writer committed while requests were outstanding");
    const settled = await Promise.all([single.search(request), dual.search(request), dual.search(request)]);
    assert.ok(settled.every(result => result.generation === generation));
  } finally { close(writer); await single.close(); await dual.close(); await fixture.done(); }
});

test("P3 shared experiment configuration rejects replacement until all threads close", async () => {
  const { configureSharedQueryWorker, sharedQueryWorker } = await import("./query-worker.js");
  configureSharedQueryWorker({ workerCount: 2 });
  const pool = sharedQueryWorker();
  try {
    assert.throws(() => configureSharedQueryWorker({ workerCount: 1 }), /active/);
    assert.throws(() => new QueryWorkerPool({ workerCount: 3 as 2 }), /1 or 2/);
    assert.throws(() => new QueryWorkerPool({ queueMax: 33 }), /1\.\.32/);
  } finally { await pool.close(); configureSharedQueryWorker({}); }
  const defaultPool = sharedQueryWorker();
  await defaultPool.close();
});


test("P3 two readers: deadline termination respawns without exceeding two live threads", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ workerCount: 2, allowTestHooks: true, killGraceMs: 20 });
  const internals = pool as unknown as { slots: { worker?: { terminate(): Promise<number> } }[] };
  const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const };
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, pool.stats().threads); }, 1);
  try {
    const stuck = Array.from({ length: 2 }, () => pool.search({ ...request, deadlineAt: absoluteNow() + 100, testBlockMs: 5_000 }));
    for (const slot of internals.slots) {
      const worker = slot.worker!; const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => { await new Promise(resolve => setTimeout(resolve, 150)); return terminate(); };
    }
    const waiting = Array.from({ length: 4 }, () => pool.search(request));
    assert.ok((await Promise.all(stuck)).every(result => result.stopReason === "deadline"));
    assert.ok((await Promise.all(waiting)).every(result => result.stopReason === undefined));
    assert.equal(pool.stats().spawned, 4);
    assert.ok(peak <= 2, `running plus terminating threads peak=${peak}`);
    assert.equal(pool.stats().terminated, 2);
  } finally { clearInterval(sampler); await pool.close(); await fixture.done(); }
});

test("P3 worker error reserves its slot until exit; release and request settle after exit", async () => {
  const fixture = await corpus(3);
  const pool = new QueryWorkerPool({ allowTestHooks: true });
  const internals = pool as unknown as { slots: { worker?: import("node:worker_threads").Worker }[] };
  const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const };
  try {
    const busy = pool.search({ ...request, testBlockMs: 5_000 });
    const rejected = assert.rejects(busy, /simulated worker failure/);
    const worker = internals.slots[0]!.worker!;
    // Reproduce the error-to-exit gap without depending on OS scheduling.
    worker.emit("error", new Error("simulated worker failure"));
    const waiting = pool.search(request);
    let released = false;
    const release = pool.release(fixture.dbPath).then(() => { released = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pool.stats().spawned, 1);
    assert.equal(pool.stats().threads, 1);
    assert.equal(released, false);
    await worker.terminate();
    await rejected;
    await release;
    assert.equal((await waiting).stopReason, undefined);
    assert.equal(pool.stats().spawned, 2);
  } finally { await pool.close(); await fixture.done(); }
});

test("P3 observer errors do not change query errors, successful results or release/close", async () => {
  const fixture = await corpus(3);
  let observations = 0;
  const pool = new QueryWorkerPool({ workerCount: 2, onTiming: () => { observations += 1; throw new Error("observer failure"); } });
  const request = { dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text" as const };
  try {
    await assert.rejects(pool.search({ ...request, task: "order ".repeat(120), mode: "auto" }), /query length/);
    assert.equal((await pool.search({ ...request, deadlineAt: absoluteNow() - 1 })).stopReason, "deadline");
    assert.ok((await Promise.all([pool.search(request), pool.search(request)])).every(result => result.stopReason === undefined));
    await pool.release(fixture.dbPath);
    await pool.close();
    assert.equal(observations, 4);
    assert.equal(pool.stats().threads, 0);
  } finally { await pool.close(); await fixture.done(); }
});
