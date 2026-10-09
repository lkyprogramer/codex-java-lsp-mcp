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
  const internals = pool as unknown as { worker?: { terminate(): Promise<number> } };
  try {
    const first = pool.search({ dbPath: fixture.dbPath, task: "order", limit: 5, mode: "text", deadlineAt: absoluteNow() + 30, testBlockMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const stalled = internals.worker!;
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
