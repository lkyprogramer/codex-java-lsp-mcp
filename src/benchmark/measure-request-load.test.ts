import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_QUERY_WORKERS } from "../java-index/snapshot/query-pool.js";
import { parseRequestLoadArgs, REQUEST_LOAD_PROTOCOL, runRequestLoad, type RequestStepReport } from "./measure-request-load.js";

test("K29 request-path load passes every sample through the request view, the query pool and previews", { timeout: 240_000 }, async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), "k29-request-load-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const report = await runRequestLoad(parseRequestLoadArgs(["--files", "40", "--samples", "8", "--steps", "1,4", "--update-interval-ms", "30", "--output", output]));
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "query-request-load-report.json"), "utf8")).protocol, REQUEST_LOAD_PROTOCOL);
  const steps = report.steps as RequestStepReport[];
  const withUpdates = report.withUpdates as RequestStepReport;
  assert.deepEqual(steps.map(step => [step.concurrency, step.requests]), [[1, 8], [4, 8]]);
  for (const step of [...steps, withUpdates]) {
    assert.equal(step.errors, 0, JSON.stringify(step.rawLatencies.filter(row => row.error)));
    assert.equal(step.settled, true);
    assert.equal(step.scopeStates.READY, step.requests, JSON.stringify(step.scopeStates));
    assert.ok(step.worker.submits >= step.requests, "every public call reaches the query pool");
    assert.ok(step.worker.pids.length >= 1 && step.worker.pids.length <= MAX_QUERY_WORKERS, JSON.stringify(step.worker));
    assert.ok(step.worker.pids.every(pid => pid !== process.pid), "queries run in persistent worker processes");
    assert.ok(step.previews > 0, "head previews are served under load");
    assert.equal(step.rawLatencies.length, step.requests);
    assert.ok(step.latencyMs.p95 > 0 && step.eventLoopDelayMs.max >= step.eventLoopDelayMs.p95);
  }
  assert.equal(steps.reduce((sum, step) => sum + step.publishes, 0), 0, "the static steps publish nothing");
  assert.ok(withUpdates.edits >= 1 && withUpdates.publishes >= 1, `a publish lands while requests hold views: ${JSON.stringify({ edits: withUpdates.edits, publishes: withUpdates.publishes })}`);
});

test("K29 request-load arguments are validated", () => {
  assert.throws(() => parseRequestLoadArgs([]), /--output is required/);
  assert.throws(() => parseRequestLoadArgs(["--output", "/tmp/x", "--steps", "1,0"]), /invalid/);
  assert.deepEqual(parseRequestLoadArgs(["--output", "/tmp/x"]), { files: 1000, samples: 100, steps: [1, 5, 20], updateIntervalMs: 200, output: "/tmp/x", readyTimeoutMs: 300_000 });
});
