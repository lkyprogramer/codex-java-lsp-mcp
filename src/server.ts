// input: Codex MCP stdio transport events.
// output: One stdio protocol instance backed by the shared Java LSP application.
// pos: Compatibility entrypoint; protocol/tool registration lives in mcp-server-factory.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JavaLspApplication } from "./application.js";
import { createMcpServer } from "./mcp-server-factory.js";
import { McpServerLifecycle, type ServerShutdownReason } from "./server-lifecycle.js";

const STDIO_SHUTDOWN_GRACE_MS = 30000;

const application = new JavaLspApplication({ transportMode: "stdio", resolverOptions: { cwdFallback: "allow" } });
const server = createMcpServer(application, { transportMode: "stdio" });

const lifecycle = new McpServerLifecycle({
  stdin: process.stdin,
  shutdown: shutdownServer,
  reportFailure: (reason, error) => {
    console.error(`[codex-java-lsp] shutdown failed (${reason})`, error);
  }
});

async function main(): Promise<void> {
  const cleanup = await application.initialize();
  if (cleanup.removed > 0) {
    console.error(`[codex-java-lsp] cleaned ${cleanup.removed} stale worktree cache(s)`);
  }
  lifecycle.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[codex-java-lsp] MCP server ready");
}

process.on("SIGINT", () => {
  void lifecycle.shutdown("sigint");
});
process.on("SIGTERM", () => {
  void lifecycle.shutdown("sigterm");
});

main().catch(error => {
  console.error("[codex-java-lsp] fatal startup error", error);
  void lifecycle.shutdown("startup_failure", 1);
});

async function shutdownServer(reason: ServerShutdownReason): Promise<void> {
  console.error(`[codex-java-lsp] shutting down (${reason})`);
  try {
    await application.shutdown(STDIO_SHUTDOWN_GRACE_MS);
  } finally {
    await server.close();
  }
}
