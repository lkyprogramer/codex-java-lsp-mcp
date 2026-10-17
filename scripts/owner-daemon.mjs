// input: a compiled candidate's dist/server.js, an isolated cache root and the caller's child env.
// output: one owner daemon (dist/http-server.js under the native owner launcher) advertised in that
//         cache, plus the stdio-relay env that reaches it; stop() reaps the daemon's process group.
// pos: MAC-08B driver support: stdio only relays (contract §1), so a driver that speaks stdio MCP
//      starts its own owner. Every state root is isolated; never the production cache or :38456.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_PORT = 38456;
const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

async function freeLoopbackPort() {
  for (;;) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    if (port !== PRODUCTION_PORT) return port;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

function removeTree(dir) {
  const writable = current => {
    try { chmodSync(current, 0o755); } catch { return; }
    for (const entry of readdirSync(current, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(current, entry.name));
  };
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Starts the owner for `cacheRoot` (created if missing). `env` is the driver's child env; the
 * daemon gets it with every state root (HOME, ownership, service state, Gradle home, projects)
 * moved under a private temp root, JDTLS_BIN defaulting to /usr/bin/false and a free port.
 * `ephemeralCache`: stop() also removes the cache (sealed snapshots are read-only by mode).
 */
export async function startOwnerDaemon({ serverJs, cacheRoot, env = process.env, projects = { aliases: [], defaults: {} }, ephemeralCache = false }) {
  const dist = path.dirname(path.resolve(serverJs));
  const entry = path.join(dist, "http-server.js");
  if (!existsSync(entry)) throw new Error(`owner entry missing beside ${serverJs}: ${entry}`);
  mkdirSync(cacheRoot, { recursive: true });
  const cache = realpathSync(cacheRoot);
  const state = realpathSync(mkdtempSync(path.join(os.tmpdir(), "java-lsp-owner-")));
  for (const dir of ["home", "tmp", "owner", "service-state"]) mkdirSync(path.join(state, dir));
  const projectsJson = path.join(state, "projects.json");
  writeFileSync(projectsJson, `${JSON.stringify(projects)}\n`);
  const port = await freeLoopbackPort();
  const daemonEnv = { ...env, HOME: path.join(state, "home"), TMPDIR: path.join(state, "tmp"),
    JAVA_LSP_CACHE_ROOT: cache, JAVA_LSP_OWNERSHIP_BASE: path.join(state, "owner"), JAVA_LSP_PROJECTS_JSON: projectsJson,
    JAVA_LSP_SERVICE_STATE_ROOT: path.join(state, "service-state"), GRADLE_USER_HOME: path.join(state, "service-state", "gradle-home"),
    JDTLS_BIN: env.JDTLS_BIN || "/usr/bin/false", JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_HTTP_PORT: String(port) };
  delete daemonEnv.JAVA_LSP_OWNER_ENDPOINT;
  const { ownerLaunchArguments } = await import(pathToFileURL(path.join(dist, "mac-platform", "owner-lock.js")).href);
  const launch = await ownerLaunchArguments(cache, entry);
  const daemon = spawn(launch.binary, launch.args, { env: daemonEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  daemon.stderr.on("data", bytes => { if (stderr.length < 256 * 1024) stderr += bytes; });
  const closed = new Promise(resolve => daemon.once("close", (code, signal) => resolve({ code, signal })));
  const spawned = new Promise((resolve, reject) => { daemon.once("spawn", resolve); daemon.once("error", reject); });
  // A driver that dies without stop() must not leave its owner running.
  const onExit = () => { if (daemon.pid) signalGroup(daemon.pid, "SIGKILL"); };
  process.once("exit", onExit);
  let stopped;
  const stop = () => stopped ??= (async () => {
    process.removeListener("exit", onExit);
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) {
      signalGroup(daemon.pid, "SIGTERM");
      const graceful = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(resolve, STOP_GRACE_MS, false))]);
      if (!graceful) signalGroup(daemon.pid, "SIGKILL");
      await closed;
    }
    // Workers and builders share the daemon's group: none may outlive it.
    if (daemon.pid) signalGroup(daemon.pid, "SIGKILL");
    removeTree(state);
    if (ephemeralCache) removeTree(cache);
  })();
  try {
    await spawned;
    const endpointFile = path.join(cache, "owner-endpoint.json");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let advertised;
    while (!advertised) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`owner daemon exited (${daemon.exitCode ?? daemon.signalCode}): ${stderr.slice(-4000)}`);
      if (Date.now() > deadline) throw new Error(`owner daemon not advertised within ${READY_TIMEOUT_MS} ms: ${stderr.slice(-4000)}`);
      try {
        const record = JSON.parse(readFileSync(endpointFile, "utf8"));
        if (record.pid === daemon.pid) advertised = record;
      } catch { /* not advertised yet */ }
      if (!advertised) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = advertised.url;
    return {
      url, pid: daemon.pid, cacheRoot: cache, stop, stderr: () => stderr, alive: () => Boolean(daemon.pid) && alive(daemon.pid),
      /** The env for dist/server.js: the relay goes to this owner and no other. */
      relayEnv: { ...env, JAVA_LSP_CACHE_ROOT: cache, JAVA_LSP_OWNER_ENDPOINT: url }
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
