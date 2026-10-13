// input: a generated corpus, cold-built, loaded through the real query
//        boundary (SqlJavaIndexClient -> runStaticDiscovery -> shared worker).
// output: R09/K29 mechanism lock (not a performance gate): 20 concurrent
//         requests keep the worker queue <= 32, every request settles with
//         an explicit outcome, nothing is left queued or running, the main
//         event loop is never held by a scan, and answers that straddle a
//         writer commit are PARTIAL rather than mixed.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { classifyQuery } from "../discovery/query-intent.js";
import { sharedQueryWorker } from "../discovery/query-worker.js";
import { generateRepo, parseArgs, runStepLoad, type LoadQuery } from "./measure-query-load.js";

const QUERIES: LoadQuery[] = [
  { kind: "rare-fqn", mode: "exact", query: "com.synth.p00000.Service00000" },
  { kind: "common-word", mode: "text", query: "order" },
  { kind: "broad", mode: "text", query: "order refund ledger payment" },
  { kind: "fuzzy", mode: "auto", query: "refundOrder" }
];

test("P3: worker count defaults to one and only accepts one or two", () => {
  assert.equal(parseArgs(["--output", "/tmp/p3-unused"]).workerCount, 1);
  assert.equal(parseArgs(["--output", "/tmp/p3-unused", "--worker-count", "2"]).workerCount, 2);
  for (const value of ["0", "3", "1.5", "NaN"]) assert.throws(() => parseArgs(["--output", "/tmp/p3-unused", "--worker-count", value]), /--worker-count/);
  assert.throws(() => parseArgs(["--output", "/tmp/p3-unused", "--worker-count"]), /--worker-count/);
});

for (const workerCount of [1, 2] as const) test(`K29/R09 P3 (${workerCount} readers): step load at 20 concurrent stays queue-bounded and fully settled; updates make answers PARTIAL, never mixed`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "r09-load-"));
  try {
    generateRepo(root, 120);
    const dbPath = path.join(root, "load.sqlite");
    const db = openIndexDb(dbPath);
    ensureSchema(db);
    await runSqlColdBuild({ db, repoRoot: root });
    close(db);
    const load = await runStepLoad({ repoRoot: root, dbPath, workerCount, queries: QUERIES, concurrency: 20, rounds: 3, deadlineMs: 5_000 });
    assert.equal(load.requests, 60);
    assert.equal(load.workerCount, workerCount);
    assert.equal(load.rawLatencies.length, 60);
    assert.equal(load.workerRequests.length, 60);
    assert.equal(load.measuredWorkerCompleted, 60);
    assert.equal(load.measuredWorkerSpawned, 0);
    assert.equal(classifyQuery("refundOrder", "auto"), "exact");
    assert.ok(load.warmup.workerRequests.some(event => event.request.task === "refundOrder" && event.request.mode === "exact"));
    for (let slot = 0; slot < workerCount; slot += 1) for (const query of QUERIES) {
      assert.ok(load.warmup.workerRequests.some(event => event.workerSlot === slot && event.request.task === query.query && event.request.mode === classifyQuery(query.query, query.mode) && event.outcome === "completed" && event.actualServiceMs !== null));
    }
    for (const timing of load.workerRequests) {
      assert.equal(timing.started, true);
      assert.ok(timing.dispatchedAt! >= timing.enqueueAt);
      assert.ok(timing.settledAt >= timing.dispatchedAt!);
      assert.ok(timing.actualServiceMs !== null && timing.actualServiceMs >= 0);
      assert.equal(timing.actualServiceMs, timing.workerFinishedAt! - timing.workerStartedAt!);
      assert.equal(timing.queuedMs, timing.dispatchedAt! - timing.enqueueAt);
      assert.equal(timing.dispatchReplyMs, timing.settledAt - timing.dispatchedAt!);
    }
    assert.equal(load.warmup.requests, QUERIES.length * workerCount);
    assert.equal(load.warmup.workerSlots.length, workerCount);
    assert.equal(new Set(load.rawLatencies.map(row => row.sample)).size, 60);
    assert.ok(load.resources.wallMs > 0);
    assert.ok(load.resources.cpuUserUs >= 0 && load.resources.cpuSystemUs >= 0);
    assert.ok(load.resources.rssSampledPeakMb >= load.resources.rssStartMb);
    assert.ok(load.resources.rssSampledPeakMb >= load.resources.rssEndMb);
    assert.ok(load.worker.queuePeak <= 32, `${load.worker.queuePeak}`);
    assert.ok(load.worker.queuePeak >= 2, "the requests really overlapped in the worker queue");
    assert.ok(load.settled, "nothing queued or running after the step");
    assert.equal(load.worker.terminated, 0);
    assert.equal(load.worker.rejectedQueueFull, 0);
    assert.deepEqual(Object.keys(load.stopReasons).filter(reason => reason !== "none" && reason !== "candidate_budget"), []);
    assert.ok(load.eventLoopDelayMs.max < 250, `scans never hold this loop (max ${load.eventLoopDelayMs.max}ms)`);
    const updated = await runStepLoad({ repoRoot: root, dbPath, workerCount, queries: QUERIES, concurrency: 20, rounds: 3, deadlineMs: 5_000, writerIntervalMs: 5 });
    assert.ok(updated.writerCommits > 0);
    assert.ok(updated.measuredWriterCommits > 0);
    assert.equal(updated.writerCommits, updated.measuredWriterCommits + updated.warmup.writerCommits);
    assert.ok(updated.settled);
    assert.ok((updated.stopReasons.changed_during_request ?? 0) > 0, JSON.stringify(updated.stopReasons));
    assert.equal(updated.requests, (updated.scopeStates.READY ?? 0) + (updated.scopeStates.PARTIAL ?? 0));
    const worker = sharedQueryWorker();
    await worker.close();
    assert.equal(worker.stats().threads, 0);
    assert.equal(worker.stats().queued, 0);
    assert.equal(worker.stats().running, false);
  } finally {
    await sharedQueryWorker().close();
    await rm(root, { recursive: true, force: true });
  }
});
