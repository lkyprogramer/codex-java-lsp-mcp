// input: codex-java-lsp cache directories with repo metadata.
// output: Best-effort deletion of stale inactive Git worktree caches.
// pos: Startup cache janitor scoped to linked worktrees only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoCacheBase, repoCacheRoot } from "./repo-layout.js";

const DAY_MS = 86400000;
const META_FILE = "repo-meta.json";

type RepoCacheMeta = {
  schemaVersion?: number;
  repoRoot?: string;
  isGitWorktree?: boolean;
  jdtlsPid?: number;
  updatedAt?: string;
};

export type WorktreeCacheCleanupResult = {
  scanned: number;
  removed: number;
  skipped: number;
  removedDirs: string[];
};

export function touchRepoCache(repoRoot: string, extra: Pick<RepoCacheMeta, "jdtlsPid"> = {}): void {
  try {
    const cacheRoot = repoCacheRoot(repoRoot);
    mkdirSync(cacheRoot, { recursive: true });
    const meta: RepoCacheMeta = {
      schemaVersion: 1,
      repoRoot,
      isGitWorktree: isLinkedGitWorktree(repoRoot),
      updatedAt: new Date().toISOString(),
      ...extra
    };
    writeFileSync(path.join(cacheRoot, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // Best-effort cache metadata only; Java navigation must not depend on it.
  }
}

export function cleanupStaleWorktreeCaches(options: {
  cacheBase?: string;
  now?: number;
  ttlDays?: number;
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
  const cutoff = (options.now ?? Date.now()) - ttlDays * DAY_MS;

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    result.scanned += 1;
    const cacheRoot = path.join(base, entry.name);
    const meta = readRepoCacheMeta(cacheRoot);
    if (!meta?.repoRoot || cacheUpdatedAt(cacheRoot, meta) > cutoff || !isWorktreeCache(meta) || hasActiveJdtls(cacheRoot, meta)) {
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
  for (const file of [META_FILE, "source-index.meta.json"]) {
    try {
      return JSON.parse(readFileSync(path.join(cacheRoot, file), "utf8")) as RepoCacheMeta;
    } catch {
      // Try the next metadata source.
    }
  }
  return undefined;
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
  if (meta.jdtlsPid && isProcessAlive(meta.jdtlsPid)) {
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
