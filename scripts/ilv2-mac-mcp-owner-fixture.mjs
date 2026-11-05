// input: a registered ILV2 run root, the compiled candidate and repos prepared by the caller.
// output: one isolated owner daemon (HTTP MCP under the owner launcher, real FSEvents trackers)
//         plus HTTP and stdio-relay clients against it.
// pos: MAC-08B shared MCP fixture: stdio only relays, so every stdio MCP test needs an owner.
//      Isolated cache, ports and HOME; never the production cache, LaunchAgent or :38456.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixture = path.join(sourceRoot, "fixtures", "java-index-v2");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 38456);
  return port;
}

export function children(pid) {
  try { return execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return []; throw error; }
}

/**
 * One isolated owner daemon on a free loopback port, launched with the owner lock.
 * `prepare(root)` returns the repo roots (default: copies of the java-index-v2 fixture);
 * `projects` (or projects(repos)) is the owner's projects.json; `env` (or env(root)) adds daemon variables; `preload` is source run
 * in the owner before the daemon (the launcher scrubs NODE_OPTIONS, so `--import` cannot be used).
 */
export async function startOwner(t, name, { repos = 1, prepare, projects = { aliases: [], defaults: {} }, env: extra = {}, preload } = {}) {
  await verifyRuntime();
  assert.ok(process.env.ILV2_RUN_ROOT, "registered run root required");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `mac-mcp-${name}-`)));
  for (const dir of ["cache", "home", "tmp", "owner", "service-state"]) await mkdir(path.join(root, dir));
  const cache = path.join(root, "cache");
  let repoRoots = [];
  if (prepare) repoRoots = await prepare(root);
  else for (let index = 0; index < repos; index += 1) {
    const repo = path.join(root, `repo-${index}`);
    await cp(defaultFixture, repo, { recursive: true });
    repoRoots.push(repo);
  }
  const resolvedProjects = typeof projects === "function" ? projects(repoRoots) : projects;
  await writeFile(path.join(root, "projects.json"), `${JSON.stringify(resolvedProjects)}\n`);
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    JAVA_LSP_CACHE_ROOT: cache, JAVA_LSP_OWNERSHIP_BASE: path.join(root, "owner"), JAVA_LSP_PROJECTS_JSON: path.join(root, "projects.json"),
    JAVA_LSP_SERVICE_STATE_ROOT: path.join(root, "service-state"), GRADLE_USER_HOME: path.join(root, "service-state", "gradle-home"),
    JDTLS_BIN: "/usr/bin/false", JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_HTTP_PORT: String(port),
    ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST, ...(typeof extra === "function" ? extra(root) : extra) };
  let entry = path.join(sourceRoot, "dist/http-server.js");
  if (preload) {
    // Named http-server.js: the daemon starts only when argv[1] ends with it.
    await mkdir(path.join(root, "preload"));
    await writeFile(path.join(root, "preload", "package.json"), '{"type":"module"}\n');
    entry = path.join(root, "preload", "http-server.js");
    await writeFile(entry, `${preload}\nawait import(${JSON.stringify(path.join(sourceRoot, "dist/http-server.js"))});\n`);
  }
  const launch = await ownerLaunchArguments(cache, entry);
  const lease = await acquireFixtureSlot(MAC_WORK_ROOT);
  let stderr = "";
  const daemon = spawn(launch.binary, launch.args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const closed = new Promise((resolve, reject) => { daemon.once("close", (code, signal) => resolve({ code, signal })); daemon.once("error", reject); });
  void closed.catch(() => {});
  daemon.stderr.on("data", bytes => { if (stderr.length < 256 * 1024) stderr += bytes; });
  const clients = [];
  const owner = {
    root, cache, env, port, repos: repoRoots, daemon, closed, clients, url: `http://127.0.0.1:${port}/mcp`,
    stderr: () => stderr,
    async kill() {
      if (daemon.pid && processAlive(daemon.pid)) { try { process.kill(-daemon.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      await closed.catch(() => {});
      if (daemon.pid) await eventually(() => !processAlive(daemon.pid) && !processAlive(-daemon.pid), 5000);
    }
  };
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    try { await owner.kill(); } finally { await lease.release(); }
    // Sealed snapshots are read-only by mode: restore write access, then remove the fixture root.
    const writable = async dir => {
      await chmod(dir, 0o755).catch(() => {});
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });
  await lease.registerChild(daemon.pid, daemon.pid);
  await eventually(() => existsSync(path.join(cache, "owner-endpoint.json")) || (daemon.exitCode !== null && Promise.reject(new Error(`daemon exited: ${stderr}`))), 20000);
  const advertised = JSON.parse(await readFile(path.join(cache, "owner-endpoint.json"), "utf8"));
  assert.equal(advertised.url, owner.url);
  assert.equal(advertised.pid, daemon.pid, "the launcher execs node in place: the daemon pid advertises itself");
  return owner;
}

export async function httpClient(owner) {
  const client = new Client({ name: "mac08b-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(owner.url)));
  owner.clients.push(client);
  return client;
}

/** The stdio entry as Codex launches it; it finds the owner through the advertised endpoint. */
export async function stdioClient(owner, cwd, { env = {} } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sourceRoot, "dist/server.js")], cwd, env: { ...owner.env, ...env }, stderr: "pipe" });
  const client = new Client({ name: "mac08b-stdio", version: "1.0.0" });
  await client.connect(transport);
  owner.clients.push(client);
  return { client, pid: transport.pid };
}

export async function call(client, name, args) {
  let result;
  // A JSON-RPC error (e.g. the relay's "owner unavailable") rejects; a tool error resolves with isError.
  try { result = await client.callTool({ name, arguments: args }); }
  catch (error) { if (error?.code === -32000) return { error: error.message }; throw error; }
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) return { error: text };
  return JSON.parse(text);
}

/** A failure carries the daemon's own stderr: the owner is a separate process. */
export function withDaemonLog(owner, body) {
  return body().catch(error => { error.message += `\n--- daemon stderr (exit ${owner.daemon.exitCode}/${owner.daemon.signalCode}) ---\n${owner.stderr().slice(-6000)}`; throw error; });
}
