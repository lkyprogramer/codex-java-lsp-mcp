// input: A repo root (any directory, Git or not).
// output: Canonical identity — repoHash for facts, familyHash for family-scoped
//         leases and seeding.
// pos: The single owner of Git common-dir discovery. repoHash is the correctness
//      identity for caches/JDT; familyHash is ONLY for lease/seed/sweep scoping.
import { execFile } from "node:child_process";
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

export async function resolveWorktreeIdentity(inputRoot: string): Promise<WorktreeIdentity> {
  const repoRoot = canonicalPath(inputRoot);
  const repoHash = hashRepoPath(repoRoot);
  const [gitDir, gitCommonDir] = await Promise.all([
    gitPath(repoRoot, "--git-dir"),
    gitPath(repoRoot, "--git-common-dir")
  ]);
  // Missing Git metadata is a valid state (a plain directory), not an error.
  if (!gitDir || !gitCommonDir) {
    return { repoRoot, repoHash, isLinkedWorktree: false };
  }
  return {
    repoRoot,
    repoHash,
    gitDir,
    gitCommonDir,
    familyHash: hashRepoPath(gitCommonDir),
    isLinkedWorktree: gitDir !== gitCommonDir
  };
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
