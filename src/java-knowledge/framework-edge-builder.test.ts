import assert from "node:assert/strict";
import test from "node:test";
import { openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, JavaTypeRef, SourceRange } from "../java-index/index-types.js";
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



function allSqlEdges(graph: { nodesById: { entries(): Iterable<[string, unknown]> }; successors(id: string): Array<{ kind: string; toId?: string; fromId?: string }> }) {
  const edges: Array<{ kind: string; toId?: string; fromId?: string }> = [];
  for (const [id] of graph.nodesById.entries()) edges.push(...graph.successors(id));
  return edges;
}


const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 8, column: 2 } };

function external(name: string): JavaTypeRef {
  return {
    text: name,
    simpleName: name.split(".").pop() ?? name,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "EXTERNAL", qualifiedName: name, strategy: "QUALIFIED" }
  };
}

function repoType(typeId: string, simpleName: string): JavaTypeRef {
  return {
    text: simpleName,
    simpleName,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId, strategy: "SAME_PACKAGE" }
  };
}

function serviceBundle(): JavaFileBundle {
  const relativePath = "src/main/java/demo/AppService.java";
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
  const typeId = javaTypeId({ fqn: "demo.AppService", relativePath, range: RANGE });
  const gatewayId = javaTypeId({ fqn: "demo.Gateway", relativePath: "src/main/java/demo/Gateway.java", range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.AppService",
    simpleName: "AppService",
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [{ name: "Service", range: RANGE }],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  const ctorId = javaMethodId(typeId, "AppService(demo.Gateway)");
  type.methodIds.push(ctorId);
  const ctor: JavaMethodFacts = {
    methodId: ctorId,
    ownerTypeId: typeId,
    name: "AppService",
    constructor: true,
    signatureKey: "AppService(demo.Gateway)",
    range: RANGE,
    modifiers: ["public"],
    annotations: [{ name: "Autowired", qualifiedName: "org.springframework.beans.factory.annotation.Autowired", range: RANGE }],
    typeParameters: [],
    parameters: [{
      name: "gateway",
      type: repoType(gatewayId, "Gateway"),
      varargs: false,
      annotations: [],
      range: RANGE
    }],
    throws: [],
    callSites: [{
      kind: "METHOD_INVOCATION",
      name: "publishEvent",
      arity: 1,
      receiverText: "publisher",
      receiverDeclaredType: external("org.springframework.context.ApplicationEventPublisher"),
      argumentTypeHints: [external("demo.Created")],
      range: RANGE
    }],
    localTypes: []
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  return { file, types: [type], fields: [], methods: [ctor], edges: [] };
}

function gatewayBundle(): JavaFileBundle {
  const relativePath = "src/main/java/demo/Gateway.java";
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
  const typeId = javaTypeId({ fqn: "demo.Gateway", relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.Gateway",
    simpleName: "Gateway",
    kind: "interface",
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
  return { file, types: [type], fields: [], methods: [], edges: [] };
}

test("Autowired constructor parameter emits SPRING_INJECTS and publishEvent emits PUBLISHES_EVENT", () => {
  const index = new MemoryFacts();
  index.replaceFile(gatewayBundle());
  index.replaceFile(serviceBundle());
  const graph = sqlGraph();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index.store, 1);
  const inject = allSqlEdges(graph).filter(edge => edge.kind === "SPRING_INJECTS");
  const published = allSqlEdges(graph).filter(edge => edge.kind === "PUBLISHES_EVENT");
  assert.equal(inject.length, 1);
  assert.equal(published.length, 1);
  assert.ok(published[0]?.toId?.includes("Created") || published[0]?.toId?.startsWith("ext:"));
});
