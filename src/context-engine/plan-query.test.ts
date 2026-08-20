import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { knowledgeEdgeId } from "../java-knowledge/entity-id.js";
import { compileIntent } from "./intent-compiler.js";
import { searchContextGraph } from "./graph-search.js";
import { attachAnchorSignatureBundles, planContextQuery } from "./plan-query.js";
import { JavaIndexStore } from "../java-index/index-store.js";
import type { JavaFileBundle, JavaFileFacts, JavaFieldFacts, JavaMethodFacts, JavaTypeFacts, JavaTypeRef, SourceRange } from "../java-index/index-types.js";
import { javaFieldId, javaFileId, javaMethodId, javaTypeId } from "../java-index/stable-id.js";
import { PLANNER_VERSION, StaleSessionError, contextSessions } from "./context-contract.js";

function seed(): KnowledgeGraphStore {
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  graph.upsertNode({ id: "src/A.java#A#run#1", kind: "METHOD", generation: 1, relativePath: "src/A.java", simpleName: "run" }, "src/A.java");
  graph.upsertNode({ id: "src/B.java", kind: "FILE", generation: 1, relativePath: "src/B.java" }, "src/B.java");
  graph.upsertNode({ id: "src/B.java#B#save#1", kind: "METHOD", generation: 1, relativePath: "src/B.java", simpleName: "save" }, "src/B.java");
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CALLS_EXACT", fromId: "src/A.java#A#run#1", toId: "src/B.java#B#save#1" }),
    kind: "CALLS_EXACT",
    fromId: "src/A.java#A#run#1",
    toId: "src/B.java#B#save#1",
    generation: 1,
    sourceFile: "src/A.java"
  }, "src/A.java");
  return graph;
}

test("planContextQuery returns a contract without scores and fail-closes a stale session", () => {
  const graph = seed();
  const search = searchContextGraph(graph, "src/A.java", compileIntent("IMPLEMENTATION_CHANGE"), { maxHops: 2, maxExpansions: 16 });
  const contract = planContextQuery({ graph, search, tokenBudget: 400, generation: 4, serviceMs: 9 });
  assert.equal(contract.version, 1);
  assert.equal(contract.resolvedIntent, "IMPLEMENTATION_CHANGE");
  assert.ok(contract.contexts.length >= 1);
  assert.equal(JSON.stringify(contract).includes("confidence"), false);
  const session = { sessionId: "s-plan", generation: 4, repoHash: "r", plannerVersion: PLANNER_VERSION };
  const first = planContextQuery({ graph, search, tokenBudget: 400, generation: 4, session });
  contextSessions.save(session, { ...first, coverage: "COMPLETE" });
  assert.throws(
    () => planContextQuery({ graph, search, tokenBudget: 400, generation: 4, session: { ...session, generation: 9 } }),
    StaleSessionError
  );
});

const RANGE: SourceRange = { start: { line: 1, column: 1 }, end: { line: 20, column: 2 } };

function repoRef(simpleName: string, typeId: string): JavaTypeRef {
  return {
    text: simpleName,
    simpleName,
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId, strategy: "QUALIFIED" }
  };
}

function fileBundle(simpleName: string, options: {
  methods?: Array<{ name: string; start: number; end: number; calls?: Array<{ name: string; receiver: string; typeId: string }> }>;
  fields?: Array<{ name: string; typeId: string; simpleName: string }>;
}): JavaFileBundle {
  const relativePath = `src/${simpleName}.java`;
  const file: JavaFileFacts = {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src",
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
  const fields: JavaFieldFacts[] = (options.fields ?? []).map(field => {
    const fieldId = javaFieldId(typeId, field.name);
    type.fieldIds.push(fieldId);
    return {
      fieldId,
      ownerTypeId: typeId,
      name: field.name,
      type: repoRef(field.simpleName, field.typeId),
      modifiers: ["private"],
      annotations: [],
      range: RANGE
    };
  });
  const methods: JavaMethodFacts[] = (options.methods ?? []).map(method => {
    const methodId = javaMethodId(typeId, `${method.name}()`);
    type.methodIds.push(methodId);
    return {
      methodId,
      ownerTypeId: typeId,
      name: method.name,
      constructor: false,
      signatureKey: `${method.name}()`,
      range: { start: { line: method.start, column: 1 }, end: { line: method.end, column: 2 } },
      modifiers: ["public"],
      annotations: [],
      typeParameters: [],
      parameters: [],
      throws: [],
      callSites: (method.calls ?? []).map(call => ({
        kind: "METHOD_INVOCATION" as const,
        name: call.name,
        receiverText: call.receiver,
        receiverDeclaredType: repoRef(call.receiver, call.typeId),
        arity: 0,
        argumentTypeHints: [],
        range: { start: { line: method.start + 1, column: 1 }, end: { line: method.start + 1, column: 8 } }
      })),
      localTypes: []
    };
  });
  return { file, types: [type], fields, methods, edges: [] };
}

test("attachAnchorSignatureBundles adds method-body callees and hop-2 field types", () => {
  const generator = fileBundle("Generator", { methods: [{ name: "generate", start: 4, end: 8 }] });
  const helper = fileBundle("Helper", { methods: [{ name: "getMe", start: 4, end: 8 }] });
  const collab = fileBundle("Collab", {
    methods: [{ name: "requireMe", start: 4, end: 8 }],
    fields: [{ name: "helper", typeId: helper.types[0]!.typeId, simpleName: "Helper" }]
  });
  const service = fileBundle("Service", {
    methods: [{
      name: "run",
      start: 10,
      end: 16,
      calls: [{ name: "generate", receiver: "generator", typeId: generator.types[0]!.typeId }]
    }],
    fields: [
      { name: "generator", typeId: generator.types[0]!.typeId, simpleName: "Generator" },
      { name: "collab", typeId: collab.types[0]!.typeId, simpleName: "Collab" }
    ]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(collab);
  store.replaceFile(generator);
  store.replaceFile(helper);
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const search = {
    resolvedIntent: "IMPLEMENTATION_CHANGE" as const,
    coverage: "PARTIAL" as const,
    bundles: [{ path: "src/Service.java", hops: 0, estimatedTokens: 40, provingPath: [], closedObligations: ["O1"] }],
    unresolved: [],
    metrics: { expansions: 0, hops: 0, estimatedTokens: 40 }
  };
  const attached = attachAnchorSignatureBundles(search, graph, store, "src/Service.java", 12);
  const paths = attached.bundles.map(item => item.path).sort();
  assert.ok(paths.includes("src/Generator.java"), `missing callee, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/Collab.java"), `missing hop-1 field, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/Helper.java"), `missing hop-2 field, got ${paths.join(",")}`);
  const generatorBundle = attached.bundles.find(item => item.path === "src/Generator.java");
  assert.ok(generatorBundle?.provingPath.some(step => step.toId.includes("#generate#")), JSON.stringify(generatorBundle?.provingPath));
});
