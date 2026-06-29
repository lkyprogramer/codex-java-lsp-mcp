#!/usr/bin/env node
// input: Codex hook JSON on stdin.
// output: Hook JSON that silently continues or adds non-blocking Java LSP advice.
// pos: Out-of-process advisory gate; shares AliasRegistry and RepoResolver.
import { readFileSync } from "node:fs";
import { AliasRegistry } from "../alias-registry.js";
import { RepoResolver } from "../repo-resolver.js";

type HookPayload = {
  cwd?: string;
  working_directory?: string;
  workspace_root?: string;
  prompt?: string;
  user_prompt?: string;
  userPrompt?: string;
  message?: string;
  input?: string;
};

const payload = readPayload();
const cwd = payload.cwd || payload.working_directory || payload.workspace_root || process.cwd();
const prompt = payload.prompt || payload.user_prompt || payload.userPrompt || payload.message || payload.input || "";

try {
  const registry = new AliasRegistry();
  await registry.reloadIfChanged();
  const resolver = new RepoResolver(registry);
  const lsp = resolver.resolveEnablement(cwd);
  if (!lsp.enabled || !looksJavaSemantic(prompt)) {
    writeContinue();
  } else {
    writeAdvice(`JAVA_LSP_ADVISOR: 当前路径已启用 codex-java-lsp (${lsp.matchedBy})。这是已配置项目，不能只报告 LSP server 未启动。先调用 java_status({repoRoot:"${lsp.effectiveRepoRoot}",start:false}) 校验 repoRoot；若返回 started=false，必须立即调用 java_status({repoRoot:"${lsp.effectiveRepoRoot}",start:true}) 启动 LSP server；随后优先用 java_impact 获取影响面。`);
  }
} catch {
  writeContinue();
}

function readPayload(): HookPayload {
  try {
    const input = readFileSync(0, "utf8").trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

function looksJavaSemantic(prompt: string): boolean {
  return /\bjava\b|controller|service|repository|mapper|entity|dto|调用链|影响面|方法|类|实现|修复|排查/i.test(prompt);
}

function writeContinue(): void {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function writeAdvice(message: string): void {
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message
    }
  }));
}
