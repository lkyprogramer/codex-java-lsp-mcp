// input: Canonical repository roots and process identity metadata.
// output: Cross-process exclusive ownership leases for JDT workspace and SourceIndex state.
// pos: Fail-closed safety boundary shared by stdio compatibility and HTTP daemon runtimes.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { readRuntimeBuild } from "./build-info.js";
import { canonicalPath } from "./path-utils.js";
import { repoCacheBase, repoCacheRoot, resolveConfiguredBase } from "./repo-layout.js";

const OWNER_FILE = "owner.json";

export type RepoOwnerTransport = "stdio" | "streamable_http";

export type RepoOwnershipJdtlsState = {
  state: "starting";
  updatedAt: string;
} | {
  state: "running";
  pid: number;
  processStartIdentity: string;
  updatedAt: string;
};

export type RepoOwnershipMetadata = {
  schemaVersion: 1;
  repoRoot: string;
  ownerToken: string;
  pid: number;
  processStartIdentity: string;
  transport: RepoOwnerTransport;
  buildSha: string;
  acquiredAt: string;
  jdtls?: RepoOwnershipJdtlsState;
};

export type RepoOwnershipLease = {
  readonly metadata: RepoOwnershipMetadata;
  readonly lockPath: string;
  markJdtlsStarting?(): void;
  markJdtlsRunning?(pid: number, processStartIdentity: string): void;
  clearJdtlsState?(): void;
  release(): void;
};

export type RepoOwnershipProvider = {
  acquire(repoRoot: string): RepoOwnershipLease;
};

export type RepoOwnerLiveness = "alive" | "dead" | "unknown";

export type RepoOwnershipManagerOptions = {
  baseDir?: string;
  cacheBase?: string;
  transport: RepoOwnerTransport;
  buildSha?: string;
  ownerToken?: string;
  pid?: number;
  processStartIdentity?: string;
  now?: () => Date;
  ownerLiveness?: (metadata: RepoOwnershipMetadata) => RepoOwnerLiveness;
  orphanJdtlsLiveness?: (repoRoot: string) => RepoOwnerLiveness;
  orphanJdtlsRecovery?: (repoRoot: string, jdtls: Extract<RepoOwnershipJdtlsState, { state: "running" }>) => RepoOwnerLiveness;
};

export class RepoOwnershipConflictError extends Error {
  constructor(repoRoot: string, owner: RepoOwnershipMetadata, readonly liveness: Exclude<RepoOwnerLiveness, "dead">) {
    super(`Repository runtime is already owned: ${repoRoot} (pid=${owner.pid}, transport=${owner.transport}, build=${owner.buildSha}, liveness=${liveness}).`);
    this.name = "RepoOwnershipConflictError";
  }
}

export class RepoOwnershipOrphanJdtlsError extends Error {
  constructor(repoRoot: string, readonly liveness: Exclude<RepoOwnerLiveness, "dead">) {
    super(`Repository ownership owner is dead, but its recorded JDT LS state is ${liveness}; refusing to start another JDT LS for ${repoRoot}.`);
    this.name = "RepoOwnershipOrphanJdtlsError";
  }
}

export class RepoOwnershipManager implements RepoOwnershipProvider {
  private readonly baseDir: string;
  private readonly transport: RepoOwnerTransport;
  private readonly buildSha: string;
  private readonly ownerToken: string;
  private readonly pid: number;
  private readonly processStartIdentity: string;
  private readonly now: () => Date;
  private readonly ownerLiveness: (metadata: RepoOwnershipMetadata) => RepoOwnerLiveness;
  private readonly orphanJdtlsLiveness: (repoRoot: string) => RepoOwnerLiveness;
  private readonly orphanJdtlsRecovery: (repoRoot: string, jdtls: Extract<RepoOwnershipJdtlsState, { state: "running" }>) => RepoOwnerLiveness;

  constructor(options: RepoOwnershipManagerOptions) {
    this.baseDir = repoOwnershipBase(options.baseDir);
    this.transport = options.transport;
    this.buildSha = options.buildSha ?? readRuntimeBuild().gitSha;
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.processStartIdentity = options.processStartIdentity ?? processIdentity(this.pid);
    this.now = options.now ?? (() => new Date());
    this.ownerLiveness = options.ownerLiveness ?? ownerProcessLiveness;
    const cacheBase = options.cacheBase
      ? resolveConfiguredBase(options.cacheBase, "RepoOwnershipManager.cacheBase")
      : repoCacheBase();
    this.orphanJdtlsLiveness = options.orphanJdtlsLiveness
      ?? (repoRoot => recordedJdtlsLiveness(repoRoot, cacheBase));
    this.orphanJdtlsRecovery = options.orphanJdtlsRecovery
      ?? ((repoRoot, jdtls) => recoverRecordedJdtls(repoRoot, jdtls));
  }

  lockPath(repoRoot: string): string {
    const root = canonicalPath(repoRoot);
    return ownershipLockPath(this.baseDir, root);
  }

  acquire(repoRoot: string): RepoOwnershipLease {
    const root = canonicalPath(repoRoot);
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const lockPath = this.lockPath(root);
    const metadata: RepoOwnershipMetadata = {
      schemaVersion: 1,
      repoRoot: root,
      ownerToken: this.ownerToken,
      pid: this.pid,
      processStartIdentity: this.processStartIdentity,
      transport: this.transport,
      buildSha: this.buildSha,
      acquiredAt: this.now().toISOString()
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = mkdtempSync(path.join(this.baseDir, `.${path.basename(lockPath)}.candidate-`));
      try {
        writeFileSync(path.join(candidate, OWNER_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx"
        });
        try {
          renameSync(candidate, lockPath);
          return new FileRepoOwnershipLease(lockPath, metadata, this.now);
        } catch (error) {
          if (!isExistingDestination(error)) {
            throw error;
          }
        }
      } finally {
        if (existsSync(candidate)) {
          rmSync(candidate, { recursive: true, force: true });
        }
      }

      const current = readOwner(lockPath);
      if (!current) {
        if (!existsSync(lockPath)) {
          continue;
        }
        throw new Error(`Repository ownership is unreadable; refusing to steal unknown owner: ${lockPath}`);
      }
      if (current.repoRoot !== root) {
        throw new Error(`Repository ownership key collision; refusing unsafe reuse: ${lockPath}`);
      }
      if (current.ownerToken === metadata.ownerToken
        && current.pid === metadata.pid
        && current.processStartIdentity === metadata.processStartIdentity) {
        return new FileRepoOwnershipLease(lockPath, current, this.now);
      }
      const liveness = this.ownerLiveness(current);
      if (liveness !== "dead") {
        throw new RepoOwnershipConflictError(root, current, liveness);
      }
      const jdtlsLiveness = this.recoverOrInspectJdtls(root, current);
      if (jdtlsLiveness !== "dead") {
        throw new RepoOwnershipOrphanJdtlsError(root, jdtlsLiveness);
      }
      if (!quarantineStaleLock(lockPath)) {
        continue;
      }
    }
    throw new Error(`Unable to acquire repository ownership after concurrent retries: ${root}`);
  }

  private recoverOrInspectJdtls(repoRoot: string, owner: RepoOwnershipMetadata): RepoOwnerLiveness {
    const jdtls = owner.jdtls;
    if (!jdtls) {
      return this.orphanJdtlsLiveness(repoRoot);
    }
    if (jdtls.state === "starting") {
      // The prior process may have died between spawn() and recording a child PID.
      // Reclaiming here would permit a second JVM to reuse the same Eclipse workspace.
      return "unknown";
    }
    return this.orphanJdtlsRecovery(repoRoot, jdtls);
  }
}

export function repoOwnershipBase(explicitBase?: string, fallbackCacheBase?: string): string {
  const configuredBase = explicitBase ?? process.env.JAVA_LSP_OWNERSHIP_BASE;
  if (configuredBase) {
    return resolveConfiguredBase(
      configuredBase,
      explicitBase ? "RepoOwnershipManager.baseDir" : "JAVA_LSP_OWNERSHIP_BASE"
    );
  }
  const cacheBase = fallbackCacheBase
    ? resolveConfiguredBase(fallbackCacheBase, "WorktreeCacheCleanupOptions.cacheBase")
    : repoCacheBase();
  return path.join(cacheBase, ".ownership");
}

export function processStartIdentityForPid(pid: number): string | undefined {
  return readProcessStartIdentity(pid);
}

class FileRepoOwnershipLease implements RepoOwnershipLease {
  private released = false;

  constructor(
    readonly lockPath: string,
    readonly metadata: RepoOwnershipMetadata,
    private readonly now: () => Date
  ) {}

  markJdtlsStarting(): void {
    this.updateJdtlsState({ state: "starting", updatedAt: this.now().toISOString() });
  }

  markJdtlsRunning(pid: number, processStartIdentity: string): void {
    if (!Number.isInteger(pid) || pid <= 0 || !processStartIdentity) {
      throw new Error("JDT LS ownership requires a positive PID and process start identity.");
    }
    this.updateJdtlsState({
      state: "running",
      pid,
      processStartIdentity,
      updatedAt: this.now().toISOString()
    });
  }

  clearJdtlsState(): void {
    this.updateJdtlsState(undefined);
  }

  release(): void {
    if (this.released) {
      return;
    }
    const current = readOwner(this.lockPath);
    if (!current) {
      if (!existsSync(this.lockPath)) {
        this.released = true;
        return;
      }
      throw new Error(`Repository ownership is unreadable; refusing unsafe release: ${this.lockPath}`);
    }
    if (current.ownerToken !== this.metadata.ownerToken
      || current.pid !== this.metadata.pid
      || current.processStartIdentity !== this.metadata.processStartIdentity) {
      throw new Error(`Repository ownership changed; refusing to release another owner: ${this.lockPath}`);
    }
    const releasedPath = `${this.lockPath}.released-${randomUUID()}`;
    try {
      renameSync(this.lockPath, releasedPath);
    } catch (error) {
      if (isMissingPath(error)) {
        this.released = true;
        return;
      }
      throw error;
    }
    rmSync(releasedPath, { recursive: true, force: true });
    this.released = true;
  }

  private updateJdtlsState(jdtls: RepoOwnershipJdtlsState | undefined): void {
    if (this.released) {
      throw new Error(`Repository ownership has already been released: ${this.lockPath}`);
    }
    const current = readOwner(this.lockPath);
    if (!current
      || current.ownerToken !== this.metadata.ownerToken
      || current.pid !== this.metadata.pid
      || current.processStartIdentity !== this.metadata.processStartIdentity) {
      throw new Error(`Repository ownership changed; refusing to update JDT LS state: ${this.lockPath}`);
    }
    const next: RepoOwnershipMetadata = { ...current, ...(jdtls ? { jdtls } : {}) };
    if (!jdtls) {
      delete next.jdtls;
    }
    writeOwnerAtomically(this.lockPath, next);
    if (jdtls) {
      this.metadata.jdtls = jdtls;
    } else {
      delete this.metadata.jdtls;
    }
  }
}

function readOwner(lockPath: string): RepoOwnershipMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(lockPath, OWNER_FILE), "utf8")) as Partial<RepoOwnershipMetadata>;
    if (value.schemaVersion !== 1
      || typeof value.repoRoot !== "string"
      || typeof value.ownerToken !== "string"
      || typeof value.pid !== "number"
      || typeof value.processStartIdentity !== "string"
      || (value.transport !== "stdio" && value.transport !== "streamable_http")
      || typeof value.buildSha !== "string"
      || typeof value.acquiredAt !== "string") {
      return undefined;
    }
    if (value.jdtls !== undefined && !isJdtlsState(value.jdtls)) {
      return undefined;
    }
    return value as RepoOwnershipMetadata;
  } catch {
    return undefined;
  }
}

function isJdtlsState(value: unknown): value is RepoOwnershipJdtlsState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<RepoOwnershipJdtlsState>;
  if (state.state === "starting") {
    return typeof state.updatedAt === "string";
  }
  return state.state === "running"
    && Number.isInteger(state.pid)
    && (state.pid as number) > 0
    && typeof state.processStartIdentity === "string"
    && state.processStartIdentity.length > 0
    && typeof state.updatedAt === "string";
}

function writeOwnerAtomically(lockPath: string, metadata: RepoOwnershipMetadata): void {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const stagedPath = path.join(lockPath, `.${OWNER_FILE}.next-${randomUUID()}`);
  try {
    writeFileSync(stagedPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    renameSync(stagedPath, ownerPath);
  } finally {
    if (existsSync(stagedPath)) {
      rmSync(stagedPath, { force: true });
    }
  }
}

function quarantineStaleLock(lockPath: string): boolean {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function ownershipLockPath(baseDir: string, repoRoot: string): string {
  const key = createHash("sha256").update(repoRoot).digest("hex");
  return path.join(baseDir, `${key}.lock`);
}

function processIdentity(pid: number): string {
  return readProcessStartIdentity(pid) ?? `pid-only:${pid}`;
}

function readProcessStartIdentity(pid: number): string | undefined {
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (startedAt) {
      return `ps:${startedAt}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function ownerProcessLiveness(metadata: RepoOwnershipMetadata): RepoOwnerLiveness {
  if (isZombieProcess(metadata.pid)) {
    return "dead";
  }
  try {
    process.kill(metadata.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
  if (!metadata.processStartIdentity.startsWith("ps:")) {
    return "alive";
  }
  const currentIdentity = readProcessStartIdentity(metadata.pid);
  if (!currentIdentity) {
    return "unknown";
  }
  return currentIdentity === metadata.processStartIdentity ? "alive" : "dead";
}

function recordedJdtlsLiveness(repoRoot: string, cacheBase: string): RepoOwnerLiveness {
  const cacheRoot = repoCacheRoot(repoRoot, cacheBase);
  const metadata = readRecordedJdtlsMetadata(cacheRoot);
  if (metadata) {
    return processLiveness(metadata.pid, metadata.processStartIdentity);
  }
  // A JDT workspace lock without a trustworthy child identity is ambiguous:
  // after a daemon crash, releasing this root would allow a second JVM to use
  // the same -data directory. Treat it as unknown until an operator clears it.
  return existsSync(path.join(cacheRoot, "workspace", ".metadata", ".lock")) ? "unknown" : "dead";
}

function readRecordedJdtlsMetadata(cacheRoot: string): { pid: number; processStartIdentity?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(cacheRoot, "repo-meta.json"), "utf8")) as {
      jdtlsPid?: unknown;
      jdtlsProcessStartIdentity?: unknown;
    };
    if (!Number.isInteger(parsed.jdtlsPid) || (parsed.jdtlsPid as number) <= 0) {
      return undefined;
    }
    return {
      pid: parsed.jdtlsPid as number,
      ...(typeof parsed.jdtlsProcessStartIdentity === "string"
        ? { processStartIdentity: parsed.jdtlsProcessStartIdentity }
        : {})
    };
  } catch {
    return undefined;
  }
}

function processLiveness(pid: number, expectedIdentity?: string): RepoOwnerLiveness {
  if (isZombieProcess(pid)) {
    return "dead";
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  if (!expectedIdentity) {
    return "unknown";
  }
  const currentIdentity = readProcessStartIdentity(pid);
  if (!currentIdentity) {
    return "unknown";
  }
  return currentIdentity === expectedIdentity ? "alive" : "dead";
}

function isZombieProcess(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

function recoverRecordedJdtls(
  _repoRoot: string,
  jdtls: Extract<RepoOwnershipJdtlsState, { state: "running" }>
): RepoOwnerLiveness {
  let liveness = processLiveness(jdtls.pid, jdtls.processStartIdentity);
  if (liveness !== "alive") {
    return liveness;
  }
  try {
    process.kill(jdtls.pid, "SIGTERM");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  liveness = waitForExactProcessExit(jdtls.pid, jdtls.processStartIdentity, 1500);
  if (liveness !== "alive") {
    return liveness;
  }
  try {
    process.kill(jdtls.pid, "SIGKILL");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  return waitForExactProcessExit(jdtls.pid, jdtls.processStartIdentity, 1500);
}

function waitForExactProcessExit(pid: number, identity: string, deadlineMs: number): RepoOwnerLiveness {
  const deadline = Date.now() + deadlineMs;
  let liveness = processLiveness(pid, identity);
  while (liveness === "alive" && Date.now() < deadline) {
    sleepSynchronously(Math.min(25, Math.max(1, deadline - Date.now())));
    liveness = processLiveness(pid, identity);
  }
  return liveness;
}

function sleepSynchronously(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isExistingDestination(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
