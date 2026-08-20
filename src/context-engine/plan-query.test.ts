import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { knowledgeEdgeId } from "../java-knowledge/entity-id.js";
import { compileIntent } from "./intent-compiler.js";
import { searchContextGraph, type GraphSearchResult } from "./graph-search.js";
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
  methods?: Array<{ name: string; start: number; end: number; calls?: Array<{ name: string; receiver: string; typeId?: string }> }>;
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
        receiverDeclaredType: call.typeId ? repoRef(call.receiver, call.typeId) : undefined,
        arity: 0,
        argumentTypeHints: [],
        range: { start: { line: method.start + 1, column: 1 }, end: { line: method.start + 1, column: 8 } }
      })),
      localTypes: []
    };
  });
  return { file, types: [type], fields, methods, edges: [] };
}

function emptySearch(path = "src/Service.java"): GraphSearchResult {
  return {
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    coverage: "PARTIAL",
    bundles: [{ path, hops: 0, estimatedTokens: 40, provingPath: [], closedObligations: ["O1"] }],
    unresolved: [],
    metrics: { expansions: 0, hops: 0, estimatedTokens: 40 }
  };
}

test("attachAnchorSignatureBundles names field callees and does not walk unused hop-1 fields", () => {
  const generator = fileBundle("Generator", { methods: [{ name: "generate", start: 4, end: 8 }] });
  const helper = fileBundle("Helper", { methods: [{ name: "getMe", start: 4, end: 8 }] });
  const other = fileBundle("Other", { methods: [{ name: "unused", start: 4, end: 8 }] });
  const unused = fileBundle("Unused", { fields: [{ name: "other", typeId: other.types[0]!.typeId, simpleName: "Other" }] });
  const collab = fileBundle("Collab", {
    methods: [{
      name: "requireMe",
      start: 4,
      end: 8,
      calls: [{ name: "getMe", receiver: "helper", typeId: helper.types[0]!.typeId }]
    }],
    fields: [{ name: "helper", typeId: helper.types[0]!.typeId, simpleName: "Helper" }]
  });
  const service = fileBundle("Service", {
    methods: [{
      name: "run",
      start: 10,
      end: 16,
      calls: [
        { name: "generate", receiver: "generator", typeId: generator.types[0]!.typeId },
        { name: "requireMe", receiver: "collab", typeId: collab.types[0]!.typeId }
      ]
    }],
    fields: [
      { name: "generator", typeId: generator.types[0]!.typeId, simpleName: "Generator" },
      { name: "collab", typeId: collab.types[0]!.typeId, simpleName: "Collab" },
      { name: "unused", typeId: unused.types[0]!.typeId, simpleName: "Unused" }
    ]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(collab);
  store.replaceFile(generator);
  store.replaceFile(helper);
  store.replaceFile(unused);
  store.replaceFile(other);
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const paths = attached.bundles.map(item => item.path).sort();
  assert.ok(paths.includes("src/Generator.java"), `missing callee, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/Collab.java"), `missing hop-1 callee, got ${paths.join(",")}`);
  assert.equal(paths.includes("src/Other.java"), false, `unused hop-1 field leaked: ${paths.join(",")}`);
  const generatorBundle = attached.bundles.find(item => item.path === "src/Generator.java");
  assert.ok(generatorBundle?.provingPath.some(step => step.toId.includes("#generate#")), JSON.stringify(generatorBundle?.provingPath));
  const collabBundle = attached.bundles.find(item => item.path === "src/Collab.java");
  assert.ok(collabBundle?.provingPath.some(step => step.toId.includes("#requireMe#")), JSON.stringify(collabBundle?.provingPath));
});

test("attachAnchorSignatureBundles follows same-file private callees onto hop-1 receivers", () => {
  const school = fileBundle("School", { methods: [{ name: "listStudents", start: 4, end: 8 }] });
  const service = fileBundle("Service", {
    methods: [
      { name: "export", start: 10, end: 16, calls: [{ name: "loadMap", receiver: "this" }] },
      {
        name: "loadMap",
        start: 20,
        end: 28,
        calls: [{ name: "listStudents", receiver: "school", typeId: school.types[0]!.typeId }]
      }
    ],
    fields: [{ name: "school", typeId: school.types[0]!.typeId, simpleName: "School" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(school);
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const schoolBundle = attached.bundles.find(item => item.path === "src/School.java");
  assert.ok(schoolBundle, `missing hop-1 receiver, got ${attached.bundles.map(item => item.path).join(",")}`);
  assert.ok(schoolBundle?.provingPath.some(step => step.toId.includes("#listStudents#")), JSON.stringify(schoolBundle?.provingPath));
});

test("attachAnchorSignatureBundles copies callee names onto implementers and existing bundles", () => {
  const port = fileBundle("Generator", { methods: [{ name: "generate", start: 4, end: 4 }] });
  const impl = fileBundle("Excel", { methods: [{ name: "generate", start: 10, end: 40 }] });
  impl.types[0]!.implements.push(repoRef("Generator", port.types[0]!.typeId));
  const service = fileBundle("Service", {
    methods: [{
      name: "export",
      start: 10,
      end: 16,
      calls: [{ name: "generate", receiver: "generator", typeId: port.types[0]!.typeId }]
    }],
    fields: [{ name: "generator", typeId: port.types[0]!.typeId, simpleName: "Generator" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(port);
  store.replaceFile(impl);
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const search = emptySearch();
  search.bundles.push({
    path: "src/Excel.java",
    hops: 1,
    estimatedTokens: 40,
    provingPath: [{ kind: "IMPLEMENTS" as const, fromId: "src/Service.java", toId: "src/Excel.java#Excel" }],
    closedObligations: []
  });
  const attached = attachAnchorSignatureBundles(search, graph, store, "src/Service.java", 12);
  const excel = attached.bundles.filter(item => item.path === "src/Excel.java");
  assert.equal(excel.length, 1);
  assert.ok(excel[0]?.provingPath.some(step => step.toId.includes("#generate#")), JSON.stringify(excel[0]?.provingPath));
});
