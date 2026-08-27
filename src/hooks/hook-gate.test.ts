import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGitWorktreeFamily } from "../test-support/git-worktree.test.js";

function hasGit(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function runHook(config: string, cwd: string, prompt: string): string {
  const result = spawnSync(process.execPath, ["dist/hooks/hook-gate.js"], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env: { ...process.env, JAVA_LSP_PROJECTS_JSON: config },
    input: JSON.stringify({ cwd, prompt }),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

test("hook advice tells enabled projects to start a stopped LSP server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-hook-enabled-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "demo", root, lspEnabled: true, layoutProfile: "generic-java" }
    ]
  }));

  const advice = runHook(config, root, "排查 Java service 调用链");
  assert.match(advice, /不能只报告 LSP server 未启动/);
  assert.match(advice, /start:false/);
  assert.match(advice, /started=false/);
  assert.match(advice, /start:true/);
  assert.match(advice, /semanticPolicy=auto/);
  assert.match(advice, /semanticPolicy=required/);
  assert.match(advice, /java_symbol/);
});

test("hook does not prestart JDT on a linked Git worktree", { skip: !hasGit() }, async () => {
  const family = await createGitWorktreeFamily();
  const config = path.join(family.primary, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "demo", root: family.primary, lspEnabled: true, layoutProfile: "generic-java" }
    ]
  }));

  const worktreeAdvice = runHook(config, family.linked, "排查 Java service 调用链");
  assert.match(worktreeAdvice, /Git worktree/);
  assert.match(worktreeAdvice, /start:false/);
  assert.doesNotMatch(worktreeAdvice, /start:true/);
  assert.match(worktreeAdvice, /java_impact/);
  assert.match(worktreeAdvice, /java_symbol/);

  const primaryAdvice = runHook(config, family.primary, "排查 Java service 调用链");
  assert.match(primaryAdvice, /start:true/);
  assert.doesNotMatch(primaryAdvice, /Git worktree/);
});
