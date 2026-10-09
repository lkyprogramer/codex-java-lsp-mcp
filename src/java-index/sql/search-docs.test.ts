import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
import { buildSearchDocuments, searchDocumentId } from "../../discovery/search-document.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { recordsFromBundle } from "../entity-search.js";
import { readBundle, writeBundle } from "./rows.js";
import { rebuildEntityDf, writeEntityRecord } from "./entity-tokens.js";
import {
  commitSearchDocStats,
  rebuildSearchDocDf,
  replaceSearchDocuments,
  searchDocStats
} from "./search-docs.js";
import { SqlEntitySearch } from "./entity-search.js";

const SERVICE_SOURCE = [
  "package demo;",
  "",
  "/** 处理订单回滚和冲正 */",
  "public class Svc {",
  "    /** 执行冲正步骤 */",
  "    public void refund() {",
  "    }",
  "}",
  ""
].join("\n");

const SERVICE_SOURCE_V2 = [
  "package demo;",
  "",
  "/** 处理订单回滚和冻结 */",
  "public class Svc {",
  "    /** 执行冻结步骤 */",
  "    public void refund() {",
  "    }",
  "}",
  ""
].join("\n");

const MISBIND_SOURCE = [
  "package demo;",
  "",
  "public class Mis {",
  "    public void first() {",
  "        // ledger-only note ZQXV77",
  "    }",
  "    /** step for second */",
  "    public void second() {",
  "    }",
  "}",
  ""
].join("\n");

async function writeAndParse(root: string, backend: Awaited<ReturnType<typeof createJavaParserBackend>>, content: string) {
  const rel = "src/main/java/demo/Svc.java";
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, rel), content, "utf8");
  return parseJavaSourceFile({
    repoRoot: root,
    resolvedRepoRoot: await realpath(root),
    inputPath: path.join(root, rel),
    generation: 1,
    backend,
    cache: new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 4 })
  });
}

test("T05: direct comments are bound to the declaration below them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-comments-"));
  try {
    const backend = await createJavaParserBackend();
    const bundle = await writeAndParse(root, backend, SERVICE_SOURCE);
    const refund = bundle.methods.find(method => method.name === "refund");
    assert.ok(refund, "the method parses");
    assert.ok(refund!.leadingComments?.some(comment => comment.text.includes("冲正")), `method carries its direct comment, got ${JSON.stringify(refund?.leadingComments)}`);
    const svc = bundle.types.find(type => type.simpleName === "Svc");
    assert.ok(svc!.leadingComments?.some(comment => comment.text.includes("回滚")), "the type carries its JavaDoc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K15: a comment word change is retrievable at the new content hash without restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-k15-"));
  try {
    const backend = await createJavaParserBackend();
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      const first = await writeAndParse(root, backend, SERVICE_SOURCE);
      writeBundle(db, first);
      for (const record of recordsFromBundle(first)) writeEntityRecord(db, record);
      replaceSearchDocuments(db, first.file.relativePath, buildSearchDocuments({ bundle: first, content: SERVICE_SOURCE }));
      rebuildEntityDf(db);
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
      const search = new SqlEntitySearch(db);
      const hit = search.search("冲正", 5).find(hit => hit.layer === "DOCUMENT");
      assert.ok(hit, `a word that only exists in a comment must be retrievable, got ${JSON.stringify(search.search("冲正", 5).map(h => h.layer))}`);
      assert.equal(hit?.simpleName, "refund", "the comment binds to the method below it");

      // Same index, new file content: the writer replaces documents by path in
      // one transaction, so the old hash's words disappear together with it.
      const second = await writeAndParse(root, backend, SERVICE_SOURCE_V2);
      assert.notEqual(second.file.contentHash, first.file.contentHash);
      writeBundle(db, second);
      for (const record of recordsFromBundle(second)) writeEntityRecord(db, record);
      replaceSearchDocuments(db, second.file.relativePath, buildSearchDocuments({ bundle: second, content: SERVICE_SOURCE_V2 }));
      rebuildEntityDf(db);
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
      const refreshed = new SqlEntitySearch(db);
      assert.ok(refreshed.search("冻结", 5).some(hit => hit.layer === "DOCUMENT"), "the new comment word is retrievable");
      const stale = refreshed.search("冲正", 5).filter(hit => hit.layer === "DOCUMENT");
      assert.equal(stale.length, 0, "the old hash's comment word must not survive as current");
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K16: a mapper statement binds to the same-named Java declaration, not XML alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-k16-"));
  try {
    const backend = await createJavaParserBackend();
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      const bundle = await writeAndParse(root, backend, [
        "package demo;",
        "public interface Svc {",
        "    int refund(int id);",
        "}"
      ].join("\n"));
      writeBundle(db, bundle);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="demo.Svc">\n  <update id="refund">UPDATE t SET state='R' WHERE id=#{id}</update>\n</mapper>\n`;
      const rel = "src/main/resources/mapper/SvcMapper.xml";
      await mkdir(path.join(root, "src/main/resources/mapper"), { recursive: true });
      await writeFile(path.join(root, rel), xml, "utf8");
      const resource = extractMyBatisMapperFacts({
        relativePath: rel,
        content: xml,
        contentHash: "fixture",
        generation: 1
      });
      assert.ok(resource, "the mapper XML parses");
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
      rebuildEntityDf(db);
      const docs = buildSearchDocuments({ bundle, myBatisResources: [resource] });
      const bound = docs.find(doc => doc.sourceKind === "framework-key" && doc.normalizedText.includes("demo.Svc.refund"));
      assert.ok(bound, `a statement document links to the mapper, got ${JSON.stringify(docs.map(d => d.normalizedText))}`);
      assert.ok(bound!.declarationId.endsWith("#refund(int)"), "the statement binds to the Java method, not the XML file");
      replaceSearchDocuments(db, bundle.file.relativePath, docs);
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
      const hits = new SqlEntitySearch(db).search("demo.Svc.refund", 5, "text");
      // The declaration is what matters: the statement must resolve to the
      // Java method, whichever retrieval layer surfaces it first (entity-level
      // dedupe across routes is intentional).
      assert.ok(hits.some(hit => hit.kind === "method" && hit.simpleName === "refund"), `querying the statement id resolves to the Java declaration, got ${JSON.stringify(hits.map(h => [h.simpleName, h.layer]))}`);
      const docRows = db.prepare("SELECT declaration_sym FROM search_doc WHERE kind='framework-key'").all();
      assert.ok(docRows.length > 0, "the statement document exists source-linked");
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K18: a secret value never enters any document, token, or search response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-k18-"));
  try {
    const backend = await createJavaParserBackend();
    const canary = "CANARY_DO_NOT_INDEX_SECRET_84729";
    const bundle = await writeAndParse(root, backend, [
      "package demo;",
      `@FeignClient("${canary}")`,
      "public class Svc {",
      "    public void run() {",
      "    }",
      "}"
    ].join("\n"));
    const content = await readFile(path.join(root, "src/main/java/demo/Svc.java"), "utf8");
    const docs = buildSearchDocuments({ bundle, content });
    for (const doc of docs) {
      assert.ok(!doc.normalizedText.includes(canary), `the canary must not be indexed in any document, found it in: ${doc.normalizedText}`);
    }
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      writeBundle(db, bundle);
      replaceSearchDocuments(db, bundle.file.relativePath, docs);
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
      const tokenRows = db.prepare("SELECT text FROM sym WHERE text LIKE '%' || ? || '%'").all(canary) as Array<{ text: string }>;
      assert.equal(tokenRows.length, 0, "the canary must not exist as an indexed token");
      const hits = new SqlEntitySearch(db).search("CANARY_DO_NOT_INDEX_SECRET", 5);
      assert.equal(hits.filter(hit => hit.layer === "DOCUMENT").length, 0, "the canary must not be returned by search");
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T05/R08: document ids are deterministic over target, kind, source path/range/hash and version", () => {
  const base = {
    declarationId: "method:demo.Svc#refund()",
    sourceKind: "comment" as const,
    source: { relativePath: "src/Svc.java", contentHash: "h1", startLine: 3, endLine: 3 },
    representationVersion: 2 as const
  };
  assert.equal(searchDocumentId(base), "method:demo.Svc#refund()|comment|src/Svc.java|3|3|h1|2");
  assert.notEqual(searchDocumentId({ ...base, source: { ...base.source, contentHash: "h2" } }), searchDocumentId(base),
    "a content change produces a new document identity");
  assert.notEqual(searchDocumentId({ ...base, source: { ...base.source, relativePath: "src/main/resources/Svc.xml" } }), searchDocumentId(base),
    "the same target and lines from another source file is another document");
});
test("T05: a body comment inside the previous method never migrates to the next declaration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-misbind-"));
  try {
    const backend = await createJavaParserBackend();
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      const bundle = await writeAndParse(root, backend, MISBIND_SOURCE);
      const second = bundle.methods.find(method => method.name === "second");
      assert.ok(second, "the method parses");
      assert.ok(second!.leadingComments?.some(comment => comment.text.includes("step for second")),
        "the direct comment above the method still binds to it");
      assert.ok(!second!.leadingComments?.some(comment => comment.text.includes("ZQXV77")),
        `the sibling method's body comment must not become the next declaration's leading comment, got ${JSON.stringify(second?.leadingComments)}`);
      const first = bundle.methods.find(method => method.name === "first");
      assert.ok(!first!.leadingComments?.some(comment => comment.text.includes("ZQXV77")),
        "a body comment is not a leading comment of its own method");

      writeBundle(db, bundle);
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
      replaceSearchDocuments(db, bundle.file.relativePath, buildSearchDocuments({ bundle, content: MISBIND_SOURCE }));
      rebuildEntityDf(db);
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
      const search = new SqlEntitySearch(db);
      assert.equal(
        search.search("ZQXV77", 5).filter(hit => hit.layer === "DOCUMENT").length,
        0,
        "an in-body comment is not a source-linked document of any declaration"
      );
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T05: without writer-published stats the document route scans instead of vanishing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t05-stats-fallback-"));
  try {
    const backend = await createJavaParserBackend();
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      const bundle = await writeAndParse(root, backend, SERVICE_SOURCE);
      writeBundle(db, bundle);
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
      replaceSearchDocuments(db, bundle.file.relativePath, buildSearchDocuments({ bundle, content: SERVICE_SOURCE }));
      rebuildEntityDf(db);
      rebuildSearchDocDf(db);
      // Deliberately no commitSearchDocStats: simulate a legacy/degraded DB
      // whose documents exist but whose meta stats row was never published.
      const stats = searchDocStats(db);
      assert.ok(stats.docCount > 0 && stats.totalLen > 0,
        `stats must fall back to the stored documents, got ${JSON.stringify(stats)}`);
      const search = new SqlEntitySearch(db);
      assert.ok(search.search("冲正", 5).some(hit => hit.layer === "DOCUMENT"),
        "the document route stays alive without the meta stats row");
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
