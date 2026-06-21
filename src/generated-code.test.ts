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

test("semantic version sorting prefers 1.18.38 over 1.18.4", () => {
  assert.deepEqual(["1.18.4", "1.18.38", "1.18.30"].sort(compareVersionsDesc), ["1.18.38", "1.18.30", "1.18.4"]);
});
