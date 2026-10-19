// input: a registered ILV2 run root, the compiled candidate, and (for semantic cases) the frozen toolchains.
// output: one isolated launchd owner job running the real HTTP daemon under the owner launcher, its
//         MCP clients, fault barriers, and the closeout that proves both process classes gone.
// pos: MAC-09 formal recovery and fault matrix. Isolated cache, ports, HOME and Gradle home; never the
//      production cache, LaunchAgent or :38456. Repos and the Gradle configuration live outside the
//      fixture root, so they exist before launchd starts the job (RunAtLoad).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execute, readJson, sha256, verifyRuntime, writeJson } from "./ilv2-mac-contracts.mjs";
import { createOwnerFixture, eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";
import { sourceRoot } from "./ilv2-mac-mcp-owner-fixture.mjs";
import { GradleDomain, defaultGradleCleanupIO } from "../dist/mac-platform/gradle-domain.js";

export { eventually, processAlive };

export async function frozenToolchains() {
  const frozen = await readJson(process.env.ILV2_TOOLCHAINS ?? "ILV2_TOOLCHAINS is unset: name the frozen toolchain INPUT");
  for (const file of frozen.files) assert.equal(sha256(await readFile(file.path)), file.sha256, `toolchain drift: ${file.path}`);
  assert.equal(frozen.jdtVersion, "1.56.0"); assert.equal(frozen.gradleVersion, "9.3.1");
  return frozen;
}

/** A small Gradle project: App calls Greeter.greet, so a JDT definition proves semantic service. */
export async function gradleRepo(dir, name) {
  const repo = path.join(dir, name);
  await mkdir(path.join(repo, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(repo, "settings.gradle"), `rootProject.name = 'mac09-${name}'\n`);
  await writeFile(path.join(repo, "build.gradle"), "plugins { id 'java' }\n");
  await writeFile(path.join(repo, "gradle.properties"), "org.gradle.jvmargs=-Xms128m -Xmx512m\norg.gradle.daemon.idletimeout=600000\n");
  await writeFile(path.join(repo, "src/main/java/demo/Greeter.java"), "package demo;\n\npublic class Greeter {\n  public String greet(String name) { return \"hello \" + name; }\n}\n");
  await writeFile(path.join(repo, "src/main/java/demo/App.java"),
    "package demo;\n\npublic class App {\n  public static void main(String[] args) {\n    System.out.println(new Greeter().greet(\"mac09\"));\n  }\n}\n");
  return repo;
}
export const greetCall = { file: "src/main/java/demo/App.java", line: 5, column: "    System.out.println(new Greeter().".length + 1 };

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 38456);
  return port;
}

export function childPids(pid) {
  try { return execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return []; throw error; }
}
export function command(pid) {
  try { return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
  catch (error) { if (error.status === 1) return ""; throw error; }
}

/** Pids of this domain's Gradle daemons that are alive (from their own registry logs). */
export async function liveDaemons(home, version = "9.3.1") {
  const entries = await readdir(path.join(home, "daemon", version)).catch(() => []);
  return entries.flatMap(name => /^daemon-(\d+)\.out\.log$/.exec(name)?.slice(1).map(Number) ?? []).filter(processAlive).sort((a, b) => a - b);
}

export async function call(client, name, args) {
  const started = performance.now();
  let result;
  try { result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); }
  catch (error) { return { error: error.message, rpcError: true, elapsedMs: performance.now() - started }; }
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) return { error: text, elapsedMs: performance.now() - started };
  return Object.assign(JSON.parse(text), { elapsedMs: performance.now() - started });
}

/**
 * Starts the launchd job. `repos(dir)` prepares repo roots in a directory outside the fixture root;
 * `pins` are registered lspEnabled (and so prewarmed by the daemon); `gradle` writes the domain's
 * distribution configuration from the frozen toolchains.
 */
export async function startRecoveryOwner(t, name, { repos, pins = () => [], frozen, gcCycleMs = 1500, env = {} }) {
  await verifyRuntime();
  assert.ok(process.env.ILV2_RUN_ROOT, "registered run root required");
  const input = await realpath(await mkdtemp(path.join(os.tmpdir(), `mac09-${name}-`)));
  const barrierDir = path.join(input, "barriers");
  for (const dir of [barrierDir, path.join(input, "ownership")]) await mkdir(dir);
  const repoRoots = await repos(input);
  const projects = path.join(input, "projects.json");
  await writeJson(projects, { aliases: pins(repoRoots).map((root, index) => ({ id: `${name}-${index}`, root, lspEnabled: true })), defaults: {} });
  const gradleConfig = path.join(input, "gradle-distributions.json");
  if (frozen) await writeGradleConfig(gradleConfig, frozen);
  const port = await freePort();
  const daemonEnv = { JAVA_LSP_HTTP_PORT: String(port), JAVA_LSP_PROJECTS_JSON: projects, JAVA_LSP_OWNERSHIP_BASE: path.join(input, "ownership"),
    JAVA_LSP_FAULT_BARRIER_DIR: barrierDir, JAVA_LSP_GC_CYCLE_MS: String(gcCycleMs),
    ...(frozen ? { JAVA_LSP_GRADLE_DISTRIBUTIONS: gradleConfig } : {}), ...env };
  const fixture = await createOwnerFixture({ after() {} }, { entry: "scripts/ilv2-mac-recovery-owner.mjs", daemonEnv,
    ...(frozen ? { javaHome: frozen.javaHome, jdtlsBin: frozen.jdtlsBin } : {}) });
  const home = path.join(fixture.root, "service-state", "jdt-gradle-home");
  const url = `http://127.0.0.1:${port}/mcp`;
  const clients = [];
  const owner = {
    fixture, input, repos: repoRoots, port, url, home, barrierDir, gradleConfig, cache: fixture.cacheRoot,
    mac1: path.join(fixture.cacheRoot, "mac1"),
    async readyRows() { return (await fixture.records()).filter(row => row.type === "ready"); },
    /** The incarnation started after `afterPid`'s (or the first), once its advertised endpoint is its own. */
    async incarnation(afterPid) {
      const row = await eventually(async () => {
        const rows = await owner.readyRows();
        return afterPid === undefined ? rows[0] : rows[rows.findIndex(item => item.pid === afterPid) + 1];
      }, 30000);
      await eventually(async () => {
        try { return JSON.parse(await readFile(path.join(fixture.cacheRoot, "owner-endpoint.json"), "utf8")).pid === row.pid; } catch { return false; }
      }, 30000);
      return row;
    },
    async http() {
      const client = new Client({ name: `mac09-${name}-http`, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      clients.push(client);
      return client;
    },
    async stdio(cwd) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sourceRoot, "dist/server.js")], cwd, stderr: "pipe",
        env: { PATH: process.env.PATH, HOME: path.join(fixture.root, "home"), TMPDIR: path.join(fixture.root, "tmp"), JAVA_LSP_CACHE_ROOT: fixture.cacheRoot,
          JAVA_LSP_PROJECTS_JSON: projects, JAVA_LSP_OWNERSHIP_BASE: path.join(input, "ownership"), JAVA_LSP_ISOLATED_VALIDATION: "1",
          JDTLS_BIN: "/usr/bin/false", ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST } });
      const client = new Client({ name: `mac09-${name}-stdio`, version: "1.0.0" });
      await client.connect(transport);
      clients.push(client);
      return { client, pid: transport.pid };
    },
    async arm(step) { await writeFile(path.join(barrierDir, `${step}.arm`), ""); },
    async held(step, timeoutMs = 60000) {
      return eventually(async () => { try { return JSON.parse(await readFile(path.join(barrierDir, `${step}.held`), "utf8")); } catch { return undefined; } }, timeoutMs);
    },
    async release(step) { await writeFile(path.join(barrierDir, `${step}.release`), ""); },
    /** External SIGKILL of one incarnation's daemon; launchd then clears its process group. */
    kill(row) { const at = performance.now(); process.kill(row.pid, "SIGKILL"); return at; },
    /** Workspace bindings as on disk, by canonical root. */
    async bindings() {
      const out = {};
      for (const id of await readdir(path.join(owner.mac1, "workspaces")).catch(() => [])) {
        try { const binding = JSON.parse(await readFile(path.join(owner.mac1, "workspaces", id, "binding.json"), "utf8")); out[binding.root.canonicalRoot] = binding; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return out;
    },
    async storeObjects() {
      const list = async dir => (await readdir(path.join(owner.mac1, dir), { withFileTypes: true }).catch(() => [])).map(entry => entry.name).sort();
      const workspaceFiles = {};
      for (const id of await list("workspaces")) workspaceFiles[id] = (await readdir(path.join(owner.mac1, "workspaces", id)).catch(() => [])).sort();
      return { snapshots: await list("snapshots"), jobs: await list("jobs"), workspaceFiles };
    },
    /** A bound snapshot is sealed and its database still hashes to its manifest. */
    async verifySnapshot(snapshotId) {
      const dir = path.join(owner.mac1, "snapshots", snapshotId);
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
      const actual = sha256(await readFile(path.join(dir, "index.sqlite")));
      // The binding's content identity is the manifest's; the file still hashes to the sealed digest.
      const binding = Object.values(await owner.bindings()).find(item => item.snapshotId === snapshotId);
      return { snapshotId, manifestSha256: manifest.file?.sha256, actualSha256: actual,
        matches: manifest.file?.sha256 === actual && manifest.snapshotId === snapshotId && (!binding || binding.contentManifestId === manifest.contentManifestId),
        sidecars: (await readdir(dir)).filter(entry => entry !== "index.sqlite" && entry !== "manifest.json") };
    },
    clients
  };
  return owner;
}

export async function writeGradleConfig(file, frozen, overrides = {}) {
  await writeJson(file, { import: frozen.gradleVersion,
    distributions: [{ ...frozen.distribution, gradleHome: frozen.gradleHome, ...overrides }] });
}

/**
 * Closeout: bootout, every incarnation's group gone, then this domain's Gradle daemons. The daemon's
 * own normal stop (§2.1) must have stopped them; a survivor is cleaned from here and reported.
 */
export async function closeRecoveryOwner(owner, frozen) {
  const result = { bootout: undefined, groupsGone: false, daemonsAfterNormalStop: [], fallbackCleanup: null };
  for (const client of owner.clients) await client.close().catch(() => {});
  try { await execute("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${owner.fixture.label}`]); result.bootout = 0; }
  catch (error) { if (![3, 113].includes(error.code)) throw error; result.bootout = error.code; }
  const rows = await owner.readyRows();
  await eventually(() => rows.every(row => !processAlive(-row.pgid)), 30000);
  result.groupsGone = true;
  if (frozen) {
    const deadline = performance.now() + 5000;
    do result.daemonsAfterNormalStop = await liveDaemons(owner.home);
    while (result.daemonsAfterNormalStop.length && performance.now() < deadline && await new Promise(resolve => setTimeout(resolve, 100, true)));
    if (result.daemonsAfterNormalStop.length) {
      const domain = new GradleDomain(owner.home, [frozen.distribution], defaultGradleCleanupIO);
      await domain.recover(async () => {});
      result.fallbackCleanup = { daemonsAfter: await liveDaemons(owner.home) };
    }
  }
  await owner.fixture.close();
  // Sealed snapshots are read-only by mode: restore write access, then remove the fixture and input roots.
  const writable = async dir => {
    await chmod(dir, 0o755).catch(() => {});
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
  };
  for (const dir of [owner.fixture.root, owner.input]) { await writable(dir); await rm(dir, { recursive: true, force: true }); }
  return result;
}

export async function evidence(name, value) {
  const dir = process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, `${name}.json`), value);
}

export async function copyEvidence(owner, name) {
  const dir = path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), `${name}-files`);
  await mkdir(dir, { recursive: true });
  for (const [from, to] of [["timeline.jsonl", "timeline.jsonl"], ["stderr.log", "daemon-stderr.log"], ["stdout.log", "daemon-stdout.log"]])
    await cp(path.join(owner.fixture.root, from), path.join(dir, to)).catch(error => { if (error.code !== "ENOENT") throw error; });
  await cp(path.join(owner.home, "daemon"), path.join(dir, "gradle-daemon-logs"), { recursive: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
}
