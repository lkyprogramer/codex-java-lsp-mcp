#!/usr/bin/env node
// Test-only target for the isolated resource runners; always executes from the detached candidate clone.
if (process.argv[2] === "observer") {
  const { startBenchmarkProcessResourceObserverFromEnvironment } = await import("../dist/benchmark/process-resource-observer.js");
  const observer = startBenchmarkProcessResourceObserverFromEnvironment("runner-test", "PRESENT");
  observer.recordQueueDepth("java-index:test", 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  await observer.stop();
} else {
  await new Promise(resolve => setTimeout(resolve, 80));
}
