import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmitAnswerTool, validateSubmission, parseStrictAnswer, loadPublicAnswerContract, MAX_STRICT_ANSWER_CHARS } from "./eval-answer-contract.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const keys = { name: "string", enabled: "boolean", count: "integer", values: "array" };
test("public submission schema has exact required keys/types without value constraints", () => {
  const tool = buildSubmitAnswerTool(keys);
  assert.equal(tool.function.name, "submit_answer");
  assert.deepEqual(tool.function.parameters.required, Object.keys(keys));
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.deepEqual(tool.function.parameters.properties.values, { type: "array" });
  assert.throws(() => buildSubmitAnswerTool({ name: "gold-enum" }), /unsupported/);
  assert.equal(validateSubmission('{"name":"wrong factual value","enabled":false,"count":2,"values":[{},false,3]}', keys).ok, true);
});
test("strict parser preserves duplicate nesting, escaping, syntax and input limits", () => {
  for (const input of ['{"x":1,"x":2}', '{"x":{"nested":1,"nested":2}}']) {
    assert.equal(parseStrictAnswer(input).reason, "duplicate_keys");
  }
  // Decode escaped keys consistently with the frozen object_pairs_hook.
  assert.equal(parseStrictAnswer('{"x":1,"\\u0078":2}').reason, "duplicate_keys");
  assert.equal(parseStrictAnswer('{"nested":{"x":1,"\\u0078":2}}').reason, "duplicate_keys");
  assert.equal(parseStrictAnswer('{"first":{"x":1},"second":{"x":2}}').ok, true);
  assert.equal(parseStrictAnswer('{"a\\\"b":1,"a\\u0022b":2}').reason, "duplicate_keys");
  assert.equal(validateSubmission('{"x":1,"\\u0078":2}', { x: "integer" }).reason, "duplicate_keys");
  assert.equal(parseStrictAnswer('prefix {"x":1}').reason, "parse_error");
  assert.equal(parseStrictAnswer('{"x":1} suffix').reason, "parse_error");
  assert.equal(parseStrictAnswer('[1]').reason, "not_object");
  assert.equal(parseStrictAnswer(null).reason, "not_string");
  assert.equal(parseStrictAnswer('x'.repeat(MAX_STRICT_ANSWER_CHARS + 1)).reason, "input_too_long");
  assert.deepEqual(parseStrictAnswer(' {"x":{"name":"value"},"y":[]} ').value, { x: { name: "value" }, y: [] });
});
test("submission rejects missing/extra keys and type mismatches without coercion", () => {
  for (const input of ['{}', '{"x":"yes","extra":1}']) assert.equal(validateSubmission(input, { x: "string" }).reason, "key_mismatch");
  for (const [type, value] of [["string", false], ["boolean", "true"], ["integer", 1.5], ["array", {}], ["string", null]]) {
    assert.equal(validateSubmission(JSON.stringify({ x: value }), { x: type }).reason, "type_mismatch");
  }
});

test("public field constraints share schema and validation without factual answers or normalization", () => {
  const answerKeys = { method: "string", tracks: "array", direction: "string", declaredType: "string", literal: "string", guard: "string" };
  const fields = {
    method: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", description: "Simple member name." },
    tracks: { type: "array", items: { type: "string" }, order: "lexical", description: "String values in lexical order." },
    direction: { type: "string", enum: ["head-to-tail", "tail-to-head"] },
    declaredType: { type: "string", minLength: 1 },
    literal: { type: "string" },
    guard: { type: "string", minLength: 1 }
  };
  const schema = buildSubmitAnswerTool(answerKeys, fields).function.parameters;
  assert.equal(schema.properties.method.pattern, fields.method.pattern);
  assert.deepEqual(schema.properties.tracks.items, { type: "string" });
  assert.equal(Object.hasOwn(schema.properties.tracks, "order"), false, "ordering is public metadata, not an unsupported JSON Schema keyword");
  const value = { method: "anyMethod", tracks: ["alpha", "beta"], direction: "tail-to-head", declaredType: "Set<String>", literal: "owner.VALUE\r\n quoted \"text\"", guard: "!flags.contains(name)" };
  assert.deepEqual(validateSubmission(JSON.stringify(value), answerKeys, fields).value, value, "expressions and literal bytes are never normalized");
  for (const [key, bad] of [["method", "pkg.Owner#anyMethod"], ["tracks", [{ track: "alpha" }]], ["tracks", ["beta", "alpha"]], ["direction", "tail_to_head"]]) {
    const rejected = validateSubmission(JSON.stringify({ ...value, [key]: bad }), answerKeys, fields);
    assert.equal(rejected.ok, false, key);
    assert.ok(rejected.key.startsWith(key));
  }
  assert.throws(() => buildSubmitAnswerTool(answerKeys, { ...fields, method: { type: "integer" } }), /public.*type|type.*public/i);
  assert.throws(() => buildSubmitAnswerTool(answerKeys, { ...fields, hidden: { type: "string" } }), /public.*key|key.*public/i);
});

test("contract loader binds exact bytes and rejects duplicate tasks and unsupported constraints", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "public-contract-"));
  try {
    const file = path.join(dir, "contract.json");
    const task = { id: "Q", properties: { method: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" } } };
    const doc = { schema: "java-specialist-public-answer-contract/v1.0", version: "public-qa/v1.0", tasks: [task] };
    const bytes = JSON.stringify(doc) + "\n";
    writeFileSync(file, bytes);
    const contract = loadPublicAnswerContract(file);
    assert.equal(contract.version, doc.version);
    assert.equal(contract.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(contract.tasks.get("Q"), task.properties);
    writeFileSync(file, JSON.stringify({ ...doc, tasks: [task, task] }));
    assert.throws(() => loadPublicAnswerContract(file), /duplicate/);
    writeFileSync(file, JSON.stringify({ ...doc, tasks: [{ ...task, properties: { method: { type: "string", goldValue: "secret" } } }] }));
    assert.throws(() => loadPublicAnswerContract(file), /unsupported public constraint/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
