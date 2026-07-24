// input: none (creates a throwaway Git repo under the OS temp dir).
// output: A primary checkout plus one linked worktree that share a common-dir.
// pos: Shared fixture for worktree-identity, lease, storm and snapshot-seed tests.
//      Runs only local Git commands; never touches the network.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalPath } from "../path-utils.js";

const run = promisify(execFile);

export type GitWorktreeFamily = {
  primary: string;
  linked: string;
  branch: string;
};

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid"
    }
  });
}

export async function createGitWorktreeFamily(): Promise<GitWorktreeFamily> {
  const base = canonicalPath(mkdtempSync(path.join(tmpdir(), "git-family-")));
  const primary = path.join(base, "primary");
  mkdirSync(primary, { recursive: true });
  mkdirSync(path.join(primary, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(primary, "src", "main", "java", "demo", "A.java"), "package demo;\npublic class A {}\n");
  writeFileSync(path.join(primary, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");

  await git(primary, ["init", "-q", "-b", "main"]);
  await git(primary, ["config", "user.name", "fixture"]);
  await git(primary, ["config", "user.email", "fixture@example.invalid"]);
  await git(primary, ["add", "-A"]);
  await git(primary, ["commit", "-q", "-m", "initial"]);

  const branch = "feature";
  const linked = path.join(base, "linked");
  await git(primary, ["worktree", "add", "-q", "-b", branch, linked]);

  return { primary: canonicalPath(primary), linked: canonicalPath(linked), branch };
}
