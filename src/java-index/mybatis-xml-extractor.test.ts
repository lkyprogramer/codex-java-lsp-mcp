import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMyBatisMapperFacts, locateMapperElementRange } from "./mybatis-xml-extractor.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "framework-mybatis");

function extract(content: string, relativePath = "src/main/resources/mapper/OrderMapper.xml") {
  return extractMyBatisMapperFacts({ relativePath, content, contentHash: "test", generation: 1 });
}

test("extractMyBatisMapperFacts reads namespace, statements, resultMaps and includes from a real mapper file", () => {
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");

  const facts = extract(content, relativePath);

  assert.ok(facts);
  assert.equal(facts.namespace, "demo.OrderMapper");
  assert.equal(facts.resourceId, `mybatis-resource:${relativePath}`);
  assert.deepEqual(facts.statements.map(s => `${s.kind}:${s.id}`), ["select:findById", "insert:insert"]);
  assert.equal(facts.statements[0]?.statementId, "mybatis-statement:demo.OrderMapper.findById");
  assert.equal(facts.statements[0]?.parameterType, "java.lang.Long");
  assert.equal(facts.statements[0]?.resultMap, "OrderMap");
  assert.equal(facts.statements[1]?.parameterType, "demo.OrderEntity");
  assert.equal(facts.resultMaps[0]?.type, "demo.OrderEntity");
  assert.equal(facts.resultMaps[0]?.resultMapId, "mybatis-resultmap:demo.OrderMapper.OrderMap");
  assert.deepEqual(facts.includes, [{ fromStatementId: "mybatis-statement:demo.OrderMapper.findById", refid: "orderColumns" }]);
  assert.equal(facts.parseState, "COMPLETE");
});

test("extractMyBatisMapperFacts populates ranges located by scanning the original XML text", () => {
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");

  const facts = extract(content, relativePath);

  const findById = facts?.statements.find(s => s.id === "findById");
  assert.ok(findById?.range);
  assert.equal(content.slice(offsetOf(content, findById!.range!.start), offsetOf(content, findById!.range!.end)),
    content.slice(content.indexOf('<select id="findById"'), content.indexOf("</select>") + "</select>".length));

  assert.ok(facts?.resultMaps[0]?.range);
  const resultMapRange = facts!.resultMaps[0]!.range!;
  assert.equal(content.slice(offsetOf(content, resultMapRange.start), offsetOf(content, resultMapRange.end)),
    content.slice(content.indexOf('<resultMap id="OrderMap"'), content.indexOf("</resultMap>") + "</resultMap>".length));
});

function offsetOf(text: string, position: { line: number; column: number }): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line - 1; i++) offset += lines[i]!.length + 1;
  return offset + position.column - 1;
}

test("a non-mapper root element yields undefined - not a MyBatis resource, never a FAILED fact", () => {
  const facts = extract('<?xml version="1.0"?><beans><bean id="x"/></beans>', "src/main/resources/beans.xml");
  assert.equal(facts, undefined);
});

test("malformed content under a <mapper> root returns FAILED and never throws", () => {
  assert.doesNotThrow(() => extract('<mapper><select id="x">no namespace, no close'));
  const noNamespace = extract('<mapper><select id="x">no namespace, no close');
  assert.equal(noNamespace?.parseState, "FAILED");
  assert.deepEqual(noNamespace?.statements, []);

  assert.doesNotThrow(() => extract('<mapper namespace="demo.X"><select id="x">oops<broken'));
  const unterminated = extract('<mapper namespace="demo.X"><select id="x">oops<broken');
  assert.equal(unterminated?.parseState, "FAILED");
});

test("a mapper with mismatched closing tags returns FAILED instead of trusted facts", () => {
  const facts = extract(`
<mapper namespace="demo.OrderMapper">
  <select id="findById"></insert>
</mapper>`);

  assert.equal(facts?.parseState, "FAILED");
  assert.deepEqual(facts?.statements, []);
});

test("extractMyBatisMapperFacts collects includes nested below dynamic statement elements", () => {
  const facts = extract(`
<mapper namespace="demo.OrderMapper">
  <select id="findById">
    <if test="enabled"><include refid="enabledColumns"/></if>
  </select>
</mapper>`);

  assert.deepEqual(facts?.includes, [{
    fromStatementId: "mybatis-statement:demo.OrderMapper.findById",
    refid: "enabledColumns"
  }]);
});

test("locateMapperElementRange returns undefined for a duplicate (tag, id) pair rather than guessing", () => {
  const xml = '<mapper namespace="demo.X"><select id="dup">a</select><select id="dup">b</select></mapper>';
  assert.equal(locateMapperElementRange(xml, "select", "dup"), undefined);

  const facts = extract(xml, "d.xml");
  assert.deepEqual(facts?.statements.map(s => s.range), [undefined, undefined]);
});

test("locateMapperElementRange handles a self-closing statement element", () => {
  const xml = '<mapper namespace="demo.X"><select id="x" parameterType="Y"/></mapper>';
  const range = locateMapperElementRange(xml, "select", "x");
  assert.ok(range);
  assert.equal(xml.slice(offsetOf(xml, range!.start), offsetOf(xml, range!.end)), '<select id="x" parameterType="Y"/>');
});

test("locateMapperElementRange skips past nested same-shaped elements to the correct closing tag", () => {
  const xml = '<mapper namespace="demo.X"><select id="x"><where><if test="a">a=1</if></where></select></mapper>';
  const range = locateMapperElementRange(xml, "select", "x");
  assert.ok(range);
  assert.equal(xml.slice(offsetOf(xml, range!.start), offsetOf(xml, range!.end)),
    '<select id="x"><where><if test="a">a=1</if></where></select>');
});

test("locateMapperElementRange returns undefined when the element is never closed", () => {
  const xml = '<mapper namespace="demo.X"><select id="x">unterminated</mapper>';
  assert.equal(locateMapperElementRange(xml, "select", "x"), undefined);
});
