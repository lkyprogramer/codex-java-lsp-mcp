#!/usr/bin/env node
// Isolated installer candidate admission. The child is the real native owner.
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, isMain, managedPath, requireUnprotectedRoot, requireValue, verifyRuntime } from "./ilv2-mac-contracts.mjs";

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** One owned detached process group; quota is released only after actual exit. */
export async function runFixtureProcess(file, args, { workRoot = MAC_WORK_ROOT } = {}) {
  const admission = new AbortController();
  let requestedSignal, notifyStop;
  const stopped = new Promise(resolve => { notifyStop = resolve; });
  const requestStop = signal => {
    requestedSignal ??= signal;
    admission.abort(new Error(`fixture executor received ${signal}`));
    notifyStop();
  };
  const onTerm = () => requestStop("SIGTERM"), onInt = () => requestStop("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  let lease, child, closed, firstFailure;
  const sendGroup = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  try {
    lease = await acquireFixtureSlot(workRoot, { signal: admission.signal });
    // The slot exists before spawn; detached makes the actual child its PGID.
    child = spawn(file, args, { detached: true, stdio: "inherit" });
    closed = new Promise(resolve => {
      child.once("error", error => { firstFailure ??= error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (child.pid) await lease.registerChild(child.pid, child.pid);
    await Promise.race([closed, stopped]);
  } catch (error) { firstFailure ??= error; }
  finally {
    if (child?.pid) {
      // Natural owner exit may leave descendants; those still hold this slot.
      const deadline = Date.now() + 4000;
      try {
        if (alive(-child.pid)) sendGroup(requestedSignal ?? "SIGTERM");
        const termEnd = Date.now() + 1500;
        while (alive(-child.pid) && Date.now() < termEnd) await delay(25);
        if (alive(-child.pid)) sendGroup("SIGKILL");
        while (alive(child.pid) || alive(-child.pid)) {
          requireValue(Date.now() < deadline, "owned fixture process group did not exit within 4 seconds");
          await delay(25);
        }
        await closed;
      } catch (error) { firstFailure ??= error; }
    }
    if (lease) {
      try { await lease.release(); }
      catch (error) { firstFailure ??= error; }
    }
    process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
  }
  if (firstFailure) throw firstFailure;
  const result = closed ? await closed : { code: null, signal: requestedSignal };
  return requestedSignal ? 128 + os.constants.signals[requestedSignal] : result.code ?? 128 + (os.constants.signals[result.signal] ?? 1);
}

async function main(args) {
  requireValue(args.length === 3, "usage: ilv2-mac-fixture-exec.mjs <native-binary> <canonical-cache-root> <absolute-entry>");
  requireValue(process.env.JAVA_LSP_ISOLATED_VALIDATION === "1", "isolated validation marker required");
  const root = process.env.ILV2_RUN_ROOT;
  requireValue(root && path.isAbsolute(root) && await realpath(root) === root && (await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "registered ILV2_RUN_ROOT required");
  requireUnprotectedRoot(root, "fixture executor root");
  await verifyRuntime();
  for (const file of args) requireValue(path.isAbsolute(file) && await managedPath(root, file) === file && await realpath(file) === file, "canonical registered fixture paths required");
  const [binary, cache, entry] = args;
  requireValue((await lstat(binary)).isFile() && (await lstat(entry)).isFile() && (await lstat(cache)).isDirectory(), "native binary, cache directory and entry file required");
  process.exitCode = await runFixtureProcess(binary, ["owner", cache, entry]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error("[ilv2-mac-fixture-exec]", error);
  process.exitCode = 1;
});
