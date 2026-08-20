import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaIndexStore } from "../java-index/index-store.js";
import { KnowledgeGraphBuilder } from "./graph-builder.js";
import { graphDigest, loadGraphSnapshot, packGraphSnapshot, unpackGraphSnapshot, writeGraphSnapshotAtomic } from "./graph-snapshot.js";
import { KnowledgeGraphStore } from "./graph-store.js";
import { knowledgeFileId } from "./entity-id.js";

test("snapshot round-trip preserves digest", async () => {
  const index = new JavaIndexStore();
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: knowledgeFileId("src/A.java"), kind: "FILE", generation: 3, relativePath: "src/A.java" }, "src/A.java");
  const packed = packGraphSnapshot(graph);
  const restored = new KnowledgeGraphStore();
  unpackGraphSnapshot(packed, restored);
  assert.equal(graphDigest(restored), packed.digest);
  assert.equal(restored.nodesById.get("src/A.java")?.kind, "FILE");

  const target = path.join(mkdtempSync(path.join(tmpdir(), "jin-graph-snap-")), "graph.json.gz");
  await writeGraphSnapshotAtomic(target, packed);
  const loaded = await loadGraphSnapshot(target);
  assert.equal(loaded?.digest, packed.digest);
});

test("two rebuilds of identical facts produce the same digest", () => {
  const index = new JavaIndexStore();
  const first = new KnowledgeGraphStore();
  const second = new KnowledgeGraphStore();
  new KnowledgeGraphBuilder(first).rebuildFromStore(index, 1);
  new KnowledgeGraphBuilder(second).rebuildFromStore(index, 1);
  assert.equal(graphDigest(first), graphDigest(second));
});

test("unpack restores file ownership so incremental removeFiles drops stale nodes", () => {
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  graph.upsertNode({ id: "src/A.java#A", kind: "TYPE", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  const packed = packGraphSnapshot(graph);
  const restored = new KnowledgeGraphStore();
  unpackGraphSnapshot(packed, restored);
  restored.removeFiles(["src/A.java"]);
  assert.equal(restored.nodesById.has("src/A.java"), false);
  assert.equal(restored.nodesById.has("src/A.java#A"), false);
});
