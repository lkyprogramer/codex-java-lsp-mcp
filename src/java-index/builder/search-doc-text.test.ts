// search_doc_text: every SearchDocument keeps its ordered normalizedText
// through the real writer paths (cold build, Java refresh, XML-only resource
// job, deletion), and its postings stay derivable from that text.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { documentTokens } from "../../discovery/search-document.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { applyBuilderJob } from "../../index-builder/incremental.js";

const SVC_JAVA = "src/main/java/demo/OrderService.java";
const MAPPER_JAVA = "src/main/java/demo/OrderMapper.java";
const MAPPER_XML = "src/main/resources/mapper/OrderMapper.xml";

const service = (comment: string) => [
  "package demo;",
  "",
  "public class OrderService {",
  `    /** ${comment} */`,
  "    public void refund(String orderId) {",
  "    }",
  "}",
  ""
].join("\n");

const mapperXml = (kind: string) => [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<mapper namespace="demo.OrderMapper">`,
  `  <${kind} id="load">SELECT * FROM t WHERE id = #{id}</${kind}>`,
  `</mapper>`,
  ""
].join("\n");

type TextRow = { doc: string; source: string; kind: string; text: string | null; tokenLen: number };

function documents(db: ReturnType<typeof openIndexDb>): TextRow[] {
  return db.prepare(
    `SELECT ds.text AS doc, sp.text AS source, d.kind AS kind, t.text AS text, d.token_len AS tokenLen
       FROM search_doc d JOIN sym ds ON ds.id=d.sym JOIN sym sp ON sp.id=d.source_path_sym
       LEFT JOIN search_doc_text t ON t.doc_sym=d.sym ORDER BY ds.text`
  ).all() as TextRow[];
}

/** Every document has exactly one text, no text is orphaned, and the stored
 *  postings are exactly the tokenization of that text. */
function assertTextBacksPostings(db: ReturnType<typeof openIndexDb>): TextRow[] {
  const rows = documents(db);
  assert.ok(rows.length > 0, "the fixture produces documents");
  const orphans = db.prepare("SELECT count(*) AS n FROM search_doc_text WHERE doc_sym NOT IN (SELECT sym FROM search_doc)").get() as { n: number };
  assert.equal(orphans.n, 0, "no text outlives its document");
  const postings = db.prepare(
    "SELECT tk.text AS token, p.tf AS tf FROM search_doc_token p JOIN sym tk ON tk.id=p.token_sym JOIN sym ds ON ds.id=p.doc_sym WHERE ds.text=?"
  );
  for (const row of rows) {
    assert.equal(typeof row.text, "string", `document ${row.doc} has no stored text`);
    const tokens = documentTokens(row.text!);
    assert.equal(row.tokenLen, tokens.length, `token_len of ${row.doc}`);
    const expected = new Map<string, number>();
    for (const token of tokens) expected.set(token, (expected.get(token) ?? 0) + 1);
    const stored = new Map((postings.all(row.doc) as Array<{ token: string; tf: number }>).map(p => [p.token, Number(p.tf)]));
    assert.deepEqual(stored, expected, `postings of ${row.doc} are the text's tokens`);
  }
  return rows;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "search-doc-text-"));
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
    return path.join(root, rel);
  };
  await write("pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>t</artifactId><version>1</version></project>\n");
  await write(SVC_JAVA, service("退款前先冻结订单再冲正"));
  await write(MAPPER_JAVA, "package demo;\n\npublic interface OrderMapper {\n    int load(int id);\n}\n");
  await write(MAPPER_XML, mapperXml("select"));
  const dir = await mkdtemp(path.join(tmpdir(), "search-doc-text-db-"));
  const db = openIndexDb(path.join(dir, "index.sqlite"));
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot: root, db, generation: 1, batchSize: 5 });
  return {
    root, db, write,
    async dispose() {
      close(db);
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("search_doc_text: a cold build stores each document's ordered normalizedText", async () => {
  const { db, dispose } = await fixture();
  try {
    const rows = assertTextBacksPostings(db);
    const comment = rows.find(row => row.source === SVC_JAVA && row.kind === "comment");
    assert.ok(comment?.text?.includes("退款前先冻结订单再冲正"), `the comment keeps its word order, got ${comment?.text}`);
    const signature = rows.find(row => row.source === SVC_JAVA && row.kind === "signature" && row.text?.includes("refund"));
    assert.ok(signature?.text?.includes("public void refund(String orderId)"), `the signature keeps source order, got ${signature?.text}`);
    const statement = rows.find(row => row.source === MAPPER_XML);
    assert.match(statement?.text ?? "", /^mybatis select demo\.OrderMapper\..*load$/);
  } finally {
    await dispose();
  }
});

test("search_doc_text: refresh, XML-only job and deletion replace or drop the text with its document", async () => {
  const { root, db, write, dispose } = await fixture();
  try {
    const javaAbs = await write(SVC_JAVA, service("退款后解冻订单"));
    let result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "refresh", generation: 2, changed: [javaAbs] } });
    assert.ok(result.ok, result.error);
    let rows = assertTextBacksPostings(db);
    const texts = rows.map(row => row.text).join("\n");
    assert.ok(texts.includes("退款后解冻订单") && !texts.includes("冲正"), "the old comment text is gone with its document");

    const xmlAbs = await write(MAPPER_XML, mapperXml("update"));
    result = await applyBuilderJob({ repoRoot: root, db, job: { id: 2, kind: "resources", generation: 3, changed: [xmlAbs] } });
    assert.ok(result.ok, result.error);
    rows = assertTextBacksPostings(db);
    const statements = rows.filter(row => row.source === MAPPER_XML).map(row => row.text ?? "");
    assert.equal(statements.length, 1, JSON.stringify(statements));
    assert.match(statements[0], /^mybatis update demo\.OrderMapper\..*load$/, "the XML job replaced the statement text");

    await rm(path.join(root, SVC_JAVA));
    result = await applyBuilderJob({ repoRoot: root, db, job: { id: 3, kind: "refresh", generation: 4, changed: [javaAbs] } });
    assert.ok(result.ok, result.error);
    rows = assertTextBacksPostings(db);
    assert.equal(rows.some(row => row.source === SVC_JAVA), false, "a deleted file leaves no document and no text");
  } finally {
    await dispose();
  }
});
