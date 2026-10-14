// HTTP JSON is an offline adapter protocol, independent of the product API.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CONTRACT_VERSION, MAC_WORK_ROOT, managedPath, newOutput, requireValue, sha256, writeJson, resolvedPath } from "./ilv2-mac-contracts.mjs";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";

export function field(value, selector) {
  return selector === "$" ? value : selector.split(".").reduce((current, key) => current?.[key], value);
}
function template(value, parameters) {
  if (typeof value === "string" && /^\{[A-Za-z][A-Za-z0-9]*\}$/.test(value)) return parameters[value.slice(1, -1)];
  if (Array.isArray(value)) return value.map(item => template(item, parameters));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, parameters)]));
  return value;
}
export function normalizeResponse(body, mapping) {
  return Object.fromEntries(Object.entries(mapping).map(([key, selector]) => [key, field(body, selector)]));
}
export function verifyInstance(identity, expected) {
  for (const key of ["instanceId", "sourceDigest", "buildDigest", "nativeDigest", "runtimeManifestSha256", "cacheRoot", "ownerRoot", "contractVersion"]) {
    requireValue(typeof expected[key] === "string" && expected[key].length > 0, `missing expected identity: ${key}`);
    requireValue(identity[key] === expected[key], `instance identity mismatch: ${key}`);
  }
}
function localUrl(url) {
  const parsed = new URL(url);
  requireValue(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && !parsed.username && !parsed.password, "loopback HTTP URL required");
  requireValue(parsed.port !== "38456", "production port rejected");
  return parsed;
}
async function availablePort(port) {
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 38456, "invalid fixture port");
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("fixture port occupied")));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
export async function connectDriver(config, options) {
  requireValue(config.contractVersion === CONTRACT_VERSION && config.protocol === "http-json/v1", "unsupported driver contract");
  requireValue(["start", "attach"].includes(options.mode), "mode must be start or attach");
  requireValue(await resolvedPath(options.workRoot) === await resolvedPath(MAC_WORK_ROOT), "shared work root mismatch");
  await managedPath(MAC_WORK_ROOT, options.runRoot);
  requireValue(Number.isFinite(config.startTimeoutMs) && config.startTimeoutMs > 0 && config.startTimeoutMs <= 30000, "bounded startup timeout required");
  requireValue(config.expected?.runtimeManifestSha256 === options.runtime.runtimeManifestSha256, "driver runtime manifest digest mismatch");
  const expected = { ...config.expected, runtimeManifestSha256: options.runtime.runtimeManifestSha256, contractVersion: CONTRACT_VERSION };
  let child;
  let servicePid;
  let childClosed;
  let quota;
  let url;
  let stopped = false;
  const logs = new Map();
  async function request(operation, parameters = {}, { timeoutMs = 1000, signal } = {}) {
    const mapping = config.operations?.[operation];
    requireValue(mapping && mapping.path?.startsWith("/") && !mapping.path.startsWith("//") && ["GET", "POST"].includes(mapping.method), `driver operation unavailable: ${operation}`);
    requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, "invalid operation budget");
    const endpoint = new URL(mapping.path, url);
    requireValue(endpoint.origin === new URL(url).origin, "driver operation must retain origin");
    const body = template(mapping.body ?? {}, parameters);
    if (operation === "status") requireValue(mapping.method === "POST"
      ? typeof mapping.readOnlyField === "string" && field(body, mapping.readOnlyField) === false
      : endpoint.searchParams.get("start") === "false", "status mapping must explicitly use start=false");
    const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(endpoint, {
      method: mapping.method, signal: combined, redirect: "error", headers: { "content-type": "application/json" },
      ...(mapping.method === "POST" ? { body: JSON.stringify(body) } : {})
    });
    requireValue(response.ok, `driver HTTP failure: ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("driver response exceeds limit"); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    let decoded;
    try { decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("driver response is not valid JSON"); }
    return { value: normalizeResponse(decoded, mapping.normalize ?? { result: "$" }), payloadBytes: bytes };
  }
  async function stop() {
    if (stopped || !child) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    let timer;
    const exited = await Promise.race([childClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    clearTimeout(timer);
    if (!exited) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      const killed = await Promise.race([childClosed.then(() => true), delay(2000).then(() => false)]);
      requireValue(killed, "fixture child did not exit after SIGKILL");
    }
    // A parent exit alone is not proof that its process group has disappeared.
    const limit = performance.now() + 2000;
    while (performance.now() < limit) {
      try { process.kill(-child.pid, 0); } catch (error) {
        if (error.code === "ESRCH") {
          try { for (const [file, chunks] of logs) await writeFile(file, Buffer.concat(chunks)); }
          finally { await quota.release(); }
          return;
        }
        if (error.code === "EPERM") { await delay(25); continue; }
        throw new Error(`fixture group observation failed: ${error.code}`);
      }
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await delay(25);
    }
    throw new Error("fixture group did not exit; quota retained");
  }
  try {
    if (options.mode === "start") {
      await availablePort(options.port);
      const serviceWork = await newOutput(options.runRoot, options.serviceWork);
      expected.instanceId = randomUUID();
      expected.cacheRoot = path.join(serviceWork, "cache");
      expected.ownerRoot = path.join(serviceWork, "owner");
      const directories = ["home", "cache", "owner", "tmp", "gradle-home", "jdt", "logs"];
      await Promise.all(directories.map(name => mkdir(path.join(serviceWork, name))));
      await writeJson(path.join(serviceWork, "projects.json"), { aliases: [], defaults: {} });
      requireValue(Array.isArray(config.argv) && config.argv.length > 0 && config.argv.every(item => typeof item === "string"), "driver argv required");
      requireValue(config.argv[0] === process.execPath, "driver must use frozen absolute Node");
      requireValue(path.isAbsolute(config.argv[1] ?? ""), "driver requires an absolute isolated script path");
      await managedPath(MAC_WORK_ROOT, config.argv[1]);
      quota = await acquireFixtureSlot(MAC_WORK_ROOT, { signal: options.signal });
      options.signal?.throwIfAborted();
      const parameters = { port: String(options.port), serviceWork, instanceId: expected.instanceId };
      const argv = config.argv.map(item => item.replace(/\{(port|serviceWork|instanceId)\}/g, (_, key) => parameters[key]));
      const env = {
        PATH: process.env.PATH, HOME: path.join(serviceWork, "home"), TMPDIR: path.join(serviceWork, "tmp"),
        JAVA_LSP_CACHE_ROOT: expected.cacheRoot, JAVA_LSP_OWNERSHIP_BASE: expected.ownerRoot,
        JAVA_LSP_PROJECTS_JSON: path.join(serviceWork, "projects.json"), GRADLE_USER_HOME: path.join(serviceWork, "gradle-home"),
        JDTLS_BIN: "/usr/bin/false", JAVA_LSP_ISOLATED_VALIDATION: "1", ILV2_INSTANCE_ID: expected.instanceId,
        ILV2_EXPECTED_IDENTITY: JSON.stringify(expected), ILV2_RUNTIME_MANIFEST: options.runtimeManifest
      };
      const launcher = path.join(serviceWork, "ilv2-mac-fixture-launch.mjs");
      await copyFile(fileURLToPath(new URL("./ilv2-mac-fixture-launch.mjs", import.meta.url)), launcher);
      await copyFile(fileURLToPath(new URL("./ilv2-mac-contracts.mjs", import.meta.url)), path.join(serviceWork, "ilv2-mac-contracts.mjs"));
      // The supervisor waits on IPC. The service cannot start in the registration gap.
      child = spawn(process.execPath, [launcher], { cwd: serviceWork, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      childClosed = new Promise(resolve => child.once("close", resolve));
      try { await once(child, "spawn"); }
      catch (error) { child = undefined; await quota.release(); quota = undefined; throw error; }
      await quota.registerChild(child.pid, child.pid);
      await writeJson(path.join(serviceWork, "process.json"), { supervisorPid: child.pid, pid: null, pgid: child.pid, port: options.port, instanceId: expected.instanceId });
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
        const chunks = [];
        logs.set(path.join(serviceWork, `${name}.log`), chunks);
        let bytes = 0;
        stream.on("data", chunk => {
          // Continue draining after the private log cap; never echo payloads.
          const available = Math.max(0, 1024 * 1024 - bytes);
          if (available) chunks.push(chunk.subarray(0, available));
          bytes += chunk.length;
        });
      }
      const started = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("fixture launch handshake timed out")), config.startTimeoutMs);
        const receive = message => {
          if (message?.type !== "started") { finish(new Error("invalid fixture launch acknowledgement")); return; }
          finish(null, message);
        };
        const closed = () => finish(new Error("fixture launcher exited before acknowledgement"));
        const aborted = () => finish(new Error("fixture launch cancelled"));
        function finish(error, value) {
          clearTimeout(timer);
          child.removeListener("message", receive);
          child.removeListener("close", closed);
          options.signal?.removeEventListener("abort", aborted);
          if (error) reject(error); else resolve(value);
        }
        child.once("message", receive);
        child.once("close", closed);
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) { aborted(); return; }
        child.send({ type: "start", argv, env }, error => { if (error) finish(error); });
      });
      requireValue(Number.isInteger(started.pid) && started.pid > 0 && started.pgid === child.pid, "fixture launcher process identity mismatch");
      servicePid = started.pid;
      await writeJson(path.join(serviceWork, "process.json"), { supervisorPid: child.pid, pid: servicePid, pgid: child.pid, port: options.port, instanceId: expected.instanceId });
      url = `http://127.0.0.1:${options.port}`;
    } else {
      url = localUrl(options.url).href;
      requireValue(options.expectedInstance && options.expectedSource, "attach requires expected instance and source");
      expected.instanceId = options.expectedInstance;
      requireValue(expected.sourceDigest === options.expectedSource, "attach source does not match driver");
      await managedPath(options.workRoot, expected.cacheRoot);
      await managedPath(options.workRoot, expected.ownerRoot);
    }
    localUrl(url);
    const started = performance.now();
    let identity;
    while (performance.now() - started < config.startTimeoutMs) {
      options.signal?.throwIfAborted();
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("owned driver exited before identity");
      try { identity = (await request("identity", {}, { timeoutMs: Math.min(500, config.startTimeoutMs - (performance.now() - started)), signal: options.signal })).value; }
      catch (error) {
        if (options.mode === "attach") throw error;
        await delay(25, undefined, { signal: options.signal });
        continue;
      }
      // A successful reply with wrong identity is fatal; never retry into load.
      verifyInstance(identity, expected);
      if (child) requireValue(identity.pid === servicePid, "port does not belong to owned process");
      break;
    }
    requireValue(identity, "driver startup timed out");
    async function waitForOwnedExit(timeoutMs) {
      requireValue(child && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, "bounded owned-exit wait required");
      let timer;
      const exited = await Promise.race([childClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      clearTimeout(timer);
      requireValue(exited, "owned process did not exit before fault deadline");
    }
    return { identity, request, stop, waitForOwnedExit, ownedPid: servicePid ?? null, ownedPgid: child?.pid ?? null,
      driverDigest: sha256(JSON.stringify(config)) };
  } catch (error) {
    if (child) await stop(); else if (quota) await quota.release();
    throw error;
  }
}
