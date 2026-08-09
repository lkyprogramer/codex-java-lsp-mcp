import assert from "node:assert/strict";
import test from "node:test";
import * as routingPolicies from "./routing-policy.js";
import { genericJavaPolicy, lishueduPolicy, resolveRoutingPolicy } from "./routing-policy.js";

test("routing policy selects a family pack without exposing additive score state", () => {
  assert.deepEqual(Object.keys(genericJavaPolicy), ["id"]);
  assert.deepEqual(Object.keys(lishueduPolicy), ["id"]);
  assert.equal("scoreWithPolicy" in routingPolicies, false);
});

test("resolveRoutingPolicy picks by env override then repo basename", () => {
  process.env.JAVA_LSP_ROUTING_POLICY = "generic-java";
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "generic-java");
  process.env.JAVA_LSP_ROUTING_POLICY = "lishuedu-legacy";
  assert.equal(resolveRoutingPolicy("/x/other").id, "lishuedu");
  delete process.env.JAVA_LSP_ROUTING_POLICY;
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "lishuedu");
  assert.equal(resolveRoutingPolicy("/x/cipherlink").id, "generic-java");
});

test("family ranking resolves the selected generic or lishuedu policy pack", () => {
  const resolveFamilyRankPolicy = (routingPolicies as unknown as {
    resolveFamilyRankPolicy?: (policy: { id: string }) => { id: string };
  }).resolveFamilyRankPolicy;
  assert.equal(typeof resolveFamilyRankPolicy, "function", "Task 25 must not hard-code the generic policy at the final ranking boundary");
  assert.equal(resolveFamilyRankPolicy!(genericJavaPolicy).id, "generic-java");
  assert.equal(resolveFamilyRankPolicy!(lishueduPolicy).id, "lishuedu");
});

test("legacy lishuedu override resolves to the supported lishuedu policy id", () => {
  const previous = process.env.JAVA_LSP_ROUTING_POLICY;
  try {
    process.env.JAVA_LSP_ROUTING_POLICY = "lishuedu-legacy";
    assert.equal(resolveRoutingPolicy("/x/other").id, "lishuedu");
  } finally {
    if (previous === undefined) {
      delete process.env.JAVA_LSP_ROUTING_POLICY;
    } else {
      process.env.JAVA_LSP_ROUTING_POLICY = previous;
    }
  }
});
