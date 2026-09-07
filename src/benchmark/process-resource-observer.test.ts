import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  startBenchmarkProcessResourceObserver,
  startBenchmarkProcessResourceObserverFromEnvironment,
  summarizeInProcessSamples
} from "./process-resource-observer.js";

test("in-process resource observer records event-loop, GC capability and queue depth without overwriting evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-resource-observer-"));
  const output = path.join(root, "resources.json");
  try {
    const observer = startBenchmarkProcessResourceObserver({
      outputFile: output,
      intervalMs: 5,
      profile: "test",
      javaIndex: "PRESENT",
      isolated: true
    })!;
    observer.recordQueueDepth("java-index-rpc", 2);
    await new Promise(resolve => setTimeout(resolve, 15));
    const payload = await observer.stop();
    assert.equal((payload.observations as { queueDepth: { status: string } }).queueDepth.status, "MEASURED");
    const persisted = JSON.parse(await readFile(output, "utf8"));
    assert.equal(persisted.observations.eventLoopDelay.status, "MEASURED");
    assert.equal(persisted.observations.gc.status, "MEASURED");
    assert.ok(persisted.summary.sampleCount >= 2);

    const second = startBenchmarkProcessResourceObserver({
      outputFile: output,
      intervalMs: 5,
      profile: "test",
      javaIndex: "NOT_PRESENT",
      isolated: true
    })!;
    await assert.rejects(second.stop(), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-process summary keeps zero samples unmeasured instead of reporting zero resources", () => {
  assert.deepEqual(summarizeInProcessSamples([]), {
    sampleCount: 0,
    peakRssBytes: undefined,
    peakHeapUsedBytes: undefined,
    cpuUserMicros: undefined,
    cpuSystemMicros: undefined
  });
});

test("FromEnvironment binds the sidecar path from the provided env map", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-resource-observer-env-"));
  const output = path.join(root, "resources.json");
  const previous = process.env.JAVA_LSP_ISOLATED_VALIDATION;
  process.env.JAVA_LSP_ISOLATED_VALIDATION = "1";
  try {
    const observer = startBenchmarkProcessResourceObserverFromEnvironment("runner-test", "PRESENT", {
      ...process.env,
      JAVA_LSP_RESOURCE_TELEMETRY_FILE: output,
      JAVA_LSP_RESOURCE_INTERVAL_MS: "5"
    })!;
    observer.recordQueueDepth("java-index:test", 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    await observer.stop();
    const persisted = JSON.parse(await readFile(output, "utf8"));
    assert.equal(persisted.observations.queueDepth.status, "MEASURED");
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_ISOLATED_VALIDATION;
    else process.env.JAVA_LSP_ISOLATED_VALIDATION = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("an immediately stopped observer reports an unsampled event loop as UNMEASURED", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-resource-observer-empty-loop-"));
  try {
    const observer = startBenchmarkProcessResourceObserver({
      outputFile: path.join(root, "resources.json"),
      intervalMs: 100,
      profile: "immediate-stop",
      javaIndex: "NOT_PRESENT",
      isolated: true
    })!;
    const payload = await observer.stop();
    const eventLoopDelay = (payload.observations as { eventLoopDelay: Record<string, unknown> }).eventLoopDelay;
    assert.deepEqual(eventLoopDelay, {
      status: "UNMEASURED",
      reason: "event-loop histogram collected no samples"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
