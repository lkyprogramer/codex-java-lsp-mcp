import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSymbolLimiter } from "./document-symbol-limiter.js";

test("DocumentSymbolLimiter enforces per-repo concurrency", async () => {
  const limiter = new DocumentSymbolLimiter(2, 1);
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const first = limiter.withSlot("/repo", async () => {
    order.push("first-start");
    await firstDone;
    order.push("first-end");
  });
  const second = limiter.withSlot("/repo", async () => {
    order.push("second-start");
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first-start"]);
  assert.equal(limiter.status().pending, 1);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.equal(limiter.status().active, 0);
});
