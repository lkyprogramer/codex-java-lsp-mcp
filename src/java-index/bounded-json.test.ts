import assert from "node:assert/strict";
import test from "node:test";
import { JSON_STRINGIFY_CAP_BYTES, jsonStringifyBounded, truncateToJsonCap } from "./bounded-json.js";

test("jsonStringifyBounded never stringifies a payload above the cap as one array", () => {
  const items = Array.from({ length: 40 }, () => "x".repeat(1024 * 1024));
  const cap = 8 * 1024 * 1024;
  const result = jsonStringifyBounded(items, cap);
  assert.equal(result.truncated, true);
  assert.ok(result.bytes <= cap, `bounded json ${result.bytes} exceeded cap ${cap}`);
  assert.ok(result.json.startsWith("["));
  assert.ok(result.json.endsWith("]"));
  const parsed = JSON.parse(result.json) as string[];
  assert.ok(parsed.length < items.length);
  assert.ok(parsed.length >= 1);
});

test("truncateToJsonCap drops trailing array elements so JSON stays under the cap", () => {
  const items = Array.from({ length: 20 }, () => "y".repeat(1024 * 1024));
  const cap = 5 * 1024 * 1024;
  const truncated = truncateToJsonCap(items, cap);
  const json = JSON.stringify(truncated);
  assert.ok(Buffer.byteLength(json, "utf8") <= cap);
  assert.ok(Array.isArray(truncated) && truncated.length < items.length);
});

test("default cap is 32 MiB and the worker respond helper truncates to it", () => {
  assert.equal(JSON_STRINGIFY_CAP_BYTES, 32 * 1024 * 1024);
  const items = Array.from({ length: 40 }, () => "z".repeat(1024 * 1024));
  const capped = truncateToJsonCap({ id: 1, ok: true, value: items });
  const json = jsonStringifyBounded(capped);
  assert.ok(json.bytes <= JSON_STRINGIFY_CAP_BYTES);
  assert.ok(Array.isArray((capped as { value: unknown[] }).value));
  assert.ok((capped as { value: unknown[] }).value.length < items.length);
});
