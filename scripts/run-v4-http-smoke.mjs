#!/usr/bin/env node
// An owned ephemeral HTTP fixture. Binding and both clients run in its group.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MAC_WORK_ROOT, isMain, managedPath, runCli, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function runClient(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`HTTP smoke client exited ${code}`)));
  });
}

async function serve(port, instanceId) {
  const runtime = await verifyRuntime();
  const { JavaLspHttpServer, installDaemonSignalHandling } = await import("../dist/http-server.js");
  const server = new JavaLspHttpServer({ port, instanceId });
  const address = await server.start();
  installDaemonSignalHandling(server);
  console.log(JSON.stringify({ ownedHttpReady: true, pid: process.pid, instanceId, ...address, runtime }));
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, { redirect: "error" });
    if (!response.ok || (await response.json()).instanceId !== instanceId) throw new Error("owned HTTP instance mismatch");
    await runClient(["dist/smoke-http.js", "--url", address.url]);
    await runClient(["dist/smoke-http.js", "--url", address.url]);
  } finally { await server.shutdown(); }
}

export async function runOwnedHttpSmoke({ port = 0, timeoutMs = 60000, signal } = {}) {
  const runtime = await verifyRuntime();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") throw new Error("HTTP smoke requires the isolation broker");
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 38456) throw new Error("invalid fixture port");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error("bounded HTTP smoke timeout required");
  signal?.throwIfAborted();
  await managedPath(MAC_WORK_ROOT, os.tmpdir());
  const directory = await mkdtemp(path.join(os.tmpdir(), "ilv2-owned-http-"));
  let lease, supervisor, closed;
  let completed = false;
  const instanceId = randomUUID();
  let identity;
  const clientRuntimes = [];
  try {
    for (const name of ["home", "tmp", "cache", "owner", "gradle-home"]) await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, "projects.json"), '{"aliases":[],"defaults":{}}\n');
    for (const name of ["ilv2-mac-fixture-launch.mjs", "ilv2-mac-contracts.mjs"]) await copyFile(path.join(root, "scripts", name), path.join(directory, name));
    const env = { PATH: process.env.PATH, HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"),
      JAVA_LSP_CACHE_ROOT: path.join(directory, "cache"), JAVA_LSP_OWNERSHIP_BASE: path.join(directory, "owner"), JAVA_LSP_PROJECTS_JSON: path.join(directory, "projects.json"),
      GRADLE_USER_HOME: path.join(directory, "service-state", "jdt-gradle-home"), JAVA_LSP_SERVICE_STATE_ROOT: path.join(directory, "service-state"), JDTLS_BIN: "/usr/bin/false", JAVA_LSP_ISOLATED_VALIDATION: "1",
      ILV2_NODE_BIN: process.execPath, ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST };
    lease = await acquireFixtureSlot(MAC_WORK_ROOT, { signal });
    signal?.throwIfAborted();
    supervisor = spawn(process.execPath, [path.join(directory, "ilv2-mac-fixture-launch.mjs")], { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    closed = new Promise(resolve => supervisor.once("close", code => resolve(code)));
    await new Promise((resolve, reject) => { supervisor.once("spawn", resolve); supervisor.once("error", reject); });
    await lease.registerChild(supervisor.pid, supervisor.pid);
    supervisor.stderr.on("data", data => process.stderr.write(data));
    let servicePid;
    let serviceExit;
    supervisor.on("message", message => {
      if (message?.type === "started") servicePid = message.pid;
      if (message?.type === "service-exited") serviceExit = message;
    });
    let text = "";
    supervisor.stdout.on("data", data => {
      text += data.toString();
      if (text.length > 1024 * 1024) { text = ""; return; }
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, index); text = text.slice(index + 1);
        try {
          const row = JSON.parse(line);
          if (row.ownedHttpReady) identity = row;
          if (row.fixtureRuntime) clientRuntimes.push(row);
        } catch { /* Client prose is not a readiness record. */ }
      }
    });
    supervisor.send({ type: "start", argv: [process.execPath, path.join(root, "scripts/run-v4-http-smoke.mjs"), "--serve", String(port), instanceId], env });
    let timer;
    let cancel;
    let result;
    try {
      result = await Promise.race([closed.then(code => ({ code })), new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); }),
        new Promise(resolve => { cancel = () => resolve({ aborted: true }); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel(); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
    if (result.timeout || result.aborted || serviceExit?.code !== 0 || serviceExit?.signal !== null || serviceExit.pid !== servicePid) throw new Error("owned HTTP smoke failed or timed out");
    if (!identity || identity.pid !== servicePid || identity.instanceId !== instanceId || identity.runtime.runtimeManifestSha256 !== runtime.runtimeManifestSha256 ||
        identity.runtime.execPath !== runtime.execPath || identity.runtime.nodeSha256 !== runtime.nodeSha256 || !identity.port || (port && identity.port !== port)) throw new Error("owned HTTP readiness identity mismatch");
    completed = true;
    return { status: "PASS", identity, clientRuntimes, supervisorPid: supervisor.pid, pgid: supervisor.pid };
  } finally {
    if (supervisor?.pid) {
      try { process.kill(-supervisor.pid, "SIGTERM"); } catch (error) { if (!["ESRCH", "EPERM"].includes(error.code)) throw error; }
      const end = performance.now() + 4000;
      let gone = false;
      while (performance.now() < end) {
        try { process.kill(-supervisor.pid, 0); }
        catch (error) { if (error.code === "ESRCH") { gone = true; break; } if (error.code !== "EPERM") throw error; }
        await delay(25);
      }
      if (!gone) throw new Error("HTTP fixture group remains; reservation retained");
      await closed;
    }
    if (lease) await lease.release();
    await rm(directory, { recursive: true, force: true });
    if (completed) console.error(JSON.stringify({ ownedHttpReaped: true, pgid: supervisor.pid }));
  }
}

if (isMain(import.meta.url)) runCli(async ({ signal }) => {
  if (process.argv[2] === "--serve") {
    if (process.argv.length !== 5) throw new Error("invalid serve arguments");
    await serve(Number(process.argv[3]), process.argv[4]);
  } else {
    if (process.argv.length !== 2) throw new Error("unexpected HTTP smoke arguments");
    console.log(JSON.stringify(await runOwnedHttpSmoke({ signal })));
  }
});
