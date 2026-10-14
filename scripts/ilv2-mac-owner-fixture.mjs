// Isolated launchd adapter. The job is the real native exec route, with no
// supervising wrapper between launchd and the owner.
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFixtureSlot, acquireLaunchdFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, execute, writeJson } from "./ilv2-mac-contracts.mjs";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escapeXml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const dict = values => `<dict>${Object.entries(values).map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("")}</dict>`;
export async function eventually(operation, timeoutMs = 10000) {
  const limit = performance.now() + timeoutMs;
  while (performance.now() < limit) { const value = await operation(); if (value) return value; await delay(25); }
  throw new Error("fixture observation deadline exceeded");
}
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    // A denied probe proves neither exit nor ownership. Keep waiting for
    // ESRCH within the existing deadline, never treat EPERM as absence.
    if (error.code === "EPERM") return true;
    throw error;
  }
}
export async function processGroup(pid) { return Number((await execute("/bin/ps", ["-o", "pgid=", "-p", String(pid)])).stdout.trim()); }

export async function createOwnerFixture(t, options = {}) {
  const direct = options.route === "direct";
  if (options.route && !["direct", "launchd"].includes(options.route)) throw new Error("invalid fixture route");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-owner-")));
  for (const name of ["cache", "home", "tmp", "service-state", "repo"]) await mkdir(path.join(root, name));
  const cacheRoot = options.cacheRoot ?? path.join(root, "cache");
  const label = `com.lky.ilv2-mac02b.${randomUUID()}`;
  const entry = path.join(root, "owner.mjs");
  await writeJson(path.join(root, "options.json"), { ...options, sourceRoot, cacheRoot });
  await writeFile(entry, `import ${JSON.stringify(path.join(sourceRoot, "scripts/ilv2-mac-owner-process.mjs"))};\n`);
  const launch = await ownerLaunchArguments(cacheRoot, entry, [root]);
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST,
    JAVA_LSP_SERVICE_STATE_ROOT: path.join(root, "service-state"), JAVA_LSP_CACHE_ROOT: cacheRoot,
    JDTLS_DATA_DIR: path.join(root, "jdt-data"), JDTLS_LOG_DIR: path.join(root, "jdt-logs"),
    JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_HOME: options.javaHome ?? "", JDTLS_BIN: options.jdtlsBin ?? "/usr/bin/false" };
  const plist = path.join(root, "fixture.plist");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[launch.binary, ...launch.args].map(arg => `<string>${escapeXml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key>${dict(env)}<key>WorkingDirectory</key><string>${escapeXml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>1</integer><key>AbandonProcessGroup</key><false/>
<key>StandardOutPath</key><string>${escapeXml(path.join(root, "stdout.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(path.join(root, "stderr.log"))}</string></dict></plist>\n`;
  await writeFile(plist, xml);
  await writeJson(path.join(root, "native-launch.json"), launch);
  const lease = direct ? await acquireFixtureSlot(MAC_WORK_ROOT) : await acquireLaunchdFixtureSlot(MAC_WORK_ROOT, { runRoot: root, label });
  let supervisor, supervisorClosed;
  let externalCleanup;
  let closed = false;
  const fixture = { root, label, cacheRoot, lease,
    beforeClose(operation) { if (externalCleanup) throw new Error("external cleanup already registered"); externalCleanup = operation; },
    async records() {
      let content;
      try { content = await readFile(path.join(root, "timeline.jsonl"), "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      const rows = content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (!direct) for (const row of rows) if (row.type === "ready") lease.observe(row.pid, row.pgid);
      return rows;
    },
    async ready(excludePid) { return eventually(async () => (await fixture.records()).find(row => row.type === "ready" && row.pid !== excludePid)); },
    async command(command) { await writeJson(path.join(root, "command.json"), { id: randomUUID(), ...command }); },
    async stopOwned() {
      if (!direct) throw new Error("direct primitive fixture required");
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) process.kill(-supervisor.pid, "SIGTERM");
      if (supervisorClosed) {
        let timer;
        try { await Promise.race([supervisorClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("direct fixture did not close")), 5000); })]); }
        finally { clearTimeout(timer); }
      }
      if (supervisor) await eventually(() => !processAlive(-supervisor.pid), 5000);
    },
    async close() {
      if (closed) return;
      await fixture.records();
      let result;
      if (direct) {
        await fixture.stopOwned();
        await externalCleanup?.();
        await lease.release();
        result = { route: "G01-direct-fixture", launchd: "NOT_RUN", residualProcesses: [] };
      } else result = await lease.close();
      await writeJson(path.join(root, "closeout.json"), result);
      if (process.env.ILV2_RUN_ROOT) {
        const target = path.join(process.env.ILV2_RUN_ROOT, "raw", `owner-${label.split(".").at(-1)}`);
        await mkdir(target);
        for (const name of ["options.json", "fixture.plist", "timeline.jsonl", "stdout.log", "stderr.log", "closeout.json"]) {
          try { await writeFile(path.join(target, name), await readFile(path.join(root, name))); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      closed = true;
    }
  };
  t.after(() => fixture.close());
  try {
    if (direct) {
      supervisor = spawn(process.execPath, [path.join(sourceRoot, "scripts/ilv2-mac-fixture-launch.mjs")], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      supervisorClosed = new Promise((resolve, reject) => { supervisor.once("close", resolve); supervisor.once("error", reject); });
      supervisor.stdout.on("data", bytes => appendFileSync(path.join(root, "stdout.log"), bytes));
      supervisor.stderr.on("data", bytes => appendFileSync(path.join(root, "stderr.log"), bytes));
      await new Promise((resolve, reject) => { supervisor.once("spawn", resolve); supervisor.once("error", reject); });
      await lease.registerChild(supervisor.pid, supervisor.pid);
      supervisor.send({ type: "start", argv: [process.execPath, path.join(sourceRoot, "scripts/ilv2-mac-owner-direct-entry.mjs"), root], env });
    } else await lease.bootstrap(plist);
  } catch (error) { await fixture.close(); throw error; }
  return fixture;
}
