// input: Built MCP server artifact and local environment variables.
// output: Minimal tools/list and java_status smoke-test result.
// pos: Local verification client for the generic Java LSP MCP bridge. stdio only relays, so the
//      smoke starts its own isolated owner on a throwaway cache (scripts/owner-daemon.mjs).
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type OwnerDaemon = { relayEnv: Record<string, string>; stop(): Promise<void> };
type OwnerDaemonModule = { startOwnerDaemon(options: { serverJs: string; cacheRoot: string; env: NodeJS.ProcessEnv; ephemeralCache: boolean }): Promise<OwnerDaemon> };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.LISHUEDU_ROOT || process.cwd();
const expectedTools = ["java_status", "java_impact", "java_symbol", "java_diagnostics", "java_runtime"];
const serverJs = path.join(projectDir, "dist", "server.js");

const { startOwnerDaemon } = await import(pathToFileURL(path.join(projectDir, "scripts", "owner-daemon.mjs")).href) as OwnerDaemonModule;
const owner = await startOwnerDaemon({ serverJs, cacheRoot: mkdtempSync(path.join(os.tmpdir(), "java-lsp-smoke-cache-")), env: process.env, ephemeralCache: true });
// The relay resolves selector-free calls against its cwd: the repository under test.
const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], cwd: repoRoot, env: owner.relayEnv, stderr: "inherit" });

const client = new Client({ name: "codex-java-lsp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(tool => tool.name).sort();
  const expected = [...expectedTools].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${names.join(", ")}`);
  }
  const selector = { repoRoot, start: false };
  const shutdownSelector = { repoRoot, action: "shutdown" };
  const status = await client.callTool({ name: "java_status", arguments: selector }, undefined, {
    timeout: 180000
  });
  if (status.isError) {
    throw new Error(`java_status smoke failed: ${JSON.stringify(status.content)}`);
  }
  const shutdown = await client.callTool({ name: "java_runtime", arguments: shutdownSelector }, undefined, {
    timeout: 180000
  });
  if (shutdown.isError) {
    throw new Error(`java_runtime shutdown smoke failed: ${JSON.stringify(shutdown.content)}`);
  }
  console.log(JSON.stringify({
    tools: names,
    status: status.content,
    shutdown: shutdown.content
  }, null, 2));
} finally {
  try { await client.close(); } finally { await owner.stop(); }
}
