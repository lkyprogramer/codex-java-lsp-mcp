import assert from "node:assert/strict";
import test from "node:test";
import { openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { knowledgeEdgeId } from "../java-knowledge/entity-id.js";
import { compileIntent } from "./intent-compiler.js";
import { searchContextGraph, type GraphSearchResult } from "./graph-search.js";
import { attachAnchorSignatureBundles, factsForStore, planContextQuery } from "./plan-query.js";
import { JavaIndexStore } from "../java-index/index-store.js";
import type { JavaFileBundle, JavaFileFacts, JavaFieldFacts, JavaMethodFacts, JavaTypeFacts, JavaTypeRef, SourceRange } from "../java-index/index-types.js";
import { javaEdgeId, javaFieldId, javaFileId, javaMethodId, javaTypeId } from "../java-index/stable-id.js";
import { PLANNER_VERSION, StaleSessionError, contextSessions } from "./context-contract.js";

function sqlGraph() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return new SqlKnowledgeGraph(db);
}

function seed(): SqlKnowledgeGraph {
  const graph = sqlGraph();
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
  assert.equal(contract.version, 3);
  assert.ok(contract.evidence.length >= 1);
  assert.ok(contract.candidates.length >= 1);
  assert.equal(typeof contract.evidence[0]!.ranges, "string");
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
  module?: string;
  methods?: Array<{ name: string; start: number; end: number; calls?: Array<{ name: string; receiver?: string; typeId?: string }> }>;
  fields?: Array<{ name: string; typeId: string; simpleName: string }>;
}): JavaFileBundle {
  const relativePath = `src/${simpleName}.java`;
  const file: JavaFileFacts = {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src",
    module: options.module ?? "demo",
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
        ...(call.receiver ? { receiverText: call.receiver } : {}),
        receiverDeclaredType: call.typeId ? repoRef(call.receiver ?? call.name, call.typeId) : undefined,
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
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const paths = attached.bundles.map(item => item.path).sort();
  assert.ok(paths.includes("src/Generator.java"), `missing callee, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/Collab.java"), `missing hop-1 callee, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/Helper.java"), `missing hop-2 callee field, got ${paths.join(",")}`);
  assert.equal(paths.includes("src/Other.java"), false, `unused hop-1 field leaked: ${paths.join(",")}`);
  const generatorBundle = attached.bundles.find(item => item.path === "src/Generator.java");
  assert.ok(generatorBundle?.provingPath.some(step => step.toId.includes("#generate#")), JSON.stringify(generatorBundle?.provingPath));
  const collabBundle = attached.bundles.find(item => item.path === "src/Collab.java");
  assert.ok(collabBundle?.provingPath.some(step => step.toId.includes("#requireMe#")), JSON.stringify(collabBundle?.provingPath));
  const helperBundle = attached.bundles.find(item => item.path === "src/Helper.java");
  assert.ok(helperBundle?.provingPath.some(step => step.toId.includes("#getMe#")), JSON.stringify(helperBundle?.provingPath));
  assert.equal(helperBundle?.hops, 2);
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
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const schoolBundle = attached.bundles.find(item => item.path === "src/School.java");
  assert.ok(schoolBundle, `missing hop-1 receiver, got ${attached.bundles.map(item => item.path).join(",")}`);
  assert.ok(schoolBundle?.provingPath.some(step => step.toId.includes("#listStudents#")), JSON.stringify(schoolBundle?.provingPath));
});

test("attachAnchorSignatureBundles records every hop-0 call name on a field type", () => {
  const school = fileBundle("School", {
    methods: [
      { name: "listStudents", start: 4, end: 8 },
      { name: "listSummaries", start: 10, end: 16 }
    ]
  });
  const service = fileBundle("Service", {
    methods: [
      { name: "export", start: 10, end: 16, calls: [{ name: "loadMap", receiver: "this" }, { name: "resolve", receiver: "this" }] },
      { name: "loadMap", start: 20, end: 24, calls: [{ name: "listStudents", receiver: "school", typeId: school.types[0]!.typeId }] },
      { name: "resolve", start: 26, end: 30, calls: [{ name: "listSummaries", receiver: "school", typeId: school.types[0]!.typeId }] }
    ],
    fields: [{ name: "school", typeId: school.types[0]!.typeId, simpleName: "School" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(school);
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const schoolBundle = attached.bundles.find(item => item.path === "src/School.java");
  const ids = schoolBundle?.provingPath.map(step => step.toId).join(",") ?? "";
  assert.ok(ids.includes("#listStudents#"), ids);
  assert.ok(ids.includes("#listSummaries#"), ids);
});

test("attachAnchorSignatureBundles matches field-type methods without a receiverText", () => {
  const school = fileBundle("School", { methods: [{ name: "listStudents", start: 4, end: 8 }] });
  const service = fileBundle("Service", {
    methods: [
      { name: "export", start: 10, end: 16, calls: [{ name: "loadMap", receiver: "this" }] },
      { name: "loadMap", start: 20, end: 24, calls: [{ name: "listStudents" }] }
    ],
    fields: [{ name: "school", typeId: school.types[0]!.typeId, simpleName: "School" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(school);
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 12);
  const schoolBundle = attached.bundles.find(item => item.path === "src/School.java");
  assert.ok(schoolBundle?.provingPath.some(step => step.toId.includes("#listStudents#")), JSON.stringify(schoolBundle?.provingPath));
});

test("attachAnchorSignatureBundles copies callee names onto implementers and existing bundles", () => {
  const port = fileBundle("Generator", { methods: [{ name: "generate", start: 4, end: 4 }] });
  const impl = fileBundle("Excel", { methods: [{ name: "generate", start: 10, end: 40 }] });
  impl.types[0]!.implements.push(repoRef("Generator", port.types[0]!.typeId));
  const implTypeId = impl.types[0]!.typeId;
  const portTypeId = port.types[0]!.typeId;
  impl.edges.push({
    edgeId: javaEdgeId({ kind: "IMPLEMENTS", fromId: implTypeId, toId: portTypeId }),
    fromId: implTypeId,
    toId: portTypeId,
    kind: "IMPLEMENTS",
    confidence: 1,
    sourceFile: impl.file.relativePath,
    generation: 1,
    resolution: { kind: "TYPE_REFERENCE", typeStrategy: "QUALIFIED" }
  });
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
  const graph = sqlGraph();
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

test("attachAnchorSignatureBundles hop-2 matches callee field methods without receiverText", () => {
  const helper = fileBundle("Helper", { methods: [{ name: "getMe", start: 84, end: 93 }] });
  const collab = fileBundle("Collab", {
    methods: [{ name: "requireMe", start: 4, end: 8, calls: [{ name: "getMe" }] }],
    fields: [{ name: "helper", typeId: helper.types[0]!.typeId, simpleName: "Helper" }]
  });
  const service = fileBundle("Service", {
    methods: [{
      name: "claim",
      start: 28,
      end: 43,
      calls: [{ name: "requireMe", receiver: "collab", typeId: collab.types[0]!.typeId }]
    }],
    fields: [{ name: "collab", typeId: collab.types[0]!.typeId, simpleName: "Collab" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(collab);
  store.replaceFile(helper);
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Service.java", kind: "FILE", generation: 1, relativePath: "src/Service.java" }, "src/Service.java");
  const attached = attachAnchorSignatureBundles(emptySearch(), graph, store, "src/Service.java", 30);
  const helperBundle = attached.bundles.find(item => item.path === "src/Helper.java");
  assert.ok(helperBundle, `missing hop-2, got ${attached.bundles.map(item => item.path).join(",")}`);
  assert.ok(helperBundle?.provingPath.some(step => step.toId.includes("#getMe#")), JSON.stringify(helperBundle?.provingPath));
  assert.equal(helperBundle?.hops, 2);
});

test("hop0 keeps field-calling callees and not unrelated same-file helpers", () => {
  const school = fileBundle("School", { methods: [{ name: "listStudents", start: 4, end: 8 }] });
  const service = fileBundle("Service", {
    methods: [
      { name: "export", start: 55, end: 84, calls: [{ name: "loadMap", receiver: "this" }, { name: "buildName", receiver: "this" }] },
      { name: "loadMap", start: 95, end: 107, calls: [{ name: "listStudents", receiver: "school", typeId: school.types[0]!.typeId }] },
      { name: "buildName", start: 156, end: 160, calls: [{ name: "safeSegment", receiver: "this" }] },
      { name: "safeSegment", start: 162, end: 168 }
    ],
    fields: [{ name: "school", typeId: school.types[0]!.typeId, simpleName: "School" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  const graph = sqlGraph();
  const facts = factsForStore(graph, store, "src/Service.java", new Set(), 60);
  const names = new Set(facts.methods.map(method => method.name));
  assert.ok(names.has("export"), [...names].join(","));
  assert.ok(names.has("loadMap"), [...names].join(","));
  assert.equal(names.has("safeSegment"), false, [...names].join(","));
});

test("hop0 prefers two cross-module field callees over nearer same-module helpers", () => {
  const school = fileBundle("School", {
    module: "school",
    methods: [
      { name: "listStudents", start: 4, end: 8 },
      { name: "listSummaries", start: 10, end: 16 }
    ]
  });
  const items = fileBundle("Items", {
    module: "exam",
    methods: [{ name: "listBySubjectId", start: 4, end: 8 }]
  });
  const service = fileBundle("Service", {
    module: "exam",
    methods: [
      {
        name: "export",
        start: 55,
        end: 84,
        calls: [
          { name: "loadItems", receiver: "this" },
          { name: "loadMap", receiver: "this" },
          { name: "resolve", receiver: "this" }
        ]
      },
      { name: "loadItems", start: 86, end: 93, calls: [{ name: "listBySubjectId", receiver: "items", typeId: items.types[0]!.typeId }] },
      { name: "loadMap", start: 95, end: 107, calls: [{ name: "listStudents", receiver: "school", typeId: school.types[0]!.typeId }] },
      { name: "resolve", start: 145, end: 154, calls: [{ name: "listSummaries", receiver: "school", typeId: school.types[0]!.typeId }] }
    ],
    fields: [
      { name: "items", typeId: items.types[0]!.typeId, simpleName: "Items" },
      { name: "school", typeId: school.types[0]!.typeId, simpleName: "School" }
    ]
  });
  const store = new JavaIndexStore();
  store.replaceFile(service);
  store.replaceFile(school);
  store.replaceFile(items);
  const graph = sqlGraph();
  const facts = factsForStore(graph, store, "src/Service.java", new Set(), 60);
  const names = new Set(facts.methods.map(method => method.name));
  assert.ok(names.has("export"), [...names].join(","));
  assert.ok(names.has("loadMap"), [...names].join(","));
  assert.ok(names.has("resolve"), [...names].join(","));
  assert.equal(names.has("loadItems"), false, [...names].join(","));
});

test("factsForStore unions proving method names and keeps a same-file callee", () => {
  const excel = fileBundle("Excel", {
    methods: [
      { name: "generate", start: 41, end: 56, calls: [{ name: "fillWorkbook", receiver: "this" }] },
      { name: "fillWorkbook", start: 62, end: 96 },
      { name: "unused", start: 100, end: 140 }
    ]
  });
  const store = new JavaIndexStore();
  store.replaceFile(excel);
  const graph = sqlGraph();
  const proving = new Set([
    "src/Excel.java#Excel#generate#n",
    "src/School.java#School#listSummaries#n"
  ]);
  const facts = factsForStore(graph, store, "src/Excel.java", proving);
  const names = new Set(facts.methods.map(method => method.name));
  assert.ok(names.has("generate"), [...names].join(","));
  assert.ok(names.has("fillWorkbook"), [...names].join(","));
  assert.equal(names.has("unused"), false, [...names].join(","));
});

test("factsForStore keeps a type span for a hop-1 DTO with no matching method name", () => {
  const dto = fileBundle("SignedUrl", { methods: [] });
  const store = new JavaIndexStore();
  store.replaceFile(dto);
  const graph = sqlGraph();
  const proving = new Set([`src/SignedUrl.java#SignedUrl#n`]);
  const facts = factsForStore(graph, store, "src/SignedUrl.java", proving);
  assert.equal(facts.methods.length, 0);
  assert.ok((facts.types ?? []).some(span => span.start === 1));
});

test("factsForStore keeps a type span when the proving id is a graph TYPE node on that path", () => {
  const entity = fileBundle("PayAccount", { methods: [{ name: "getId", start: 4, end: 8 }] });
  const store = new JavaIndexStore();
  store.replaceFile(entity);
  const graph = sqlGraph();
  graph.upsertNode({
    id: "entity:PayAccount",
    kind: "JPA_ENTITY",
    generation: 1,
    relativePath: "src/PayAccount.java",
    simpleName: "PayAccount"
  }, "src/PayAccount.java");
  const facts = factsForStore(graph, store, "src/PayAccount.java", new Set(["entity:PayAccount"]));
  assert.ok((facts.types ?? []).some(span => span.start === 1), JSON.stringify(facts.types));
});

test("planContextQuery selects a hop-1 persistence entity from type spans", () => {
  const order = fileBundle("Order", { methods: [{ name: "create", start: 10, end: 20 }] });
  const account = fileBundle("PayAccount", { methods: [{ name: "getId", start: 4, end: 8 }] });
  const store = new JavaIndexStore();
  store.replaceFile(order);
  store.replaceFile(account);
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Order.java", kind: "FILE", generation: 1, relativePath: "src/Order.java" }, "src/Order.java");
  graph.upsertNode({
    id: "entity:PayAccount",
    kind: "JPA_ENTITY",
    generation: 1,
    relativePath: "src/PayAccount.java",
    simpleName: "PayAccount"
  }, "src/PayAccount.java");
  const search: GraphSearchResult = {
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    coverage: "PARTIAL",
    bundles: [
      { path: "src/Order.java", hops: 0, estimatedTokens: 40, provingPath: [], closedObligations: ["O1"] },
      {
        path: "src/PayAccount.java",
        hops: 1,
        estimatedTokens: 80,
        provingPath: [{
          kind: "REPOSITORY_MANAGES_ENTITY",
          fromId: "src/Order.java",
          toId: "entity:PayAccount"
        }],
        closedObligations: ["O4"]
      }
    ],
    unresolved: [],
    metrics: { expansions: 2, hops: 1, estimatedTokens: 120 }
  };
  const contract = planContextQuery({ graph, store, search, tokenBudget: 400, generation: 1, anchorLine: 12 });
  assert.ok(contract.evidence.some(item => item.path === "src/PayAccount.java"), contract.evidence.map(item => item.path).join(","));
});

test("attachAnchorSignatureBundles follows persistence edges from a hop-1 field type", () => {
  const mapper = fileBundle("ReleaseMapper", { methods: [{ name: "storeRelease", start: 4, end: 8 }] });
  const entity = fileBundle("PayAccount", { methods: [{ name: "getId", start: 4, end: 8 }] });
  const gateway = fileBundle("Gateway", {
    methods: [{
      name: "store",
      start: 10,
      end: 20,
      calls: [{ name: "storeRelease", receiver: "mapper", typeId: mapper.types[0]!.typeId }]
    }],
    fields: [{ name: "mapper", typeId: mapper.types[0]!.typeId, simpleName: "ReleaseMapper" }]
  });
  const store = new JavaIndexStore();
  store.replaceFile(gateway);
  store.replaceFile(mapper);
  store.replaceFile(entity);
  const graph = sqlGraph();
  graph.upsertNode({ id: "src/Gateway.java", kind: "FILE", generation: 1, relativePath: "src/Gateway.java" }, "src/Gateway.java");
  graph.upsertNode({
    id: "src/ReleaseMapper.java#ReleaseMapper",
    kind: "TYPE",
    generation: 1,
    relativePath: "src/ReleaseMapper.java",
    simpleName: "ReleaseMapper",
    javaIndexId: mapper.types[0]!.typeId
  }, "src/ReleaseMapper.java");
  graph.upsertNode({
    id: "src/PayAccount.java#PayAccount",
    kind: "JPA_ENTITY",
    generation: 1,
    relativePath: "src/PayAccount.java",
    simpleName: "PayAccount"
  }, "src/PayAccount.java");
  graph.addEdge({
    edgeId: knowledgeEdgeId({
      kind: "REPOSITORY_MANAGES_ENTITY",
      fromId: "src/ReleaseMapper.java#ReleaseMapper",
      toId: "src/PayAccount.java#PayAccount"
    }),
    kind: "REPOSITORY_MANAGES_ENTITY",
    fromId: "src/ReleaseMapper.java#ReleaseMapper",
    toId: "src/PayAccount.java#PayAccount",
    generation: 1,
    sourceFile: "src/ReleaseMapper.java"
  }, "src/ReleaseMapper.java");
  const attached = attachAnchorSignatureBundles(emptySearch("src/Gateway.java"), graph, store, "src/Gateway.java", 12);
  const paths = attached.bundles.map(item => item.path).sort();
  assert.ok(paths.includes("src/ReleaseMapper.java"), `missing mapper, got ${paths.join(",")}`);
  assert.ok(paths.includes("src/PayAccount.java"), `missing persistence entity, got ${paths.join(",")}`);
});
