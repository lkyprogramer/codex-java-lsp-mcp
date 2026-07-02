import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EdgeStore } from "./edge-store.js";

async function fixture(prefix: string): Promise<{ root: string; anchor: string; caller: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const dir = path.join(root, "src", "main", "java", "demo");
  await mkdir(dir, { recursive: true });
  const anchor = path.join(dir, "FooService.java");
  const caller = path.join(dir, "OtherController.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  return { root, anchor, caller };
}

test("EdgeStore records edges and returns them for a fresh anchor", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-store-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const edges = store.edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, caller);
  assert.equal(edges[0].kind, "reference");
  assert.equal(store.status().hits, 1);
});

test("EdgeStore reloads persisted edges in a new instance", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-reload-");
  new EdgeStore(root).recordEdges(anchor, [{ to: caller, kind: "typeHierarchy", line: 2, column: 14 }]);
  const reloaded = new EdgeStore(root);
  assert.equal(reloaded.edgesFor(anchor).length, 1);
});

test("EdgeStore drops edges after anchor mtime changes", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-stale-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const future = new Date(Date.now() + 5000);
  utimesSync(anchor, future, future);
  assert.deepEqual(store.edgesFor(anchor), []);
  assert.equal(store.status().invalidated, 1);
});

test("EdgeStore filters edges whose target file is gone", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-target-gone-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  rmSync(caller);
  assert.deepEqual(store.edgesFor(anchor), []);
});

test("EdgeStore re-record replaces previous edges for the same anchor", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-replace-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  store.recordEdges(anchor, [{ to: caller, kind: "typeHierarchy", line: 3, column: 1 }]);
  const reloaded = new EdgeStore(root);
  const edges = reloaded.edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "typeHierarchy");
});
