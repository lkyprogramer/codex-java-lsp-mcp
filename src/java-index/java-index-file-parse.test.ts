import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveJavaSourceLayout } from "./java-index-file-parse.js";

test("deriveJavaSourceLayout prefers a layout-probe modules/ prefix over classifyPath", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-file-parse-layout-"));
  const relativePath = "modules/foo/src/main/java/demo/A.java";
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "package demo; class A {}\n");
  const layout = deriveJavaSourceLayout(
    repoRoot,
    absolutePath,
    { sourceRoots: [{ relativePath: "modules/foo/src/main/java", module: "foo", sourceSet: "main" }] }
  );
  assert.equal(layout.relativePath, relativePath);
  assert.equal(layout.sourceRoot, "modules/foo/src/main/java");
});
