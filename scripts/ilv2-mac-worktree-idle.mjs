// Run the real worktree acceptance on one isolated native owner, without LaunchAgent or JDT.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { ownerCacheRoot, ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";

if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") throw new Error("isolated validation required");
if (ownerCacheRoot()) {
  const file = fileURLToPath(new URL("../dist/java-index/snapshot/worktree-idle.test.js", import.meta.url));
  const tests = run({ files: [file], isolation: "none" });
  tests.on("test:fail", () => { process.exitCode = 1; });
  tests.compose(tap).pipe(process.stdout);
} else {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ilv2-worktree-idle-owner-")));
  const cache = path.join(root, "cache");
  await mkdir(cache);
  const launch = await ownerLaunchArguments(cache, fileURLToPath(import.meta.url));
  const quota = await acquireFixtureSlot(MAC_WORK_ROOT);
  const child = spawn(launch.binary, launch.args, { detached: true, stdio: "inherit" });
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  const timer = setTimeout(() => {
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
  }, 135_000);
  try {
    await once(child, "spawn");
    await quota.registerChild(child.pid, child.pid);
    const [code, signal] = await closed;
    if (code !== 0) throw new Error(`worktree idle owner exited with ${code ?? signal}`);
  } finally {
    clearTimeout(timer);
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    await closed.catch(() => undefined);
    if (child.pid) await eventually(() => !processAlive(-child.pid), 5000);
    await quota.release();
  }
  console.log("worktree idle native owner exited; fixture quota released");
}
