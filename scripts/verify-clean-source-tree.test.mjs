import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCleanSourceTree } from "./verify-clean-source-tree.mjs";

test("release provenance accepts a clean Git checkout and rejects tracked or untracked source changes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-clean-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Codex Test", "-c", "user.email=codex@example.invalid", "commit", "-qm", "fixture"], { cwd: root });

  assert.doesNotThrow(() => assertCleanSourceTree(root));
  await writeFile(path.join(root, "tracked.txt"), "modified\n");
  assert.throws(() => assertCleanSourceTree(root), /dirty source tree/);
  execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: root });
  await writeFile(path.join(root, "untracked.txt"), "new\n");
  assert.throws(() => assertCleanSourceTree(root), /untracked\.txt/);
});
