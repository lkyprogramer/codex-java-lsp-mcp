import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectBuildSystem, resetInstalledJdksCacheForTests, resolveProjectJdk, warmupInstalledJdks } from "./project-jdk.js";

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

test("warmupInstalledJdks caches discovery so later resolves reuse the same list", async () => {
  resetInstalledJdksCacheForTests();
  const first = await warmupInstalledJdks();
  const second = await warmupInstalledJdks();
  assert.equal(first, second);
  resetInstalledJdksCacheForTests();
});

test("basename-parseable JAVA_HOME does not need java -version to resolve a major", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-labeled-jdk-"));
  await writeFile(path.join(root, "pom.xml"), `
<project>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
  </properties>
</project>`);
  const fakeHome = path.join(root, "21.0.2-tem");
  await mkdir(path.join(fakeHome, "bin"), { recursive: true });
  await writeFile(path.join(fakeHome, "bin", "java"), "#!/bin/sh\nexit 1\n");
  const previousHome = process.env.JAVA_HOME;
  process.env.JAVA_HOME = fakeHome;
  resetInstalledJdksCacheForTests();
  try {
    const status = resolveProjectJdk(root);
    assert.equal(status.requiredMajor, 21);
    assert.equal(status.candidates.some(label => label.startsWith("21:")), true);
  } finally {
    resetInstalledJdksCacheForTests();
    if (previousHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = previousHome;
  }
});

test("listInstalledJdks survives a JAVA_HOME whose java -version has no stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-silent-jdk-"));
  await writeFile(path.join(root, "pom.xml"), `
<project>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
  </properties>
</project>`);
  const fakeHome = path.join(root, "Contents", "Home");
  await mkdir(path.join(fakeHome, "bin"), { recursive: true });
  // Present but not executable: spawnSync yields null stderr, which used to throw in parseMajor.
  await writeFile(path.join(fakeHome, "bin", "java"), "");
  const previousHome = process.env.JAVA_HOME;
  process.env.JAVA_HOME = fakeHome;
  resetInstalledJdksCacheForTests();
  try {
    const status = resolveProjectJdk(root);
    assert.equal(status.requiredMajor, 17);
    assert.equal(status.primarySource, "maven");
  } finally {
    resetInstalledJdksCacheForTests();
    if (previousHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = previousHome;
  }
});
