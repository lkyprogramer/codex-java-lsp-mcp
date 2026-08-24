import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JavaLspApplication } from "./application.js";
import {
  HTTP_BODY_LIMIT_BYTES,
  installDaemonSignalHandling,
  JavaLspHttpServer,
  type JavaLspHttpServerAddress
} from "./http-server.js";

const EXPECTED_TOOLS = [
  "java_diagnostics",
  "java_impact",
  "java_runtime",
  "java_status",
  "java_symbol"
];

test("loopback HTTP host enforces security boundaries and isolates protocol clients", async t => {
  const fixture = await createApplicationFixture(t);
  const errors: unknown[] = [];
  const daemon = new JavaLspHttpServer({
    application: fixture.application,
    port: 0,
    instanceId: "http-server-test-instance",
    allowedOrigins: ["http://127.0.0.1:4123"],
    reportError: (_message, error) => { errors.push(error); }
  });
  const address = await daemon.start();
  t.after(() => daemon.shutdown().catch(() => undefined));
  const first = await connect(address, "first");
  const second = await connect(address, "second");
  t.after(() => Promise.allSettled([first.close(), second.close()]));

  assert.deepEqual(await toolNames(first), EXPECTED_TOOLS);
  assert.deepEqual(await toolNames(second), EXPECTED_TOOLS);
  await first.close();
  assert.equal(daemon.application.state().state, "ready");
  assert.deepEqual(await toolNames(second), EXPECTED_TOOLS);

  const status = await second.callTool({ name: "java_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(toolText(status), /"transport":"streamable_http"/);

  const health = await fetch(`${origin(address)}/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json() as { instanceId?: string };
  const healthText = JSON.stringify(healthPayload);
  assert.equal(healthPayload.instanceId, "http-server-test-instance");
  assert.equal(healthText.includes(fixture.root), false);
  assert.equal(healthText.includes("aliases"), false);

  const allowedOrigin = await fetch(`${origin(address)}/readyz`, {
    headers: { origin: "http://127.0.0.1:4123" }
  });
  assert.equal(allowedOrigin.status, 200);
  const hostileOrigin = await fetch(`${origin(address)}/readyz`, {
    headers: { origin: "https://evil.example" }
  });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(await statusWithHost(address, "evil.example"), 403);

  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await fetch(address.url, { method });
    assert.equal(response.status, 405, `${method} /mcp must be rejected`);
    assert.equal(response.headers.get("allow"), "POST");
  }
  const unknown = await fetch(`${origin(address)}/other`);
  assert.equal(unknown.status, 404);
  for (const pathSuffix of ["/MCP", "/mcp/", "/mcp?unexpected=1"]) {
    assert.equal((await fetch(`${origin(address)}${pathSuffix}`)).status, 404, `${pathSuffix} must not route to MCP`);
  }

  const oversized = await fetch(address.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({ payload: "x".repeat(HTTP_BODY_LIMIT_BYTES) })
  });
  assert.equal(oversized.status, 413);

  const malformed = await fetch(address.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: "{"
  });
  assert.equal(malformed.status, 400);
  assert.ok(errors.length >= 1, "malformed JSON should be observable without logging its body");

  await daemon.shutdown();
  assert.equal(daemon.state().state, "closed");
  assert.equal(daemon.application.state().state, "closed");
});

test("HTTP drain returns 503 for new MCP calls and lets entered calls finish", async t => {
  const fixture = await createApplicationFixture(t);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const daemon = new JavaLspHttpServer({
    application: fixture.application,
    port: 0,
    reportError: () => undefined,
    protocolFactory: () => {
      const protocol = new McpServer({ name: "drain-test", version: "0.1.0" });
      protocol.registerTool("hold", { description: "Hold one request", inputSchema: {} }, async () => {
        entered();
        await held;
        return { content: [{ type: "text" as const, text: "released" }] };
      });
      return protocol;
    }
  });
  const address = await daemon.start();
  const client = await connect(address, "drain-client");
  t.after(async () => {
    release?.();
    await client.close().catch(() => undefined);
    await daemon.shutdown().catch(() => undefined);
  });

  const call = client.callTool({ name: "hold", arguments: {} });
  await enteredPromise;
  const drain = daemon.drain(1000);
  assert.equal(daemon.state().state, "draining");
  await assert.rejects(
    () => client.listTools(),
    error => error instanceof StreamableHTTPError && error.code === 503
  );
  release();
  const result = await call;
  assert.equal(toolText(result), "released");
  await drain;
  await daemon.shutdown();
  assert.equal(daemon.state().state, "closed");
});

test("HTTP daemon configuration rejects unsafe ports and non-loopback origins", async () => {
  assert.throws(() => new JavaLspHttpServer({ port: 65536 }), /Invalid HTTP daemon port/);
  assert.throws(
    () => new JavaLspHttpServer({ port: 0, allowedOrigins: ["https://evil.example"] }),
    /exact loopback origins/
  );
  assert.throws(
    () => new JavaLspHttpServer({ port: 0, allowedOrigins: ["http://127.0.0.1:1234/"] }),
    /exact loopback origins/
  );
});

test("an idle HTTP daemon remains ready across the retired stdio server idle TTL", async t => {
  const previousIdleTtl = process.env.JAVA_LSP_SERVER_IDLE_TTL_MS;
  process.env.JAVA_LSP_SERVER_IDLE_TTL_MS = "100";
  const fixture = await createApplicationFixture(t);
  const daemon = new JavaLspHttpServer({ application: fixture.application, port: 0, reportError: () => undefined });
  const address = await daemon.start();
  t.after(async () => {
    await daemon.shutdown().catch(() => undefined);
    if (previousIdleTtl === undefined) delete process.env.JAVA_LSP_SERVER_IDLE_TTL_MS;
    else process.env.JAVA_LSP_SERVER_IDLE_TTL_MS = previousIdleTtl;
  });

  await new Promise(resolve => setTimeout(resolve, 350));
  const health = await fetch(`${origin(address)}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(daemon.state().state, "ready");
  assert.equal(daemon.application.state().state, "ready");
});

test("forced HTTP shutdown is bounded when a tool ignores request cancellation", async t => {
  const fixture = await createApplicationFixture(t);
  const application = fixture.application;
  const originalRunRequest = application.runRequest.bind(application);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  application.runRequest = operation => originalRunRequest(async () => {
    entered();
    await held;
    return operation();
  });
  const daemon = new JavaLspHttpServer({ application, port: 0, reportError: () => undefined });
  const address = await daemon.start();
  const client = await connect(address, "forced-shutdown-client");
  t.after(async () => {
    release?.();
    await client.close().catch(() => undefined);
    await daemon.shutdown().catch(() => undefined);
  });

  const callFailure = assert.rejects(client.callTool({ name: "java_status", arguments: {} }));
  await enteredPromise;
  const startedAt = Date.now();
  await daemon.shutdown(20);
  assert.ok(Date.now() - startedAt < 1000, "forced daemon shutdown must not await a non-cooperative tool");
  assert.equal(daemon.state().state, "closed");
  assert.equal(application.state().state, "closed");
  await assert.rejects(() => fetch(`${origin(address)}/healthz`));
  await callFailure;

  release();
});

test("HTTP daemon signal boundary exits nonzero after a forced JDT shutdown failure", { timeout: 5000 }, async () => {
  const moduleUrl = new URL("./http-server.js", import.meta.url).href;
  const script = `
    import { installDaemonSignalHandling } from ${JSON.stringify(moduleUrl)};
    installDaemonSignalHandling({
      shutdown: async () => { throw new Error("injected force-stop failure"); }
    }, { shutdownGraceMs: 0 });
    setInterval(() => undefined, 1000);
    process.kill(process.pid, "SIGTERM");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.match(stderr, /HTTP daemon shutdown failed/);
  assert.match(stderr, /forced exit after shutdown deadline/);
});

test("HTTP daemon signal boundary exits after a successful bounded shutdown even with a retained handle", { timeout: 5000 }, async () => {
  const moduleUrl = new URL("./http-server.js", import.meta.url).href;
  const script = `
    import { installDaemonSignalHandling } from ${JSON.stringify(moduleUrl)};
    installDaemonSignalHandling({
      shutdown: async () => undefined
    }, { shutdownGraceMs: 1000 });
    setInterval(() => undefined, 1000);
    process.kill(process.pid, "SIGTERM");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null);
  assert.equal(code, 0);
});

test("shutdown racing startup cannot leave a listening daemon", async t => {
  const fixture = await createApplicationFixture(t);
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath: path.join(fixture.root, "projects.json"),
    resolverOptions: { cwdFallback: "reject" },
    cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  // initialize() accepts a synchronous janitor, so delay the start at the application boundary.
  const originalInitialize = application.initialize.bind(application);
  application.initialize = async () => {
    await cleanupGate;
    return originalInitialize();
  };
  const daemon = new JavaLspHttpServer({ application, port: 0, reportError: () => undefined });
  const start = daemon.start();
  const shutdown = daemon.shutdown();
  releaseCleanup();
  const address = await start;
  await shutdown;
  assert.equal(daemon.state().state, "closed");
  assert.equal(application.state().state, "closed");
  await assert.rejects(() => fetch(`${origin(address)}/healthz`));
});

test("two HTTP clients reuse one live LSP root and isolate linked worktree LSP runtimes", async t => {
  const fixtureBase = await mkdtemp(path.join(tmpdir(), "java-lsp-http-worktrees-"));
  const source = path.join(fixtureBase, "source");
  const firstRoot = path.join(fixtureBase, "worktree-one");
  const secondRoot = path.join(fixtureBase, "worktree-two");
  const cacheBase = path.join(fixtureBase, "cache");
  const ownershipBase = path.join(fixtureBase, "ownership");
  const fakeJdtls = path.join(fixtureBase, "fake-jdtls.mjs");
  const fakeJdk = path.join(fixtureBase, "fake-jdk");
  await mkdir(source, { recursive: true });
  git(source, "init", "-q");
  await mkdir(path.join(source, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(source, "pom.xml"), "<project><properties><maven.compiler.release>17</maven.compiler.release></properties></project>\n");
  await writeFile(path.join(source, "src", "main", "java", "demo", "Demo.java"), "package demo; class Demo {}\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Codex Test", "-c", "user.email=codex@example.invalid", "commit", "-qm", "fixture");
  git(source, "worktree", "add", "-q", "-b", "http-worktree-one", firstRoot);
  git(source, "worktree", "add", "-q", "-b", "http-worktree-two", secondRoot);
  const previousCache = process.env.JAVA_LSP_CACHE_BASE;
  const previousOwnership = process.env.JAVA_LSP_OWNERSHIP_BASE;
  const previousJdtlsBin = process.env.JDTLS_BIN;
  const previousProjectJavaHome = process.env.JAVA_LSP_PROJECT_JAVA_HOME;
  const previousMaxActiveRepos = process.env.JAVA_LSP_MAX_ACTIVE_REPOS;
  const previousIdleTtl = process.env.JAVA_LSP_IDLE_TTL_MS;
  await mkdir(path.join(fakeJdk, "bin"), { recursive: true });
  await writeFile(path.join(fakeJdk, "bin", "java"), "#!/bin/sh\necho 'openjdk version \"17.0.0\"' >&2\n", { mode: 0o755 });
  await chmod(path.join(fakeJdk, "bin", "java"), 0o755);
  await writeFile(fakeJdtls, fakeJdtlsProgram(), { mode: 0o755 });
  await chmod(fakeJdtls, 0o755);
  process.env.JAVA_LSP_CACHE_BASE = cacheBase;
  process.env.JAVA_LSP_OWNERSHIP_BASE = ownershipBase;
  process.env.JDTLS_BIN = fakeJdtls;
  process.env.JAVA_LSP_PROJECT_JAVA_HOME = fakeJdk;
  process.env.JAVA_LSP_MAX_ACTIVE_REPOS = "2";
  process.env.JAVA_LSP_IDLE_TTL_MS = "60000";
  const restoreFixtureEnvironment = async (): Promise<void> => {
    if (previousCache === undefined) delete process.env.JAVA_LSP_CACHE_BASE;
    else process.env.JAVA_LSP_CACHE_BASE = previousCache;
    if (previousOwnership === undefined) delete process.env.JAVA_LSP_OWNERSHIP_BASE;
    else process.env.JAVA_LSP_OWNERSHIP_BASE = previousOwnership;
    if (previousJdtlsBin === undefined) delete process.env.JDTLS_BIN;
    else process.env.JDTLS_BIN = previousJdtlsBin;
    if (previousProjectJavaHome === undefined) delete process.env.JAVA_LSP_PROJECT_JAVA_HOME;
    else process.env.JAVA_LSP_PROJECT_JAVA_HOME = previousProjectJavaHome;
    if (previousMaxActiveRepos === undefined) delete process.env.JAVA_LSP_MAX_ACTIVE_REPOS;
    else process.env.JAVA_LSP_MAX_ACTIVE_REPOS = previousMaxActiveRepos;
    if (previousIdleTtl === undefined) delete process.env.JAVA_LSP_IDLE_TTL_MS;
    else process.env.JAVA_LSP_IDLE_TTL_MS = previousIdleTtl;
    await rm(fixtureBase, { recursive: true, force: true });
  };

  const projectsConfigPath = path.join(fixtureBase, "projects.json");
  await writeFile(projectsConfigPath, JSON.stringify({
    aliases: [
      { id: "http-worktree-one", root: firstRoot, lspEnabled: true, layoutProfile: "maven-reactor" },
      { id: "http-worktree-two", root: secondRoot, lspEnabled: true, layoutProfile: "maven-reactor" }
    ]
  }));
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath,
    resolverOptions: { cwdFallback: "reject" },
    cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  const daemon = new JavaLspHttpServer({ application, port: 0, reportError: () => undefined });
  const address = await daemon.start();
  const firstClient = await connect(address, "same-root-one");
  const secondClient = await connect(address, "same-root-two");
  t.after(async () => {
    await Promise.allSettled([firstClient.close(), secondClient.close()]);
    await daemon.shutdown().catch(() => undefined);
    await restoreFixtureEnvironment();
  });

  const [sameRootFirst, sameRootSecond] = await Promise.all([
    firstClient.callTool({ name: "java_status", arguments: { repoRoot: firstRoot, start: true, detail: "diagnostic" } }),
    secondClient.callTool({ name: "java_status", arguments: { repoRoot: firstRoot, start: true, detail: "diagnostic" } })
  ]);
  assert.equal(sameRootFirst.isError, undefined);
  assert.equal(sameRootSecond.isError, undefined);
  const firstStatus = toolJson(sameRootFirst);
  const secondStatus = toolJson(sameRootSecond);
  assert.equal(firstStatus.started, true);
  assert.equal(secondStatus.started, true);
  assert.equal(typeof firstStatus.pid, "number");
  assert.equal(firstStatus.pid, secondStatus.pid, "same root must reuse one JDT LS child");
  assert.equal(application.runtimes.activeRepos().length, 1);

  const otherRoot = await secondClient.callTool({
    name: "java_status",
    arguments: { repoRoot: secondRoot, start: true, detail: "diagnostic" }
  });
  assert.equal(otherRoot.isError, undefined);
  const otherStatus = toolJson(otherRoot);
  assert.equal(otherStatus.started, true);
  assert.equal(typeof otherStatus.pid, "number");
  assert.notEqual(otherStatus.pid, firstStatus.pid, "linked worktrees must own distinct JDT LS children");
  assert.notEqual(firstStatus.dataDir, otherStatus.dataDir, "linked worktrees must use distinct JDT workspace paths");

  const semantic = await firstClient.callTool({
    name: "java_symbol",
    arguments: { repoRoot: firstRoot, query: "Demo" }
  });
  assert.equal(semantic.isError, undefined);
  assert.deepEqual(toolJson(semantic).items, [], "workspace/symbol must travel through the started LSP connection");

  const active = application.runtimes.activeRepos();
  assert.equal(active.length, 2);
  assert.notEqual(active[0]?.repoHash, active[1]?.repoHash);
  assert.notEqual(active[0]?.repoRoot, active[1]?.repoRoot);

  const shutdownOne = await firstClient.callTool({
    name: "java_runtime",
    arguments: { action: "shutdown", repoRoot: firstRoot }
  });
  assert.equal(shutdownOne.isError, undefined);
  assert.equal(daemon.state().state, "ready");
  const stillAvailable = await secondClient.callTool({
    name: "java_status",
    arguments: { repoRoot: secondRoot, start: true }
  });
  assert.equal(stillAvailable.isError, undefined);
  assert.equal(toolJson(stillAvailable).started, true);
});

async function createApplicationFixture(t: test.TestContext): Promise<{
  root: string;
  application: JavaLspApplication;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-http-host-"));
  const projectsConfigPath = path.join(root, "projects.json");
  await writeFile(projectsConfigPath, JSON.stringify({ aliases: [] }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    application: new JavaLspApplication({
      transportMode: "streamable_http",
      projectsConfigPath,
      resolverOptions: { cwdFallback: "reject" },
      cacheJanitorIntervalMs: 0,
      cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
    })
  };
}

async function connect(address: JavaLspHttpServerAddress, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(address.url)));
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(tool => tool.name).sort();
}

function toolText(result: unknown): string {
  const payload = result as { content?: Array<{ type?: string; text?: string }> };
  const content = payload.content?.[0];
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected one text tool result.");
  }
  return content.text;
}

function toolJson(result: unknown): Record<string, unknown> {
  const parsed = JSON.parse(toolText(result));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object tool result.");
  }
  return parsed as Record<string, unknown>;
}

function origin(address: JavaLspHttpServerAddress): string {
  return `http://${address.host}:${address.port}`;
}

function statusWithHost(address: JavaLspHttpServerAddress, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: address.host,
      port: address.port,
      path: "/healthz",
      headers: { host }
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function fakeJdtlsProgram(): string {
  return `#!${process.execPath}
let buffer = Buffer.alloc(0);

function send(id, result) {
  if (id === undefined) return;
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    send(message.id, { capabilities: {} });
  } else if (message.method === "shutdown") {
    send(message.id, null);
  } else if (message.method === "workspace/symbol") {
    send(message.id, []);
  }
}

function consume() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\\s*(\\d+)/i);
    if (!match) throw new Error("Missing Content-Length");
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
}

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  consume();
});
process.stdin.on("end", () => process.exit(0));
`;
}
