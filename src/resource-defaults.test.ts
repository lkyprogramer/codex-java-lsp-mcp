import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FREEMEM_PRESSURE_BYTES, DEFAULT_HIBERNATE_TTL_MS, resourceDefaults } from "./resource-defaults.js";

test("hibernate TTL is 5 minutes on every machine class", () => {
  const defaults = resourceDefaults();
  assert.equal(defaults.hibernateTtlMs, DEFAULT_HIBERNATE_TTL_MS);
  assert.equal(DEFAULT_HIBERNATE_TTL_MS, 300000);
  assert.equal(DEFAULT_FREEMEM_PRESSURE_BYTES, 2 * 1024 * 1024 * 1024);
  assert.ok(defaults.idleTtlMs >= defaults.hibernateTtlMs);
});
