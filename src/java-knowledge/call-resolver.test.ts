import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexStore } from "../java-index/index-store.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange, StaticEdge } from "../java-index/index-types.js";
import { javaEdgeId, javaFileId, javaMethodId, javaTypeId } from "../java-index/stable-id.js";
import { KnowledgeGraphBuilder } from "./graph-builder.js";
import { openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { reachableFiles } from "./graph-walk.js";

function sqlGraph() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return new SqlKnowledgeGraph(db);
}

const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 8, column: 2 } };

function typeBundle(simpleName: string, kind: JavaTypeFacts["kind"], methods: string[], extras: Partial<JavaTypeFacts> = {}): JavaFileBundle {
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
    kind,
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
    confidence: 1,
    ...extras
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

function calls(from: JavaFileBundle, to: JavaFileBundle): StaticEdge {
  const fromMethod = from.methods[0]!;
  const toMethod = to.methods[0]!;
  return {
    edgeId: javaEdgeId({ kind: "CALLS", fromId: fromMethod.methodId, toId: toMethod.methodId, range: RANGE }),
    fromId: fromMethod.methodId,
    toId: toMethod.methodId,
    kind: "CALLS",
    confidence: 0.9,
    range: RANGE,
    sourceFile: from.file.relativePath,
    generation: 1,
    resolution: { kind: "DECLARED_RECEIVER_NAME_ARITY" }
  };
}

test("unique class call becomes CALLS_EXACT and materializes CALLED_BY", () => {
  const caller = typeBundle("Caller", "class", ["run"]);
  const target = typeBundle("Service", "class", ["save"]);
  caller.edges = [calls(caller, target)];
  const index = new JavaIndexStore();
  index.replaceFile(target);
  index.replaceFile(caller);
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index, 1);
  const callerMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("#run#"));
  const serviceMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("#save#"));
  assert.ok(callerMethod && serviceMethod);
  assert.ok(graph.successors(callerMethod, "CALLS_EXACT").some(edge => edge.toId === serviceMethod));
  assert.ok(graph.predecessors(callerMethod, "CALLED_BY").some(edge => edge.fromId === serviceMethod));
});

test("interface call emits CALLS_VIRTUAL plus DISPATCHES_TO each implementer", () => {
  const port = typeBundle("Port", "interface", ["save"]);
  const impl = typeBundle("PortImpl", "class", ["save"]);
  const caller = typeBundle("Caller", "class", ["run"]);
  impl.edges = [{
    edgeId: javaEdgeId({ kind: "IMPLEMENTS", fromId: impl.types[0]!.typeId, toId: port.types[0]!.typeId, range: RANGE }),
    fromId: impl.types[0]!.typeId,
    toId: port.types[0]!.typeId,
    kind: "IMPLEMENTS",
    confidence: 1,
    range: RANGE,
    sourceFile: impl.file.relativePath,
    generation: 1,
    resolution: { kind: "TYPE_REFERENCE" }
  }];
  caller.edges = [calls(caller, port)];
  const index = new JavaIndexStore();
  index.replaceFile(port);
  index.replaceFile(impl);
  index.replaceFile(caller);
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index, 1);
  const callerMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("Caller.java") && id.includes("#run#"))!;
  const portMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("Port.java") && id.includes("#save#"))!;
  const implMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("PortImpl.java") && id.includes("#save#"))!;
  assert.ok(graph.successors(callerMethod, "CALLS_VIRTUAL").some(edge => edge.toId === portMethod));
  assert.ok(graph.successors(portMethod, "DISPATCHES_TO").some(edge => edge.toId === implMethod));
});

test("removing a call edge leaves no stale CALLS_EXACT", () => {
  const caller = typeBundle("Caller", "class", ["run"]);
  const target = typeBundle("Service", "class", ["save"]);
  caller.edges = [calls(caller, target)];
  const index = new JavaIndexStore();
  index.replaceFile(target);
  index.replaceFile(caller);
  const graph = sqlGraph();
  const builder = new KnowledgeGraphBuilder(graph);
  builder.rebuildFromStore(index, 1);
  const cleaned = typeBundle("Caller", "class", ["run"]);
  index.replaceFile(cleaned);
  builder.replaceFile(cleaned, index, 2);
  const callerMethod = [...graph.nodesById.entries()].map(([id]) => id).find(id => id.includes("Caller.java") && id.includes("#run#"))!;
  assert.equal(graph.successors(callerMethod, "CALLS_EXACT").length, 0);
});

test("undirected walk reaches a callee file in one hop", () => {
  const caller = typeBundle("Caller", "class", ["run"]);
  const target = typeBundle("Service", "class", ["save"]);
  caller.edges = [calls(caller, target)];
  const index = new JavaIndexStore();
  index.replaceFile(target);
  index.replaceFile(caller);
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index, 1);
  const reached = reachableFiles(graph, caller.file.relativePath, 3);
  assert.equal(reached.hops[target.file.relativePath], 1);
});
