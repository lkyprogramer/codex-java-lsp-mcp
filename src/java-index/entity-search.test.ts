import assert from "node:assert/strict";
import test from "node:test";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange } from "./index-types.js";
import {
  extractFqnCandidates,
  recordsFromBundle,
  splitIdentifier,
  tokenize,
  type EntityRecord
} from "./entity-search.js";
import { searchEntities } from "../test-support/entity-search-oracle.js";
import { javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 8, column: 2 } };

function record(overrides: Partial<EntityRecord> & Pick<EntityRecord, "entityId" | "simpleName" | "fqn" | "relativePath">): EntityRecord {
  return {
    kind: "type",
    identifierTokens: tokenize(overrides.simpleName),
    chunkTokens: [],
    ...overrides
  };
}

test("splitIdentifier breaks camelCase and snake_case without a scene word list", () => {
  assert.deepEqual(splitIdentifier("getSignedUrl"), ["get", "signed", "url"]);
  assert.deepEqual(splitIdentifier("StorageGateway"), ["storage", "gateway"]);
  assert.deepEqual(splitIdentifier("signed_url"), ["signed", "url"]);
  assert.deepEqual(splitIdentifier("XMLParser"), ["xml", "parser"]);
});

test("tokenize passes CJK runs through and emits bigrams", () => {
  const tokens = tokenize("修改支付订单准入逻辑");
  assert.ok(tokens.includes("修改支付订单准入逻辑"));
  assert.ok(tokens.includes("支付"));
  assert.ok(tokens.includes("准入"));
});

test("tokenize keeps ASCII identifier pieces from a mixed task", () => {
  const tokens = tokenize("storage signed url report");
  assert.deepEqual(tokens.sort(), ["report", "signed", "storage", "url"]);
});

test("four-layer fallback: FQN exact match beats simpleName", () => {
  const entities = [
    record({
      entityId: "type:demo.other.Pay",
      simpleName: "Pay",
      fqn: "demo.other.Pay",
      relativePath: "src/other/Pay.java"
    }),
    record({
      entityId: "type:demo.pay.ApplyPayService",
      simpleName: "ApplyPayService",
      fqn: "demo.pay.ApplyPayService",
      relativePath: "src/pay/ApplyPayService.java"
    })
  ];
  const hits = searchEntities(entities, "please open demo.pay.ApplyPayService for the Pay flow", 3);
  assert.equal(hits[0]?.layer, "FQN");
  assert.equal(hits[0]?.fqn, "demo.pay.ApplyPayService");
  assert.equal(hits.every(hit => hit.layer === "FQN"), true);
});

test("four-layer fallback: unique simpleName beats identifier BM25", () => {
  const entities = [
    record({
      entityId: "type:demo.StorageGateway",
      simpleName: "StorageGateway",
      fqn: "demo.StorageGateway",
      relativePath: "src/StorageGateway.java",
      identifierTokens: tokenize("StorageGateway")
    }),
    record({
      entityId: "type:demo.Unrelated",
      simpleName: "Unrelated",
      fqn: "demo.Unrelated",
      relativePath: "src/Unrelated.java",
      identifierTokens: tokenize("storage signed url Unrelated")
    })
  ];
  const hits = searchEntities(entities, "StorageGateway storage signed url", 3);
  assert.equal(hits[0]?.layer, "SIMPLE_NAME");
  assert.equal(hits[0]?.simpleName, "StorageGateway");
});

test("simpleName dictionary ignores camelCase fragments", () => {
  const entities = [
    record({
      entityId: "type:demo.Order",
      simpleName: "Order",
      fqn: "demo.Order",
      relativePath: "src/Order.java",
      identifierTokens: tokenize("Order")
    }),
    record({
      entityId: "type:demo.OrderController",
      simpleName: "OrderController",
      fqn: "demo.OrderController",
      relativePath: "src/OrderController.java",
      identifierTokens: tokenize("OrderController createPayOrder")
    })
  ];
  const hits = searchEntities(entities, "OrderController createPayOrder payment admission", 3);
  assert.equal(hits[0]?.layer, "SIMPLE_NAME");
  assert.equal(hits[0]?.simpleName, "OrderController");
  assert.equal(hits.some(hit => hit.simpleName === "Order" && hit.layer === "SIMPLE_NAME"), false);
});

test("simpleName dictionary is type-only and prefers the longer exact name", () => {
  const entities = [
    record({
      entityId: "method:report",
      kind: "method",
      simpleName: "report",
      fqn: "demo.Repo#report",
      relativePath: "src/Repo.java"
    }),
    record({
      entityId: "type:demo.ReportBatchExportTaskRepository",
      simpleName: "ReportBatchExportTaskRepository",
      fqn: "demo.ReportBatchExportTaskRepository",
      relativePath: "src/ReportBatchExportTaskRepository.java"
    }),
    record({
      entityId: "type:demo.Order",
      simpleName: "Order",
      fqn: "demo.Order",
      relativePath: "src/Order.java"
    }),
    record({
      entityId: "type:demo.OrderController",
      simpleName: "OrderController",
      fqn: "demo.OrderController",
      relativePath: "src/OrderController.java"
    })
  ];
  const repoHits = searchEntities(entities, "ReportBatchExportTaskRepository findReusableReadyZip report batch", 3);
  assert.equal(repoHits[0]?.simpleName, "ReportBatchExportTaskRepository");
  assert.equal(repoHits[0]?.layer, "SIMPLE_NAME");
  const orderHits = searchEntities(entities, "OrderController createPayOrder payment order", 3);
  assert.equal(orderHits[0]?.simpleName, "OrderController");
});

test("four-layer fallback: identifier BM25 beats chunk tokens", () => {
  const entities = [
    record({
      entityId: "type:demo.StorageGateway",
      simpleName: "StorageGateway",
      fqn: "demo.StorageGateway",
      relativePath: "src/StorageGateway.java",
      identifierTokens: tokenize("StorageGateway"),
      chunkTokens: tokenize("unrelated body")
    }),
    record({
      entityId: "type:demo.Other",
      simpleName: "Other",
      fqn: "demo.Other",
      relativePath: "src/Other.java",
      identifierTokens: tokenize("Other"),
      chunkTokens: tokenize("storage signed url")
    })
  ];
  const hits = searchEntities(entities, "storage signed url", 3);
  assert.equal(hits[0]?.layer, "BM25_IDENTIFIER");
  assert.equal(hits[0]?.simpleName, "StorageGateway");
});

test("four-layer fallback: chunk inverted index is used when identifiers miss", () => {
  const entities = [
    record({
      entityId: "method:save",
      kind: "method",
      simpleName: "persistOrder",
      fqn: "demo.Repo#persistOrder",
      relativePath: "src/Repo.java",
      identifierTokens: tokenize("persistOrder"),
      chunkTokens: tokenize("insert PayAccount mapper")
    }),
    record({
      entityId: "type:demo.Unrelated",
      simpleName: "Unrelated",
      fqn: "demo.Unrelated",
      relativePath: "src/Unrelated.java",
      identifierTokens: tokenize("Unrelated"),
      chunkTokens: tokenize("widget")
    })
  ];
  const hits = searchEntities(entities, "PayAccount mapper insert", 3);
  assert.equal(hits[0]?.layer, "CHUNK");
  assert.equal(hits[0]?.simpleName, "persistOrder");
});

test("extractFqnCandidates finds dotted and Type#method forms", () => {
  assert.deepEqual(
    extractFqnCandidates("see com.lishu.edu.StorageGateway#getSignedUrl today").sort(),
    ["StorageGateway#getSignedUrl", "com.lishu.edu.StorageGateway#getSignedUrl"].sort()
  );
});

test("recordsFromBundle plus searchEntities ranks a file bundle", () => {
  const relativePath = "src/main/java/demo/StorageGateway.java";
  const file: JavaFileFacts = {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src/main/java",
    module: ".",
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
  const typeId = javaTypeId({ fqn: "demo.StorageGateway", relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: "demo.StorageGateway",
    simpleName: "StorageGateway",
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
  const methodId = javaMethodId(typeId, "getSignedUrl()");
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: typeId,
    name: "getSignedUrl",
    constructor: false,
    signatureKey: "getSignedUrl()",
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [{
      kind: "METHOD_INVOCATION",
      name: "sign",
      arity: 1,
      argumentTypeHints: [],
      range: RANGE
    }],
    localTypes: []
  };
  type.methodIds.push(methodId);
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  const bundle: JavaFileBundle = { file, types: [type], fields: [], methods: [method], edges: [] };

  const records = recordsFromBundle(bundle);
  const hits = searchEntities(records, "storage signed url", 3);
  assert.ok(hits.some(hit => hit.relativePath === relativePath));
  assert.ok(hits[0]?.layer === "BM25_IDENTIFIER" || hits[0]?.layer === "SIMPLE_NAME");
  assert.deepEqual(searchEntities(records, "demo.StorageGateway", 1)[0]?.layer, "FQN");
});
