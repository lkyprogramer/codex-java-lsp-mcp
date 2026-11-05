// input: The built MCP server artifact (dist/server.js).
// output: Real tools/list JSON byte/token cost, per tool and total.
// pos: Task 31 Step 6 - measured before any 7->5 tool-merge decision (Step 7),
//      so that decision is made from real numbers, not a built prototype's guess.
// Spawns the actual server and calls tools/list over stdio (same approach as
// smoke.ts) rather than re-registering tools in-process: the SDK's zod-to-
// JSON-Schema conversion is what a real agent's context actually pays for,
// and duplicating that conversion here could silently drift from it.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startOwnerDaemon } from "./owner-daemon.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const BYTES_PER_TOKEN = 4;
const serverJs = path.join(projectDir, "dist", "server.js");

// stdio only relays: tools/list is served by an isolated owner on a throwaway cache.
const owner = await startOwnerDaemon({ serverJs, cacheRoot: mkdtempSync(path.join(os.tmpdir(), "java-lsp-schema-cache-")), ephemeralCache: true });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs],
  cwd: process.env.JAVA_LSP_REPO_ROOT || projectDir,
  env: owner.relayEnv,
  stderr: "inherit"
});

const client = new Client({ name: "codex-java-lsp-measure-tool-schema", version: "0.1.0" });

try {
  await client.connect(transport);
  const response = await client.listTools();
  const perTool = response.tools
    .map(tool => {
      const jsonBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
      return { name: tool.name, jsonBytes, estimatedTokens: Math.ceil(jsonBytes / BYTES_PER_TOKEN) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const jsonBytes = Buffer.byteLength(JSON.stringify(response.tools), "utf8");
  console.log(JSON.stringify({
    tools: response.tools.length,
    jsonBytes,
    estimatedTokens: Math.ceil(jsonBytes / BYTES_PER_TOKEN),
    perTool
  }, null, 2));
} finally {
  try { await client.close(); } finally { await owner.stop(); }
}
