// input: codex-java-lsp cache directories, pin roots, and cross-process ownership state.
// output: L0 retired-format GC, L1 dead-path / non-pin TTL reclaim, L2 unpinned LRU caps.
// pos: Startup and periodic cache janitor; never deletes a pin or concurrently owned runtime.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { observeRuntimeLeaseLiveness } from "./cross-process-lease.js";
import { canonicalPath } from "./path-utils.js";
import { repoCacheBase, repoCacheRoot } from "./repo-layout.js";
import {
  processStartIdentityForPid,
  repoOwnershipBase,
  RepoOwnershipManager,
  type RepoOwnershipProvider,
  type RepoOwnershipMetadata,
  type RepoOwnerTransport
} from "./repo-ownership-lease.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const META_FILE = "repo-meta.json";
const DEFAULT_UNPINNED_MAX_DIRS = 48;
const DEFAULT_UNPINNED_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const RETIRED_INDEX_FILES = [
  "semantic-edges.jsonl",
  "java-index-v2.initialized"
] as const;

type RepoCacheMeta = {
  schemaVersion?: number;
  repoRoot?: string;
  isGitWorktree?: boolean;
  jdtlsPid?: number;
  jdtlsProcessStartIdentity?: string;
  ownerToken?: string;
  ownerPid?: number;
  ownerProcessStartIdentity?: string;
  ownerTransport?: RepoOwnerTransport;
  ownerBuildSha?: string;
  lastRequestAt?: string;
  repoHash?: string;
  familyHash?: string;
  updatedAt?: string;
};

type RemovalTarget = {
  cacheRoot: string;
  repoRoot?: string;
  lastRequestAtMs: number;
  sizeBytes: number;
};

export type RepoCacheTouch = {
  jdtlsPid?: number | null;
  jdtlsProcessStartIdentity?: string | null;
  ownerPid?: number;
  ownerToken?: string;
  lastRequestAt?: string;
  /** When true, stamp lastRequestAt to now. JDT pid updates must leave this unset. */
  touchLastRequest?: boolean;
  repoHash?: string;
  familyHash?: string;
  ownership?: RepoOwnershipMetadata;
};

export type WorktreeCacheCleanupResult = {
  scanned: number;
  removed: number;
  skipped: number;
  failures: number;
  removedDirs: string[];
  reclaimedFiles?: number;
};

export type WorktreeCacheCleanupFailure = {
  phase: "delete" | "release";
  repoRoot: string;
  cacheRoot: string;
  lockPath: string;
  error: unknown;
};

export type WorktreeCacheCleanupOptions = {
  cacheBase?: string;
  ownershipBase?: string;
  now?: number;
  ttlDays?: number;
  unpinnedMaxDirs?: number;
  unpinnedMaxBytes?: number;
  noMetaGraceMs?: number;
  dryRun?: boolean;
  protectedRepoRoots?: ReadonlySet<string>;
  protectedCacheDirNames?: ReadonlySet<string>;
  transport?: RepoOwnerTransport;
  ownership?: RepoOwnershipProvider;
  leaseBase?: string;
  /** Test seam; defaults to a real `process.kill(pid, 0)` liveness check. */
  isAlive?: (pid: number) => boolean;
  reportFailure?: (failure: WorktreeCacheCleanupFailure) => void;
  removeCacheRoot?: (cacheRoot: string) => void;
};

export function touchRepoCache(repoRoot: string, extra: RepoCacheTouch = {}): void {
  try {
    const root = canonicalPath(repoRoot);
    const cacheRoot = repoCacheRoot(root);
    mkdirSync(cacheRoot, { recursive: true });
    const previous = readRepoCacheMeta(cacheRoot);
    const meta: RepoCacheMeta = {
      ...(previous?.repoRoot === root ? previous : {}),
      schemaVersion: 2,
      repoRoot: root,
      isGitWorktree: isLinkedGitWorktree(root),
      updatedAt: new Date().toISOString()
    };
    if (extra.ownership) {
      meta.ownerToken = extra.ownership.ownerToken;
      meta.ownerPid = extra.ownership.pid;
      meta.ownerProcessStartIdentity = extra.ownership.processStartIdentity;
      meta.ownerTransport = extra.ownership.transport;
      meta.ownerBuildSha = extra.ownership.buildSha;
    }
    if ("ownerPid" in extra && extra.ownerPid === undefined) {
      delete meta.ownerPid;
    } else if (extra.ownerPid !== undefined) {
      meta.ownerPid = extra.ownerPid;
    }
    if ("ownerToken" in extra && extra.ownerToken === undefined) {
      delete meta.ownerToken;
    } else if (extra.ownerToken !== undefined) {
      meta.ownerToken = extra.ownerToken;
    }
    if (extra.lastRequestAt) {
      meta.lastRequestAt = extra.lastRequestAt;
    } else if (extra.touchLastRequest) {
      meta.lastRequestAt = new Date().toISOString();
    }
    if (extra.repoHash !== undefined) {
      meta.repoHash = extra.repoHash;
    }
    if (extra.familyHash !== undefined) {
      meta.familyHash = extra.familyHash;
    }
    if (extra.jdtlsPid === null || ("jdtlsPid" in extra && extra.jdtlsPid === undefined)) {
      delete meta.jdtlsPid;
      delete meta.jdtlsProcessStartIdentity;
    } else if (extra.jdtlsPid !== undefined) {
      meta.jdtlsPid = extra.jdtlsPid;
      meta.jdtlsProcessStartIdentity = extra.jdtlsProcessStartIdentity
        ?? processStartIdentityForPid(extra.jdtlsPid);
    }
    if (extra.jdtlsProcessStartIdentity === null) {
      delete meta.jdtlsProcessStartIdentity;
    }
    const metaPath = path.join(cacheRoot, META_FILE);
    const temporary = `${metaPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, metaPath);
  } catch {
    // Best-effort cache metadata only; Java navigation must not depend on it.
  }
}

export function cleanupStaleWorktreeCaches(options: WorktreeCacheCleanupOptions = {}): WorktreeCacheCleanupResult {
  const result: WorktreeCacheCleanupResult = {
    scanned: 0,
    removed: 0,
    skipped: 0,
    failures: 0,
    removedDirs: [],
    reclaimedFiles: 0
  };
  const base = options.cacheBase ?? repoCacheBase();
  if (!existsSync(base)) {
    return result;
  }
  const now = options.now ?? Date.now();
  const ttlDays = options.ttlDays ?? worktreeCacheTtlDays();
  const cutoff = ttlDays > 0 ? now - ttlDays * DAY_MS : undefined;
  const noMetaGraceMs = options.noMetaGraceMs ?? HOUR_MS;
  const unpinnedMaxDirs = options.unpinnedMaxDirs ?? unpinnedMaxDirsFromEnv();
  const unpinnedMaxBytes = options.unpinnedMaxBytes ?? unpinnedMaxBytesFromEnv();
  const leaseBase = options.leaseBase ?? path.join(repoCacheBase(), "leases");
  const isAlive = options.isAlive ?? isProcessAlive;
  const protectedRoots = new Set(
    [...(options.protectedRepoRoots ?? [])].map(root => canonicalPath(root))
  );
  const protectedDirNames = new Set(options.protectedCacheDirNames ?? []);
  const dryRun = options.dryRun === true;
  const janitorOwnership = options.ownership ?? new RepoOwnershipManager({
    baseDir: repoOwnershipBase(options.ownershipBase, options.cacheBase),
    cacheBase: options.cacheBase,
    transport: options.transport ?? "stdio",
    buildSha: "cache-janitor"
  });

  const l1Removes: RemovalTarget[] = [];
  const unpinnedKeep: RemovalTarget[] = [];

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (
      !entry.isDirectory()
      || entry.name.startsWith(".")
      || entry.name === "leases"
      || entry.name === "ownership"
      || entry.name === "telemetry"
    ) {
      continue;
    }
    result.scanned += 1;
    const cacheRoot = path.join(base, entry.name);
    const metaBeforeL0 = readRepoCacheMeta(cacheRoot);
    const noMetaAgeMs = metaBeforeL0 ? undefined : directoryAgeMs(cacheRoot, now);
    result.reclaimedFiles = (result.reclaimedFiles ?? 0) + reclaimRetiredIndexFiles(cacheRoot, dryRun);

    if (protectedDirNames.has(entry.name)) {
      result.skipped += 1;
      continue;
    }

    const meta = readRepoCacheMeta(cacheRoot) ?? metaBeforeL0;
    const repoRoot = meta?.repoRoot ? canonicalPath(meta.repoRoot) : undefined;
    if (!meta || !repoRoot) {
      if ((noMetaAgeMs ?? directoryAgeMs(cacheRoot, now)) >= noMetaGraceMs) {
        l1Removes.push({ cacheRoot, lastRequestAtMs: 0, sizeBytes: 0 });
      } else {
        result.skipped += 1;
      }
      continue;
    }
    if (protectedRoots.has(repoRoot)) {
      result.skipped += 1;
      continue;
    }
    if (hasActiveJdtls(cacheRoot, meta) || hasActiveRuntimeOwner(meta, leaseBase, isAlive)) {
      result.skipped += 1;
      continue;
    }
    const lastRequestAtMs = lastRequestAtMillis(meta);
    if (!existsSync(repoRoot)) {
      l1Removes.push({ cacheRoot, repoRoot, lastRequestAtMs, sizeBytes: 0 });
      continue;
    }
    if (cutoff !== undefined && lastRequestAtMs <= cutoff) {
      l1Removes.push({ cacheRoot, repoRoot, lastRequestAtMs, sizeBytes: 0 });
      continue;
    }
    unpinnedKeep.push({ cacheRoot, repoRoot, lastRequestAtMs, sizeBytes: 0 });
  }

  const l2Removes = selectUnpinnedOverflow(unpinnedKeep, unpinnedMaxDirs, unpinnedMaxBytes);
  for (const target of [...l1Removes, ...l2Removes]) {
    removeTarget(target, result, options, janitorOwnership, dryRun);
  }

  return result;
}

export function reclaimRetiredIndexFiles(cacheRoot: string, dryRun = false): number {
  if (!existsSync(cacheRoot)) {
    return 0;
  }
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const filePath = path.join(cacheRoot, name);
    if (!isRetiredIndexFileName(name, filePath)) {
      continue;
    }
    removed += 1;
    if (!dryRun) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Best-effort format GC; directory reclaim still proceeds.
      }
    }
  }
  return removed;
}

function isRetiredIndexFileName(name: string, _filePath: string): boolean {
  if (name.startsWith("source-index.") || (RETIRED_INDEX_FILES as readonly string[]).includes(name)) {
    return true;
  }
  return /^(java-index-snapshot.*\.json\.gz.*|java-knowledge-graph\.json\.gz)$/.test(name);
}

function selectUnpinnedOverflow(
  keepers: RemovalTarget[],
  maxDirs: number,
  maxBytes: number
): RemovalTarget[] {
  if ((maxDirs <= 0 && maxBytes <= 0) || keepers.length === 0) {
    return [];
  }
  const sized = keepers.map(entry => ({
    ...entry,
    sizeBytes: maxBytes > 0 ? directorySizeBytes(entry.cacheRoot) : 0
  }));
  sized.sort((left, right) => left.lastRequestAtMs - right.lastRequestAtMs || right.sizeBytes - left.sizeBytes);
  let dirs = sized.length;
  let bytes = sized.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const evicted: RemovalTarget[] = [];
  while (sized.length > 0) {
    const overDirs = maxDirs > 0 && dirs > maxDirs;
    const overBytes = maxBytes > 0 && bytes > maxBytes;
    if (!overDirs && !overBytes) {
      break;
    }
    const victim = sized.shift();
    if (!victim) {
      break;
    }
    evicted.push(victim);
    dirs -= 1;
    bytes -= victim.sizeBytes;
  }
  return evicted;
}

function removeTarget(
  target: RemovalTarget,
  result: WorktreeCacheCleanupResult,
  options: WorktreeCacheCleanupOptions,
  janitorOwnership: RepoOwnershipProvider,
  dryRun: boolean
): void {
  if (!target.repoRoot) {
    if (!dryRun) {
      try {
        (options.removeCacheRoot ?? removeCacheRoot)(target.cacheRoot);
      } catch (error) {
        result.skipped += 1;
        result.failures += 1;
        reportCleanupFailure(options, {
          phase: "delete",
          repoRoot: target.cacheRoot,
          cacheRoot: target.cacheRoot,
          lockPath: "",
          error
        });
        return;
      }
    }
    result.removed += 1;
    result.removedDirs.push(target.cacheRoot);
    return;
  }

  let lease;
  try {
    lease = janitorOwnership.acquire(target.repoRoot);
  } catch {
    result.skipped += 1;
    return;
  }
  try {
    const current = readRepoCacheMeta(target.cacheRoot);
    const currentRoot = current?.repoRoot ? canonicalPath(current.repoRoot) : undefined;
    if (currentRoot !== target.repoRoot) {
      result.skipped += 1;
      return;
    }
    if (!dryRun) {
      (options.removeCacheRoot ?? removeCacheRoot)(target.cacheRoot);
    }
    result.removed += 1;
    result.removedDirs.push(target.cacheRoot);
  } catch (error) {
    result.skipped += 1;
    result.failures += 1;
    reportCleanupFailure(options, {
      phase: "delete",
      repoRoot: target.repoRoot,
      cacheRoot: target.cacheRoot,
      lockPath: lease.lockPath,
      error
    });
  } finally {
    try {
      lease.release();
    } catch (error) {
      result.failures += 1;
      reportCleanupFailure(options, {
        phase: "release",
        repoRoot: target.repoRoot,
        cacheRoot: target.cacheRoot,
        lockPath: lease.lockPath,
        error
      });
    }
  }
}

function removeCacheRoot(cacheRoot: string): void {
  rmSync(cacheRoot, { recursive: true, force: true });
}

/**
 * Decision order: a live runtime lease is the authoritative, multi-process
 * signal that some MCP server still has this exact repo open, even for
 * fast-only (never-started-JDT) use. `ownerPid` is a last-touch fallback
 * only for legacy metadata that lacks an ownerToken.
 */
function hasActiveRuntimeOwner(
  meta: RepoCacheMeta,
  leaseBase: string,
  isAlive: (pid: number) => boolean
): boolean {
  const familyKey = meta.familyHash ?? meta.repoHash;
  if (familyKey && meta.repoHash) {
    const runtime = observeRuntimeLeaseLiveness(leaseBase, familyKey, meta.repoHash, meta.ownerToken, isAlive);
    if (runtime.matchingOwnerToken || runtime.anyLive) {
      return true;
    }
  }
  return meta.ownerToken === undefined && Boolean(meta.ownerPid && isAlive(meta.ownerPid));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function worktreeCacheTtlDays(): number {
  const raw = process.env.JAVA_LSP_WORKTREE_CACHE_TTL_DAYS;
  if (raw === undefined) {
    return 2;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

function unpinnedMaxDirsFromEnv(): number {
  return nonNegativeIntegerEnv("JAVA_LSP_CACHE_UNPINNED_MAX_DIRS", DEFAULT_UNPINNED_MAX_DIRS);
}

function unpinnedMaxBytesFromEnv(): number {
  return nonNegativeIntegerEnv("JAVA_LSP_CACHE_UNPINNED_MAX_BYTES", DEFAULT_UNPINNED_MAX_BYTES);
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function readRepoCacheMeta(cacheRoot: string): RepoCacheMeta | undefined {
  try {
    return JSON.parse(readFileSync(path.join(cacheRoot, META_FILE), "utf8")) as RepoCacheMeta;
  } catch {
    return undefined;
  }
}

function lastRequestAtMillis(meta: RepoCacheMeta): number {
  const parsed = meta.lastRequestAt ? Date.parse(meta.lastRequestAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function directoryAgeMs(cacheRoot: string, now: number): number {
  try {
    // mtime only: birthtime/ctime cannot be backdated in tests and would let a
    // freshly copied empty hash directory look "new" forever if we took max().
    return Math.max(0, now - statSync(cacheRoot).mtimeMs);
  } catch {
    return 0;
  }
}

function directorySizeBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(next);
        } else {
          total += statSync(next).size;
        }
      } catch {
        // Skip unreadable entries; size caps are best-effort.
      }
    }
  }
  return total;
}

function hasActiveJdtls(cacheRoot: string, meta: RepoCacheMeta): boolean {
  if (meta.jdtlsPid) {
    const liveness = processLiveness(meta.jdtlsPid, meta.jdtlsProcessStartIdentity);
    return liveness !== "dead";
  }
  return existsSync(path.join(cacheRoot, "workspace", ".metadata", ".lock"));
}

function reportCleanupFailure(
  options: WorktreeCacheCleanupOptions,
  failure: WorktreeCacheCleanupFailure
): void {
  try {
    if (options.reportFailure) {
      options.reportFailure(failure);
      return;
    }
    console.error(
      `[codex-java-lsp] cache janitor ${failure.phase} failed `
        + `(repoRoot=${failure.repoRoot}, cacheRoot=${failure.cacheRoot}, lockPath=${failure.lockPath})`,
      failure.error
    );
  } catch {
    // Diagnostics are best-effort; cleanup must continue scanning other entries.
  }
}

function processLiveness(pid: number, expectedIdentity?: string): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  if (!expectedIdentity) {
    return "unknown";
  }
  const currentIdentity = processStartIdentityForPid(pid);
  if (!currentIdentity) {
    return "unknown";
  }
  return currentIdentity === expectedIdentity ? "alive" : "dead";
}

function isLinkedGitWorktree(repoRoot: string): boolean {
  if (!existsSync(repoRoot)) {
    return false;
  }
  try {
    const gitDir = gitPath(repoRoot, "--git-dir");
    const commonDir = gitPath(repoRoot, "--git-common-dir");
    return path.normalize(gitDir) !== path.normalize(commonDir);
  } catch {
    try {
      return !statSync(path.join(repoRoot, ".git")).isDirectory();
    } catch {
      return false;
    }
  }
}

function gitPath(repoRoot: string, arg: "--git-dir" | "--git-common-dir"): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", arg], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}
