import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { JavaIndexStatus } from "./index-types.js";
import { JavaIndexClient, type WorkerLike } from "./java-index-client.js";

function validStatus(generation: number): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: generation,
    files: 0,
    types: 0,
    methods: 0,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: []
  };
}

class FakeWorker implements WorkerLike {
  readonly posted: Array<{ id: number; type: string }> = [];
  private readonly listeners: {
    message: Array<(value: unknown) => void>;
    error: Array<(error: Error) => void>;
    exit: Array<(code: number) => void>;
  } = { message: [], error: [], exit: [] };

  postMessage(value: unknown): void {
    this.posted.push(value as { id: number; type: string });
  }

  on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
    this.listeners[event].push(listener as never);
    return this;
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  emitMessage(value: unknown): void {
    for (const listener of this.listeners.message) listener(value);
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) listener(code);
  }
}

// ensureOpen()'s "already open" fast path still returns via a resolved
// promise, so a caller's next `await` step lands one or more microtask ticks
// later than the synchronous call that started it. Draining with setImmediate
// (a macrotask) guarantees every pending microtask in that chain has run
// before the test inspects what the fake worker received.
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function openedClient(): Promise<{ client: JavaIndexClient; worker: FakeWorker }> {
  const worker = new FakeWorker();
  const client = new JavaIndexClient("/repo", "/cache", () => worker);
  const openPromise = client.open(1);
  const openMessage = worker.posted[0];
  worker.emitMessage({ id: openMessage.id, ok: true, value: validStatus(1) });
  await openPromise;
  return { client, worker };
}

test("two out-of-order responses resolve correct promises", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  const anchorPromise = client.queryAnchor("A.java", 1, 1);
  await flushMicrotasks();
  const statusMessage = worker.posted[1];
  const anchorMessage = worker.posted[2];

  worker.emitMessage({ id: anchorMessage.id, ok: true, value: undefined });
  worker.emitMessage({ id: statusMessage.id, ok: true, value: validStatus(1) });

  const [statusResult, anchorResult] = await Promise.all([statusPromise, anchorPromise]);
  assert.equal(statusResult.state, "READY");
  assert.equal(anchorResult, undefined);
});

test("an invalid command payload is rejected by the validator and moves the client to DEGRADED", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  await flushMicrotasks();
  const statusMessage = worker.posted[1];
  worker.emitMessage({ id: statusMessage.id, ok: true, value: { not: "a status" } });

  await assert.rejects(statusPromise, (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    assert.equal(error.code, "INDEX_CORRUPT");
    return true;
  });
  assert.equal(client.localStatus().state, "DEGRADED");
});

test("worker exit rejects all pending requests and marks the client DEGRADED", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  await flushMicrotasks();
  assert.equal(worker.posted.length, 2, "the status request must have been sent before the exit");
  worker.emitExit(1);

  await assert.rejects(statusPromise, (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    assert.equal(error.code, "INDEX_PARTIAL");
    return true;
  });
  assert.equal(client.localStatus().state, "DEGRADED");
});

test("a failed OPEN clears the worker so the next request can still restart once", async () => {
  const workers: FakeWorker[] = [];
  const client = new JavaIndexClient("/repo", "/cache", () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  const openPromise = client.open(1);
  const firstWorker = workers[0];
  firstWorker.emitMessage({
    id: firstWorker.posted[0].id,
    ok: false,
    error: { code: "OPEN_FAILED", message: "boom" }
  });

  await assert.rejects(openPromise);
  assert.equal(client.localStatus().state, "DEGRADED");

  const statusPromise = client.status();
  assert.equal(workers.length, 2, "a failed OPEN must not wedge the client; the next request should restart");
  const secondWorker = workers[1];
  secondWorker.emitMessage({ id: secondWorker.posted[0].id, ok: true, value: validStatus(1) });
  await flushMicrotasks();
  secondWorker.emitMessage({ id: secondWorker.posted[1].id, ok: true, value: validStatus(1) });

  const status = await statusPromise;
  assert.equal(status.state, "READY");
});

test("after an unexpected exit, the next request restarts the worker exactly once", async () => {
  const workers: FakeWorker[] = [];
  const client = new JavaIndexClient("/repo", "/cache", () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  const openPromise = client.open(1);
  const firstWorker = workers[0];
  firstWorker.emitMessage({ id: firstWorker.posted[0].id, ok: true, value: validStatus(1) });
  await openPromise;

  firstWorker.emitExit(1);
  assert.equal(client.localStatus().state, "DEGRADED");

  const statusPromise = client.status();
  assert.equal(workers.length, 2, "the next request must spawn a replacement worker");
  const secondWorker = workers[1];
  secondWorker.emitMessage({ id: secondWorker.posted[0].id, ok: true, value: validStatus(1) });
  await flushMicrotasks();
  secondWorker.emitMessage({ id: secondWorker.posted[1].id, ok: true, value: validStatus(1) });

  const status = await statusPromise;
  assert.equal(status.state, "READY");

  secondWorker.emitExit(1);
  await assert.rejects(client.status(), (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    return true;
  });
  assert.equal(workers.length, 2, "a second exit must not spend a second restart");
});

test("client opens a real worker thread, reaches READY, and closes cleanly", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-client-smoke-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "java-index-client-smoke-cache-"));
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  assert.equal((await client.status()).state, "READY");
  await client.close();
  assert.equal(client.localStatus().state, "CLOSED");
});
