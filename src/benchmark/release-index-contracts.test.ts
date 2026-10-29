// Release contract K23 exercised through the real parser, SQLite facts and graph: a refresh's
// dispatch facts equal a fresh cold build's.
// MAC-14: K03/K06/K11/K20/K21/K30 moved to the owner path (sealed snapshots, request views, MCP via the
// owner daemon); their legacy in-process SqlJavaIndexClient/LocalBuilder versions are retired here.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { applyBuilderJob } from "../index-builder/incremental.js";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";

async function put(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

test("K23: parent self-call dispatch matches fresh cold after adding and deleting a child override", async () => {
  const { SqlFactsStore } = await import("../java-index/sql/facts-store.js");
  const { SqlKnowledgeGraph } = await import("../java-index/sql/knowledge-graph.js");
  const root = await mkdtemp(path.join(tmpdir(), "release-dispatch-self-call-"));
  const parentPath = "src/main/java/Parent.java", childPath = "src/main/java/Child.java";
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const observe = (index: typeof db) => {
    const store = new SqlFactsStore(index), graph = new SqlKnowledgeGraph(index);
    const run = store.files([parentPath])[0]!.methods.find(method => method.name === "run")!;
    const id = graph.nodeIdForJavaIndexId(run.methodId)!;
    return (["CALLS_EXACT", "CALLS_VIRTUAL"] as const).flatMap(kind => graph.successors(id, kind).map(edge => ({
      kind, toId: edge.toId, dispatch: graph.successors(edge.toId, "DISPATCHES_TO").map(target => target.toId).sort()
    })));
  };
  try {
    await put(root, { [parentPath]: "class Parent { void save() {} void run() { save(); } }" });
    await runSqlColdBuild({ repoRoot: root, db });
    assert.equal(observe(db)[0]!.kind, "CALLS_EXACT");
    for (const [generation, add] of [[2, true], [3, false]] as const) {
      if (add) await put(root, { [childPath]: "class Child extends Parent { void save() {} }" });
      else await rm(path.join(root, childPath));
      const result = await applyBuilderJob({ repoRoot: root, db, job: { kind: "refresh", generation,
        changed: add ? [childPath] : [], deleted: add ? [] : [childPath] } });
      assert.equal(result.ok, true, result.error);
      const fresh = openIndexDb(":memory:"); ensureSchema(fresh);
      try {
        await runSqlColdBuild({ repoRoot: root, db: fresh });
        assert.deepEqual(observe(db), observe(fresh), `${add ? "add" : "delete"} override must update the parent's self-call`);
        assert.equal(observe(db)[0]!.kind, add ? "CALLS_VIRTUAL" : "CALLS_EXACT");
      } finally { close(fresh); }
    }
  } finally { close(db); await rm(root, { recursive: true, force: true }); }
});
