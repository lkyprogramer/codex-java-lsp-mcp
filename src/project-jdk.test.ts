import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectBuildSystem, resolveProjectJdk } from "./project-jdk.js";

test("detects Maven Java 8 requirement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-maven-"));
  await writeFile(path.join(root, "pom.xml"), `
<project>
  <properties>
    <maven.compiler.source>1.8</maven.compiler.source>
  </properties>
</project>`);

  const status = resolveProjectJdk(root);
  assert.equal(detectBuildSystem(root), "maven");
  assert.equal(status.requiredMajor, 8);
  assert.equal(status.runtimeName, "JavaSE-1.8");
  assert.equal(status.primarySource, "maven");
});

test("detects Gradle JavaLanguageVersion requirement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-gradle-"));
  await writeFile(path.join(root, "settings.gradle.kts"), "");
  await writeFile(path.join(root, "build.gradle.kts"), "java { toolchain { languageVersion.set(JavaLanguageVersion.of(25)) } }");

  const status = resolveProjectJdk(root);
  assert.equal(detectBuildSystem(root), "gradle");
  assert.equal(status.requiredMajor, 25);
  assert.equal(status.runtimeName, "JavaSE-25");
  assert.equal(status.primarySource, "gradle-toolchain");
});

test("alias-specific env override wins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-env-"));
  const fakeHome = path.join(root, "jdk-11");
  await mkdir(fakeHome);
  process.env.JAVA_LSP_PROJECT_JAVA_HOME_DEMO_APP = fakeHome;
  try {
    const status = resolveProjectJdk(root, ["demo-app"]);
    assert.equal(status.primarySource, "env-alias");
    assert.equal(status.resolvedHome, fakeHome);
  } finally {
    delete process.env.JAVA_LSP_PROJECT_JAVA_HOME_DEMO_APP;
  }
});
