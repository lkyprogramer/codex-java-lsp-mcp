import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  McpServerLifecycle,
  parseServerIdleTtlMs,
  type ServerLifecycleClock,
  type ServerLifecycleTimer,
  type ServerShutdownReason
} from "./server-lifecycle.js";

test("transport end and close share one shutdown", async () => {
  const stdin = new PassThrough();
  const shutdownReasons: ServerShutdownReason[] = [];
  const exitCodes: number[] = [];
  const lifecycle = new McpServerLifecycle({
    stdin,
    idleTtlMs: 100,
    shutdown: async reason => { shutdownReasons.push(reason); },
    exit: code => { exitCodes.push(code); }
  });

  lifecycle.start();
  stdin.emit("end");
  stdin.emit("close");
  await lifecycle.shutdown("sigterm");

  assert.deepEqual(shutdownReasons, ["stdio_end"]);
  assert.deepEqual(exitCodes, [0]);
});

test("idle timeout starts after readiness, pauses for a request, and resumes after completion", async () => {
  const clock = new FakeClock();
  const shutdownReasons: ServerShutdownReason[] = [];
  const lifecycle = new McpServerLifecycle({
    stdin: new PassThrough(),
    idleTtlMs: 100,
    shutdown: async reason => { shutdownReasons.push(reason); },
    exit: () => undefined,
    clock
  });
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });

  lifecycle.start();
  lifecycle.markReady();
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0].delayMs, 100);

  const request = lifecycle.runRequest(async () => active);
  assert.equal(clock.liveTimers().length, 0, "an active request cancels the idle deadline");

  release();
  await request;
  assert.equal(clock.liveTimers().length, 1, "the deadline restarts only after the last request completes");

  clock.fireNext();
  await lifecycle.shutdown("sigterm");
  assert.deepEqual(shutdownReasons, ["idle_timeout"]);
});

test("server idle TTL defaults safely and accepts zero only as an explicit opt-out", () => {
  assert.equal(parseServerIdleTtlMs(undefined), 900000);
  assert.equal(parseServerIdleTtlMs(""), 900000);
  assert.equal(parseServerIdleTtlMs("invalid"), 900000);
  assert.equal(parseServerIdleTtlMs("0"), 0);
  assert.equal(parseServerIdleTtlMs("1200"), 1200);
});

class FakeClock implements ServerLifecycleClock {
  private readonly timers: FakeTimer[] = [];

  setTimeout(callback: () => void, delayMs: number): ServerLifecycleTimer {
    const timer = new FakeTimer(callback, delayMs);
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: ServerLifecycleTimer): void {
    (timer as FakeTimer).cleared = true;
  }

  liveTimers(): FakeTimer[] {
    return this.timers.filter(timer => !timer.cleared && !timer.fired);
  }

  fireNext(): void {
    const timer = this.liveTimers()[0];
    assert.ok(timer, "expected an active timer");
    timer.fired = true;
    timer.callback();
  }
}

class FakeTimer implements ServerLifecycleTimer {
  cleared = false;
  fired = false;

  constructor(readonly callback: () => void, readonly delayMs: number) {}

  unref(): void {}
}
