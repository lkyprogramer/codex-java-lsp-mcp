import assert from "node:assert/strict";
import test from "node:test";
import { QueryWorkBudget } from "./query-budget.js";

function fakeClock(initialRemainingMs: number) {
  let remaining = initialRemainingMs;
  return {
    remainingMs: () => remaining,
    elapse: (ms: number) => {
      remaining -= ms;
    }
  };
}

test("QueryWorkBudget rejects invalid work limits", () => {
  for (const invalid of [0, -5, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => new QueryWorkBudget(invalid, () => 100), /invalid work limit/, `limit=${invalid}`);
  }
});

test("QueryWorkBudget permits work while time and postings remain", () => {
  const clock = fakeClock(100);
  const budget = new QueryWorkBudget(3, clock.remainingMs);
  assert.equal(budget.take(), "ok");
  assert.equal(budget.take(), "ok");
  assert.equal(budget.take(), "ok");
  assert.equal(budget.visited(), 3);
  // the cap is on posting rows, so the fourth visit is a budget stop
  assert.equal(budget.take(), "postings");
  assert.equal(budget.visited(), 3, "a stopped take must not advance the counter");
});

test("QueryWorkBudget stops at the deadline before counting postings", () => {
  const clock = fakeClock(10);
  const budget = new QueryWorkBudget(100, clock.remainingMs);
  assert.equal(budget.take(), "ok");
  clock.elapse(10);
  assert.equal(budget.take(), "deadline", "remainingMs()<=0 must win over the posting cap");
  assert.equal(budget.visited(), 1);
  assert.equal(budget.take(), "deadline", "the deadline verdict is sticky");
});

test("QueryWorkBudget reports the postings verdict once the cap is exhausted even with time left", () => {
  const clock = fakeClock(1000);
  const budget = new QueryWorkBudget(2, clock.remainingMs);
  budget.take();
  budget.take();
  clock.elapse(900); // plenty of time left, so the stop must be 'postings', not 'deadline'
  assert.equal(budget.take(), "postings");
  assert.equal(budget.take(), "postings");
});

test("QueryWorkBudget starts at the deadline when the parent budget is already spent", () => {
  const budget = new QueryWorkBudget(10, () => 0);
  assert.equal(budget.take(), "deadline");
  assert.equal(budget.visited(), 0);
});