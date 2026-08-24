import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JavaLspApplication } from "./application.js";
import { createMcpServer, PUBLIC_JAVA_TOOLS } from "./mcp-server-factory.js";

const EXPECTED_TOOLS = [...PUBLIC_JAVA_TOOLS].sort();

test("SDK client remains compatible with stateless HTTP across daemon restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-http-stateless-"));
  const projectsConfigPath = path.join(root, "projects.json");
  await writeFile(projectsConfigPath, JSON.stringify({ aliases: [] }));
  t.after(() => rm(root, { recursive: true, force: true }));

  let host = await startStatelessHost(projectsConfigPath);
  const port = (host.server.address() as AddressInfo).port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "stateless-spike", version: "0.1.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  });

  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  assert.deepEqual(await toolNames(client), EXPECTED_TOOLS);
  assertHttpStatus(await client.callTool({ name: "java_status", arguments: {} }));

  const getResponse = await fetch(url, { headers: { accept: "text/event-stream" } });
  assert.equal(getResponse.status, 405);
  assert.equal(host.application.state().state, "ready");

  await host.close();
  host = await startStatelessHost(projectsConfigPath, port);

  assert.deepEqual(await toolNames(client), EXPECTED_TOOLS);
  assertHttpStatus(await client.callTool({ name: "java_status", arguments: {} }));
  await client.close();
  assert.equal(host.application.state().state, "ready");

  const secondTransport = new StreamableHTTPClientTransport(url);
  const secondClient = new Client({ name: "stateless-spike-after-close", version: "0.1.0" });
  try {
    await secondClient.connect(secondTransport);
    assert.deepEqual(await toolNames(secondClient), EXPECTED_TOOLS);
  } finally {
    await secondClient.close();
    await host.close();
  }
});

async function startStatelessHost(projectsConfigPath: string, port = 0): Promise<{
  application: JavaLspApplication;
  server: Server;
  close(): Promise<void>;
}> {
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath,
    resolverOptions: { cwdFallback: "reject" },
    cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use((_request, response, next) => {
    response.setHeader("Connection", "close");
    next();
  });

  app.post("/mcp", async (request, response) => {
    const protocol = createMcpServer(application, { transportMode: "streamable_http" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await protocol.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    } finally {
      await protocol.close().catch(() => undefined);
    }
  });
  app.get("/mcp", (_request, response) => methodNotAllowed(response));
  app.delete("/mcp", (_request, response) => methodNotAllowed(response));

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(port, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  let closed = false;
  return {
    application,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      });
      await application.close();
    }
  };
}

function methodNotAllowed(response: import("express").Response): void {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  });
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(tool => tool.name).sort();
}

function assertHttpStatus(result: unknown): void {
  const payload = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  assert.equal(payload.isError, undefined);
  assert.equal(payload.content?.[0]?.type, "text");
  const status = JSON.parse(payload.content?.[0]?.text || "{}") as {
    server?: { transport?: string; state?: string };
  };
  assert.equal(status.server?.transport, "streamable_http");
  assert.equal(status.server?.state, "ready");
}
