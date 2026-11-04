import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { probeLayout, probeLayoutOffThread } from "./layout-probe.js";

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
  await mkdir(path.join(root, "exam-service", "exam-service-candidate", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "exam-service", "exam-service-candidate", "src", "test", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "report", "src", "main", "resources"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><packaging>pom</packaging><modules><module>exam-management</module><module>exam-service</module><module>report</module></modules></project>\n");

  const layout = await probeLayout(root, "maven-reactor");

  assert.equal(layout.layout, "maven-multi");
  assert.ok(layout.sourceRoots.some(item => item.module === "exam-management" && item.relativePath === path.join("exam-management", "src", "main", "java")));
  assert.ok(layout.sourceRoots.some(item => item.module === "exam-service-candidate" && item.relativePath === path.join("exam-service", "exam-service-candidate", "src", "main", "java")));
  assert.ok(layout.sourceRoots.some(item => item.module === "exam-service-candidate" && item.relativePath === path.join("exam-service", "exam-service-candidate", "src", "test", "java")));
  assert.ok(layout.resourceRoots.includes(path.join("report", "src", "main", "resources")));
  assert.deepEqual(layout.broadRoots.sort(), ["exam-management", "exam-service", "report"]);
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

test("probeLayout never descends linked-worktree containers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-layout-worktrees-"));
  await mkdir(path.join(root, "modules", "live", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, ".worktrees", "peer", "modules", "shadow", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "settings.gradle"), "include ':modules:live'\n");

  const layout = await probeLayout(root, "ddd-gradle");

  assert.ok(layout.sourceRoots.some(item => item.relativePath === path.join("modules", "live", "src", "main", "java")));
  assert.equal(layout.sourceRoots.some(item => item.relativePath.startsWith(`${path.join(".worktrees")}${path.sep}`)), false);
});

test("probeLayout reports roots reached through a symlink instead of walking them", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "java-lsp-layout-symlink-")));
  const root = path.join(base, "repo");
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "shared", "java", "demo"), { recursive: true });
  await mkdir(path.join(base, "outside", "java"), { recursive: true });
  await mkdir(path.join(base, "outside", "module", "src", "main", "resources"), { recursive: true });
  for (const module of ["inrepo", "alias", "ext"]) await mkdir(path.join(root, module, "src", "main"), { recursive: true });
  await symlink("../../../shared/java", path.join(root, "inrepo", "src", "main", "java"));
  await symlink("../../../src/main/java", path.join(root, "alias", "src", "main", "java"));
  await symlink(path.join(base, "outside", "java"), path.join(root, "ext", "src", "main", "java"));
  // A symlinked ancestor hides the link from an lstat of the root itself.
  await symlink(path.join(base, "outside", "module"), path.join(root, "linkedmod"));
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");

  const layout = probeLayout(root, "generic-java");

  assert.deepEqual(layout.sourceRoots.map(item => item.relativePath), [path.join("src", "main", "java")]);
  assert.deepEqual(layout.resourceRoots, []);
  assert.equal(layout.moduleBases.includes("linkedmod"), false, "linked module is not a build marker base");
  assert.deepEqual(layout.symlinkedRoots, [
    path.join("alias", "src", "main", "java"),
    path.join("ext", "src", "main", "java"),
    path.join("inrepo", "src", "main", "java"),
    path.join("linkedmod", "src", "main", "resources")
  ]);
  assert.equal(probeLayout(path.join(base, "outside", "module")).symlinkedRoots, undefined, "a plain layout reports no symlinked root");
});

test("probeLayoutOffThread returns probeLayout's result, keeps fs errors, and leaves the process free to exit", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "java-lsp-layout-offthread-")));
  await mkdir(path.join(root, "exam-service", "candidate", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "report", "src", "main", "resources"), { recursive: true });
  await mkdir(path.join(root, "shared", "java"), { recursive: true });
  await mkdir(path.join(root, "linked", "src", "main"), { recursive: true });
  await symlink("../../../shared/java", path.join(root, "linked", "src", "main", "java"));
  await writeFile(path.join(root, "pom.xml"), "<project><modules><module>exam-service</module><module>report</module></modules></project>\n");

  const [first, second] = await Promise.all([probeLayoutOffThread(root, "maven-reactor"), probeLayoutOffThread(root)]);
  assert.deepEqual(first, probeLayout(root, "maven-reactor"));
  assert.deepEqual(second, probeLayout(root));

  // An unreadable module directory fails the walk with its errno, and the next probe still answers.
  const sealed = path.join(root, "sealed");
  await mkdir(path.join(sealed, "inner"), { recursive: true });
  await chmod(sealed, 0o000);
  try {
    await assert.rejects(probeLayoutOffThread(root), (error: NodeJS.ErrnoException) => error.code === "EACCES");
  } finally {
    await chmod(sealed, 0o755);
  }
  assert.deepEqual(await probeLayoutOffThread(root), probeLayout(root));
  // The test runner's exit after this file is the check that an idle worker holds no ref.
});
