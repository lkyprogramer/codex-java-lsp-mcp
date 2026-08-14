import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JavaLspApplication } from "./application.js";
import { createMcpServer } from "./mcp-server-factory.js";
import { AliasRegistry } from "./alias-registry.js";
import { RepoResolver } from "./repo-resolver.js";

const expectedTools = [
  "java_diagnostics",
  "java_impact",
  "java_references",
  "java_restart",
  "java_shutdown",
  "java_status",
  "java_symbol"
];

test("HTTP protocol factory refuses an application with cwd fallback", () => {
  const registry = new AliasRegistry("/path/that/does/not/exist");
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    resolver: new RepoResolver(registry, { cwdFallback: "allow" }),
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  assert.throws(
    () => createMcpServer(application, { transportMode: "streamable_http" }),
    /cwdFallback=reject/
  );
});

test("protocol factory creates independent servers over one shared application", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-factory-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const configPath = path.join(root, "projects.json");
  await writeFile(configPath, JSON.stringify({ aliases: [] }));
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath: configPath,
    resolverOptions: { cwdFallback: "reject" },
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();

  const first = await connect(application, "first");
  const second = await connect(application, "second");
  try {
    assert.deepEqual(await toolNames(first.client), expectedTools);
    assert.deepEqual(await toolNames(second.client), expectedTools);

    await first.client.close();
    assert.equal(application.state().state, "ready");
    assert.deepEqual(await toolNames(second.client), expectedTools);

    const status = await second.client.callTool({ name: "java_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const payload = toolJson(status);
    assert.equal(payload.server.transport, "streamable_http");
    assert.equal(payload.server.runtimeCount, 0);
    assert.equal(JSON.stringify(payload).includes(root), false);
    assert.equal("aliases" in payload, false);
    assert.equal("activeRepos" in payload, false);

    const globalShutdown = await second.client.callTool({ name: "java_shutdown", arguments: { all: true } });
    assert.equal(globalShutdown.isError, true);
    assert.match(toolText(globalShutdown), /not available on the shared daemon/);

    const implicitQuery = await second.client.callTool({ name: "java_symbol", arguments: { query: "Demo" } });
    assert.equal(implicitQuery.isError, true);
    assert.match(toolText(implicitQuery), /requires an explicit repoRoot/);
  } finally {
    await second.client.close();
    await application.close();
  }
});

async function connect(application: JavaLspApplication, name: string): Promise<{ client: Client }> {
  const server = createMcpServer(application, { transportMode: "streamable_http" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}

async function toolNames(client: Client): Promise<string[]> {
  const tools = await client.listTools();
  return tools.tools.map(tool => tool.name).sort();
}

function toolText(result: unknown): string {
  const payload = result as { content?: Array<{ type?: string; text?: string }> };
  const content = payload.content?.[0];
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected one text tool result.");
  }
  return content.text;
}

function toolJson(result: unknown): {
  server: Record<string, unknown>;
  [key: string]: unknown;
} {
  return JSON.parse(toolText(result)) as { server: Record<string, unknown>; [key: string]: unknown };
}
