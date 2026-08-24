import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareVersionsDesc, detectGeneratedCode } from "./generated-code.js";

test("detects Lombok and annotation processors from Gradle build", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-apt-"));
  await writeFile(path.join(root, "build.gradle.kts"), `
dependencies {
  annotationProcessor("org.projectlombok:lombok:1.18.42")
  annotationProcessor("org.mapstruct:mapstruct-processor:1.6.3")
}`);

  const status = detectGeneratedCode(root);
  assert.equal(status.lombok.detected, true);
  assert.equal(status.annotationProcessing.enabled, true);
  assert.ok(status.annotationProcessing.detectedProcessors.includes("lombok"));
  assert.ok(status.annotationProcessing.detectedProcessors.includes("mapstruct"));
});

test("detects Lombok from common module build files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-module-apt-"));
  await mkdir(path.join(root, "modules", "core"), { recursive: true });
  await writeFile(path.join(root, "settings.gradle.kts"), "include(\":modules:core\")");
  await writeFile(path.join(root, "modules", "core", "build.gradle.kts"), `
dependencies {
  annotationProcessor("org.projectlombok:lombok:1.18.42")
}`);

  const status = detectGeneratedCode(root);

  assert.equal(status.lombok.detected, true);
  assert.equal(status.annotationProcessing.enabled, true);
  assert.ok(status.annotationProcessing.detectedProcessors.includes("lombok"));
});

test("JAVA_LSP_LOMBOK_JAR enables Lombok agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-lombok-"));
  const jar = path.join(root, "lombok.jar");
  await writeFile(path.join(root, "pom.xml"), "<project><dependencies><dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.42</version></dependency></dependencies></project>");
  await writeFile(jar, "");
  process.env.JAVA_LSP_LOMBOK_JAR = jar;
  try {
    const status = detectGeneratedCode(root);
    assert.equal(status.lombok.status, "enabled");
    assert.equal(status.lombok.jar, jar);
    assert.equal(status.generatedCodeSemantics, "ok");
  } finally {
    delete process.env.JAVA_LSP_LOMBOK_JAR;
  }
});

test("Gradle cache resolver skips Lombok sources and javadoc jars", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "java-lsp-lombok-home-"));
  const versionDir = path.join(home, ".gradle", "caches", "modules-2", "files-2.1", "org.projectlombok", "lombok", "1.18.42");
  await mkdir(path.join(versionDir, "aaa"), { recursive: true });
  await mkdir(path.join(versionDir, "bbb"), { recursive: true });
  await writeFile(path.join(versionDir, "aaa", "lombok-1.18.42-sources.jar"), "");
  await writeFile(path.join(versionDir, "aaa", "lombok-1.18.42-javadoc.jar"), "");
  const agentJar = path.join(versionDir, "bbb", "lombok-1.18.42.jar");
  await writeFile(agentJar, "");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-lombok-repo-"));
  await writeFile(path.join(root, "build.gradle.kts"), `annotationProcessor("org.projectlombok:lombok:1.18.42")`);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const status = detectGeneratedCode(root);
    assert.equal(status.lombok.jar, agentJar);
    assert.equal(status.lombok.agentEnabled, true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("semantic version sorting prefers 1.18.38 over 1.18.4", () => {
  assert.deepEqual(["1.18.4", "1.18.38", "1.18.30"].sort(compareVersionsDesc), ["1.18.38", "1.18.30", "1.18.4"]);
});
