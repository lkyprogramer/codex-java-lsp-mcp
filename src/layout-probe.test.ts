import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { probeLayout } from "./layout-probe.js";

test("probeLayout detects single-module Maven source roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-layout-single-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "src", "test", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");

  const layout = await probeLayout(root, "generic-java");

  assert.equal(layout.layout, "single");
  assert.ok(layout.sourceRoots.some(item => item.relativePath === path.join("src", "main", "java") && item.module === "."));
  assert.ok(layout.sourceRoots.some(item => item.relativePath === path.join("src", "test", "java") && item.sourceSet === "test"));
  assert.deepEqual(layout.broadRoots, ["."]);
});

test("probeLayout detects Maven reactor modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-layout-maven-"));
  await mkdir(path.join(root, "exam-management", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "report", "src", "main", "resources"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><packaging>pom</packaging><modules><module>exam-management</module><module>report</module></modules></project>\n");

  const layout = await probeLayout(root, "maven-reactor");

  assert.equal(layout.layout, "maven-multi");
  assert.ok(layout.sourceRoots.some(item => item.module === "exam-management" && item.relativePath === path.join("exam-management", "src", "main", "java")));
  assert.ok(layout.resourceRoots.includes(path.join("report", "src", "main", "resources")));
  assert.deepEqual(layout.broadRoots.sort(), ["exam-management", "report"]);
});

test("probeLayout detects Gradle modules/apps roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-layout-gradle-"));
  await mkdir(path.join(root, "modules", "school", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "apps", "admin", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "settings.gradle"), "include ':modules:school', ':apps:admin'\n");

  const layout = await probeLayout(root, "ddd-gradle");

  assert.equal(layout.layout, "gradle-multi");
  assert.ok(layout.sourceRoots.some(item => item.module === "school" && item.relativePath === path.join("modules", "school", "src", "main", "java")));
  assert.ok(layout.sourceRoots.some(item => item.module === "admin" && item.relativePath === path.join("apps", "admin", "src", "main", "java")));
  assert.deepEqual(layout.broadRoots.sort(), ["apps", "modules"]);
});
