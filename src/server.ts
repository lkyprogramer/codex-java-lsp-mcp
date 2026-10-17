// input: Codex MCP stdio transport events.
// output: The same MCP messages relayed to the one owner daemon; its replies on stdout.
// pos: Compatibility entrypoint (contract §1: stdio only forwards). Tools run in the owner
//      (http-server.ts); this process builds no runtime, index, scheduler or JDT session.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServerLifecycle, type ServerShutdownReason } from "./server-lifecycle.js";
import { OwnerRelay } from "./stdio-owner-proxy.js";

const transport = new StdioServerTransport();
const relay = new OwnerRelay({
  send: message => transport.send(message),
  cwd: process.cwd()
});

const lifecycle = new McpServerLifecycle({
  stdin: process.stdin,
  shutdown: shutdownRelay,
  reportFailure: (reason, error) => {
    console.error(`[codex-java-lsp] shutdown failed (${reason})`, error);
  }
});

async function main(): Promise<void> {
  // Messages are relayed concurrently: one slow tool call must not hold the next request.
  transport.onmessage = message => {
    void relay.handle(message).catch(error => console.error("[codex-java-lsp] stdio relay failed", error));
  };
  transport.onerror = error => console.error("[codex-java-lsp] stdio transport error", error);
  lifecycle.start();
  await transport.start();
  console.error("[codex-java-lsp] MCP stdio relay ready");
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

async function shutdownRelay(reason: ServerShutdownReason): Promise<void> {
  console.error(`[codex-java-lsp] stdio relay shutting down (${reason})`);
  relay.close();
  await transport.close();
}
