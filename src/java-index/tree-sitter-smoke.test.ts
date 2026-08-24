import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

function runWorker(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./tree-sitter-smoke-worker.js", import.meta.url)
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

test("tree-sitter-java parses Java inside a worker thread", async () => {
  const result = await runWorker();
  assert.equal(result.ok, true, String(result.error ?? ""));
  assert.equal(result.rootType, "program");
  assert.equal(result.hasError, false);
  assert.match(String(result.text), /method_declaration/);
  assert.match(String(result.text), /record_declaration/);
  assert.ok(Number(result.changedRanges) >= 1);
  assert.equal(result.incrementalTypeText, "String");
  // node-tree-sitter (native) frees the underlying C tree in its N-API
  // finalizer/destructor when the JS Tree is garbage collected; it has never
  // exposed a JS-level Tree.delete() method (confirmed by inspecting
  // node_modules/tree-sitter/src/tree.cc: ts_tree_delete() runs in ~Tree(),
  // and only edit/rootNode/rootNodeWithOffset/printDotGraph/getChangedRanges/
  // getIncludedRanges/getEditedRange/_cacheNode/_cacheNodes are registered as
  // InstanceMethods). This is unlike web-tree-sitter (WASM), which requires
  // an explicit delete() since Emscripten heap objects aren't covered by V8 GC.
  assert.equal(result.supportsDelete, false);
});
