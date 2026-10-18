// Isolated launchd adapter. The job is the real native exec route, with no
// supervising wrapper between launchd and the owner.
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFixtureSlot, acquireLaunchdFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, execute, writeJson } from "./ilv2-mac-contracts.mjs";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";
import { diagnoseLaunchdJob } from "./ilv2-mac-env-probe.mjs";

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
// Reads a `builder: true` owner's held builder from this test process, then releases the hold.
// fd4 is read with proc_pidfdinfo, not lsof: lsof sat in an uninterruptible wait well past its
// SIGKILL against these fixtures' processes on this host, from the owner and from here. Each
// attempt uses fresh processes, is raced out and abandoned, and all attempts fit inside the
// owner's 4.5 s hold. An abandoned probe is unreferenced, so it keeps neither this process alive
// nor the fixture's process group (its closeout) busy.
const PROBE_ATTEMPTS = 3, PROBE_ATTEMPT_MS = 1200;
// proc_pidfdinfo(PROC_PIDFDVNODEPATHINFO) for one fd: struct vnode_fdinfowithpath is proc_fileinfo
// (24) + vnode_info (152, vst_dev u32 at 0, vst_ino u64 at 8) + MAXPATHLEN path (1024).
const FD_IDENTITY_PY = `
import ctypes, json, struct, sys
pid, fd = int(sys.argv[1]), int(sys.argv[2])
size = 1200
buffer = ctypes.create_string_buffer(size)
written = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).proc_pidfdinfo(pid, fd, 2, buffer, size)
if written != size:
    print(json.dumps({"error": "proc_pidfdinfo", "written": written, "errno": ctypes.get_errno()}))
    sys.exit(1)
print(json.dumps({"dev": struct.unpack_from("<I", buffer, 24)[0], "ino": struct.unpack_from("<Q", buffer, 32)[0],
    "path": buffer.raw[176:].split(b"\\0", 1)[0].decode()}))
`;
export async function probeHeldBuilder(fixture, timeoutMs = 15000) {
  const held = await eventually(async () => (await fixture.records()).find(row => row.type === "builder-held"), timeoutMs);
  const started = performance.now();
  const attempts = [];
  let result;
  try {
    while (!result && attempts.length < PROBE_ATTEMPTS) {
      const children = [];
      const run = (file, args) => new Promise((resolve, reject) => {
        children.push(execFile(file, args, { encoding: "utf8", timeout: PROBE_ATTEMPT_MS - 200, killSignal: "SIGKILL" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      });
      const probes = (async () => {
        const pgid = Number((await run("/bin/ps", ["-o", "pgid=", "-p", String(held.builderPid)])).trim());
        const fd4 = JSON.parse(await run("/usr/bin/python3", ["-I", "-c", FD_IDENTITY_PY, String(held.builderPid), "4"]));
        // Device and inode, the same identity the owner took from fstat(4).
        return { pgid, builderLock: `${fd4.dev}:${fd4.ino}`, builderLockName: fd4.path };
      })();
      probes.catch(() => undefined);
      const attemptStarted = performance.now();
      try { result = await Promise.race([probes, delay(PROBE_ATTEMPT_MS).then(() => { throw new Error(`builder probes exceeded ${PROBE_ATTEMPT_MS} ms`); })]); }
      catch (error) {
        for (const child of children) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
        attempts.push({ error: String(error?.stdout?.trim() || error?.message || error).slice(0, 300), ms: Math.round(performance.now() - attemptStarted) });
      }
    }
  } finally { await fixture.command({ type: "builder-probed" }); }
  return { ...result, failedAttempts: attempts, pid: held.builderPid, ownerLock: held.ownerLock,
    lockInherited: result !== undefined && result.builderLock === held.ownerLock, probeMs: performance.now() - started };
}
export async function createOwnerFixture(t, options = {}) {
  const direct = options.route === "direct";
  if (options.route && !["direct", "launchd"].includes(options.route)) throw new Error("invalid fixture route");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-owner-")));
  for (const name of ["cache", "home", "tmp", "service-state", "repo"]) await mkdir(path.join(root, name));
  const cacheRoot = options.cacheRoot ?? path.join(root, "cache");
  const label = `com.lky.ilv2-mac02b.${randomUUID()}`;
  const entry = path.join(root, "owner.mjs");
  await writeJson(path.join(root, "options.json"), { ...options, sourceRoot, cacheRoot });
  // `entry`: another owner process script under scripts/ (G06C scheduler harness).
  await writeFile(entry, `import ${JSON.stringify(path.join(sourceRoot, options.entry ?? "scripts/ilv2-mac-owner-process.mjs"))};\n`);
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
    async ready(excludePid) {
      try { return await eventually(async () => (await fixture.records()).find(row => row.type === "ready" && row.pid !== excludePid)); }
      catch (error) {
        if (direct || !/deadline exceeded/.test(error.message)) throw error;
        // Classify a launchd job that never reached Node (e.g. a pending TCC prompt) instead of a bare timeout.
        const diagnosis = await diagnoseLaunchdJob({ label, subjects: [launch.binary] });
        throw Object.assign(new Error(`${diagnosis.classification}: launchd owner not ready`), { diagnosis });
      }
    },
    // The owner polls command.json every 25 ms; a truncate-then-write would let it parse a partial file and crash.
    async command(command) {
      const id = randomUUID(), staged = path.join(root, `command.${id}.tmp`);
      await writeJson(staged, { id, ...command }); await rename(staged, path.join(root, "command.json"));
    },
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
        const target = path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), `owner-${label.split(".").at(-1)}`);
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
