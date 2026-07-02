import assert from "node:assert/strict";
import test from "node:test";
import { genericJavaPolicy, legacyRoutingPolicy, lishueduLegacyPolicy, resolveRoutingPolicy, scoreWithPolicy } from "./routing-policy.js";
import type { ImpactOptions, ResolvedAnchor } from "./agent-types.js";
import type { PathContext } from "./repo-layout.js";

test("legacy routing policy preserves parser boosts and penalties", () => {
  const anchor = {
    path: "modules/school/src/main/java/demo/SchoolTemplateImportParser.java",
    module: "school",
    profile: "parser"
  } as ResolvedAnchor;
  const options = {
    focusModules: ["school"],
    taskKeywords: []
  } as unknown as ImpactOptions;

  assert.equal(scoreWithPolicy(legacyRoutingPolicy, "java", context("modules/school/src/main/java/demo/SchoolTemplateImportDiffBuilder.java", "school", "main"), anchor, options), 154);
  assert.equal(scoreWithPolicy(legacyRoutingPolicy, "java", context("modules/school/src/main/java/demo/SchoolTemplateImportTaskRepository.java", "school", "main"), anchor, options), 46);
  assert.equal(scoreWithPolicy(legacyRoutingPolicy, "tests", context("modules/school/src/test/java/demo/SchoolTemplateImportExcelParserTest.java", "school", "test"), anchor, options), 198);
});

test("generic policy contains no lishuedu-specific tokens", () => {
  const serialized = JSON.stringify(genericJavaPolicy.scoreRules.map(rule => String(rule.when.pathRegex)));
  for (const token of ["ProductView", "ParentBenefit", "SignedUrl", "ParsedTemplate", "DiffBuilder", "ExcelParserTest", "BenefitEntitlementAssemblerTest"]) {
    assert.equal(serialized.includes(token), false, `generic policy leaked ${token}`);
  }
});

test("lishuedu legacy policy keeps its original rule ids", () => {
  const ids = lishueduLegacyPolicy.scoreRules.map(rule => rule.id);
  for (const id of ["profile.parser.tests", "profile.dto.tests", "profile.dto.family", "profile.port.family"]) {
    assert.ok(ids.includes(id), `legacy policy missing ${id}`);
  }
});

test("resolveRoutingPolicy picks by env override then repo basename", () => {
  process.env.JAVA_LSP_ROUTING_POLICY = "generic-java";
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "generic-java");
  process.env.JAVA_LSP_ROUTING_POLICY = "lishuedu-legacy";
  assert.equal(resolveRoutingPolicy("/x/other").id, "lishuedu-legacy");
  delete process.env.JAVA_LSP_ROUTING_POLICY;
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "lishuedu-legacy");
  assert.equal(resolveRoutingPolicy("/x/cipherlink").id, "generic-java");
});

function context(relativePath: string, module: string, sourceSet: string): PathContext {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    module,
    sourceSet
  };
}
