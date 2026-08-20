import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexRpcTelemetryCollector } from "./impact-metrics.js";

test("JavaIndex RPC telemetry leaves worker phases absent when no worker timing was observed", () => {
  const collector = new JavaIndexRpcTelemetryCollector();
  collector.requestStarted({ operation: "QUERY_TYPE", inputJsonBytes: 42 });
  collector.requestSettled({ operation: "QUERY_TYPE", outcome: "cancelled", callerWaitMs: 4 });

  const metrics = collector.snapshot().operations.QUERY_TYPE!;
  assert.equal(metrics.count, 1);
  assert.equal(metrics.inputJsonBytes, 42);
  assert.equal(metrics.cancelled, 1);
  assert.equal(metrics.workerQueue, undefined, "unobserved worker time must not be serialized as a measured zero");
  assert.equal(metrics.workerProcessing, undefined);
});

test("JavaIndex RPC telemetry aggregates terminal counts without exposing raw error messages", () => {
  const collector = new JavaIndexRpcTelemetryCollector();
  collector.requestStarted({ operation: "QUERY_FILES", inputJsonBytes: 10 });
  collector.requestSettled({
    operation: "QUERY_FILES",
    outcome: "retired",
    callerWaitMs: 5,
    retireReason: "WORKER_EXIT"
  });

  const metrics = collector.snapshot().operations.QUERY_FILES!;
  assert.equal(metrics.retired, 1);
  assert.deepEqual(metrics.retireReasons, { WORKER_EXIT: 1 });
  assert.equal(JSON.stringify(metrics).includes("message"), false);
});

test("relationship RPC summary counts callee operations per anchor without double-counting", () => {
  const collector = new JavaIndexRpcTelemetryCollector();
  collector.requestStarted({ operation: "QUERY_CALLEES", inputJsonBytes: 20 });
  collector.requestSettled({ operation: "QUERY_CALLEES", outcome: "completed", callerWaitMs: 3 });
  collector.requestStarted({ operation: "STATUS", inputJsonBytes: 4 });
  collector.requestSettled({ operation: "STATUS", outcome: "completed", callerWaitMs: 1 });

  const summary = collector.relationshipSummary(2);
  assert.equal(summary.bundleCount, 0);
  assert.equal(summary.relationshipOperations, 1);
  assert.equal(summary.relationshipRpcPerAnchor, 0.5);
  assert.equal(summary.anchorCount, 2);
});
