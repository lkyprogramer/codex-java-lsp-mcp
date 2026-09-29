// input: Real node processes whose argv contains a unique workspace path.
// output: Proof that the reaper kills only that tree, and the startup sweep
//         kills a recorded child of this process without touching another owner.
// pos: Regression tests for the JDT orphan-process leak.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyWorkspaceCommand, killOwnedProcessTree, listProcesses } from "./jdt-process-tree.js";
import { processStartIdentityForPid } from "./repo-ownership-lease.js";
import { reapAbandonedWorkspaceJdtls } from "./worktree-cache-cleanup.js";

const HOLD = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000000);";

function workspaceMarker(): string {
  const root = mkdtempSync(path.join(tmpdir(), "jdt-reap-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function spawnHold(marker?: string): ChildProcess {
  const args = ["-e", HOLD];
  if (marker) args.push(marker);
  return spawn(process.execPath, args, { stdio: "ignore" });
}

function spawnParent(marker: string): ChildProcess {
  const script = [
    "process.on('SIGTERM',()=>{});",
    "const {spawn}=require('node:child_process');",
    "const marker=process.argv[1];",
    `spawn(process.execPath,['-e',${JSON.stringify(HOLD)},marker],{stdio:'ignore'});`,
    "setInterval(()=>{},1000000);"
  ].join("");
  return spawn(process.execPath, ["-e", script, marker], { stdio: "ignore" });
}

function spawnOwner(marker: string): ChildProcess {
  const script = [
    "process.on('SIGTERM',()=>{});",
    "const {spawn}=require('node:child_process');",
    "const marker=process.argv[1];",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(HOLD)},marker],{stdio:'ignore'});`,
    "process.stdout.write(String(child.pid)+'\\n');",
    "setInterval(()=>{},1000000);"
  ].join("");
  return spawn(process.execPath, ["-e", script, marker], { stdio: ["ignore", "pipe", "ignore"] });
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, label);
}

async function readPidLine(child: ChildProcess): Promise<number> {
  let buffer = "";
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owner did not report a child pid")), 3000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (!line) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("owner exited before reporting a child pid"));
    });
  });
  assert.equal(Number.isInteger(pid) && pid > 1, true, `bad child pid ${pid}`);
  return pid;
}

function killAll(pids: Array<number | undefined>): void {
  for (const pid of pids) {
    if (pid === undefined || pid <= 1) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

test("a missing command is unseen, not a collision", () => {
  const dataDir = "/tmp/jdt-reap-marker/workspace";
  assert.equal(classifyWorkspaceCommand(undefined, dataDir), "unseen");
  assert.equal(classifyWorkspaceCommand(`node -data ${dataDir}`, dataDir), "owned");
  assert.equal(classifyWorkspaceCommand("node -e setInterval(()=>{},1000)", dataDir), "collision");
});

test("killOwnedProcessTree kills the marked parent and grandchild only", { timeout: 15_000 }, async () => {
  const marker = workspaceMarker();
  const pids: number[] = [];
  try {
    const parent = spawnParent(marker);
    const sleeper = spawnHold();
    assert.equal(typeof parent.pid, "number");
    assert.equal(typeof sleeper.pid, "number");
    pids.push(parent.pid!, sleeper.pid!);
    await waitFor(
      () => listProcesses().filter(row => row.command.includes(marker)).length >= 2,
      "parent and grandchild visible"
    );
    const marked = listProcesses().filter(row => row.command.includes(marker)).map(row => row.pid);
    for (const pid of marked) pids.push(pid);
    const identity = processStartIdentityForPid(parent.pid!);
    assert.equal(typeof identity, "string");
    assert.equal(killOwnedProcessTree(parent.pid!, marker, identity!), true);
    await waitFor(() => marked.every(pid => !isAlive(pid)), "marked tree exited");
    assert.equal(isAlive(sleeper.pid), true);
    assert.equal(killOwnedProcessTree(sleeper.pid!, marker, processStartIdentityForPid(sleeper.pid!) ?? ""), false);
    assert.equal(isAlive(sleeper.pid), true);
  } finally {
    killAll(pids);
    rmSync(path.dirname(marker), { recursive: true, force: true });
  }
});

test("startup sweep kills a recorded child of this process and leaves another owner's child", { timeout: 15_000 }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jdt-reap-cache-"));
  const ownRoot = path.join(base, "own-hash");
  const ownWorkspace = path.join(ownRoot, "workspace");
  const foreignRoot = path.join(base, "foreign-hash");
  const foreignWorkspace = path.join(foreignRoot, "workspace");
  mkdirSync(ownWorkspace, { recursive: true });
  mkdirSync(foreignWorkspace, { recursive: true });
  const pids: Array<number | undefined> = [];
  const owner = spawnOwner(foreignWorkspace);
  try {
    const child = spawnHold(ownWorkspace);
    assert.equal(typeof child.pid, "number");
    pids.push(child.pid!, owner.pid);
    const foreignChildPid = await readPidLine(owner);
    pids.push(foreignChildPid);
    await waitFor(() => isAlive(child.pid) && isAlive(foreignChildPid) && isAlive(owner.pid), "processes visible");
    const childIdentity = processStartIdentityForPid(child.pid!);
    const foreignIdentity = processStartIdentityForPid(foreignChildPid);
    const ownerIdentity = processStartIdentityForPid(owner.pid!);
    assert.equal(typeof childIdentity, "string");
    assert.equal(typeof foreignIdentity, "string");
    assert.equal(typeof ownerIdentity, "string");
    writeFileSync(path.join(ownRoot, "repo-meta.json"), `${JSON.stringify({
      jdtlsPid: child.pid,
      jdtlsProcessStartIdentity: childIdentity,
      ownerPid: process.pid,
      ownerProcessStartIdentity: processStartIdentityForPid(process.pid)
    })}\n`);
    writeFileSync(path.join(foreignRoot, "repo-meta.json"), `${JSON.stringify({
      jdtlsPid: foreignChildPid,
      jdtlsProcessStartIdentity: foreignIdentity,
      ownerPid: owner.pid,
      ownerProcessStartIdentity: ownerIdentity
    })}\n`);
    const sleeper = spawnHold();
    pids.push(sleeper.pid);
    assert.equal(reapAbandonedWorkspaceJdtls(base), 1);
    await waitFor(() => !isAlive(child.pid), "recorded child killed");
    assert.equal(isAlive(foreignChildPid), true);
    assert.equal(isAlive(sleeper.pid), true);
    assert.equal(isAlive(owner.pid), true);
  } finally {
    killAll(pids);
    rmSync(base, { recursive: true, force: true });
  }
});

test("startup sweep does not kill a child of another process when ownerPid equals this process", { timeout: 15_000 }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jdt-reap-cache-"));
  const cacheRoot = path.join(base, "reused-owner");
  const workspace = path.join(cacheRoot, "workspace");
  mkdirSync(workspace, { recursive: true });
  const owner = spawnOwner(workspace);
  const pids: Array<number | undefined> = [owner.pid];
  try {
    const childPid = await readPidLine(owner);
    pids.push(childPid);
    await waitFor(() => isAlive(childPid) && isAlive(owner.pid), "owner and child visible");
    const childIdentity = processStartIdentityForPid(childPid);
    const ourIdentity = processStartIdentityForPid(process.pid);
    assert.equal(typeof childIdentity, "string");
    assert.equal(typeof ourIdentity, "string");
    writeFileSync(path.join(cacheRoot, "repo-meta.json"), `${JSON.stringify({
      jdtlsPid: childPid,
      jdtlsProcessStartIdentity: childIdentity,
      ownerPid: process.pid,
      ownerProcessStartIdentity: ourIdentity
    })}\n`);
    assert.equal(reapAbandonedWorkspaceJdtls(base), 0);
    assert.equal(isAlive(childPid), true);
    assert.equal(isAlive(owner.pid), true);
  } finally {
    killAll(pids);
    rmSync(base, { recursive: true, force: true });
  }
});
