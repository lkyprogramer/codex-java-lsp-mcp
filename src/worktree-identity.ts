// input: A repo root (any directory, Git or not).
// output: Canonical identity — repoHash for facts, familyHash for family-scoped
//         leases and seeding.
// pos: The single owner of Git common-dir discovery. repoHash is the correctness
//      identity for caches/JDT; familyHash is ONLY for lease/seed/sweep scoping.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalPath, repoHash as hashRepoPath } from "./path-utils.js";

const run = promisify(execFile);

export type WorktreeIdentity = {
  repoRoot: string;
  repoHash: string;
  gitDir?: string;
  gitCommonDir?: string;
  familyHash?: string;
  isLinkedWorktree: boolean;
};

async function gitPath(repoRoot: string, arg: "--git-dir" | "--git-common-dir"): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", arg], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
    });
    const value = stdout.trim();
    return value ? canonicalPath(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Family hash without spawning git. `git rev-parse` can fail with EBADF when
 * the daemon already holds thousands of source FDs; the on-disk `.git` file or
 * directory is enough to recover the same common-dir hash sibling seed uses.
 */
export function familyHashFromGitFiles(repoRoot: string): string | undefined {
  try {
    const gitPathOnDisk = path.join(repoRoot, ".git");
    const stat = statSync(gitPathOnDisk);
    if (stat.isDirectory()) return hashRepoPath(canonicalPath(gitPathOnDisk));
    if (!stat.isFile()) return undefined;
    const text = readFileSync(gitPathOnDisk, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match) return undefined;
    const gitDir = match[1]!.trim();
    const absoluteGitDir = canonicalPath(path.isAbsolute(gitDir) ? gitDir : path.resolve(repoRoot, gitDir));
    const marker = `${path.sep}worktrees${path.sep}`;
    const worktreesAt = absoluteGitDir.lastIndexOf(marker);
    const commonDir = worktreesAt >= 0 ? absoluteGitDir.slice(0, worktreesAt) : absoluteGitDir;
    if (!existsSync(commonDir)) return undefined;
    return hashRepoPath(canonicalPath(commonDir));
  } catch {
    return undefined;
  }
}

export async function resolveWorktreeIdentity(inputRoot: string): Promise<WorktreeIdentity> {
  const repoRoot = canonicalPath(inputRoot);
  const repoHash = hashRepoPath(repoRoot);
  const [gitDir, gitCommonDir] = await Promise.all([
    gitPath(repoRoot, "--git-dir"),
    gitPath(repoRoot, "--git-common-dir")
  ]);
  if (gitDir && gitCommonDir) {
    return {
      repoRoot,
      repoHash,
      gitDir,
      gitCommonDir,
      familyHash: hashRepoPath(gitCommonDir),
      isLinkedWorktree: gitDir !== gitCommonDir
    };
  }
  const familyHash = familyHashFromGitFiles(repoRoot);
  if (!familyHash) {
    return { repoRoot, repoHash, isLinkedWorktree: false };
  }
  return { repoRoot, repoHash, familyHash, isLinkedWorktree: familyHash !== hashRepoPath(path.join(repoRoot, ".git")) };
}

/**
 * The scoping key for cross-process JDT/sweep leases: linked worktrees of the
 * same Git repo share one family and so must not run a second JDT for "the
 * same" checkout under a different path. Never use this for cache/JavaIndex
 * identity — that stays repoHash (Task 9).
 */
export function leaseFamilyKey(identity: WorktreeIdentity): string {
  return identity.familyHash ?? identity.repoHash;
}

/** Promise-cached identity so repeated tool calls do not respawn Git. */
export class WorktreeIdentityCache {
  private readonly entries = new Map<string, Promise<WorktreeIdentity>>();

  resolve(inputRoot: string): Promise<WorktreeIdentity> {
    const root = canonicalPath(inputRoot);
    const existing = this.entries.get(root);
    if (existing) return existing;
    const operation = resolveWorktreeIdentity(root).catch(error => {
      if (this.entries.get(root) === operation) this.entries.delete(root);
      throw error;
    });
    this.entries.set(root, operation);
    return operation;
  }

  invalidate(inputRoot?: string): void {
    if (inputRoot) this.entries.delete(canonicalPath(inputRoot));
    else this.entries.clear();
  }
}
