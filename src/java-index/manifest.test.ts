import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { discoverJavaFiles } from "./manifest.js";

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

test("manifest discovers tracked and untracked Java files under source roots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-"));
  write(root, "src/main/java/demo/A.java", "class A {}");
  write(root, "module/src/test/java/demo/BTest.java", "class BTest {}");
  write(root, "target/generated/Ignore.java", "class Ignore {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(
    files.map(file => path.relative(root, file)).sort(),
    ["module/src/test/java/demo/BTest.java", "src/main/java/demo/A.java"]
  );
});

test("a build/target directory nested inside a source root is not walked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-nested-"));
  write(root, "src/main/java/demo/Good.java", "class Good {}");
  write(root, "src/main/java/demo/build/Generated.java", "class Generated {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(
    files.map(file => path.relative(root, file)).sort(),
    ["src/main/java/demo/Good.java"]
  );
});

test("a source root with no test tree does not fail the walk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-no-test-"));
  write(root, "src/main/java/demo/OnlyMain.java", "class OnlyMain {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(files.map(file => path.relative(root, file)), ["src/main/java/demo/OnlyMain.java"]);
});
