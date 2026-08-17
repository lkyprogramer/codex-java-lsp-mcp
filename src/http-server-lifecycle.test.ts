import assert from "node:assert/strict";
import test from "node:test";
import { HttpServerLifecycle } from "./http-server-lifecycle.js";

test("HTTP lifecycle rejects new requests while draining and waits for entered work", async () => {
  const lifecycle = new HttpServerLifecycle();
  lifecycle.markReady();
  const first = lifecycle.enterRequest();
  const second = lifecycle.enterRequest();
  assert.ok(first);
  assert.ok(second);

  const drain = lifecycle.drain(1000);
  assert.equal(lifecycle.snapshot().state, "draining");
  assert.equal(lifecycle.enterRequest(), undefined);
  first();
  assert.equal(lifecycle.snapshot().activeRequests, 1);
  second();
  await drain;
  assert.equal(lifecycle.snapshot().activeRequests, 0);
});

test("HTTP lifecycle drain is bounded and close is terminal", async () => {
  const lifecycle = new HttpServerLifecycle();
  lifecycle.markReady();
  const release = lifecycle.enterRequest();
  assert.ok(release);

  await assert.rejects(() => lifecycle.drain(10), /Timed out draining 1 HTTP request/);
  assert.equal(lifecycle.enterRequest(), undefined);
  lifecycle.close();
  assert.equal(lifecycle.snapshot().state, "closed");
  release();
  assert.equal(lifecycle.snapshot().activeRequests, 0);
});

test("HTTP lifecycle validates transitions and drain deadlines", async () => {
  const lifecycle = new HttpServerLifecycle();
  lifecycle.markReady();
  assert.throws(() => lifecycle.markReady(), /Cannot mark HTTP server ready/);
  await assert.rejects(() => lifecycle.drain(-1), /Invalid HTTP drain deadline/);
  assert.equal(lifecycle.snapshot().state, "ready");
});
