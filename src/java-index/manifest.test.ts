import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "./manifest.js";

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
    files.map(file => file.relativePath).sort(),
    ["module/src/test/java/demo/BTest.java", "src/main/java/demo/A.java"]
  );
  const bFile = files.find(file => file.relativePath.endsWith("BTest.java"))!;
  assert.equal(bFile.sourceRoot, "module/src/test/java");
  assert.equal(bFile.absolutePath, path.join(root, "module/src/test/java/demo/BTest.java"));
});

test("a build/target directory nested inside a source root is not walked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-nested-"));
  write(root, "src/main/java/demo/Good.java", "class Good {}");
  write(root, "src/main/java/demo/build/Generated.java", "class Generated {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(files.map(file => file.relativePath), ["src/main/java/demo/Good.java"]);
});

test("a source root with no test tree does not fail the walk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-no-test-"));
  write(root, "src/main/java/demo/OnlyMain.java", "class OnlyMain {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(files.map(file => file.relativePath), ["src/main/java/demo/OnlyMain.java"]);
});

test("discoverMyBatisResourceFiles finds every .xml under src/main/resources, not src/test/resources, and skips build directories", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-resources-"));
  write(root, "src/main/resources/mapper/OrderMapper.xml", "<mapper namespace=\"demo.OrderMapper\"/>");
  write(root, "src/main/resources/application.properties", "a=1");
  write(root, "src/test/resources/mapper/TestMapper.xml", "<mapper namespace=\"demo.TestMapper\"/>");
  write(root, "src/main/resources/build/Generated.xml", "<mapper/>");
  write(root, "module-a/src/main/resources/mapper/ModuleAMapper.xml", "<mapper namespace=\"demo.ModuleAMapper\"/>");

  const layout = probeLayout(root);
  const files = await discoverMyBatisResourceFiles(root, layout);

  assert.deepEqual(
    files.map(file => file.relativePath).sort(),
    ["module-a/src/main/resources/mapper/ModuleAMapper.xml", "src/main/resources/mapper/OrderMapper.xml"]
  );
});

test("discoverMyBatisResourceFiles on a repo with no resources directory returns an empty list without failing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-no-resources-"));
  write(root, "src/main/java/demo/A.java", "class A {}");

  const layout = probeLayout(root);
  const files = await discoverMyBatisResourceFiles(root, layout);

  assert.deepEqual(files, []);
});
