import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { extractJavaFile } from "../java-index/ast-extractor.js";
import { buildTypeRegistryView, JavaNameResolver } from "../java-index/name-resolver.js";
import { buildStaticEdges, resolveFileRefs } from "../java-index/edge-builder.js";
import { openIndexDb, close } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { writeBundle } from "../java-index/sql/rows.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { queryReadRanges } from "../java-index/sql/sql-read-ranges.js";
import { buildReadPlan } from "../agent-router/read-plan.js";
import { toCompactImpact, viewSelectedRangesByFile } from "../agent-router/output-compact.js";
import type { CandidateFile, ImpactResultV6 } from "../agent-types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const relativePath = "Source.java";

async function parse(content: string, repoRoot = "/fixture", file = relativePath) {
  return extractJavaFile({ repoRoot, absolutePath: path.join(repoRoot, file), relativePath: file,
    sourceRoot: ".", module: "fixture", sourceSet: "main", size: Buffer.byteLength(content),
    mtimeMs: 0, contentHash: sha(content), generation: 1, content }, await createJavaParserBackend());
}

async function database(content: string, root = "/fixture") {
  const raw = await parse(content, root);
  const registry = buildTypeRegistryView(raw.types, raw.methods, undefined, [raw.file]);
  const resolver = new JavaNameResolver(registry);
  const resolved = resolveFileRefs(raw, resolver, registry);
  const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods, undefined, [raw.file]);
  const bundle = { ...resolved, edges: buildStaticEdges(resolved, resolvedRegistry, resolver) };
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  writeBundle(db, bundle);
  return { db, bundle, store: new SqlFactsStore(db) };
}

function serializedPlan(plan: Awaited<ReturnType<typeof buildReadPlan>>) {
  const payload: ImpactResultV6 = {
    version: 6,
    target: { file: relativePath, symbol: "action", type: "Source", method: "action", profile: "service",
      range: { start: { line: 2, column: 1 }, end: { line: 421, column: 2 } } },
    freshness: { requestGeneration: 1, indexedGeneration: 1, coverage: "COMPLETE", changedDuringRequest: false },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [{ id: "F1", path: relativePath, role: "target", confidence: "high", evidence: [], locations: [], reasons: ["target"] }],
    readPlan: plan.items, evidenceGaps: plan.evidenceGaps,
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 }
  };
  // JSON round-trip checks the public wire shape, not only provider ranges.
  return JSON.parse(JSON.stringify(toCompactImpact(payload))) as ReturnType<typeof toCompactImpact>;
}

async function longMethod(lines: number[], byteBudget = 100_000) {
  const root = await mkdtemp(path.join(tmpdir(), "release-source-contract-"));
  const content = ["class Source {", "  void action() {",
    ...Array.from({ length: 418 }, (_, i) => `    int value${i} = ${i}; // 中文 😀`), "  }", "}", ""].join("\r\n");
  const { db, store } = await database(content, root);
  try {
    await writeFile(path.join(root, relativePath), content);
    const file: CandidateFile = { absolutePath: path.join(root, relativePath), path: relativePath,
      positions: lines.map(line => ({ line, column: 5 })), score: 1000, matchCount: lines.length,
      categories: ["target"], reasons: ["target"] };
    const provider = await queryReadRanges({ store, repoRoot: root, toRelative: file => path.relative(root, file) },
      [{ file: file.absolutePath, positions: file.positions }]);
    const plan = await buildReadPlan({ files: [file], ids: new Map([[file.absolutePath, "F1"]]),
      options: { anchors: file.positions.map(p => ({ file: file.absolutePath, ...p })), mode: "balanced", profile: "service",
        semanticPolicy: "fast", semanticTimeoutMs: 1500, testReadMode: "defer", focusModules: [], excludeModules: [],
        taskKeywords: [], crossModulePolicy: "auto", readPlanMaxBytes: byteBudget } as Parameters<typeof buildReadPlan>[0]["options"],
      javaIndex: { queryReadRanges: requests => queryReadRanges({ store, repoRoot: root,
        toRelative: input => path.relative(root, input) }, requests) } as Parameters<typeof buildReadPlan>[0]["javaIndex"] });
    return { content, provider, wire: serializedPlan(plan), plan };
  } finally { close(db); await rm(root, { recursive: true, force: true }); }
}

const includes = (ranges: Array<{ startLine: number; endLine: number }>, line: number) =>
  ranges.some(range => range.startLine <= line && line <= range.endLine);

test("K04: named declaration identities survive five inserted blank lines through parser and SQLite", async () => {
  const source = "package demo;\nclass Named { int value; void run() {} }\n";
  const before = await database(source);
  const after = await database(`\n\n\n\n\n${source}`);
  try {
    assert.equal(after.bundle.types[0]!.typeId, before.bundle.types[0]!.typeId);
    assert.equal(after.bundle.methods[0]!.methodId, before.bundle.methods[0]!.methodId);
    assert.equal(after.bundle.fields[0]!.fieldId, before.bundle.fields[0]!.fieldId);
    const id = before.bundle.types[0]!.typeId;
    assert.equal(after.store.typesById.get(id)!.nameRange!.start.line, before.store.typesById.get(id)!.nameRange!.start.line + 5);
    const method = before.bundle.methods[0]!;
    assert.equal(after.store.methodsById.get(method.methodId)!.nameRange!.start.line, method.nameRange!.start.line + 5);
  } finally { close(before.db); close(after.db); }
});

test("K07: requested line 201 survives real parser, range provider, planner and final compact serializer", async () => {
  const result = await longMethod([201]);
  assert.ok(includes(result.provider[0]!.ranges, 201));
  assert.ok(includes(viewSelectedRangesByFile(result.wire).get(relativePath)!, 201));
});

test("K08: lines 100 and 350 survive final serialization, and insufficient budget reports missing anchors", async () => {
  const result = await longMethod([100, 350]);
  const ranges = viewSelectedRangesByFile(result.wire).get(relativePath)!;
  for (const line of [100, 350]) { assert.ok(includes(result.provider[0]!.ranges, line)); assert.ok(includes(ranges, line)); }
  const short = await longMethod([100, 350], 1);
  const shortRanges = viewSelectedRangesByFile(short.wire).get(relativePath) ?? [];
  if (![100, 350].every(line => includes(shortRanges, line))) {
    assert.ok(short.plan.evidenceGaps.some(gap => /partial|budget/i.test(gap)));
    assert.ok(short.wire.unresolved.some(gap => /partial|budget/i.test(gap)));
  } else {
    assert.ok(short.plan.budgetExceededByAnchor, "retaining over-budget anchors must explicitly report the budget exception");
  }
});

test("K09: long-method CRLF byte costs and source hashes match original UTF-8 bytes", async () => {
  const { content, provider } = await longMethod([201]);
  const originalLines = content.match(/[^\n]*\n|[^\n]+$/g)!;
  for (const range of provider[0]!.ranges) {
    const slice = originalLines.slice(range.startLine - 1, range.endLine).join("");
    assert.equal(range.estimatedBytes, Buffer.byteLength(slice, "utf8"));
    assert.ok(slice.includes("\r\n"));
  }
  const parsed = await parse(content);
  assert.equal(parsed.file.contentHash, sha(Buffer.from(content, "utf8").toString("utf8")));
});

test("K10: CRLF emoji declaration and call selections use independently counted UTF-16 columns", async () => {
  const declaration = '  String text = "中文😀"; void run() {}';
  const callLine = '  void caller() { String text = "😀"; run(); }';
  const content = ["class Source {", declaration, callLine, "}", ""].join("\r\n");
  const parsed = await parse(content);
  const column = (line: string, token: string) => Buffer.byteLength(line.slice(0, line.indexOf(token)), "utf16le") / 2 + 1;
  const method = parsed.methods.find(method => method.name === "run")!;
  assert.deepEqual(method.nameRange!.start, { line: 2, column: column(declaration, "run") });
  const call = parsed.methods.find(method => method.name === "caller")!.callSites.find(call => call.name === "run")!;
  assert.deepEqual(call.range.start, { line: 3, column: column(callLine, "run()") });
});

test("K22: same-arity ambiguous overload keeps syntax call and emits no false static binding", async () => {
  const { db, bundle } = await database("class Source { void accept(String x) {} void accept(Integer x) {} void run() { accept(null); } }");
  try {
    const run = bundle.methods.find(method => method.name === "run")!;
    const overloads = bundle.methods.filter(method => method.name === "accept");
    assert.equal(overloads.length, 2);
    assert.equal(run.callSites.length, 1);
    assert.ok(!bundle.edges.some(edge => edge.fromId === run.methodId && edge.kind === "CALLS"));
    assert.ok(!JSON.stringify(bundle).includes("JDT_BOUND"));
  } finally { close(db); }
});

test("K23: concrete Parent receiver with Child override is virtual rather than a unique runtime target", async () => {
  const { db, store, bundle } = await database("class Parent { void save() {} } class Child extends Parent { void save() {} } class Source { void run(Parent value) { value.save(); } }");
  try {
    const graph = new SqlKnowledgeGraph(db);
    new KnowledgeGraphBuilder(graph).rebuildFromStore(store, 1);
    const caller = bundle.methods.find(method => method.name === "run")!;
    const callerId = graph.nodeIdForJavaIndexId(caller.methodId)!;
    assert.equal(graph.successors(callerId, "CALLS_EXACT").length, 0, "static Parent declaration is not an exact runtime dispatch");
    const virtual = graph.successors(callerId, "CALLS_VIRTUAL");
    assert.equal(virtual.length, 1);
    const child = bundle.types.find(type => type.simpleName === "Child")!;
    const childMethod = bundle.methods.find(method => method.ownerTypeId === child.typeId && method.name === "save")!;
    assert.ok(graph.successors(virtual[0]!.toId, "DISPATCHES_TO")
      .some(edge => edge.toId === graph.nodeIdForJavaIndexId(childMethod.methodId)));
    assert.ok(!JSON.stringify(bundle).includes("JDT_BOUND"));
  } finally { close(db); }
});

test("K31: package-private, nested and local type declarations are independently addressable in SQLite", async () => {
  const content = ["class Source {", "  class Nested {}", "  void run() {", "    class Local {}", "  }", "}", "class PackagePrivate {}"].join("\n");
  const { db, store, bundle } = await database(content);
  try {
    for (const name of ["Source", "Nested", "Local", "PackagePrivate"]) {
      const type = bundle.types.find(type => type.simpleName === name);
      assert.ok(type, `${name} must be a real type declaration`);
      assert.equal(store.typesById.get(type.typeId)!.fileId, bundle.file.fileId);
      const point = type.nameRange!.start;
      const anchor = store.anchor(relativePath, point.line, point.column);
      assert.equal(anchor?.symbolId, type.typeId, `${name} selection must resolve to the type, not its containing method or constructor`);
      assert.equal(anchor?.symbolKind, "TYPE");
    }
  } finally { close(db); }
});

test("K32: javac --release 17 accepts record compact constructor and text-block braces do not alter parser bounds", async () => {
  const compiler = process.env.JAVA_RELEASE_CONTRACT_JAVAC ?? ["/opt/homebrew/opt/openjdk@25/bin/javac", "/opt/homebrew/opt/openjdk/bin/javac"].find(existsSync);
  assert.ok(compiler, "a real JDK17+ compiler is required; supply JAVA_RELEASE_CONTRACT_JAVAC");
  const root = await mkdtemp(path.join(tmpdir(), "release-java17-contract-"));
  const content = ["record Source(int value) {", "  Source { if (value < 0) throw new IllegalArgumentException(); }", "  String render() {", '    return """', "        literal unmatched } } ) ) {", '        """;', "  }", "}", ""].join("\n");
  try {
    await writeFile(path.join(root, relativePath), content);
    execFileSync(compiler, ["--release", "17", "-d", path.join(root, "classes"), path.join(root, relativePath)], { timeout: 30_000, stdio: "pipe" });
    const parsed = await parse(content, root);
    assert.equal(parsed.file.parseState, "COMPLETE");
    assert.equal(parsed.types[0]!.kind, "record");
    const ctor = parsed.methods.find(method => method.constructor)!;
    assert.ok(ctor, "compact constructor must be extracted as a declaration");
    assert.equal(ctor.range.start.line, 2);
    assert.equal(ctor.range.end.line, 2);
    const render = parsed.methods.find(method => method.name === "render")!;
    assert.deepEqual([render.range.start.line, render.range.end.line], [3, 7]);
    assert.equal(parsed.types[0]!.range.end.line, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, source] of [
  ["final method", "class Parent { final void save() {} } class Child extends Parent {} class Source { void run(Parent value) { value.save(); } }"],
  ["private method", "class Parent { private void save() {} void run() { save(); } } class Child extends Parent { void save() {} }"],
  ["static method", "class Parent { static void save() {} } class Child extends Parent { static void save() {} } class Source { void run(Parent value) { value.save(); } }"],
  ["overload instead of override", "class Parent { void save(String value) {} } class Child extends Parent { void save(Integer value) {} } class Source { void run(Parent value) { value.save(null); } }"]
]) {
  test(`K23: ${label} does not invent runtime dispatch to a subtype`, async () => {
    const { db, store, bundle } = await database(source!);
    try {
      const graph = new SqlKnowledgeGraph(db);
      new KnowledgeGraphBuilder(graph).rebuildFromStore(store, 1);
      const callerId = graph.nodeIdForJavaIndexId(bundle.methods.find(method => method.name === "run")!.methodId)!;
      assert.equal(graph.successors(callerId, "CALLS_VIRTUAL").length, 0);
      assert.equal(graph.successors(callerId, "CALLS_EXACT").length, 1);
      for (const method of bundle.methods) {
        const id = graph.nodeIdForJavaIndexId(method.methodId)!;
        assert.equal(graph.successors(id, "DISPATCHES_TO").length, 0);
      }
    } finally { close(db); }
  });
}

test("K23: explicit super call binds the parent declaration and bypasses virtual dispatch", async () => {
  const { db, store, bundle } = await database("class Parent { void save() {} } class Child extends Parent { void save() {} void run() { super.save(); } }");
  try {
    const parent = bundle.types.find(type => type.simpleName === "Parent")!;
    const parentMethod = bundle.methods.find(method => method.ownerTypeId === parent.typeId && method.name === "save")!;
    const run = bundle.methods.find(method => method.name === "run")!;
    assert.ok(bundle.edges.some(edge => edge.fromId === run.methodId && edge.kind === "CALLS" && edge.toId === parentMethod.methodId));
    const graph = new SqlKnowledgeGraph(db);
    new KnowledgeGraphBuilder(graph).rebuildFromStore(store, 1);
    const id = graph.nodeIdForJavaIndexId(run.methodId)!;
    assert.deepEqual(graph.successors(id, "CALLS_EXACT").map(edge => edge.toId), [graph.nodeIdForJavaIndexId(parentMethod.methodId)]);
    assert.equal(graph.successors(id, "CALLS_VIRTUAL").length, 0);
  } finally { close(db); }
});

test("K23: cross-file override add, edit, reparent and delete incrementally match a fresh cold graph", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { runSqlColdBuild } = await import("../index-builder/cold-build.js");
  const { applyBuilderJob } = await import("../index-builder/incremental.js");
  const root = await mkdtemp(path.join(tmpdir(), "release-dispatch-incremental-"));
  const sourceRoot = path.join(root, "src/main/java");
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const observe = (index: typeof db) => {
    const store = new SqlFactsStore(index);
    const graph = new SqlKnowledgeGraph(index);
    const caller = store.files(["src/main/java/Caller.java"])[0]!;
    return caller.methods.filter(method => method.name.startsWith("run")).map(method => {
      const id = graph.nodeIdForJavaIndexId(method.methodId)!;
      const calls = ["CALLS_EXACT", "CALLS_VIRTUAL"] as const;
      return { method: method.name, calls: calls.flatMap(kind => graph.successors(id, kind).map(edge => ({
        kind, toId: edge.toId, dispatch: graph.successors(edge.toId, "DISPATCHES_TO").map(target => target.toId).sort()
      }))).sort((a, b) => a.toId.localeCompare(b.toId)) };
    });
  };
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "Parent.java"), "class Parent { void save() {} } class OtherParent { void save() {} }");
    await writeFile(path.join(sourceRoot, "Caller.java"), "class Caller { void runParent(Parent value) { value.save(); } void runOther(OtherParent value) { value.save(); } }");
    await runSqlColdBuild({ repoRoot: root, db });
    const child = path.join(sourceRoot, "Child.java");
    let generation = 1;
    for (const [stage, content] of [
      ["add subtype without override", "class Child extends Parent {}"],
      ["add override", "class Child extends Parent { void save() {} }"],
      ["remove override", "class Child extends Parent {}"],
      ["restore override", "class Child extends Parent { void save() {} }"],
      ["reparent override", "class Child extends OtherParent { void save() {} }"],
      ["delete subtype", undefined]
    ] as const) {
      if (content === undefined) await rm(child);
      else await writeFile(child, content);
      const job = { kind: "refresh" as const, generation: ++generation,
        changed: content === undefined ? [] : [child], deleted: content === undefined ? [child] : [] };
      const result = await applyBuilderJob({ repoRoot: root, db, job });
      assert.equal(result.ok, true, `${stage}: ${result.error}`);
      const fresh = openIndexDb(":memory:");
      ensureSchema(fresh);
      try {
        await runSqlColdBuild({ repoRoot: root, db: fresh });
        assert.deepEqual(observe(db), observe(fresh), `${stage}: incremental dispatch must match cold rebuild`);
      } finally { close(fresh); }
    }
  } finally { close(db); await rm(root, { recursive: true, force: true }); }
});


test("K23: qualified and imported-equivalent parameter spellings retain concrete override dispatch", async () => {
  const { db, store, bundle } = await database("class Parent { void save(java.lang.String s) {} } class Child extends Parent { void save(String s) {} } class Source { void run(Parent value, String s) { value.save(s); } }");
  try {
    const graph = new SqlKnowledgeGraph(db);
    new KnowledgeGraphBuilder(graph).rebuildFromStore(store, 1);
    const id = graph.nodeIdForJavaIndexId(bundle.methods.find(method => method.name === "run")!.methodId)!;
    assert.equal(graph.successors(id, "CALLS_EXACT").length, 0);
    const calls = graph.successors(id, "CALLS_VIRTUAL");
    assert.equal(calls.length, 1);
    assert.equal(graph.successors(calls[0]!.toId, "DISPATCHES_TO").length, 1);
  } finally { close(db); }
});
