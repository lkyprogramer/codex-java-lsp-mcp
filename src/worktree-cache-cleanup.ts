// input: codex-java-lsp cache directories, retained roots, and cross-process ownership state.
// output: Best-effort deletion of stale inactive Git worktree caches under an exclusive root lease.
// pos: Startup and periodic cache janitor; never deletes a retained or concurrently owned runtime.
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
const META_FILE = "repo-meta.json";

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
  updatedAt?: string;
};

export type RepoCacheTouch = {
  jdtlsPid?: number | null;
  jdtlsProcessStartIdentity?: string | null;
  ownership?: RepoOwnershipMetadata;
};

export type WorktreeCacheCleanupResult = {
  scanned: number;
  removed: number;
  skipped: number;
  failures: number;
  removedDirs: string[];
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
  protectedRepoRoots?: ReadonlySet<string>;
  transport?: RepoOwnerTransport;
  ownership?: RepoOwnershipProvider;
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
    if (extra.jdtlsPid === null) {
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
  const ttlDays = options.ttlDays ?? worktreeCacheTtlDays();
  const result: WorktreeCacheCleanupResult = { scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] };
  if (ttlDays <= 0) {
    return result;
  }

  const base = options.cacheBase ?? repoCacheBase();
  if (!existsSync(base)) {
    return result;
  }
  const cutoff = (options.now ?? Date.now()) - ttlDays * DAY_MS;
  const protectedRoots = new Set(
    [...(options.protectedRepoRoots ?? [])].map(root => canonicalPath(root))
  );
  const janitorOwnership = options.ownership ?? new RepoOwnershipManager({
    baseDir: repoOwnershipBase(options.ownershipBase, options.cacheBase),
    cacheBase: options.cacheBase,
    transport: options.transport ?? "stdio",
    buildSha: "cache-janitor"
  });

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    result.scanned += 1;
    const cacheRoot = path.join(base, entry.name);
    const meta = readRepoCacheMeta(cacheRoot);
    const repoRoot = meta?.repoRoot ? canonicalPath(meta.repoRoot) : undefined;
    if (!meta
      || !repoRoot
      || protectedRoots.has(repoRoot)
      || !isRemovalCandidate(cacheRoot, meta, cutoff)) {
      result.skipped += 1;
      continue;
    }

    let lease;
    try {
      lease = janitorOwnership.acquire(repoRoot);
    } catch {
      result.skipped += 1;
      continue;
    }
    try {
      const current = readRepoCacheMeta(cacheRoot);
      if (!current?.repoRoot
        || canonicalPath(current.repoRoot) !== repoRoot
        || protectedRoots.has(repoRoot)
        || !isRemovalCandidate(cacheRoot, current, cutoff)) {
        result.skipped += 1;
        continue;
      }
      (options.removeCacheRoot ?? removeCacheRoot)(cacheRoot);
      result.removed += 1;
      result.removedDirs.push(cacheRoot);
    } catch (error) {
      result.skipped += 1;
      result.failures += 1;
      reportCleanupFailure(options, {
        phase: "delete",
        repoRoot,
        cacheRoot,
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
          repoRoot,
          cacheRoot,
          lockPath: lease.lockPath,
          error
        });
      }
    }
  }

  return result;
}

function removeCacheRoot(cacheRoot: string): void {
  rmSync(cacheRoot, { recursive: true, force: true });
}

function isRemovalCandidate(cacheRoot: string, meta: RepoCacheMeta, cutoff: number): boolean {
  return Boolean(meta.repoRoot
    && cacheUpdatedAt(cacheRoot, meta) <= cutoff
    && isWorktreeCache(meta)
    && !hasActiveJdtls(cacheRoot, meta));
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
