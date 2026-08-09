// input: codex-java-lsp cache directories with repo metadata.
// output: Best-effort deletion of stale inactive Git worktree caches.
// pos: Startup cache janitor scoped to linked worktrees only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { observeRuntimeLeaseLiveness } from "./cross-process-lease.js";
import { repoCacheBase, repoCacheRoot } from "./repo-layout.js";

const DAY_MS = 86400000;
const META_FILE = "repo-meta.json";

/**
 * `ownerPid`/`ownerToken`/`repoHash`/`familyHash` were added for Task 12c; a
 * legacy v1 file simply lacks them, which every reader here treats as "no
 * signal from this source" rather than an error.
 */
type RepoCacheMeta = {
  schemaVersion?: number;
  repoRoot?: string;
  repoHash?: string;
  familyHash?: string;
  isGitWorktree?: boolean;
  ownerPid?: number;
  ownerToken?: string;
  jdtlsPid?: number;
  lastRequestAt?: string;
  updatedAt?: string;
};

export type RepoCacheMetaV2 = Required<Pick<RepoCacheMeta, "repoRoot" | "isGitWorktree" | "updatedAt" | "lastRequestAt">> & {
  schemaVersion: 2;
} & Pick<RepoCacheMeta, "repoHash" | "familyHash" | "ownerPid" | "ownerToken" | "jdtlsPid">;

export type WorktreeCacheCleanupResult = {
  scanned: number;
  removed: number;
  skipped: number;
  removedDirs: string[];
};

type TouchRepoCacheExtra = Partial<
  Pick<RepoCacheMeta, "repoHash" | "familyHash" | "ownerPid" | "ownerToken" | "jdtlsPid">
>;

/**
 * Merges `extra` onto whatever is already on disk (a request-touch and a JDT
 * lifecycle touch write different, independent fields; a blind overwrite
 * would make each clobber the other's last write). A field explicitly passed
 * as `undefined` clears it — used to drop `jdtlsPid` on stop/BROKEN and
 * `ownerPid`/`ownerToken` on runtime disposal.
 */
export function touchRepoCache(repoRoot: string, extra: TouchRepoCacheExtra = {}): void {
  try {
    const cacheRoot = repoCacheRoot(repoRoot);
    mkdirSync(cacheRoot, { recursive: true });
    const existing = readRepoCacheMeta(cacheRoot);
    const meta: RepoCacheMetaV2 = {
      schemaVersion: 2,
      repoRoot,
      isGitWorktree: isLinkedGitWorktree(repoRoot),
      repoHash: existing?.repoHash,
      familyHash: existing?.familyHash,
      ownerPid: existing?.ownerPid,
      ownerToken: existing?.ownerToken,
      jdtlsPid: existing?.jdtlsPid,
      ...extra,
      lastRequestAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeFileSync(path.join(cacheRoot, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // Best-effort cache metadata only; Java navigation must not depend on it.
  }
}

export function cleanupStaleWorktreeCaches(options: {
  cacheBase?: string;
  leaseBase?: string;
  now?: number;
  ttlDays?: number;
  /** Test seam; defaults to a real `process.kill(pid, 0)` liveness check. */
  isAlive?: (pid: number) => boolean;
} = {}): WorktreeCacheCleanupResult {
  const ttlDays = options.ttlDays ?? worktreeCacheTtlDays();
  const result: WorktreeCacheCleanupResult = { scanned: 0, removed: 0, skipped: 0, removedDirs: [] };
  if (ttlDays <= 0) {
    return result;
  }

  const base = options.cacheBase ?? repoCacheBase();
  if (!existsSync(base)) {
    return result;
  }
  const leaseBase = options.leaseBase ?? path.join(repoCacheBase(), "leases");
  const isAlive = options.isAlive ?? isProcessAlive;
  const cutoff = (options.now ?? Date.now()) - ttlDays * DAY_MS;

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    result.scanned += 1;
    const cacheRoot = path.join(base, entry.name);
    const meta = readRepoCacheMeta(cacheRoot);
    if (!meta?.repoRoot || cacheUpdatedAt(cacheRoot, meta) > cutoff || !isWorktreeCache(meta) || hasActiveOwner(cacheRoot, meta, leaseBase, isAlive)) {
      result.skipped += 1;
      continue;
    }
    rmSync(cacheRoot, { recursive: true, force: true });
    result.removed += 1;
    result.removedDirs.push(cacheRoot);
  }

  return result;
}

function worktreeCacheTtlDays(): number {
  const raw = process.env.JAVA_LSP_WORKTREE_CACHE_TTL_DAYS;
  if (raw === undefined) {
    return 2;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

function readRepoCacheMeta(cacheRoot: string): RepoCacheMeta | undefined {
  try {
    return JSON.parse(readFileSync(path.join(cacheRoot, META_FILE), "utf8")) as RepoCacheMeta;
  } catch {
    return undefined;
  }
}

function cacheUpdatedAt(cacheRoot: string, meta: RepoCacheMeta): number {
  const parsed = meta.updatedAt ? Date.parse(meta.updatedAt) : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return statSync(cacheRoot).mtimeMs;
}

function isWorktreeCache(meta: RepoCacheMeta): boolean {
  if (typeof meta.isGitWorktree === "boolean") {
    return meta.isGitWorktree;
  }
  return Boolean(meta.repoRoot && existsSync(meta.repoRoot) && isLinkedGitWorktree(meta.repoRoot));
}

/**
 * Decision order: a live runtime lease is the authoritative, multi-process
 * signal (Task 12a) that some MCP server still has this exact repo open,
 * even for fast-only (never-started-JDT) use. `ownerPid`/`jdtlsPid` are
 * last-touch diagnostics/fallback for when the lease itself can't be read,
 * not a replacement for it.
 */
function hasActiveOwner(cacheRoot: string, meta: RepoCacheMeta, leaseBase: string, isAlive: (pid: number) => boolean): boolean {
  const familyKey = meta.familyHash ?? meta.repoHash;
  if (familyKey && meta.repoHash) {
    const runtime = observeRuntimeLeaseLiveness(leaseBase, familyKey, meta.repoHash, meta.ownerToken, isAlive);
    // Any live runtime is authoritative. The token comparison additionally
    // tells us whether this cache metadata's last-touch owner remains live;
    // a different live runtime must still retain the shared cache.
    if (runtime.matchingOwnerToken || runtime.anyLive) {
      return true;
    }
  }
  // Only legacy metadata lacks an ownerToken. New metadata must be backed by
  // a live runtime lease; otherwise a PID reused by this long-lived server
  // could preserve a released runtime cache indefinitely.
  if (meta.ownerToken === undefined && meta.ownerPid && isAlive(meta.ownerPid)) {
    return true;
  }
  if (meta.jdtlsPid && isAlive(meta.jdtlsPid)) {
    return true;
  }
  return existsSync(path.join(cacheRoot, "workspace", ".metadata", ".lock"));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
