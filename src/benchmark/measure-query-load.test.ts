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
import { sharedQueryWorker } from "../discovery/query-worker.js";
import { generateRepo, runStepLoad, type LoadQuery } from "./measure-query-load.js";

const QUERIES: LoadQuery[] = [
  { kind: "rare-fqn", mode: "exact", query: "com.synth.p00000.Service00000" },
  { kind: "common-word", mode: "text", query: "order" },
  { kind: "broad", mode: "text", query: "order refund ledger payment" }
];

test("K29/R09: step load at 20 concurrent stays queue-bounded and fully settled; updates make answers PARTIAL, never mixed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "r09-load-"));
  try {
    generateRepo(root, 120);
    const dbPath = path.join(root, "load.sqlite");
    const db = openIndexDb(dbPath);
    ensureSchema(db);
    await runSqlColdBuild({ db, repoRoot: root });
    close(db);
    const load = await runStepLoad({ repoRoot: root, dbPath, queries: QUERIES, concurrency: 20, rounds: 3, deadlineMs: 5_000 });
    assert.equal(load.requests, 60);
    assert.ok(load.worker.queuePeak <= 32, `${load.worker.queuePeak}`);
    assert.ok(load.worker.queuePeak >= 2, "the requests really overlapped in the worker queue");
    assert.ok(load.settled, "nothing queued or running after the step");
    assert.equal(load.worker.terminated, 0);
    assert.equal(load.worker.rejectedQueueFull, 0);
    assert.deepEqual(Object.keys(load.stopReasons).filter(reason => reason !== "none" && reason !== "candidate_budget"), []);
    assert.ok(load.eventLoopDelayMs.max < 250, `scans never hold this loop (max ${load.eventLoopDelayMs.max}ms)`);
    const updated = await runStepLoad({ repoRoot: root, dbPath, queries: QUERIES, concurrency: 20, rounds: 3, deadlineMs: 5_000, writerIntervalMs: 5 });
    assert.ok(updated.writerCommits > 0);
    assert.ok(updated.settled);
    assert.ok((updated.stopReasons.changed_during_request ?? 0) > 0, JSON.stringify(updated.stopReasons));
    assert.equal(updated.requests, (updated.scopeStates.READY ?? 0) + (updated.scopeStates.PARTIAL ?? 0));
  } finally {
    await sharedQueryWorker().close();
    await rm(root, { recursive: true, force: true });
  }
});
