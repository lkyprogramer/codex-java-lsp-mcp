import assert from "node:assert/strict";
import test from "node:test";
import { extractJavaFile } from "../java-index/ast-extractor.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange } from "../java-index/index-types.js";
import { javaFileId, javaMethodId, javaTypeId } from "../java-index/stable-id.js";
import { KnowledgeGraphBuilder } from "./graph-builder.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";

function sqlGraph() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return new SqlKnowledgeGraph(db);
}


class MemoryFacts {
  readonly db = openIndexDb(":memory:");
  readonly store: SqlFactsStore;
  constructor() {
    ensureSchema(this.db);
    this.store = new SqlFactsStore(this.db);
  }
  replaceFile(bundle: JavaFileBundle) {
    writeBundle(this.db, bundle);
    this.store.clearRequestCache();
  }
  replaceMyBatisResource(resource: Parameters<typeof writeMyBatisResource>[1]) {
    writeMyBatisResource(this.db, resource);
    this.store.clearRequestCache();
  }
}


const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 8, column: 2 } };

function bundle(simpleName: string, methods: string[] = []): JavaFileBundle {
  const relativePath = `src/main/java/demo/${simpleName}.java`;
  const file: JavaFileFacts = {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src/main/java",
    module: "demo",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: [],
    allTypeIds: [],
    contentHash: "h",
    size: 10,
    mtimeMs: 1,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 1
  };
  const typeId = javaTypeId({ fqn: `demo.${simpleName}`, relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: `demo.${simpleName}`,
    simpleName,
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  const methodFacts: JavaMethodFacts[] = methods.map(name => {
    const methodId = javaMethodId(typeId, `${name}()`);
    type.methodIds.push(methodId);
    return {
      methodId,
      ownerTypeId: typeId,
      name,
      constructor: false,
      signatureKey: `${name}()`,
      range: RANGE,
      modifiers: ["public"],
      annotations: [],
      typeParameters: [],
      parameters: [],
      throws: [],
      callSites: [],
      localTypes: []
    };
  });
  return { file, types: [type], fields: [], methods: methodFacts, edges: [] };
}

test("builder emits CONTAINS and DECLARES structural edges from JavaIndex facts", () => {
  const index = new MemoryFacts();
  index.replaceFile(bundle("Widget", ["save"]));
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index.store, 1);
  const typeId = "src/main/java/demo/Widget.java#demo.Widget";
  const fileId = "src/main/java/demo/Widget.java";
  assert.equal(graph.nodesById.get(fileId)?.kind, "FILE");
  assert.equal(graph.nodesById.get(typeId)?.kind, "TYPE");
  assert.ok(graph.successors(fileId, "CONTAINS").some(edge => edge.toId === typeId));
  assert.ok(graph.successors(typeId, "DECLARES").some(edge => graph.nodesById.get(edge.toId)?.simpleName === "save"));
});

test("replaceFile removes a deleted method and does not leave a stale DECLARES edge", () => {
  const index = new MemoryFacts();
  const first = bundle("Widget", ["save", "load"]);
  index.replaceFile(first);
  const graph = sqlGraph();
  const builder = new KnowledgeGraphBuilder(graph);
  builder.rebuildFromStore(index.store, 1);
  const typeId = "src/main/java/demo/Widget.java#demo.Widget";
  assert.equal(graph.successors(typeId, "DECLARES").length, 2);

  const second = bundle("Widget", ["save"]);
  index.replaceFile(second);
  builder.replaceFile(second, index.store, 2);
  const declared = graph.successors(typeId, "DECLARES").map(edge => graph.nodesById.get(edge.toId)?.simpleName);
  assert.deepEqual(declared.sort(), ["save"]);
  assert.equal(graph.successors(typeId, "DECLARES").length, 1);
});

test("N1 does not materialize PARAMETER or STATEMENT nodes", () => {
  const index = new MemoryFacts();
  const widget = bundle("Widget", ["save"]);
  widget.methods[0]!.parameters.push({
    name: "id",
    type: { text: "String", simpleName: "String", typeArguments: [], arrayDepth: 0, resolution: { state: "UNRESOLVED" } },
    varargs: false,
    annotations: [],
    range: RANGE
  });
  index.replaceFile(widget);
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index.store, 1);
  for (const node of [...graph.nodesById.entries()].map(([, node]) => node)) {
    assert.notEqual(node.kind, "PARAMETER");
    assert.notEqual(node.kind, "STATEMENT");
    assert.notEqual(node.kind, "LOCAL");
  }
});

test("removing one file in a two-file module keeps MODULE CONTAINS", () => {
  const index = new MemoryFacts();
  const first = bundle("Alpha", ["a"]);
  const second = bundle("Beta", ["b"]);
  index.replaceFile(first);
  index.replaceFile(second);
  const graph = sqlGraph();
  const builder = new KnowledgeGraphBuilder(graph);
  builder.rebuildFromStore(index.store, 1);
  builder.replaceFile(first, index.store, 2);
  builder.removeFiles(["src/main/java/demo/Alpha.java"]);
  const moduleId = "module:demo";
  assert.equal(graph.nodesById.get(moduleId)?.kind, "MODULE");
  assert.ok(graph.successors("repo", "CONTAINS").some(edge => edge.toId === moduleId));
  assert.equal(graph.nodesById.has("src/main/java/demo/Alpha.java"), false);
  assert.equal(graph.nodesById.get("src/main/java/demo/Beta.java")?.kind, "FILE");
});

test("same-named local types and their members remain distinct through graph replacement", async () => {
  const relativePath = "src/main/java/demo/Widget.java";
  const backend = await createJavaParserBackend();
  const extract = (content: string, generation: number): JavaFileBundle => ({
    ...extractJavaFile({
      repoRoot: "/unused", absolutePath: `/unused/${relativePath}`, relativePath,
      sourceRoot: "src/main/java", module: "demo", sourceSet: "main",
      content, size: Buffer.byteLength(content), mtimeMs: 0, contentHash: `h${generation}`, generation
    }, backend),
    edges: []
  });
  const content = `package demo;
class Widget {
  void first() { class Local { int value; Local() {} void same() {} class Inner {} } }
  void second() { class Local { int value; Local() {} void same() {} class Inner {} } }
}`;
  const first = extract(content, 1);
  assert.equal(first.file.parseState, "COMPLETE");
  const locals = first.types.filter(type => !type.fqn);
  assert.equal(locals.length, 4, "both local classes and their nested classes have position identities");
  assert.equal(new Set(locals.map(type => type.typeId)).size, 4);
  const index = new MemoryFacts();
  const graphDb = openIndexDb(":memory:");
  ensureSchema(graphDb);
  const graph = new SqlKnowledgeGraph(graphDb);
  try {
    index.replaceFile(first);
    const builder = new KnowledgeGraphBuilder(graph);
    builder.rebuildFromStore(index.store, 1);
    const assertReachable = (facts: JavaFileBundle) => {
      const graphIds = new Set<string>();
      for (const fact of [...facts.types, ...facts.fields, ...facts.methods]) {
        const javaIndexId = "typeId" in fact ? fact.typeId : "fieldId" in fact ? fact.fieldId : fact.methodId;
        const id = graph.nodeIdForJavaIndexId(javaIndexId);
        assert.ok(id, `graph must retain ${javaIndexId}`);
        assert.equal(graph.nodesById.get(id)?.javaIndexId, javaIndexId);
        graphIds.add(id);
        if ("ownerTypeId" in fact) {
          const ownerId = graph.nodeIdForJavaIndexId(fact.ownerTypeId)!;
          assert.ok(graph.successors(ownerId, "DECLARES").some(edge => edge.toId === id));
        } else if ("enclosingTypeId" in fact && fact.enclosingTypeId) {
          const ownerId = graph.nodeIdForJavaIndexId(fact.enclosingTypeId)!;
          assert.ok(graph.successors(ownerId, "CONTAINS").some(edge => edge.toId === id));
        }
      }
      assert.equal(graphIds.size, facts.types.length + facts.fields.length + facts.methods.length);
    };
    assertReachable(first);
    assert.equal(graph.nodeIdForJavaIndexId(first.types[0]!.typeId), `${relativePath}#demo.Widget`);

    const second = extract(content.replace("  void first()", "\n\n  void first()"), 2);
    index.replaceFile(second);
    builder.replaceFile(second, index.store, 2);
    assertReachable(second);
    for (const type of locals) assert.equal(graph.nodeIdForJavaIndexId(type.typeId), undefined, "replaced positions must not leave stale nodes");
  } finally {
    graphDb.close();
    index.db.close();
  }
});
