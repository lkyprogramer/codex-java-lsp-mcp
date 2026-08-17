import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RepoOwnershipConflictError,
  RepoOwnershipOrphanJdtlsError,
  RepoOwnershipManager,
  processStartIdentityForPid,
  type RepoOwnerLiveness
} from "./repo-ownership-lease.js";
import { repoCacheRoot } from "./repo-layout.js";
import { canonicalPath } from "./path-utils.js";

test("ownership is exclusive per root and independent across roots", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-"));
  const rootA = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-root-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-root-b-"));
  const first = manager(baseDir, "first", 101, () => "alive");
  const second = manager(baseDir, "second", 202, () => "alive");

  const leaseA = first.acquire(rootA);
  const leaseB = second.acquire(rootB);
  assert.throws(() => second.acquire(rootA), RepoOwnershipConflictError);

  leaseA.release();
  const transferred = second.acquire(rootA);
  transferred.release();
  leaseB.release();
});

test("ownership rejects a relative base that would vary by process cwd", () => {
  assert.throws(
    () => new RepoOwnershipManager({ baseDir: "relative-ownership", transport: "stdio" }),
    /must be an absolute path or start with ~\//
  );
});

test("dead owner is reclaimed but a stale lease cannot release its successor", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-stale-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-root-"));
  const stale = manager(baseDir, "stale", 303, () => "alive").acquire(root);
  const successor = manager(baseDir, "successor", 404, () => "dead").acquire(root);

  assert.throws(() => stale.release(), /refusing to release another owner/);
  successor.release();
});

test("dead owner lease is not reclaimed while its recorded JDT LS child is live or unknown", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-orphan-lock-"));
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-orphan-cache-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-orphan-root-"));
  const stale = new RepoOwnershipManager({
    baseDir,
    cacheBase,
    transport: "stdio",
    buildSha: "test-build",
    ownerToken: "crashed-owner",
    pid: 303,
    processStartIdentity: "ps:crashed-owner",
    ownerLiveness: () => "alive"
  }).acquire(root);
  const cacheRoot = repoCacheRoot(root, cacheBase);
  await mkdir(cacheRoot, { recursive: true });
  const liveIdentity = processStartIdentityForPid(process.pid);
  assert.ok(liveIdentity, "test host must expose a process start identity");
  await writeFile(path.join(cacheRoot, "repo-meta.json"), JSON.stringify({
    schemaVersion: 2,
    repoRoot: root,
    jdtlsPid: process.pid,
    jdtlsProcessStartIdentity: liveIdentity
  }));

  const successor = new RepoOwnershipManager({
    baseDir,
    cacheBase,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "restarted-daemon",
    ownerLiveness: () => "dead"
  });
  assert.throws(() => successor.acquire(root), RepoOwnershipOrphanJdtlsError);

  await writeFile(path.join(cacheRoot, "repo-meta.json"), JSON.stringify({
    schemaVersion: 2,
    repoRoot: root,
    jdtlsPid: process.pid,
    jdtlsProcessStartIdentity: "ps:obsolete-jdtls-process"
  }));
  const reclaimed = successor.acquire(root);
  assert.throws(() => stale.release(), /refusing to release another owner/);
  reclaimed.release();
});

test("dead owner with a pre-spawn JDT lifecycle marker fails closed", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-starting-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-starting-root-"));
  const stale = manager(baseDir, "crashed-during-spawn", 606, () => "alive").acquire(root);
  stale.markJdtlsStarting?.();

  const successor = new RepoOwnershipManager({
    baseDir,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "restart-after-spawn-window",
    ownerLiveness: () => "dead",
    orphanJdtlsLiveness: () => "dead"
  });
  assert.throws(() => successor.acquire(root), RepoOwnershipOrphanJdtlsError);
  stale.clearJdtlsState?.();
  stale.release();
});

test("dead owner reclaims a running JDT only after exact recovery and stale leases cannot mutate the successor", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-recover-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-recover-root-"));
  const stale = manager(baseDir, "dead-owner", 707, () => "alive").acquire(root);
  stale.markJdtlsRunning?.(909, "ps:exact-jdtls-child");
  const recoveries: Array<{ repoRoot: string; pid: number; processStartIdentity: string }> = [];
  const successor = new RepoOwnershipManager({
    baseDir,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "recovered-owner",
    ownerLiveness: () => "dead",
    orphanJdtlsRecovery: (repoRoot, jdtls) => {
      recoveries.push({ repoRoot, pid: jdtls.pid, processStartIdentity: jdtls.processStartIdentity });
      return "dead";
    }
  }).acquire(root);

  assert.deepEqual(recoveries, [{ repoRoot: canonicalPath(root), pid: 909, processStartIdentity: "ps:exact-jdtls-child" }]);
  assert.throws(() => stale.markJdtlsStarting?.(), /refusing to update JDT LS state/);
  successor.release();
});

test("dead owner retains ownership when exact JDT recovery cannot prove termination", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-recover-unknown-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-recover-unknown-root-"));
  const stale = manager(baseDir, "dead-owner-unknown", 808, () => "alive").acquire(root);
  stale.markJdtlsRunning?.(910, "ps:unreadable-jdtls-child");
  const successor = new RepoOwnershipManager({
    baseDir,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "unknown-recovery-owner",
    ownerLiveness: () => "dead",
    orphanJdtlsRecovery: () => "unknown"
  });
  assert.throws(() => successor.acquire(root), RepoOwnershipOrphanJdtlsError);
  stale.clearJdtlsState?.();
  stale.release();
});

test("dead owner bounded recovery terminates only the exact recorded JDT child before reclaiming", { timeout: 10000 }, async t => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-recover-process-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-recover-process-root-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  assert.ok(child.pid);
  const identity = await waitForProcessIdentity(child.pid);
  const stale = manager(baseDir, "crashed-owner-process", 1001, () => "alive").acquire(root);
  stale.markJdtlsRunning?.(child.pid, identity);
  const childExit = once(child, "exit");

  const successor = new RepoOwnershipManager({
    baseDir,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "recovered-owner-process",
    ownerLiveness: () => "dead"
  }).acquire(root);
  await childExit;
  assert.throws(() => process.kill(child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  successor.release();
});

test("unreadable ownership fails closed", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-unknown-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-root-"));
  const owner = manager(baseDir, "owner", 505, () => "dead");
  const lockPath = owner.lockPath(root);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), "not-json\n");

  assert.throws(() => owner.acquire(root), /refusing to steal unknown owner/);
});

test("independent Node processes enforce ownership, handoff, and crash recovery", { timeout: 15000 }, async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-process-"));
  const rootA = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-process-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-process-b-"));
  let holderA: ChildProcessWithoutNullStreams | undefined;
  let holderB: ChildProcessWithoutNullStreams | undefined;
  try {
    holderA = await startHolder(baseDir, rootA, "holder-a");
    assertConflict(baseDir, rootA, "contender-a");

    holderB = await startHolder(baseDir, rootB, "holder-b");
    await stopHolder(holderB, "SIGTERM");
    holderB = undefined;

    await stopHolder(holderA, "SIGTERM");
    holderA = undefined;
    assertAcquireOnce(baseDir, rootA, "normal-successor");

    holderA = await startHolder(baseDir, rootA, "crash-owner");
    await stopHolder(holderA, "SIGKILL");
    holderA = undefined;
    assertAcquireOnce(baseDir, rootA, "crash-successor");
  } finally {
    holderA?.kill("SIGKILL");
    holderB?.kill("SIGKILL");
  }
});

test("a live owner remains exclusive when process start identity is temporarily unreadable", { timeout: 10000 }, async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-no-ps-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-no-ps-root-"));
  const holder = await startHolder(baseDir, root, "holder-no-ps");
  try {
    const result = runAcquireOnce(baseDir, root, "contender-no-ps", {
      ...process.env,
      PATH: "/path-without-ps"
    });
    assert.notEqual(result.status, 0, "identity lookup failure must not steal a live owner");
    assert.match(result.stderr, /liveness=unknown/);
    assert.doesNotMatch(result.stdout, /ACQUIRED/);
  } finally {
    await stopHolder(holder, "SIGTERM");
  }
});

test("a reused PID with a different readable start identity is reclaimable", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "java-lsp-ownership-pid-reuse-"));
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-owner-pid-reuse-root-"));
  manager(baseDir, "stale-same-pid", process.pid, () => "alive", "ps:stale-process-start").acquire(root);

  const successor = new RepoOwnershipManager({
    baseDir,
    transport: "streamable_http",
    buildSha: "test-build",
    ownerToken: "pid-reuse-successor"
  }).acquire(root);
  successor.release();
});

function manager(
  baseDir: string,
  ownerToken: string,
  pid: number,
  ownerLiveness: () => RepoOwnerLiveness,
  processStartIdentity = `test:${pid}`
): RepoOwnershipManager {
  return new RepoOwnershipManager({
    baseDir,
    transport: "stdio",
    buildSha: "test-build",
    ownerToken,
    pid,
    processStartIdentity,
    ownerLiveness
  });
}

const moduleUrl = new URL("./repo-ownership-lease.js", import.meta.url).href;

const holderScript = `
  import { RepoOwnershipManager } from ${JSON.stringify(moduleUrl)};
  const [baseDir, repoRoot, ownerToken] = process.argv.slice(1);
  const manager = new RepoOwnershipManager({ baseDir, transport: "stdio", buildSha: "process-test", ownerToken });
  const lease = manager.acquire(repoRoot);
  process.on("SIGTERM", () => { lease.release(); process.exit(0); });
  console.log("READY");
  setInterval(() => undefined, 1000);
`;

const acquireOnceScript = `
  import { RepoOwnershipManager } from ${JSON.stringify(moduleUrl)};
  const [baseDir, repoRoot, ownerToken] = process.argv.slice(1);
  const manager = new RepoOwnershipManager({ baseDir, transport: "streamable_http", buildSha: "process-test", ownerToken });
  const lease = manager.acquire(repoRoot);
  console.log("ACQUIRED");
  lease.release();
`;

async function startHolder(baseDir: string, repoRoot: string, ownerToken: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", holderScript, baseDir, repoRoot, ownerToken]);
  let output = "";
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", chunk => { errorOutput += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ownership holder: ${errorOutput}`)), 5000);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", code => {
      if (!output.includes("READY")) {
        clearTimeout(timer);
        reject(new Error(`Ownership holder exited early (${code}): ${errorOutput}`));
      }
    });
  });
  return child;
}

async function stopHolder(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
  child.kill(signal);
  await once(child, "exit");
}

function assertConflict(baseDir: string, repoRoot: string, ownerToken: string): void {
  const result = runAcquireOnce(baseDir, repoRoot, ownerToken);
  assert.notEqual(result.status, 0, "a live owner must reject a second process");
  assert.match(result.stderr, /already owned/);
}

function assertAcquireOnce(baseDir: string, repoRoot: string, ownerToken: string): void {
  const result = runAcquireOnce(baseDir, repoRoot, ownerToken);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACQUIRED/);
}

function runAcquireOnce(
  baseDir: string,
  repoRoot: string,
  ownerToken: string,
  env?: NodeJS.ProcessEnv
): ReturnType<typeof spawnSync> & {
  stdout: string;
  stderr: string;
} {
  return spawnSync(process.execPath, ["--input-type=module", "-e", acquireOnceScript, baseDir, repoRoot, ownerToken], {
    encoding: "utf8",
    env,
    timeout: 5000
  }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}

async function waitForProcessIdentity(pid: number): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const identity = processStartIdentityForPid(pid);
    if (identity) return identity;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process identity: ${pid}`);
}
