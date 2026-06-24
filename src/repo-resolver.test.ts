import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AliasRegistry } from "./alias-registry.js";
import { canonicalPath, isWithin, repoHash } from "./path-utils.js";
import { RepoResolver } from "./repo-resolver.js";

test("isWithin respects path segment boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-root-"));
  const child = path.join(root, "child");
  const sibling = `${root}-sibling`;
  await mkdir(child);
  await mkdir(sibling);

  assert.equal(isWithin(root, child), true);
  assert.equal(isWithin(root, sibling), false);
});

test("resolver uses deepest enabled absolute root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-repo-"));
  const nested = path.join(root, "nested");
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await mkdir(path.join(nested, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><packaging>pom</packaging><modules></modules></project>");
  await writeFile(path.join(nested, "pom.xml"), "<project></project>");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "root", root, lspEnabled: true, layoutProfile: "maven-reactor" },
      { id: "nested", root: nested, lspEnabled: true, layoutProfile: "generic-java" }
    ]
  }));

  const registry = new AliasRegistry(config);
  await registry.reloadIfChanged();
  const resolved = new RepoResolver(registry).resolveEnablement(nested);

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.configuredRoot, canonicalPath(nested));
  assert.equal(resolved.matchedBy, "direct-root");
});

test("resolver returns enable hint for unregistered repos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-unregistered-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({ aliases: [] }));

  const registry = new AliasRegistry(config);
  await registry.reloadIfChanged();
  const resolved = await new RepoResolver(registry).resolve({ repoRoot: root });

  assert.equal(resolved.lsp.enabled, false);
  assert.equal(resolved.lsp.matchedBy, "unregistered");
  assert.match(resolved.lsp.enableHint || "", /register-alias\.sh --enable-lsp/);
});

test("resolver reports where the repo root came from", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-root-source-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "demo", root, lspEnabled: true, layoutProfile: "maven-reactor" }
    ]
  }));

  const registry = new AliasRegistry(config);
  await registry.reloadIfChanged();
  const resolver = new RepoResolver(registry);

  assert.equal((await resolver.resolve({ repoRoot: root }) as unknown as { rootSource?: string }).rootSource, "explicit");
  assert.equal((await resolver.resolve({ projectId: "demo" }) as unknown as { rootSource?: string }).rootSource, "projectId");
  assert.equal((await resolver.resolve({ file: path.join(root, "src", "main", "java", "Demo.java") }) as unknown as { rootSource?: string }).rootSource, "inferred");
});

test("registry rejects relative alias roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-relative-config-"));
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "relative", root: "relative-repo", lspEnabled: true }
    ]
  }));

  const registry = new AliasRegistry(config);
  await assert.rejects(() => registry.reloadIfChanged(), /root must be an absolute path/);
});

test("resolver lets Git worktrees inherit enablement without sharing runtime identity", { skip: !hasGit() }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-worktree-main-"));
  const reviewRoot = `${root}-review`;
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  await writeFile(path.join(root, "src", "main", "java", "Demo.java"), "class Demo {}\n");
  git(root, ["init"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "-m", "init"]);
  git(root, ["worktree", "add", "-b", "review", reviewRoot]);

  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "main", root, lspEnabled: true, layoutProfile: "maven-reactor" }
    ]
  }));

  const registry = new AliasRegistry(config);
  await registry.reloadIfChanged();
  const resolved = await new RepoResolver(registry).resolve({ repoRoot: reviewRoot });

  assert.equal(resolved.repoRoot, canonicalPath(reviewRoot));
  assert.notEqual(resolved.repoHash, repoHash(root));
  assert.equal(resolved.lsp.enabled, true);
  assert.equal(resolved.lsp.matchedBy, "git-worktree-family");
  assert.equal(resolved.lsp.configuredRoot, canonicalPath(root));
  assert.equal(resolved.lsp.effectiveRepoRoot, canonicalPath(reviewRoot));
});

function hasGit(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
