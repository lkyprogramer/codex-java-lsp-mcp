import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FREEMEM_PRESSURE_BYTES,
  DEFAULT_HIBERNATE_TTL_MS,
  nonNegativeInteger,
  parsePrewarmHotSet,
  resourceDefaults
} from "./resource-defaults.js";

test("hibernate TTL is 5 minutes on every machine class", () => {
  const defaults = resourceDefaults();
  assert.equal(defaults.hibernateTtlMs, DEFAULT_HIBERNATE_TTL_MS);
  assert.equal(DEFAULT_HIBERNATE_TTL_MS, 300000);
  assert.equal(DEFAULT_FREEMEM_PRESSURE_BYTES, 2 * 1024 * 1024 * 1024);
  assert.ok(defaults.idleTtlMs >= defaults.hibernateTtlMs);
});

test("parsePrewarmHotSet defaults to lishuedu,lishu-v2 and ignores unknown aliases", () => {
  const parsed = parsePrewarmHotSet(["lishuedu", "cipherlink", "lishu-v2"], "");
  assert.deepEqual([...parsed.hot].sort(), ["lishu-v2", "lishuedu"].sort());
  assert.deepEqual(parsed.ignored, []);
  const ignored = parsePrewarmHotSet(["lishuedu"], "lishuedu,nope,lishu-v2");
  assert.deepEqual([...ignored.hot], ["lishuedu"]);
  assert.deepEqual(ignored.ignored, ["nope", "lishu-v2"]);
});

test("nonNegativeInteger treats 0 as disable rather than falling back", () => {
  assert.equal(nonNegativeInteger("0", 1_200_000), 0);
  assert.equal(nonNegativeInteger(undefined, 1_200_000), 1_200_000);
});
