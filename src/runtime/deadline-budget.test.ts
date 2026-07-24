import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineBudget } from "./deadline-budget.js";
import { JavaIntelligenceError } from "./intelligence-error.js";

test("DeadlineBudget clamps each stage to the absolute remaining budget", () => {
  let now = 100;
  const budget = DeadlineBudget.fromTimeout(1000, () => now);
  assert.equal(budget.remainingMs(), 1000);
  assert.equal(budget.remainingMs(200), 200);
  now = 950;
  assert.equal(budget.remainingMs(), 150);
  assert.equal(budget.remainingMs(200), 150);
  now = 1100;
  assert.equal(budget.remainingMs(), 0);
  assert.equal(budget.expired(), true);
});

test("DeadlineBudget rejects expired stages with a classified error", () => {
  let now = 0;
  const budget = DeadlineBudget.fromTimeout(10, () => now);
  now = 11;
  assert.throws(
    () => budget.throwIfExpired("semantic.references"),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /semantic\.references/.test(error.message)
  );
});

test("DeadlineBudget.race calls timeout cleanup", async () => {
  let cleaned = 0;
  const budget = DeadlineBudget.fromTimeout(10);
  // The deadline timer is unref'd on purpose so a pending timeout never keeps the
  // MCP process alive. The operation under test never settles, so this test must
  // hold the event loop open itself or Node exits before the deadline fires.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(
      () => budget.race(
        "slow-stage",
        new Promise<void>(() => undefined),
        1000,
        () => { cleaned += 1; }
      ),
      (error: unknown) => error instanceof JavaIntelligenceError
        && error.code === "DEADLINE_EXCEEDED"
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(cleaned, 1);
});

test("DeadlineBudget.race rejects immediately once the budget is already spent", async () => {
  let now = 0;
  let cleaned = 0;
  const budget = DeadlineBudget.fromTimeout(10, () => now);
  now = 50;
  await assert.rejects(
    () => budget.race("late-stage", Promise.resolve("value"), 1000, () => { cleaned += 1; }),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /late-stage/.test(error.message)
  );
  assert.equal(cleaned, 1);
});

test("DeadlineBudget.race resolves a fast operation without invoking cleanup", async () => {
  let cleaned = 0;
  const budget = DeadlineBudget.fromTimeout(5000);
  const value = await budget.race("fast-stage", Promise.resolve(42), 1000, () => { cleaned += 1; });
  assert.equal(value, 42);
  assert.equal(cleaned, 0);
});

test("DeadlineBudget rejects non-positive and non-finite timeouts", () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => DeadlineBudget.fromTimeout(invalid),
      (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
    );
  }
});
