import assert from "node:assert/strict";
import test from "node:test";
import { legacyRoutingPolicy, scoreWithPolicy } from "./routing-policy.js";
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

function context(relativePath: string, module: string, sourceSet: string): PathContext {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    module,
    sourceSet
  };
}
