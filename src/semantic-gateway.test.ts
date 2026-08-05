import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import {
  SemanticGateway,
  type SemanticBackendResult,
  type SemanticCacheKey,
  type SemanticValueMap
} from "./semantic-gateway.js";
import { deferred } from "./test-support/deferred.js";

function reference(name: string): SemanticValueMap["references"][number] {
  return {
    uri: `file:///repo/${name}.java`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

const baseKey: SemanticCacheKey<"references"> = {
  repoHash: "repo",
  generation: 1,
  operation: "references",
  file: "/repo/A.java",
  fileFingerprint: "10:1",
  line: 3,
  column: 7,
  optionsKey: "includeDeclaration=false"
};

test("identical concurrent semantic requests share one backend call", async () => {
  const pending = deferred<SemanticBackendResult<SemanticValueMap["references"]>>();
  let backendCalls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      backendCalls += 1;
      return pending.promise;
    }
  }, {
    now: () => 100,
    ttlMs: 5000,
    absoluteCapMs: 1500
  });

  const input: SemanticCacheKey<"references"> = {
    repoHash: "repo",
    generation: 7,
    operation: "references",
    file: "/repo/A.java",
    fileFingerprint: "12:1000",
    line: 9,
    column: 4,
    optionsKey: "includeDeclaration=false"
  };

  const first = gateway.execute(input, DeadlineBudget.fromTimeout(1000), 1500);
  const second = gateway.execute(input, DeadlineBudget.fromTimeout(1000), 1500);

  assert.equal(backendCalls, 1);
  pending.resolve({ completion: "COMPLETE", value: [reference("A"), reference("B")] });
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.value.map(item => item.uri), ["file:///repo/A.java", "file:///repo/B.java"]);
  assert.deepEqual(right.value.map(item => item.uri), ["file:///repo/A.java", "file:///repo/B.java"]);
  assert.equal(left.completion, "COMPLETE");
  assert.equal(right.shared, true);
  assert.equal(backendCalls, 1);
});

test("partial and failed outcomes are never cached", async () => {
  let calls = 0;
  const responses: Array<SemanticBackendResult<SemanticValueMap["references"]>> = [
    { completion: "PARTIAL_TIMEOUT", value: [reference("partial")], errorCode: "DEADLINE_EXCEEDED" },
    { completion: "FAILED", value: [], errorCode: "JDT_SERVER_ERROR" },
    { completion: "COMPLETE", value: [reference("complete")] }
  ];
  const gateway = new SemanticGateway({
    async execute() {
      const response = responses[calls];
      calls += 1;
      if (!response) throw new Error("unexpected backend call");
      return response;
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "PARTIAL_TIMEOUT");
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "FAILED");
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "COMPLETE");
  const cached = await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.value.map(item => item.uri), ["file:///repo/complete.java"]);
  assert.equal(calls, 3);
});

test("completed cache TTL starts after backend completion", async () => {
  let now = 0;
  let calls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      calls += 1;
      now = 1000;
      return { completion: "COMPLETE", value: [reference(`call-${calls}`)] };
    }
  }, { now: () => now, ttlMs: 100, absoluteCapMs: 1000 });

  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).value[0]?.uri, "file:///repo/call-1.java");
  now = 1099;
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).cacheHit, true);
  now = 1101;
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).value[0]?.uri, "file:///repo/call-2.java");
  assert.equal(calls, 2);
});

test("generation and fingerprint are part of the cache key", async () => {
  let calls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      calls += 1;
      return { completion: "COMPLETE", value: [reference(`call-${calls}`)] };
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  await gateway.execute({ ...baseKey, generation: 2 }, DeadlineBudget.fromTimeout(1000), 1000);
  await gateway.execute({ ...baseKey, fileFingerprint: "11:2" }, DeadlineBudget.fromTimeout(1000), 1000);
  assert.equal(calls, 3);
});

test("one caller deadline does not cancel another caller sharing backend work", async () => {
  const pending = deferred<SemanticBackendResult<SemanticValueMap["references"]>>();
  let backendSignal: AbortSignal | undefined;
  const gateway = new SemanticGateway({
    async execute(_key, _timeoutMs, signal) {
      backendSignal = signal;
      return pending.promise;
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  const short = gateway.execute(baseKey, DeadlineBudget.fromTimeout(10), 1000);
  const long = gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(backendSignal?.aborted, false);
  pending.resolve({ completion: "COMPLETE", value: [reference("survived")] });
  assert.deepEqual((await long).value.map(item => item.uri), ["file:///repo/survived.java"]);
  assert.equal(backendSignal?.aborted, false);
});

test("gateway calls during an active lifecycle backoff cause zero backend calls", async () => {
  let backendCalls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      backendCalls += 1;
      throw new Error("backend must not be reached while backoff is active");
    }
  }, {
    ttlMs: 1000,
    absoluteCapMs: 1000,
    lifecycleGate: () => ({ allowed: false, code: "JDT_BACKOFF", message: "backing off for 5000ms" })
  });

  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000))
  );

  assert.equal(backendCalls, 0);
  for (const outcome of outcomes) {
    assert.equal(outcome.completion, "FAILED");
    assert.equal(outcome.errorCode, "JDT_BACKOFF");
    assert.equal(outcome.cacheHit, false);
  }
  assert.equal(gateway.status().lifecycleBackoffSkips, 5);
});

test("busy-other-session lifecycle outcome is reported distinctly from backoff", async () => {
  const gateway = new SemanticGateway({
    async execute() {
      throw new Error("backend must not be reached while another session holds the lease");
    }
  }, {
    ttlMs: 1000,
    absoluteCapMs: 1000,
    lifecycleGate: () => ({ allowed: false, code: "JDT_BUSY_OTHER_SESSION", message: "busy" })
  });

  const outcome = await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  assert.equal(outcome.completion, "FAILED");
  assert.equal(outcome.errorCode, "JDT_BUSY_OTHER_SESSION");
  const status = gateway.status();
  assert.equal(status.busyOtherSessionSkips, 1);
  assert.equal(status.lifecycleBackoffSkips, 0);
});
