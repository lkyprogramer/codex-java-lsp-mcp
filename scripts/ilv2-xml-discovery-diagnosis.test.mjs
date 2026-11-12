import test from "node:test";
import assert from "node:assert/strict";
import { LADDER, diagnoseXmlTarget, enclosingElement, identifierTokens, javaFinder, mapperNamespace, summarizeXml, termsHitDocument } from "./ilv2-xml-discovery-diagnosis.mjs";

const XML = [
  `<?xml version="1.0"?>`,
  `<mapper namespace="demo.dao.UserMapper">`,
  `  <resultMap id="base" type="demo.User"/>`,
  `  <sql id="cols">id, user_name</sql>`,
  `  <select id="selectByName" resultMap="base">`,
  `    select <include refid="cols"/> from user_info`,
  `    where user_name = #{name}`,
  `  </select>`,
  `</mapper>`
].join("\n");
const JAVA = "package demo.dao;\npublic interface UserMapper {\n  User selectByName(String name);\n}\n";
const files = { "app/src/main/resources/mapper/UserMapper.xml": XML, "app/src/main/java/demo/dao/UserMapper.java": JAVA };
const readText = async file => files[file] ?? null;
const findJava = javaFinder(Object.keys(files).filter(file => file.endsWith(".java")));
const target = (startLine, endLine) => ({ path: "app/src/main/resources/mapper/UserMapper.xml", startLine, endLine });

function stubCall({ probe = [], impactSpans = null, method = true } = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, ...args });
    if (name === "java_symbol" && args.searchMode === "text") return { candidates: probe };
    if (name === "java_symbol") return { candidates: method ? [{ declaration: { relativePath: "app/src/main/java/demo/dao/UserMapper.java", selection: { line: 3, column: 8 } } }] : [] };
    return { contexts: impactSpans ? [{ path: target(5, 8).path, spans: impactSpans }] : [] };
  };
  return { call, calls };
}
const xmlCandidate = (startLine, endLine) => ({ declaration: { relativePath: "app/src/main/java/demo/dao/UserMapper.java" }, evidenceRange: { relativePath: target(5, 8).path, startLine, endLine } });
const noise = { declaration: { relativePath: "x/X.java" } };

test("element, namespace and token helpers mirror the index rules", () => {
  const lines = XML.split("\n");
  assert.deepEqual(enclosingElement(lines, 6), { tag: "select", id: "selectByName", line: 5 });
  assert.equal(enclosingElement(lines, 4).tag, "sql");
  assert.equal(enclosingElement(lines, 1), null);
  assert.equal(mapperNamespace(XML), "demo.dao.UserMapper");
  assert.ok(identifierTokens("selectByName user_info").has("by"));
  assert.ok(identifierTokens("user_info").has("info"));
  assert.equal(termsHitDocument(["user_info"], "mybatis select demo.dao.UserMapper.selectByName"), true, "user is shared through UserMapper");
  assert.equal(termsHitDocument(["order_total"], "mybatis select demo.dao.UserMapper.selectByName"), false);
  assert.equal(termsHitDocument(["mapper select"], "mybatis select demo.dao.UserMapper.selectByName"), false, "generic words do not count");
  assert.equal(findJava("demo.dao.UserMapper"), "app/src/main/java/demo/dao/UserMapper.java");
  assert.equal(findJava("demo.dao.Missing"), null);
});

test("the ladder stops at the first failing stage", async () => {
  assert.equal((await diagnoseXmlTarget({ target: target(4, 4), terms: [], readText, findJava, call: stubCall().call })).label, "NOT_STATEMENT");
  const otherNs = { "a/M.xml": XML.replace("demo.dao.UserMapper", "demo.dao.Gone") };
  assert.equal((await diagnoseXmlTarget({ target: { path: "a/M.xml", startLine: 5, endLine: 8 }, terms: [], readText: async f => otherNs[f] ?? null, findJava, call: stubCall().call })).label, "NO_NAMESPACE_TYPE");
  const renamed = { ...files, "app/src/main/java/demo/dao/UserMapper.java": JAVA.replace("selectByName", "findByName") };
  assert.equal((await diagnoseXmlTarget({ target: target(5, 8), terms: [], readText: async f => renamed[f] ?? null, findJava, call: stubCall().call })).label, "NO_SAME_NAMED_METHOD");
  const missing = await diagnoseXmlTarget({ target: target(5, 8), terms: ["order_total"], readText, findJava, call: stubCall({ probe: [noise] }).call });
  assert.equal(missing.label, "DOC_NOT_RETRIEVED");
  assert.equal(missing.termsHitDoc, false, "the vocabulary check is recorded even when retrieval fails first");
  const deep = await diagnoseXmlTarget({ target: target(5, 8), terms: [], readText, findJava, call: stubCall({ probe: [...Array(9).fill(noise), xmlCandidate(5, 8)] }).call });
  assert.deepEqual([deep.label, deep.probe], ["DOC_RANK_GT8", 10]);
  assert.equal((await diagnoseXmlTarget({ target: target(5, 8), terms: ["user_info"], readText, findJava, call: stubCall({ probe: [xmlCandidate(5, 8)] }).call })).label, "REACHABLE");
  assert.equal((await diagnoseXmlTarget({ target: target(5, 8), terms: ["order_total"], readText, findJava, call: stubCall({ probe: [xmlCandidate(5, 8)] }).call })).label, "TERMS_MISS_DOC");
});

test("impact at the mapper method and the probe use the driver's shapes; the summary is counts only", async () => {
  const { call, calls } = stubCall({ probe: [xmlCandidate(5, 8)], impactSpans: [{ s: 5, e: 8 }] });
  const covered = await diagnoseXmlTarget({ target: target(5, 8), terms: ["user_info"], readText, findJava, call });
  assert.equal(covered.impact, "COVERED");
  assert.deepEqual(calls.map(item => [item.name, item.query ?? null, item.searchMode ?? null, item.mode ?? null, item.verbosity ?? null]), [
    ["java_symbol", "demo.dao.UserMapper#selectByName", null, null, null],
    ["java_impact", null, null, "balanced", "compact"],
    ["java_symbol", "selectByName", "text", null, null]
  ]);
  assert.equal((await diagnoseXmlTarget({ target: target(5, 8), terms: [], readText, findJava, call: stubCall({ impactSpans: [{ s: 5, e: 6 }] }).call })).impact, "SELECTED_RANGE_MISS");
  assert.equal((await diagnoseXmlTarget({ target: target(5, 8), terms: [], readText, findJava, call: stubCall({ method: false }).call })).impact, "NO_METHOD_CANDIDATE");
  const summary = summarizeXml([covered, { label: "NOT_STATEMENT", element: "sql", impact: null, probe: null, termsHitDoc: null }]);
  assert.deepEqual(Object.keys(summary.byLabel), [...LADDER]);
  assert.equal(summary.byLabel.REACHABLE, 1);
  assert.deepEqual(summary.byElement, { select: 1, sql: 1 });
  assert.deepEqual(summary.impactAtMapperMethod, { COVERED: 1 });
  assert.deepEqual(summary.termsHitDocAmongBound, { yes: 1, no: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /UserMapper|selectByName/);
});
