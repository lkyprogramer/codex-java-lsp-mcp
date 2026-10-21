import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JavaLspApplication } from "./application.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JAVA_IMPACT_TOOL_DESCRIPTION } from "./tools/impact.js";
import { createMcpServer, PUBLIC_JAVA_TOOLS } from "./mcp-server-factory.js";
import { AliasRegistry } from "./alias-registry.js";
import { RepoResolver } from "./repo-resolver.js";
import { resetImpactTelemetryForTests } from "./telemetry/impact-telemetry.js";
import { IndexOwner } from "./java-index/snapshot/index-owner.js";
import { FSEVENT_FLAGS } from "./java-index/snapshot/workspace-tracker.js";

const expectedTools = [...PUBLIC_JAVA_TOOLS].sort();

test("PUBLIC_JAVA_TOOLS drops java_context after L1 kill and keeps java_impact", () => {
  const names: string[] = [...PUBLIC_JAVA_TOOLS];
  assert.deepEqual([...PUBLIC_JAVA_TOOLS].sort(), expectedTools);
  assert.equal(names.includes("java_context"), false);
  assert.equal(PUBLIC_JAVA_TOOLS.includes("java_impact"), true);
  assert.equal(PUBLIC_JAVA_TOOLS.length, 5);
});

test("production MCP factory, java_impact, and java_context do not read JAVA_LSP_ENGINE", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const relative of ["mcp-server-factory.ts", "tools/impact.ts", "application.ts"]) {
    const source = readFileSync(path.join(root, relative), "utf8");
    assert.equal(source.includes("JAVA_LSP_ENGINE"), false, relative);
  }
});

test("withContext notes repoHash for telemetry without putting it on the wire", () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server-factory.ts"), "utf8");
  assert.match(source, /withTelemetryRequestScope/);
  assert.match(source, /noteTelemetryRepoHash\(context\.repoHash\)/);
});

test("repo-scoped java_status reads memory only without start and keeps the 15s budget with start", () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server-factory.ts"), "utf8");
  // Contract §2.6 (MAC-08B): start=false never enters withContext; the behavior is covered by
  // repo-runtime-manager statusOnly tests and the MCP status-only-does-not-bootstrap contract.
  assert.match(source, /if \(!args\.start\) \{[\s\S]*?application\.runtimes\.statusOnly\(args,/);
  assert.match(source, /deadlineMs: 15000/);
  assert.equal(source.includes("requestOptions: args.start ?"), false);
});

test("java_impact tools/list teaches auto-skip and the required/java_symbol retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-factory-schema-"));
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
  const session = await connect(application, "schema");
  try {
    const listed = await session.client.listTools();
    const impact = listed.tools.find(tool => tool.name === "java_impact");
    const symbol = listed.tools.find(tool => tool.name === "java_symbol");
    assert.equal(impact?.description, JAVA_IMPACT_TOOL_DESCRIPTION);
    assert.match(impact?.description ?? "", /semanticPolicy=auto/);
    assert.match(symbol?.description ?? "", /static discovery over the on-disk index/);
    assert.match(symbol?.description ?? "", /backend=jdt/);
    const policy = JSON.stringify(impact?.inputSchema?.properties?.semanticPolicy ?? {});
    assert.match(policy, /service-profile/);
    assert.match(policy, /semantic\.used=false/);
    assert.match(policy, /java_symbol/);
  } finally {
    await session.client.close();
    await application.close();
  }
});

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

    const globalShutdown = await second.client.callTool({ name: "java_runtime", arguments: { action: "shutdown", all: true } });
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

test("register wrapper records a counter line without changing java_status bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-factory-tel-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const configPath = path.join(root, "projects.json");
  await writeFile(configPath, JSON.stringify({ aliases: [] }));
  const telemetryDir = path.join(root, "telemetry");
  const previousDir = process.env.JAVA_LSP_TELEMETRY_DIR;
  const previousFlag = process.env.JAVA_LSP_TELEMETRY;
  process.env.JAVA_LSP_TELEMETRY_DIR = telemetryDir;
  delete process.env.JAVA_LSP_TELEMETRY;
  resetImpactTelemetryForTests();
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath: configPath,
    resolverOptions: { cwdFallback: "reject" },
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();
  const session = await connect(application, "telemetry");
  try {
    const on = await session.client.callTool({ name: "java_status", arguments: {} });
    const onText = toolText(on);
    resetImpactTelemetryForTests();
    const files = await readdir(telemetryDir);
    assert.equal(files.length, 1);
    const line = JSON.parse((await readFile(path.join(telemetryDir, files[0]!), "utf8")).trim());
    assert.equal(line.tool, "java_status");
    assert.equal(typeof line.elapsedMs, "number");
    assert.equal(line.ok, true);
    assert.deepEqual(Object.keys(line).sort(), ["elapsedMs", "ok", "start", "tool", "ts"]);
    assert.equal(line.start, false);

    process.env.JAVA_LSP_TELEMETRY = "0";
    resetImpactTelemetryForTests();
    const off = await session.client.callTool({ name: "java_status", arguments: {} });
    assert.deepEqual(stableStatus(onText), stableStatus(toolText(off)));
  } finally {
    await session.client.close();
    await application.close();
    resetImpactTelemetryForTests();
    if (previousDir === undefined) delete process.env.JAVA_LSP_TELEMETRY_DIR;
    else process.env.JAVA_LSP_TELEMETRY_DIR = previousDir;
    if (previousFlag === undefined) delete process.env.JAVA_LSP_TELEMETRY;
    else process.env.JAVA_LSP_TELEMETRY = previousFlag;
  }
});

test("MAC11 public symbol freezes STALE labels, suppresses misses, then converges to FRESH", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-public-stale-")));
  const root = path.join(base, "repo");
  const relative = "src/main/java/com/acme/Ready.java";
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  await writeFile(path.join(root, relative), "package com.acme; public class Ready {}\n");
  const configPath = path.join(base, "projects.json");
  await writeFile(configPath, JSON.stringify({ aliases: [] }));
  let emit!: (flags: number, file: string) => void;
  let hold = false;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = await IndexOwner.open({ cacheRoot: path.join(base, "cache"), roundDelayMs: 5,
    trackerSource: () => async onSignal => {
      emit = onSignal;
      return { epoch: "a".repeat(32), fence: async () => {}, stop: async () => {}, closed: new Promise<void>(() => undefined) };
    },
    faultAt: async stage => { if (hold && stage.startsWith("round-")) { entered = true; await gate; } }
  });
  const application = new JavaLspApplication({ transportMode: "streamable_http", projectsConfigPath: configPath,
    resolverOptions: { cwdFallback: "reject" }, index: async () => owner,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] }) });
  let client: Client | undefined;
  const until = async (probe: () => boolean, label: string) => {
    const end = Date.now() + 60000;
    while (!probe()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(10); }
  };
  try {
    await application.initialize();
    client = (await connect(application, "mac11-stale")).client;
    const workspace = await owner.workspace(root);
    await until(() => workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, "initial FRESH");
    const before = owner.store.binding(workspace.workspaceId)!;
    const query = async (name: string) => {
      const result = await client!.callTool({ name: "java_symbol", arguments: { repoRoot: root, query: name, searchMode: "exact", preview: "none" } });
      assert.notEqual(result.isError, true, toolText(result));
      return toolJson(result);
    };
    const ready = await query("com.acme.Ready");
    assert.equal(ready.scopeState, "READY");
    assert.equal((ready.indexView as { state: string }).state, "FRESH");
    hold = true;
    await writeFile(path.join(root, relative), "package com.acme; public class Ready { public void addedMac11() {} }\n");
    emit(0x1000 | FSEVENT_FLAGS.ItemIsFile, path.join(root, relative));
    await until(() => entered, "held edit round");
    const started = performance.now();
    const stale = await query("com.acme.Ready#addedMac11()");
    const elapsedMs = performance.now() - started;
    assert.equal(stale.scopeState, "PARTIAL");
    assert.equal(stale.exact, undefined);
    assert.deepEqual(stale.candidates, []);
    const held = stale.indexView as { state: string; snapshotId: string; bindingVersion: number };
    assert.equal(held.state, "STALE");
    assert.equal(held.snapshotId, before.snapshotId);
    assert.equal(held.bindingVersion, before.bindingVersion);
    assert.ok(elapsedMs < 5000, `prepare must cap rather than wait for the held builder: ${elapsedMs}`);
    release(); hold = false;
    await until(() => workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight
      && owner.store.binding(workspace.workspaceId)?.snapshotId !== before.snapshotId, "edit FRESH");
    const fresh = await query("com.acme.Ready#addedMac11()");
    assert.equal(fresh.scopeState, "READY");
    assert.equal(fresh.exact, "match");
    assert.equal((fresh.indexView as { state: string }).state, "FRESH");
    assert.equal(held.state, "STALE", "a later binding cannot relabel a completed response");
    if (process.env.ILV2_EVIDENCE_ROOT) {
      await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, "stale-symbol.json"), JSON.stringify({
        fixture: "synthetic Java; deterministic held tracker round; real builder/query processes and MCP handler",
        elapsedMs, before: ready.indexView, stale: stale.indexView, after: fresh.indexView,
        staleScope: stale.scopeState, staleExact: stale.exact ?? null, freshExact: fresh.exact
      }, null, 2));
    }
  } finally {
    release();
    await client?.close();
    await application.close();
    await owner.stop();
    const writable = async (dir: string): Promise<void> => {
      await chmod(dir, 0o755);
      for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    await writable(base);
    await rm(base, { recursive: true, force: true });
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

function stableStatus(text: string): unknown {
  const payload = JSON.parse(text) as { server?: Record<string, unknown> };
  if (payload.server) {
    delete payload.server.uptimeMs;
    delete payload.server.activeRequests;
  }
  return payload;
}
