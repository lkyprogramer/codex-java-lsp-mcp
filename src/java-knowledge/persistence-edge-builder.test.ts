import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexStore } from "../java-index/index-store.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, JavaTypeRef, SourceRange } from "../java-index/index-types.js";
import { myBatisResourceId, myBatisStatementId } from "../java-index/mybatis-types.js";
import { javaFileId, javaMethodId, javaTypeId } from "../java-index/stable-id.js";
import { KnowledgeGraphBuilder } from "./graph-builder.js";
import { KnowledgeGraphStore } from "./graph-store.js";

const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 8, column: 2 } };

function mapperBundle(): JavaFileBundle {
  const relativePath = "src/main/java/demo/OrderMapper.java";
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
  const typeId = javaTypeId({ fqn: "demo.OrderMapper", relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.OrderMapper",
    simpleName: "OrderMapper",
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
  const methodId = javaMethodId(typeId, "findById()");
  type.methodIds.push(methodId);
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: typeId,
    name: "findById",
    constructor: false,
    signatureKey: "findById()",
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  return { file, types: [type], fields: [], methods: [method], edges: [] };
}

function entityBundle(): JavaFileBundle {
  const relativePath = "src/main/java/demo/Order.java";
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
  const typeId = javaTypeId({ fqn: "demo.Order", relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.Order",
    simpleName: "Order",
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [{ name: "Entity", range: RANGE }],
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

function templateBundle(entityTypeId: string): JavaFileBundle {
  const relativePath = "src/main/java/demo/OrderTemplate.java";
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
  const typeId = javaTypeId({ fqn: "demo.OrderTemplate", relativePath, range: RANGE });
  const entityArg: JavaTypeRef = {
    text: "Order",
    simpleName: "Order",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId: entityTypeId, strategy: "SAME_PACKAGE" }
  };
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.OrderTemplate",
    simpleName: "OrderTemplate",
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [{
      text: "BaseTemplate<Order>",
      simpleName: "BaseTemplate",
      typeArguments: [entityArg],
      arrayDepth: 0,
      resolution: { state: "UNRESOLVED" }
    }],
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

test("mapper method binds the XML statement and statement uses the entity", () => {
  const mapper = mapperBundle();
  const entity = entityBundle();
  const index = new JavaIndexStore();
  index.replaceFile(entity);
  index.replaceFile(mapper);
  index.replaceMyBatisResource({
    resourceId: myBatisResourceId("src/main/resources/mapper/OrderMapper.xml"),
    relativePath: "src/main/resources/mapper/OrderMapper.xml",
    namespace: "demo.OrderMapper",
    statements: [{
      statementId: myBatisStatementId("demo.OrderMapper", "findById"),
      namespace: "demo.OrderMapper",
      id: "findById",
      kind: "select",
      resultType: "demo.Order"
    }],
    resultMaps: [],
    includes: [],
    contentHash: "x",
    generation: 1,
    parseState: "COMPLETE"
  });
  const graph = new KnowledgeGraphStore();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index, 1);
  const binds = [...graph.edgesById.values()].filter(edge => edge.kind === "MYBATIS_METHOD_BINDS_STATEMENT");
  const uses = [...graph.edgesById.values()].filter(edge => edge.kind === "MYBATIS_STATEMENT_USES_ENTITY");
  assert.equal(binds.length, 1);
  assert.equal(uses.length, 1);
});

test("Template suffix plus generic argument emits REPOSITORY_MANAGES_ENTITY", () => {
  const entity = entityBundle();
  const template = templateBundle(entity.types[0]!.typeId);
  const index = new JavaIndexStore();
  index.replaceFile(entity);
  index.replaceFile(template);
  const graph = new KnowledgeGraphStore();
  new KnowledgeGraphBuilder(graph).rebuildFromStore(index, 1);
  const managed = [...graph.edgesById.values()].filter(edge => edge.kind === "REPOSITORY_MANAGES_ENTITY");
  assert.equal(managed.length, 1);
  assert.ok(managed[0]?.toId.includes("Order"));
});
