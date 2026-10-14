#!/usr/bin/env node
// Card-start environment probe: managed paths stay outside TCC folders, frozen
// toolchains are intact, and an isolated launchd job reaches native main -> Node
// within a short budget. A missing ready line is classified in seconds instead
// of being diagnosed by hand (G02B lost two runs to a pre-main TCC wait).
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MAC_WORK_ROOT, cliOptions, execute, isMain, requireValue, runCli, sha256, tccProtectedFolder, verifyRuntime, writeJson } from "./ilv2-mac-contracts.mjs";
import { acquireLaunchdFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escapeXml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// A pending prompt or a denial; a line that merely names a protected service may be an allowed access.
const TCC_PROMPT = /AUTHREQ_PROMPTING|AUTHREQ_RESULT[^\n]*authValue=0/;

export function pathChecks(paths, home = os.userInfo().homedir) {
  return Object.entries(paths).filter(([, value]) => value).map(([name, value]) => ({ name, path: value, protectedFolder: tccProtectedFolder(value, home) }));
}

/** Attribute TCC lines to this job only; another app's prompt in the same window is not evidence. */
export function classifyTccLog(text, subjects) {
  const lines = text.split("\n").filter(line => TCC_PROMPT.test(line));
  const attributed = lines.filter(line => subjects.some(subject => subject && line.includes(subject)));
  const services = [...new Set(attributed.flatMap(line => line.match(/kTCCService[A-Za-z]+/g) ?? []))];
  return { status: attributed.length ? "BLOCKED_ENV_TCC" : null, services, attributed: attributed.slice(0, 20), unattributedCount: lines.length - attributed.length };
}

export async function diagnoseLaunchdJob({ label, subjects, windowSeconds = 60 }) {
  const service = `gui/${process.getuid()}/${label}`;
  let launchd = null, pid = null, processState = null, tcc = { status: null, services: [], attributed: [], unattributedCount: 0 }, logError = null;
  try {
    launchd = (await execute("/bin/launchctl", ["print", service], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
    pid = Number(/^\s*pid = (\d+)$/m.exec(launchd)?.[1]) || null;
  } catch (error) { launchd = `launchctl print exit ${error.code}`; }
  if (pid) {
    try { processState = (await execute("/bin/ps", ["-o", "stat=,wchan=", "-p", String(pid)], { timeout: 2000 })).stdout.trim(); } catch { processState = "EXITED"; }
  }
  try {
    const log = await execute("/usr/bin/log", ["show", "--style", "compact", "--last", `${windowSeconds}s`, "--predicate", 'subsystem == "com.apple.TCC"'],
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    // Delimited PID tokens: "pid=231" must not match pid=2310.
    tcc = classifyTccLog(log.stdout, [...subjects, pid ? `pid=${pid},` : null, pid ? `(${pid})` : null]);
  } catch (error) { logError = error.message; }
  return { classification: tcc.status ?? "BLOCKED_ENV_PRE_MAIN", pid, processState, tcc, logError, launchdState: /^\s*state = (.+)$/m.exec(launchd ?? "")?.[1] ?? null };
}

async function readRows(file) {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Real isolated launchd job: native owner launcher -> exec frozen Node -> optional read of target. */
export async function probeLaunchd({ timeoutMs = 5000, readTarget } = {}) {
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 30000, "probe timeout must be 500..30000 ms");
  requireValue(!readTarget || path.isAbsolute(readTarget), "absolute read target required");
  const { ownerLaunchArguments } = await import("../dist/mac-platform/owner-lock.js");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-env-probe-")));
  for (const name of ["cache", "home", "tmp"]) await mkdir(path.join(root, name));
  const label = `com.lky.ilv2-mac-env.${randomUUID()}`;
  const timeline = path.join(root, "timeline.jsonl");
  const entry = path.join(root, "probe-entry.mjs");
  await writeFile(entry, `import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [file, target] = process.argv.slice(2);
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const record = row => appendFileSync(file, JSON.stringify({ ...row, pid: process.pid, pgid, at: performance.timeOrigin + performance.now() }) + "\\n");
record({ type: "ready", execPath: process.execPath });
if (target) {
  const started = performance.now();
  try { record({ type: "read", bytes: readFileSync(target).length, elapsedMs: performance.now() - started }); }
  catch (error) { record({ type: "read-error", code: error.code, elapsedMs: performance.now() - started }); }
}
`);
  const launch = await ownerLaunchArguments(path.join(root, "cache"), entry, [timeline, readTarget ?? ""]);
  const env = { PATH: "/usr/bin:/bin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST };
  const plist = path.join(root, "probe.plist");
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[launch.binary, ...launch.args].map(arg => `<string>${escapeXml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join("")}</dict>
<key>WorkingDirectory</key><string>${escapeXml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>1</integer><key>AbandonProcessGroup</key><false/>
<key>StandardOutPath</key><string>${escapeXml(path.join(root, "stdout.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(path.join(root, "stderr.log"))}</string></dict></plist>\n`);
  const lease = await acquireLaunchdFixtureSlot(MAC_WORK_ROOT, { runRoot: root, label });
  const started = performance.now();
  let result, closeout, closeoutError;
  try {
    await lease.bootstrap(plist);
    let rows = [];
    const wanted = readTarget ? row => row.type === "read" || row.type === "read-error" : row => row.type === "ready";
    while (performance.now() - started < timeoutMs && !rows.some(wanted)) { await delay(25); rows = await readRows(timeline); }
    for (const row of rows) if (row.type === "ready") lease.observe(row.pid, row.pgid);
    const ready = rows.find(row => row.type === "ready");
    const read = rows.find(row => row.type === "read" || row.type === "read-error");
    if (ready && (!readTarget || read?.type === "read")) {
      result = { status: "READY", readyMs: ready.at - (performance.timeOrigin + started), execPath: ready.execPath, read: read ?? null };
    } else if (read?.type === "read-error") {
      result = { status: ["EPERM", "EACCES"].includes(read.code) ? "BLOCKED_ENV_TCC_DENIED" : "BLOCKED_ENV", readyMs: ready.at - (performance.timeOrigin + started), read };
    } else {
      // The launcher path is unique to this candidate; the shared frozen Node path is not.
      const diagnosis = await diagnoseLaunchdJob({ label, subjects: [launch.binary] });
      // Record the PID without claiming a group it has not published itself.
      if (diagnosis.pid) lease.observe(diagnosis.pid, 1, "launchctl");
      result = { status: ready ? (diagnosis.tcc.status ?? "BLOCKED_ENV_READ_TIMEOUT") : diagnosis.classification, phase: ready ? "read" : "pre-main", diagnosis };
    }
  } finally {
    try { closeout = await lease.close(); } catch (error) { closeoutError = { message: error.message, detail: error.fixtureCloseout ?? null }; }
  }
  if (process.env.ILV2_EVIDENCE_ROOT) {
    for (const name of ["probe.plist", "timeline.jsonl", "stdout.log", "stderr.log"]) {
      try { await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, `env-probe-${name}`), await readFile(path.join(root, name))); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  if (closeoutError) return { status: "BLOCKED_ENV_CLOSEOUT", label, launchd: result, closeoutError };
  return { ...result, label, budgetMs: timeoutMs, readTarget: readTarget ?? null, closeout: { absent: closeout.absent, residualProcesses: closeout.residualProcesses } };
}

export async function verifyToolchains(file) {
  const bytes = await readFile(file);
  const manifest = JSON.parse(bytes);
  const mismatched = [];
  for (const row of manifest.files) {
    try { if (sha256(await readFile(row.path)) !== row.sha256) mismatched.push(row.path); }
    catch { mismatched.push(row.path); }
  }
  return { status: mismatched.length ? "BLOCKED_ENV_TOOLCHAIN_DRIFT" : "READY", manifest: file, manifestSha256: sha256(bytes), files: manifest.files.length, mismatched: mismatched.slice(0, 10), mismatchCount: mismatched.length };
}

export async function probeEnvironment({ timeoutMs, readTarget, toolchains } = {}) {
  const started = performance.now();
  const runtime = await verifyRuntime();
  const paths = pathChecks({ workRoot: MAC_WORK_ROOT, runRoot: process.env.ILV2_RUN_ROOT, tmpdir: os.tmpdir(), candidateRoot: sourceRoot });
  const checks = { paths, toolchains: toolchains ? await verifyToolchains(toolchains) : "NOT_REQUESTED", launchd: "NOT_RUN" };
  const blockedPath = paths.find(row => row.protectedFolder);
  if (!blockedPath) checks.launchd = await probeLaunchd({ timeoutMs, readTarget });
  const status = blockedPath ? "BLOCKED_ENV_TCC_PATH"
    : checks.toolchains !== "NOT_REQUESTED" && checks.toolchains.status !== "READY" ? checks.toolchains.status
      : checks.launchd.status;
  return { schema: "ilv2-mac-env-probe/v1", status, runtime: { execPath: runtime.execPath, runtimeManifestSha256: runtime.runtimeManifestSha256 }, checks, elapsedMs: performance.now() - started };
}

if (isMain(import.meta.url)) runCli(async () => {
  const options = cliOptions(process.argv.slice(2), ["--timeout-ms", "--read", "--toolchains"]);
  const result = await probeEnvironment({ timeoutMs: options["timeout-ms"] ? Number(options["timeout-ms"]) : 5000, readTarget: options.read, toolchains: options.toolchains });
  if (process.env.ILV2_EVIDENCE_ROOT) await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT, "env-probe.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "READY" ? 0 : 2;
});
