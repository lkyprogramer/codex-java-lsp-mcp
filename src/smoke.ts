// input: Built MCP server artifact and local environment variables.
// output: Minimal tools/list and java_status smoke-test result.
// pos: Local verification client for the generic Java LSP MCP bridge.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.JAVA_LSP_SMOKE_REPO_ROOT || process.env.JAVA_LSP_TEST_REPO_ROOT || process.env.LISHUEDU_ROOT || process.cwd();
const projectId = process.env.JAVA_LSP_SMOKE_PROJECT_ID;
const start = process.env.JAVA_LSP_SMOKE_START === "true";
const expectedTools = ["java_status", "java_impact", "java_symbol", "java_references", "java_diagnostics", "java_restart", "java_shutdown"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDir, "dist", "server.js")],
  cwd: projectDir,
  env: {
    ...process.env,
    JAVA_LSP_REPO_ROOT: repoRoot
  },
  stderr: "inherit"
});

const client = new Client({ name: "codex-java-lsp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(tool => tool.name).sort();
  const expected = [...expectedTools].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${names.join(", ")}`);
  }
  const selector = projectId ? { projectId, start } : { repoRoot, start };
  const shutdownSelector = projectId ? { projectId } : { repoRoot };
  const status = await client.callTool({ name: "java_status", arguments: selector }, undefined, {
    timeout: 180000
  });
  const shutdown = await client.callTool({ name: "java_shutdown", arguments: shutdownSelector }, undefined, {
    timeout: 180000
  });
  console.log(JSON.stringify({
    tools: names,
    status: status.content,
    shutdown: shutdown.content
  }, null, 2));
} finally {
  await client.close();
}
