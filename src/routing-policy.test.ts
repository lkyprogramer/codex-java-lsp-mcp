import assert from "node:assert/strict";
import test from "node:test";
import * as routingPolicies from "./routing-policy.js";
import { genericJavaPolicy, lishueduPolicy, resolveRoutingPolicy, scoreWithPolicy } from "./routing-policy.js";
import type { ImpactOptions, ResolvedAnchor } from "./agent-types.js";
import type { PathContext } from "./repo-layout.js";

test("lishuedu discovery policy preserves parser boosts and penalties", () => {
  const anchor = {
    path: "modules/school/src/main/java/demo/SchoolTemplateImportParser.java",
    module: "school",
    profile: "parser"
  } as ResolvedAnchor;
  const options = {
    focusModules: ["school"],
    taskKeywords: []
  } as unknown as ImpactOptions;

  assert.equal(scoreWithPolicy(lishueduPolicy, "java", context("modules/school/src/main/java/demo/SchoolTemplateImportDiffBuilder.java", "school", "main"), anchor, options), 154);
  assert.equal(scoreWithPolicy(lishueduPolicy, "java", context("modules/school/src/main/java/demo/SchoolTemplateImportTaskRepository.java", "school", "main"), anchor, options), 46);
  assert.equal(scoreWithPolicy(lishueduPolicy, "tests", context("modules/school/src/test/java/demo/SchoolTemplateImportExcelParserTest.java", "school", "test"), anchor, options), 198);
});

test("generic policy contains no lishuedu-specific tokens", () => {
  const serialized = JSON.stringify(genericJavaPolicy.scoreRules.map(rule => String(rule.when.pathRegex)));
  for (const token of ["ProductView", "ParentBenefit", "SignedUrl", "ParsedTemplate", "DiffBuilder", "ExcelParserTest", "BenefitEntitlementAssemblerTest"]) {
    assert.equal(serialized.includes(token), false, `generic policy leaked ${token}`);
  }
});

test("lishuedu discovery policy keeps its original rule ids", () => {
  const ids = lishueduPolicy.scoreRules.map(rule => rule.id);
  for (const id of ["profile.parser.tests", "profile.dto.tests", "profile.dto.family", "profile.port.family"]) {
    assert.ok(ids.includes(id), `legacy policy missing ${id}`);
  }
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

function context(relativePath: string, module: string, sourceSet: string): PathContext {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    module,
    sourceSet
  };
}
