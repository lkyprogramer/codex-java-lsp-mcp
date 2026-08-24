import assert from "node:assert/strict";
import test from "node:test";
import type { AnchorFacts, JavaMethodFacts, JavaTypeFacts, JavaTypeRef } from "./index-types.js";
import { anchorToSourceFacts, methodToFact, typeFactsToSourceFacts } from "./router-facts.js";

const range = {
  start: { line: 10, column: 1 },
  end: { line: 10, column: 20 }
};

function repoRef(name: string, typeId: string): JavaTypeRef {
  return {
    text: name,
    simpleName: name,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId, strategy: "EXPLICIT_IMPORT" },
    range
  };
}

test("method facts retain a repository-resolved generic return argument as a return relation", () => {
  const responseTypeId = "type:demo.ConfirmResponse";
  const response = repoRef("ConfirmResponse", responseTypeId);
  const method: JavaMethodFacts = {
    methodId: "method:demo.ConfirmController.confirm",
    ownerTypeId: "type:demo.ConfirmController",
    name: "confirm",
    constructor: false,
    signatureKey: "confirm()",
    range,
    modifiers: [],
    annotations: [],
    typeParameters: [],
    returnType: {
      text: "ApiResponse<ConfirmResponse>",
      simpleName: "ApiResponse",
      typeArguments: [response],
      arrayDepth: 0,
      resolution: { state: "EXTERNAL", qualifiedName: "demo.ApiResponse", strategy: "EXPLICIT_IMPORT" },
      range
    },
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };

  const fact = methodToFact(method);
  assert.deepEqual(
    fact.relations.find(relation => relation.typeId === responseTypeId),
    {
      kind: "return",
      typeName: "ConfirmResponse",
      typeId: "type:demo.ConfirmResponse",
      line: 10,
      confidence: "high",
      source: "ast"
    }
  );
  assert.ok(fact.referencedTypes.includes("ConfirmResponse"));
});

test("lightweight type facts retain the declaration FQN", () => {
  const type: JavaTypeFacts = {
    typeId: "type:demo.OrderMapper",
    fqn: "demo.OrderMapper",
    simpleName: "OrderMapper",
    kind: "interface",
    fileId: "file:src/main/java/demo/OrderMapper.java",
    range,
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

  const fact = typeFactsToSourceFacts("/repo", type);
  assert.equal(fact.qualifiedName, "demo.OrderMapper");
  assert.equal(fact.typeStartLine, 10);
});

test("anchor source facts drop static imports from imports, since a static import's qualifiedName carries a member segment and is never a valid type FQN", () => {
  const anchor: AnchorFacts = {
    file: {
      fileId: "file:src/main/java/demo/Controller.java",
      relativePath: "src/main/java/demo/Controller.java",
      sourceRoot: "src/main/java",
      module: ".",
      sourceSet: "main",
      packageName: "demo",
      imports: [
        { qualifiedName: "demo.OrderMapper", wildcard: false, static: false, range },
        { qualifiedName: "demo.Constants.MAX_SIZE", wildcard: false, static: true, range },
        { qualifiedName: "demo.util.*", wildcard: true, static: false, range },
        { qualifiedName: "demo.Constants.*", wildcard: true, static: true, range }
      ],
      topLevelTypeIds: [],
      allTypeIds: [],
      contentHash: "hash",
      size: 0,
      mtimeMs: 0,
      parseState: "COMPLETE",
      parseErrorCount: 0,
      generation: 1
    },
    symbolId: "type:demo.Controller",
    symbolKind: "TYPE",
    symbolName: "Controller",
    range,
    coverage: "COMPLETE",
    confidence: 1
  };

  const facts = anchorToSourceFacts("/repo", anchor);
  assert.deepEqual(facts.imports, ["demo.OrderMapper"]);
  assert.deepEqual(facts.wildcardImports, ["demo.util", "demo.Constants"]);
});
