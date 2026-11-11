import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { extractMyBatisMapperFacts } from "../java-index/mybatis-xml-extractor.js";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { encodeFacts, writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import { queryEvidenceSources } from "../java-index/sql/evidence-sources.js";
import { buildSearchDocuments } from "./search-document.js";
import { replaceSearchDocuments } from "../java-index/sql/search-docs.js";
import { replaceAllEntities } from "../java-index/sql/entity-tokens.js";
import { recordsFromBundle } from "../java-index/entity-search.js";
import { SqlEntitySearch } from "../java-index/sql/entity-search.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { runEvidenceUnit, selectEvidenceWindows, type EvidenceUnitResult } from "./evidence-unit.js";
import type { JavaFileBundle } from "../java-index/index-types.js";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
// v2 (Q04): the anchor declaration arrives as Java units; XML link assertions look at resource units.
const resourceUnits = (out: EvidenceUnitResult) => out.units.filter(unit => unit.role === "resource");
const javaUnits = (out: EvidenceUnitResult) => out.units.filter(unit => unit.relation === "java-declaration");
const receipt = "package demo;\npublic class Receipt {\n}\n";
const xml = '<mapper namespace="demo.AbsentMapper">\r\n  <resultMap id="ReceiptMap" type="demo.Receipt">\r\n    <id property="id" column="receipt_id"/>\r\n  </resultMap>\r\n</mapper>\r\n';
async function fixture(disk = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "evidence-unit-")));
  const db = openIndexDb(disk ? path.join(root, "index.sqlite") : ":memory:"); ensureSchema(db);
  db.prepare("INSERT INTO meta(key,value) VALUES ('indexedGeneration','1'),('buildState','READY')").run();
  const backend = await createJavaParserBackend();
  const bundles = new Map<string, JavaFileBundle>();
  async function java(file: string, content: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    const bundle = await parseJavaSourceFile({ repoRoot: root, resolvedRepoRoot: root, inputPath: path.join(root, file), generation: 1, backend, cache: new ParseTreeCache(DEFAULT_PARSE_TREE_CACHE_OPTIONS) });
    writeBundle(db, bundle);
    bundles.set(bundle.file.relativePath, bundle);
    db.prepare("INSERT INTO source_root_coverage(root,state,generation) VALUES (?,'COMPLETE',1) ON CONFLICT(root) DO NOTHING").run(bundle.file.sourceRoot);
    return bundle;
  }
  async function resource(file: string, content: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    const facts = extractMyBatisMapperFacts({ relativePath: file, content, contentHash: hash(content), generation: 1 });
    assert.ok(facts); writeMyBatisResource(db, facts); return facts;
  }
  const client = {
    // The facts of the files this fixture parsed, as the index serves them.
    queryFiles: async (files: string[]) => files.map(file => bundles.get(path.relative(root, file).split(path.sep).join("/"))).filter((bundle): bundle is JavaFileBundle => bundle !== undefined),
    queryEvidenceSources: async (file: string, line: number, column: number, options?: { budget?: { remainingMs(): number } }) => queryEvidenceSources(db, file, line, column, options?.budget ? () => options.budget!.remainingMs() : undefined),
    status: async () => ({ state: "READY", indexedGeneration: Number(db.prepare("SELECT value FROM meta WHERE key='indexedGeneration'").get()?.value), coverage: db.prepare("SELECT root,state,generation FROM source_root_coverage").all() })
  } as unknown as JavaIndexClientApi;
  return { root, db, java, resource, client, cleanup: async () => { close(db); await rm(root, { recursive: true, force: true }); } };
}
const input = (root: string, file = "src/main/java/demo/Receipt.java") => ({ repoRoot: root, file, line: 2, column: 14 });

test("Receipt source-only resultMap delivers exact CRLF lines 2–4 without a Mapper or statement", async () => {
  const f = await fixture(); try {
    const bundle = await f.java(input(f.root).file, receipt);
    const resource = await f.resource("src/main/resources/receipt.xml", xml);
    assert.deepEqual(resource.statements, []);
    assert.equal(buildSearchDocuments({ bundle, content: receipt, myBatisResources: [resource] }).filter(doc => doc.source.relativePath.endsWith(".xml")).length, 0);
    const out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(out.scopeState, "READY"); assert.equal(out.generation, 1);
    assert.equal(out.anchor?.declarationId, bundle.types[0]?.typeId);
    const xmlUnits = resourceUnits(out);
    assert.equal(xmlUnits.length, 1); assert.equal(xmlUnits[0]?.complete, true);
    assert.equal(xmlUnits[0]?.startLine, 2); assert.equal(xmlUnits[0]?.endLine, 4);
    assert.equal(xmlUnits[0]?.text, xml.split(/(?<=\n)/).slice(1,4).join(""));
    assert.equal(xmlUnits[0]?.contentHash, hash(xml));
    assert.equal(xmlUnits[0]?.proof, "SOURCE_FACT");
    // The type's own declaration head, byte-exact from the anchor file.
    assert.deepEqual(javaUnits(out).map(unit => ({ path: unit.path, role: unit.role, startLine: unit.startLine, endLine: unit.endLine, text: unit.text, contentHash: unit.contentHash })),
      [{ path: input(f.root).file, role: "signature", startLine: 2, endLine: 2, text: "public class Receipt {\n", contentHash: hash(receipt) }]);
    assert.equal(out.schemaVersion, "java-evidence-unit/v2");
  } finally { await f.cleanup(); }
});

test("explicit METHOD retains XML provenance when identifier discovery wins the declaration", async () => {
  const f = await fixture(); try {
    const file = "src/main/java/demo/ReceiptMapper.java";
    const content = "package demo;\npublic interface ReceiptMapper {\n  Receipt findReceipt();\n}\n";
    const bundle = await f.java(file, content);
    const resource = await f.resource("src/main/resources/mapper.xml", '<mapper namespace="demo.ReceiptMapper">\n<select id="findReceipt">select receipt_id from receipt</select>\n</mapper>\n');
    const docs = buildSearchDocuments({ bundle, content, myBatisResources: [resource] });
    replaceAllEntities(f.db, recordsFromBundle(bundle));
    replaceSearchDocuments(f.db, file, docs);
    const search = new SqlEntitySearch(f.db);
    const baseline = search.searchDetailed("findReceipt", 10, "auto");
    const method = bundle.methods[0]!;
    const locator = { repoRoot: f.root, file, line: method.nameRange!.start.line, column: method.nameRange!.start.column };
    const out = await runEvidenceUnit(f.client, locator);
    assert.equal(out.scopeState, "READY");
    assert.ok(out.units.some(unit => unit.path.endsWith("mapper.xml") && unit.text.includes("select receipt_id")));
    assert.equal(resourceUnits(out).some(unit => unit.path === file), false);
    // The abstract mapper method fits whole: one anchor unit with its exact line.
    assert.deepEqual(javaUnits(out).map(unit => [unit.role, unit.startLine, unit.endLine, unit.text, unit.complete]), [["anchor", 3, 3, "  Receipt findReceipt();\n", true]]);
    // A second document range for the same declaration survives independent of ranking.
    const secondResource = await f.resource("src/main/resources/mapper-second.xml", '<mapper namespace="demo.ReceiptMapper">\n<select id="findReceipt">select receipt_id from archived_receipt</select>\n</mapper>\n');
    replaceSearchDocuments(f.db, file, buildSearchDocuments({ bundle, content, myBatisResources: [resource, secondResource] }));
    const multiple = await runEvidenceUnit(f.client, locator);
    assert.equal(resourceUnits(multiple).length, 2);
    assert.deepEqual(resourceUnits(multiple).map(unit => unit.path), ["src/main/resources/mapper-second.xml", "src/main/resources/mapper.xml"]);
    replaceSearchDocuments(f.db, file, docs);
    const after = search.searchDetailed("findReceipt", 10, "auto");
    const { trace: beforeTrace, ...beforeResult } = baseline;
    const { trace: afterTrace, ...afterResult } = after;
    assert.deepEqual(afterResult, beforeResult);
    assert.deepEqual(afterTrace?.map(({ operation, visited }) => ({ operation, visited })), beforeTrace?.map(({ operation, visited }) => ({ operation, visited })));
  } finally { await f.cleanup(); }
});

test("duplicate FQN resolves only the resource's same physical module; unscoped XML is ambiguous", async () => {
  const f = await fixture(); try {
    await f.java("modules/a/src/main/java/demo/Receipt.java", receipt);
    await f.java("modules/b/src/main/java/demo/Receipt.java", receipt);
    await f.resource("modules/a/src/main/resources/receipt.xml", xml);
    const a = queryEvidenceSources(f.db, "modules/a/src/main/java/demo/Receipt.java", 2, 14);
    const b = queryEvidenceSources(f.db, "modules/b/src/main/java/demo/Receipt.java", 2, 14);
    assert.equal(a.sources.length, 1); assert.equal(a.partial, false); assert.equal(b.sources.length, 0);
    await f.resource("docs/receipt.xml", xml);
    const unresolved = queryEvidenceSources(f.db, "modules/a/src/main/java/demo/Receipt.java", 2, 14);
    assert.ok(unresolved.reasons.includes("RESULT_MAP_TYPE_AMBIGUOUS"));
    assert.equal(unresolved.sources.length, 1);
  } finally { await f.cleanup(); }
});

test("Java and XML mutations reject stale indexed hashes", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt); await f.resource("src/main/resources/receipt.xml", xml);
    await writeFile(path.join(f.root, "src/main/resources/receipt.xml"), xml + "<!-- changed -->");
    let out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(resourceUnits(out).length, 0); assert.ok(out.reasons.includes("SOURCE_STALE"));
    await writeFile(path.join(f.root, input(f.root).file), receipt + "// changed");
    out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(out.units.length, 0); assert.ok(out.reasons.includes("ANCHOR_STALE"));
  } finally { await f.cleanup(); }
});

test("whole-line budget clips actual range and never claims source completeness", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    const long = '<mapper namespace="demo.AbsentMapper">\n<resultMap id="x" type="demo.Receipt">\n' + "<result property=\"x\" column=\"x\"/>\n".repeat(90) + '</resultMap>\n</mapper>\n';
    await f.resource("src/main/resources/receipt.xml", long);
    const out = await runEvidenceUnit(f.client, input(f.root));
    // The anchor's one-line declaration head is charged first, leaving 79 of the 80 lines for XML.
    assert.equal(javaUnits(out).length, 1);
    const clippedXml = resourceUnits(out)[0];
    assert.equal(out.scopeState, "PARTIAL"); assert.equal(clippedXml?.complete, false);
    assert.equal(clippedXml?.startLine, 2); assert.equal(clippedXml?.endLine, 80);
    assert.equal(clippedXml?.originalEndLine, 93);
    assert.equal(clippedXml?.text.split("\n").length, 80);
    assert.equal(out.units.reduce((lines, unit) => lines + unit.endLine - unit.startLine + 1, 0), 80);
    const timedOut = await runEvidenceUnit(f.client, { ...input(f.root), budget: DeadlineBudget.fromTimeout(1, (() => { let clock=0; return () => ++clock; })()) });
    assert.equal(timedOut.scopeState, "PARTIAL"); assert.equal(timedOut.units.length, 0);
  } finally { await f.cleanup(); }
});

test("empty complete scan differs from unparsed or capped resource scan", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    assert.equal((await runEvidenceUnit(f.client, input(f.root))).scopeState, "READY");
    const facts = await f.resource("src/main/resources/invalid.xml", '<mapper namespace="demo.X"></mapper>');
    writeMyBatisResource(f.db, { ...facts, parseState: "FAILED" });
    const unparsed = await runEvidenceUnit(f.client, input(f.root));
    assert.ok(unparsed.reasons.includes("RESOURCE_PARSE_INCOMPLETE"));
    for (let n=0; n<257; n++) writeMyBatisResource(f.db, { ...facts, relativePath: `resource-${n}.xml`, resourceId: `resource-${n}`, parseState: "COMPLETE" });
    assert.ok(queryEvidenceSources(f.db, input(f.root).file, 2, 14).reasons.includes("RESOURCE_SCAN_CAP"));
  } finally { await f.cleanup(); }
});

test("XML symlink outside repository is omitted even when content hash matches", async () => {
  const f = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "evidence-outside-"));
  try {
    await f.java(input(f.root).file, receipt); await f.resource("src/main/resources/receipt.xml", xml);
    await writeFile(path.join(outside, "receipt.xml"), xml);
    await rm(path.join(f.root, "src/main/resources/receipt.xml"));
    await symlink(path.join(outside, "receipt.xml"), path.join(f.root, "src/main/resources/receipt.xml"));
    const out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(resourceUnits(out).length, 0); assert.ok(out.reasons.includes("SOURCE_OUTSIDE_REPO"));
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("generation change across asynchronous source delivery drops mixed-version units", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt); await f.resource("src/main/resources/receipt.xml", xml);
    const client = { ...f.client, status: async () => ({ indexedGeneration: 2 }) } as unknown as JavaIndexClientApi;
    const out = await runEvidenceUnit(client, input(f.root));
    assert.equal(out.generation, 1); assert.equal(out.units.length, 0); assert.ok(out.reasons.includes("GENERATION_CHANGED"));
    assert.equal(f.db.isTransaction, false);
  } finally { await f.cleanup(); }
});


test("SQL lookup keeps generation and provenance on one WAL snapshot across concurrent publication", async () => {
  const f = await fixture(true); let writer: ReturnType<typeof openIndexDb> | undefined;
  try {
    await f.java(input(f.root).file, receipt);
    const resource = await f.resource("src/main/resources/receipt.xml", xml);
    writer = openIndexDb(path.join(f.root, "index.sqlite"));
    let published = false;
    const out = queryEvidenceSources(f.db, input(f.root).file, 2, 14, () => {
      if (!published) {
        published = true;
        writer!.exec("BEGIN");
        writer!.prepare("UPDATE meta SET value='2' WHERE key='indexedGeneration'").run();
        writeMyBatisResource(writer!, { ...resource, resultMaps: [], generation: 2 });
        writer!.exec("COMMIT");
      }
      return 10000;
    });
    assert.equal(out.generation, 1); assert.equal(out.sources.length, 1);
    const next = queryEvidenceSources(f.db, input(f.root).file, 2, 14);
    assert.equal(next.generation, 2); assert.equal(next.sources.length, 0);
    assert.equal(f.db.isTransaction, false);
  } finally { if (writer) close(writer); await f.cleanup(); }
});

test("byte cap never emits a partial UTF-8 line; sensitive source is omitted rather than credited", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    const oversized = '<mapper namespace="demo.AbsentMapper">\n<resultMap id="x" type="demo.Receipt">' + '列'.repeat(6000) + '</resultMap>\n</mapper>\n';
    await f.resource("src/main/resources/receipt.xml", oversized);
    const clipped = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(resourceUnits(clipped).length, 0); assert.ok(clipped.reasons.includes("SOURCE_BUDGET"));
    const sensitive = '<mapper namespace="demo.AbsentMapper">\n<resultMap id="x" type="demo.Receipt">\n<!-- password = "abc123" -->\n</resultMap>\n</mapper>\n';
    await f.resource("src/main/resources/receipt.xml", sensitive);
    const omitted = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(resourceUnits(omitted).length, 0); assert.ok(omitted.reasons.includes("SOURCE_SENSITIVE"));
  } finally { await f.cleanup(); }
});


test("incomplete index metadata never upgrades an empty relation set to READY", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    f.db.prepare("UPDATE source_root_coverage SET state='DEGRADED'").run();
    const out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(out.scopeState, "PARTIAL"); assert.ok(out.reasons.includes("INDEX_COVERAGE_INCOMPLETE"));
    f.db.prepare("UPDATE source_root_coverage SET state='COMPLETE'").run();
    f.db.prepare("UPDATE meta SET value='BUILDING' WHERE key='buildState'").run();
    assert.equal(queryEvidenceSources(f.db, input(f.root).file, 2, 14).partial, true);
  } finally { await f.cleanup(); }
});


test("unresolved resultMap type aliases are explicit partial scope and never invented bindings", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    await f.resource("src/main/resources/alias.xml", '<mapper namespace="demo.AbsentMapper">\n<resultMap id="x" type="Receipt"/>\n</mapper>\n');
    const out = await runEvidenceUnit(f.client, input(f.root));
    assert.equal(out.supportedScope, "java-declaration-and-indexed-resource-links");
    assert.equal(out.scopeState, "PARTIAL"); assert.equal(resourceUnits(out).length, 0);
    assert.ok(out.reasons.includes("RESULT_MAP_TYPE_UNSUPPORTED"));
  } finally { await f.cleanup(); }
});

test("METHOD damaged Mapper XML remains PARTIAL after failed parser facts clear all source documents", async () => {
  const f = await fixture(); try {
    const file = "src/main/java/demo/ReceiptMapper.java";
    const content = "package demo;\npublic interface ReceiptMapper {\n  Receipt findReceipt();\n}\n";
    const bundle = await f.java(file, content);
    const broken = await f.resource("src/main/resources/mapper.xml", '<mapper namespace="demo.ReceiptMapper"><select id="findReceipt">select receipt_id</mapper>');
    assert.equal(broken.parseState, "FAILED"); assert.equal(broken.namespace, "");
    assert.deepEqual(broken.statements, []); assert.deepEqual(broken.resultMaps, []);
    // Same publication outcome as the existing resource builder: no XML docs survive.
    replaceSearchDocuments(f.db, file, buildSearchDocuments({ bundle, content, myBatisResources: [broken] }));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM search_doc d JOIN sym p ON p.id=d.source_path_sym WHERE p.text LIKE '%.xml'").get()?.n, 0);
    assert.equal(bundle.file.parseState, "COMPLETE");
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='buildState'").get()?.value, "READY");
    const method = bundle.methods[0]!;
    const out = await runEvidenceUnit(f.client, { repoRoot: f.root, file, line: method.nameRange!.start.line, column: method.nameRange!.start.column });
    assert.equal(resourceUnits(out).length, 0);
    assert.equal(out.scopeState, "PARTIAL");
    assert.ok(out.reasons.includes("RESOURCE_PARSE_INCOMPLETE"));
  } finally { await f.cleanup(); }
});

test("METHOD resource health scan reports cap, invalid facts and deadline as partial scope", async () => {
  const f = await fixture(); try {
    const file = "src/main/java/demo/ReceiptMapper.java";
    const bundle = await f.java(file, "package demo;\npublic interface ReceiptMapper {\n  Receipt findReceipt();\n}\n");
    const method = bundle.methods[0]!;
    const line = method.nameRange!.start.line, column = method.nameRange!.start.column;
    f.db.prepare("INSERT INTO mybatis_resource(path,facts) VALUES (?,?)").run("invalid.xml", Buffer.from("not-deflate"));
    assert.ok(queryEvidenceSources(f.db, file, line, column).reasons.includes("RESOURCE_FACT_INVALID"));
    f.db.prepare("UPDATE mybatis_resource SET facts=?").run(encodeFacts(null));
    assert.ok(queryEvidenceSources(f.db, file, line, column).reasons.includes("RESOURCE_FACT_INVALID"));
    f.db.prepare("DELETE FROM mybatis_resource").run();
    const empty = extractMyBatisMapperFacts({ relativePath: "empty.xml", content: '<mapper namespace="demo.Other"></mapper>', contentHash: hash("empty"), generation: 1 })!;
    for (let n=0; n<257; n++) writeMyBatisResource(f.db, { ...empty, relativePath: `empty-${n}.xml` });
    const capped = queryEvidenceSources(f.db, file, line, column);
    assert.equal(capped.sources.length, 0); assert.ok(capped.reasons.includes("RESOURCE_SCAN_CAP"));
    let checks = 0;
    const expired = queryEvidenceSources(f.db, file, line, column, () => ++checks > 1 ? 0 : 10000);
    assert.ok(expired.reasons.includes("DEADLINE_EXCEEDED")); assert.equal(expired.partial, true);
  } finally { await f.cleanup(); }
});


test("METHOD matching statements without parser-located ranges remain partial when no documents exist", async () => {
  const f = await fixture(); try {
    const file = "src/main/java/demo/ReceiptMapper.java";
    const content = "package demo;\npublic interface ReceiptMapper {\n  Receipt findReceipt();\n}\n";
    const bundle = await f.java(file, content);
    const resource = await f.resource("src/main/resources/duplicate.xml", '<mapper namespace="demo.ReceiptMapper">\n<select id="findReceipt">select 1</select>\n<select id="findReceipt">select 2</select>\n</mapper>\n');
    assert.equal(resource.parseState, "COMPLETE"); assert.equal(resource.statements.length, 2);
    assert.ok(resource.statements.every(statement => statement.range === undefined));
    replaceSearchDocuments(f.db, file, buildSearchDocuments({ bundle, content, myBatisResources: [resource] }));
    const method = bundle.methods[0]!;
    const out = await runEvidenceUnit(f.client, { repoRoot: f.root, file, line: method.nameRange!.start.line, column: method.nameRange!.start.column });
    assert.equal(resourceUnits(out).length, 0); assert.equal(out.scopeState, "PARTIAL");
    assert.ok(out.reasons.includes("SOURCE_RANGE_UNRESOLVED"));
  } finally { await f.cleanup(); }
});

test("Q04: two distant anchors in a long method both keep a window within 80 lines", () => {
  const selected = selectEvidenceWindows({ methodStart: 2, methodEnd: 421, anchorLines: [201, 301], maxLines: 80 });
  assert.ok(selected.ranges.some(range => range.startLine <= 201 && 201 <= range.endLine));
  assert.ok(selected.ranges.some(range => range.startLine <= 301 && 301 <= range.endLine));
  assert.ok(selected.ranges.reduce((lines, range) => lines + range.endLine - range.startLine + 1, 0) <= 80);
  assert.deepEqual(selected.omittedAnchors, []);
  // A tighter budget narrows the radius first, then drops the last anchor and reports it.
  const tight = selectEvidenceWindows({ methodStart: 2, methodEnd: 421, anchorLines: [301, 201, 999], maxLines: 1 });
  assert.deepEqual(tight.ranges, [{ startLine: 201, endLine: 201 }]);
  assert.deepEqual(tight.omittedAnchors, [301, 999]);
  assert.deepEqual(selectEvidenceWindows({ methodStart: 2, methodEnd: 421, anchorLines: [201], maxLines: 0 }), { ranges: [], omittedAnchors: [201] });
});

test("Q04: a method larger than the budget yields its head and an anchor window, marked BODY_PARTIAL", async () => {
  const f = await fixture(); try {
    const file = "src/main/java/demo/LongService.java";
    const body = Array.from({ length: 120 }, (_, i) => `        total += ${i};\r\n`).join("");
    const content = `package demo;\r\npublic class LongService {\r\n    public int run(int total) {\r\n${body}        return total;\r\n    }\r\n}\r\n`;
    const bundle = await f.java(file, content);
    const method = bundle.methods[0]!;
    const out = await runEvidenceUnit(f.client, { repoRoot: f.root, file, line: 64, column: 9 });
    const java = javaUnits(out);
    assert.deepEqual(java.map(unit => unit.role), ["signature", "anchor"]);
    assert.equal(java[0]?.startLine, method.range.start.line);
    assert.equal(java[0]?.text, "    public int run(int total) {\r\n", "CRLF kept byte for byte");
    assert.ok(java[1]!.startLine <= 64 && 64 <= java[1]!.endLine);
    assert.ok(java.reduce((lines, unit) => lines + unit.endLine - unit.startLine + 1, 0) <= 80);
    assert.equal(out.scopeState, "PARTIAL");
    assert.ok(out.reasons.includes("BODY_PARTIAL"));
    assert.ok(out.omitted.some(entry => entry.reason === "BODY_PARTIAL" && entry.startLine === method.range.start.line && entry.endLine === method.range.end.line));
  } finally { await f.cleanup(); }
});

test("Q04: facts that no longer describe the anchor bytes give no Java unit, only PARTIAL", async () => {
  const f = await fixture(); try {
    await f.java(input(f.root).file, receipt);
    const client = { ...f.client, queryFiles: async () => [] } as unknown as JavaIndexClientApi;
    const out = await runEvidenceUnit(client, input(f.root));
    assert.equal(javaUnits(out).length, 0);
    assert.equal(out.scopeState, "PARTIAL");
    assert.ok(out.reasons.includes("ANCHOR_UNRESOLVED"));
  } finally { await f.cleanup(); }
});
