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
import { parseEvidenceHandle } from "./java-index/symbol-identity.js";
import { FSEVENT_FLAGS } from "./java-index/snapshot/workspace-tracker.js";
import { RepoRuntimeManager } from "./repo-runtime-manager.js";
import { NoopCrossProcessLeaseStore } from "./cross-process-lease.js";
import { deferred } from "./test-support/fake-jdtls.test.js";

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
    // MAC-13: every input the descriptions teach exists in the schema.
    assert.match(impact?.description ?? "", /symbol/);
    assert.ok(impact?.inputSchema?.properties?.symbol, "java_impact schema has symbol");
    assert.match(symbol?.description ?? "", /symbolId/);
    assert.ok(symbol?.inputSchema?.properties?.symbolId, "java_symbol schema has symbolId");
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

test("public MCP shutdown waits for the same repository's active semantic query", { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "java-lsp-factory-control-")));
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot);
  await writeFile(path.join(repoRoot, "pom.xml"), "<project></project>");
  await writeFile(path.join(repoRoot, "Sample.java"), "class Sample {}");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({ aliases: [{ id: "sample", root: repoRoot, lspEnabled: true }] }));
  const registry = new AliasRegistry(config);
  const resolver = new RepoResolver(registry, { cwdFallback: "reject" });
  const runtimes = new RepoRuntimeManager(resolver, { index: false, gradleDomain: false, transportMode: "streamable_http" },
    undefined, undefined, new NoopCrossProcessLeaseStore());
  const application = new JavaLspApplication({ transportMode: "streamable_http", registry, resolver, runtimes,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] }) });
  const querying = deferred<void>();
  const release = deferred<void>();
  const admitted = deferred<void>();
  const order: string[] = [];
  await application.initialize();
  await runtimes.withContext({ repoRoot }, async ({ session }) => {
    t.mock.method(session, "diagnosticsFor", async () => {
      order.push("query-start");
      querying.resolve();
      await release.promise;
      order.push("query-end");
      return {};
    });
    t.mock.method(session, "stop", async () => { order.push("stop"); });
  });
  const first = (await connect(application, "semantic-query")).client;
  const second = (await connect(application, "control")).client;
  const withContext = runtimes.withContext.bind(runtimes);
  const observedContext: typeof runtimes.withContext = (selector, handler, options) =>
    withContext(selector, (context, request) => {
      const pending = handler(context, request);
      if (!options?.mayStartLsp) admitted.resolve();
      return pending;
    }, options);
  t.mock.method(runtimes, "withContext", observedContext);
  try {
    const query = first.callTool({ name: "java_diagnostics", arguments: { repoRoot, files: ["Sample.java"] } });
    await querying.promise;
    const control = second.callTool({ name: "java_runtime", arguments: { repoRoot, action: "shutdown" } });
    await admitted.promise;
    assert.deepEqual(order, ["query-start"]);
    release.resolve();
    for (const result of await Promise.all([query, control])) assert.equal(result.isError, undefined);
    assert.deepEqual(order, ["query-start", "query-end", "stop"]);
  } finally {
    release.resolve();
    await Promise.all([first.close(), second.close()]);
    await application.close();
    await rm(root, { recursive: true, force: true });
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
    // Both static operations must keep the held view while the replacement round is paused.
    const [outline, evidence] = await Promise.all([
      { operation: "outline", file: relative },
      { operation: "evidence", file: relative, line: 1, column: 32 }
    ].map(async args => {
      const result = await client!.callTool({ name: "java_symbol", arguments: { repoRoot: root, ...args } });
      assert.notEqual(result.isError, true, toolText(result));
      return toolJson(result);
    }));
    for (const result of [outline!, evidence!]) {
      assert.equal(result.scopeState, "PARTIAL");
      assert.deepEqual(result.indexView, held);
      assert.ok((result.reasons as string[]).includes("ANCHOR_STALE"));
    }
    assert.deepEqual(outline!.entries, []);
    assert.deepEqual(evidence!.units, []);
    // MAC-13: java_impact(symbol=) on the held STALE view cannot call the new method absent.
    const staleImpact = await client!.callTool({ name: "java_impact", arguments: { repoRoot: root, symbol: "com.acme.Ready#addedMac11" } });
    assert.notEqual(staleImpact.isError, true, toolText(staleImpact));
    const staleMiss = toolJson(staleImpact) as { status?: string; indexView?: { state: string } };
    assert.equal(staleMiss.status, "NOT_READY");
    assert.equal(staleMiss.indexView?.state, "STALE");
    // The same for a symbolId minted by the newer snapshot: the held view misses it without proving it gone.
    const readyId = String(((ready.candidates as Array<{ declaration: { symbolId: string } }>)[0]!).declaration.symbolId);
    const [, , ws, encodedType] = readyId.split(":");
    const methodKey = `method:v3:${Buffer.from(encodedType!, "base64url").toString("utf8")}#addedMac11()`;
    const newerId = `jsym:mac1:${ws}:${Buffer.from(methodKey, "utf8").toString("base64url")}`;
    const staleById = toolJson(await client!.callTool({ name: "java_impact", arguments: { repoRoot: root, symbol: newerId } })) as { status?: string; indexView?: { state: string } };
    assert.equal(staleById.status, "NOT_READY", JSON.stringify(staleById).slice(0, 400));
    assert.equal(staleById.indexView?.state, "STALE");
    release(); hold = false;
    await until(() => workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight
      && owner.store.binding(workspace.workspaceId)?.snapshotId !== before.snapshotId, "edit FRESH");
    const freshById = toolJson(await client!.callTool({ name: "java_impact", arguments: { repoRoot: root, symbol: newerId, verbosity: "compact" } })) as { status?: string };
    assert.equal(freshById.status, undefined, "the id resolves once its snapshot is published");
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

test("MAC13 public symbolId survives an unrelated publish, misses after a signature change, and never guesses", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-public-identity-")));
  const root = path.join(base, "repo");
  const files: Record<string, string> = {
    "src/main/java/com/acme/Orders.java": "package com.acme; public class Orders { public void place(int n) {} public void place(String s) {} public void ship() {}"
      + " public void fill(String[] a) {} public void fill(String[][] a) {} public void log(String... lines) {}"
      + " public <T extends Number> void pick(T value) {} public void nest(Orders.Line line) {} public static class Line {} }\n",
    "src/main/java/com/acme/Maps.java": "package com.acme; import java.util.Map; public class Maps { public <T, U extends T> void entry(Map.Entry<String, String> e, U u) {} }\n",
    "src/main/java/com/acme/Dup.java": "package com.acme; public class Dup {}\n",
    "src/test/java/com/acme/Dup.java": "package com.acme; public class Dup {}\n",
    "src/main/java/com/acme/Other.java": "package com.acme; public class Other {}\n",
    "src/main/java/com/acme/Jobs.java": "package com.acme; public class Jobs { private int pending = 7; public void run() { class LocalStep {} new LocalStep(); } }\n",
    // A deep source path and a long signature: its mac1 symbolId passes 512 characters.
    [`src/main/java/com/acme/${"deeply/nested/".repeat(12)}Deep.java`]: `package com.acme.${"deeply.nested.".repeat(12)}x; public class Deep { public void handle(${Array.from({ length: 8 }, (_, i) => `java.util.Map<java.lang.String, java.lang.Object> argument${i}`).join(", ")}) {} }\n`
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const configPath = path.join(base, "projects.json");
  await writeFile(configPath, JSON.stringify({ aliases: [] }));
  let emit!: (flags: number, file: string) => void;
  const owner = await IndexOwner.open({ cacheRoot: path.join(base, "cache"), roundDelayMs: 5,
    trackerSource: () => async onSignal => {
      emit = onSignal;
      return { epoch: "b".repeat(32), fence: async () => {}, stop: async () => {}, closed: new Promise<void>(() => undefined) };
    }
  });
  const application = new JavaLspApplication({ transportMode: "streamable_http", projectsConfigPath: configPath,
    resolverOptions: { cwdFallback: "reject" }, index: async () => owner,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] }) });
  let client: Client | undefined;
  const until = async (probe: () => boolean, label: string) => {
    const end = Date.now() + 60000;
    while (!probe()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(10); }
  };
  type Declaration = { symbolId?: string; stability?: string; evidenceHandle?: string; sourceRoot?: string; [key: string]: unknown };
  try {
    await application.initialize();
    client = (await connect(application, "mac13-identity")).client;
    const workspace = await owner.workspace(root);
    const settled = () => workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight;
    await until(settled, "initial FRESH");
    const call = async (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: { repoRoot: root, ...args } });
    const ok = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      assert.notEqual(result.isError, true, toolText(result));
      return toolJson(result) as Record<string, unknown>;
    };
    const publish = async (relative: string, text: string) => {
      const before = owner.store.binding(workspace.workspaceId)!.snapshotId;
      await writeFile(path.join(root, relative), text);
      emit(0x1000 | FSEVENT_FLAGS.ItemIsFile, path.join(root, relative));
      await until(() => settled() && owner.store.binding(workspace.workspaceId)?.snapshotId !== before, `publish ${relative}`);
    };

    // Output: a named declaration carries its mac1 symbolId (no evidence handle); no internal key leaks.
    const found = await ok("java_symbol", { query: "com.acme.Orders#ship", searchMode: "exact", preview: "none" });
    const ship = (found.candidates as Array<{ declaration: Declaration }>)[0]!.declaration;
    assert.equal(Object.hasOwn(ship, "id"), false);
    assert.equal(ship.stability, "STABLE");
    assert.match(ship.symbolId!, /^jsym:mac1:/);
    assert.equal(Object.hasOwn(ship, "evidenceHandle"), false);
    // A local declaration has no lasting identity: stability=SNAPSHOT and an evidence handle only.
    const local = (await ok("java_symbol", { query: "LocalStep", searchMode: "exact", preview: "none" })).candidates as Array<{ declaration: Declaration }>;
    assert.equal(local.length, 1, JSON.stringify(local).slice(0, 400));
    assert.equal(local[0]!.declaration.stability, "SNAPSHOT");
    assert.equal(Object.hasOwn(local[0]!.declaration, "symbolId"), false);
    assert.match(local[0]!.declaration.evidenceHandle!, /^jev:mac1:/);
    const jobs = "src/main/java/com/acme/Jobs.java";
    const outline = await ok("java_symbol", { operation: "outline", file: jobs });
    assert.equal(outline.scopeState, "READY");
    const entries = outline.entries as Declaration[];
    const localEntry = entries.find(entry => entry.kind === "type" && entry.name === "LocalStep");
    assert.ok(localEntry);
    assert.equal(localEntry.stability, "SNAPSHOT");
    assert.equal(Object.hasOwn(localEntry, "symbolId"), false);
    assert.equal(localEntry.evidenceHandle, local[0]!.declaration.evidenceHandle);
    const parsed = parseEvidenceHandle(localEntry.evidenceHandle!);
    assert.ok(parsed.ok);
    const view = outline.indexView as { snapshotId: string; contentManifestId: string };
    assert.equal(parsed.handle.snapshotId, view.snapshotId);
    assert.equal(parsed.handle.contentManifestId, view.contentManifestId);
    assert.equal(parsed.handle.relativePath, jobs);
    assert.equal(parsed.handle.sourceHash, outline.contentHash);
    const field = entries.find(entry => entry.kind === "field" && entry.name === "pending");
    assert.ok(field);
    assert.equal(field.signature, "int pending");
    assert.equal(field.stability, "STABLE");
    assert.match(field.symbolId!, /^jsym:mac1:/);
    assert.equal(Object.hasOwn(field, "evidenceHandle"), false);
    assert.ok(entries.every(entry => !Object.hasOwn(entry, "declarationKey")));
    assert.equal(ship.symbolId!.split(":")[2], workspace.workspaceId);
    const evidence = await ok("java_symbol", { operation: "evidence", symbolId: ship.symbolId });
    const anchor = evidence.anchor as Declaration;
    assert.equal(anchor.symbolId, ship.symbolId);
    assert.equal(Object.hasOwn(anchor, "declarationId"), false);

    // java_impact(symbol=): overloads and one FQN in two source roots list candidates; impact never runs on a guess.
    const overloads = await ok("java_impact", { symbol: "com.acme.Orders#place" });
    assert.equal(overloads.status, "AMBIGUOUS");
    const overloadIds = (overloads.candidates as Declaration[]).map(candidate => candidate.symbolId);
    assert.equal(overloadIds.length, 2);
    assert.equal(new Set(overloadIds).size, 2);
    for (const candidate of overloads.candidates as Declaration[]) assert.equal(Object.hasOwn(candidate, "id"), false);
    const dup = await ok("java_impact", { symbol: "com.acme.Dup" });
    assert.equal(dup.status, "AMBIGUOUS");
    assert.deepEqual((dup.candidates as Declaration[]).map(candidate => candidate.sourceRoot).sort(), ["src/main/java", "src/test/java"]);
    assert.equal((await ok("java_impact", { symbol: "com.acme.Missing" })).status, "NOT_FOUND");
    // A parameter list picks one overload; simple and qualified type names both match the erased key.
    for (const symbol of ["com.acme.Orders#place(int)", "com.acme.Orders#place(String s)", "com.acme.Orders#place(java.lang.String)"]) {
      const picked = await ok("java_impact", { symbol, verbosity: "compact" });
      assert.equal(picked.status, undefined, `${symbol}: ${JSON.stringify(picked).slice(0, 300)}`);
    }
    const noOverload = await ok("java_impact", { symbol: "com.acme.Orders#place(long)" });
    assert.equal(noOverload.status, "NOT_FOUND");
    assert.match(String(noOverload.hint), /none has this parameter list/);
    // Arrays, varargs, a bounded type variable, nesting and annotation arguments are read from the parsed parameters.
    const fills = ((await ok("java_impact", { symbol: "com.acme.Orders#fill" })).candidates as Declaration[]).map(candidate => candidate.symbolId);
    assert.equal(fills.length, 2);
    const legacyArrayKey = Buffer.from(fills[0]!.split(":")[3]!, "base64url").toString("utf8")
      .replace(/^method:v3:/, "method:").replace(/#fill\(.*\)$/, "#fill(String[][])");
    const legacyArrayId = `jsym:mac1:${workspace.workspaceId}:${Buffer.from(legacyArrayKey).toString("base64url")}`;
    for (const [tool, args] of [["java_symbol", { operation: "evidence", symbolId: legacyArrayId }], ["java_impact", { symbol: legacyArrayId }]] as const) {
      const obsolete = await ok(tool, args);
      assert.equal(obsolete.status, "REJECTED");
      assert.equal(obsolete.reason, "MALFORMED");
      assert.match(String(obsolete.hint), /java_symbol/);
    }
    for (const symbol of ["com.acme.Orders#fill(String[])", "com.acme.Orders#fill(java.lang.String[][] grid)", "com.acme.Orders#log(String[])",
      "com.acme.Orders#log(@SuppressWarnings({\"a\", \"b\"}) String... lines)", "com.acme.Orders#pick(T)", "com.acme.Orders#pick(Number)",
      "com.acme.Orders#nest(Orders.Line)", "com.acme.Orders#nest(Orders$Line)", "com.acme.Orders#nest(com.acme.Orders.Line)"]) {
      const picked = await ok("java_impact", { symbol, verbosity: "compact" });
      assert.equal(picked.status, undefined, `${symbol}: ${JSON.stringify(picked).slice(0, 300)}`);
    }
    for (const symbol of ["com.acme.Orders#fill(String[][][])", "com.acme.Orders#log(String)", "com.acme.Orders#pick(Object)", "com.acme.Orders#nest(com.other.Line)"]) {
      assert.equal((await ok("java_impact", { symbol })).status, "NOT_FOUND", symbol);
    }
    // A partially qualified external type proves only its source spelling: a fuller name lists, never calls it absent.
    assert.equal((await ok("java_impact", { symbol: "com.acme.Maps#entry(Map.Entry, Object)", verbosity: "compact" })).status, undefined);
    const fuller = await ok("java_impact", { symbol: "com.acme.Maps#entry(java.util.Map.Entry, Object)" });
    assert.equal(fuller.status, "AMBIGUOUS", JSON.stringify(fuller).slice(0, 300));
    assert.equal((fuller.candidates as Declaration[]).length, 1);
    // A symbolId past 512 characters round-trips from java_symbol into java_impact.
    const deep = ((await ok("java_symbol", { query: "Deep#handle", searchMode: "exact", preview: "none" })).candidates as Array<{ declaration: Declaration }>)[0]!.declaration;
    assert.ok(deep.symbolId!.length > 512, String(deep.symbolId!.length));
    assert.equal((await ok("java_impact", { symbol: deep.symbolId, verbosity: "compact" })).status, undefined);
    for (const symbol of ["com.acme.Orders#ship", ship.symbolId!]) {
      const ran = await ok("java_impact", { symbol, verbosity: "diagnostic" });
      assert.equal(ran.status, undefined, JSON.stringify(ran).slice(0, 400));
      assert.equal((ran.indexView as { workspaceId: string }).workspaceId, workspace.workspaceId);
    }

    // Input: every pre-mac1 id shape and another workspace's id are rejected with a re-locate hint.
    for (const old of ["type:v2:src/main/java/com/acme/Orders.java#com.acme.Orders", "type-local:x", "method:com.acme.Orders#ship()", "field:com.acme.Orders#n", "file:x", "jsym:v0:x", "jev:v0:x"]) {
      const rejected = await ok("java_symbol", { operation: "evidence", symbolId: old });
      assert.equal(rejected.status, "REJECTED", old);
      assert.equal(rejected.reason, "PRE_MAC1_FORMAT", old);
      assert.match(String(rejected.hint), /java_symbol/);
    }
    const [, , ws, key] = ship.symbolId!.split(":");
    const handleAsId = await ok("java_symbol", { operation: "evidence", symbolId: local[0]!.declaration.evidenceHandle });
    assert.equal(handleAsId.status, "REJECTED");
    assert.equal(handleAsId.reason, "MALFORMED");
    assert.match(String(handleAsId.hint), /evidence handle, not a symbolId/);
    const foreign = await ok("java_symbol", { operation: "evidence", symbolId: `jsym:mac1:${ws!.split("").reverse().join("")}x:${key}` });
    assert.equal(foreign.status, "REJECTED");
    assert.equal(foreign.reason, "WORKSPACE_MISMATCH");

    // Mutually exclusive targets fail with a valid example.
    const both = await call("java_impact", { symbol: "com.acme.Orders#ship", file: "src/main/java/com/acme/Orders.java", line: 1, column: 1 });
    assert.equal(both.isError, true);
    assert.match(toolText(both), /"symbol":"com\.example\.OrderService#create"/);
    const neither = await call("java_impact", {});
    assert.equal(neither.isError, true);
    assert.match(toolText(neither), /"symbol":"com\.example\.OrderService#create"/);
    const mixed = await call("java_symbol", { operation: "evidence", symbolId: ship.symbolId, line: 1 });
    assert.equal(mixed.isError, true);
    assert.match(toolText(mixed), /"symbolId":"jsym:mac1:/);

    // An unrelated publish keeps the id; a signature change makes it a miss with a re-locate hint, not a rebind.
    await publish("src/main/java/com/acme/Other.java", "package com.acme; public class Other { int changed; }\n");
    const kept = await ok("java_symbol", { operation: "evidence", symbolId: ship.symbolId });
    assert.equal((kept.anchor as Declaration).symbolId, ship.symbolId);
    await publish("src/main/java/com/acme/Orders.java", "package com.acme; public class Orders { public void place(int n) {} public void place(String s) {} public void ship(int n) {} }\n");
    const changed = await ok("java_symbol", { operation: "evidence", symbolId: ship.symbolId });
    assert.equal(changed.status, "NOT_FOUND");
    assert.equal(changed.reason, "DECLARATION_CHANGED");
    assert.match(String(changed.hint), /java_symbol/);
    assert.equal((await ok("java_impact", { symbol: ship.symbolId })).status, "NOT_FOUND");
  } finally {
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
