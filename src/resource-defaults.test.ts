import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FREEMEM_PRESSURE_BYTES,
  nonNegativeInteger,
  resourceDefaults
} from "./resource-defaults.js";

test("resource defaults expose JDT idle and omit heap hibernate TTL", () => {
  const previous = process.env.JAVA_LSP_HIBERNATE_TTL_MS;
  process.env.JAVA_LSP_HIBERNATE_TTL_MS = "1";
  try {
    const defaults = resourceDefaults();
    assert.equal(DEFAULT_FREEMEM_PRESSURE_BYTES, 2 * 1024 * 1024 * 1024);
    assert.ok(defaults.idleTtlMs > 0);
    assert.equal("hibernateTtlMs" in defaults, false);
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_HIBERNATE_TTL_MS;
    else process.env.JAVA_LSP_HIBERNATE_TTL_MS = previous;
  }
});

test("nonNegativeInteger treats 0 as disable rather than falling back", () => {
  assert.equal(nonNegativeInteger("0", 1_200_000), 0);
  assert.equal(nonNegativeInteger(undefined, 1_200_000), 1_200_000);
});
