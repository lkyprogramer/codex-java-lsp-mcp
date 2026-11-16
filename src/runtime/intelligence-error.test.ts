import assert from "node:assert/strict";
import test from "node:test";
import { JavaIntelligenceError, rethrowIfTerminal, terminalErrorCode } from "./intelligence-error.js";

test("only deadline and cancellation are terminal", () => {
  const deadline = new JavaIntelligenceError("DEADLINE_EXCEEDED", "late");
  const cancelled = new JavaIntelligenceError("CANCELLED", "stop");
  assert.equal(terminalErrorCode(deadline), "DEADLINE_EXCEEDED");
  assert.equal(terminalErrorCode(cancelled), "CANCELLED");
  assert.throws(() => rethrowIfTerminal(deadline), error => error === deadline);
  assert.throws(() => rethrowIfTerminal(cancelled), error => error === cancelled);
  for (const other of [new JavaIntelligenceError("SEARCH_FAILED", "rg"), new Error("DEADLINE_EXCEEDED"), "CANCELLED", undefined]) {
    assert.equal(terminalErrorCode(other), undefined);
    assert.doesNotThrow(() => rethrowIfTerminal(other));
  }
});
