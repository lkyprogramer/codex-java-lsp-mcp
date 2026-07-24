import assert from "node:assert/strict";
import test from "node:test";
import { isCacheableCompletion } from "./completion.js";

test("only COMPLETE results are cacheable", () => {
  assert.equal(isCacheableCompletion("COMPLETE"), true);
  assert.equal(isCacheableCompletion("PARTIAL_TIMEOUT"), false);
  assert.equal(isCacheableCompletion("PARTIAL_LIMIT"), false);
  assert.equal(isCacheableCompletion("CANCELLED"), false);
  assert.equal(isCacheableCompletion("FAILED"), false);
});
