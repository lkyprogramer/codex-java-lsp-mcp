#!/usr/bin/env node
// input: Codex hook JSON on stdin.
// output: Hook JSON that silently continues or adds non-blocking Java LSP advice.
// pos: Out-of-process advisory gate; shares AliasRegistry and RepoResolver.
import { readFileSync } from "node:fs";
import { AliasRegistry } from "../alias-registry.js";
import { RepoResolver, type LspEnablement } from "../repo-resolver.js";
import { WorktreeIdentityCache } from "../worktree-identity.js";

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
  const identities = new WorktreeIdentityCache();
  const [lsp, identity] = await Promise.all([
    resolver.resolveEnablement(cwd),
    identities.resolve(cwd)
  ]);
  if (!lsp.enabled || !looksJavaSemantic(prompt)) {
    writeContinue();
  } else {
    writeAdvice(advisorMessage(lsp, identity.isLinkedWorktree));
  }
} catch {
  writeContinue();
}

function advisorMessage(lsp: LspEnablement, linkedWorktree: boolean): string {
  const root = lsp.effectiveRepoRoot;
  const worktree = linkedWorktree ? "，这是 Git worktree" : "";
  return `JAVA_LSP_ADVISOR: 当前路径已启用 codex-java-lsp (${lsp.matchedBy})${worktree}。Java 语义任务按 AGENTS.md 的工具指引执行；每次调用显式传 repoRoot:"${root}" 直接调用目标工具，不必先调 java_status，结果的 indexView.workspaceId 即核对。未知位置先用 java_symbol(operation=query) 静态定位，或直接 java_impact({symbol:"Type#method"})；结果里的 symbolId 可直接传回，AMBIGUOUS 时从候选选一个 symbolId，不猜重载；静态查询不需要 JDT，started=false 不代表工具不可用。需要语义结果时按需启动 JDT；java_impact 默认 semanticPolicy=auto，只对 service 锚点打 JDT，需要精确实现或引用时传 semanticPolicy=required，或用 java_symbol(position/references)。`;
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
