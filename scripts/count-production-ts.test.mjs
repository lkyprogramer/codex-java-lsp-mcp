import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { countLines, countProductionTs, verifyProductionTsManifest } from "./count-production-ts.mjs";

const exec = promisify(execFile);

test("countLines counts a final unterminated line without inventing one for an empty file", () => {
  assert.equal(countLines(Buffer.from("")), 0);
  assert.equal(countLines(Buffer.from("one\n")), 1);
  assert.equal(countLines(Buffer.from("one\ntwo")), 2);
});

test("revision counting is source-locked and excludes only test TypeScript", async t => {
  const root = await fixtureRepository(t);
  const baseline = await git(root, "rev-parse", "HEAD");
  const manifest = await countProductionTs({ root, revision: baseline.stdout.trim() });

  assert.equal(manifest.source.kind, "git-revision");
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.totalLoc, 3);
  assert.deepEqual(manifest.files.map(file => file.path), ["src/a.ts", "src/nested/b.ts"]);
  assert.match(manifest.inventorySha256, /^[a-f0-9]{64}$/);
});

test("worktree counting includes an untracked production file and detects manifest drift", async t => {
  const root = await fixtureRepository(t);
  const baseline = await countProductionTs({ root });
  await writeFile(path.join(root, "src", "new.ts"), "export const added = 3;\n");
  const changed = await countProductionTs({ root });

  assert.equal(changed.fileCount, baseline.fileCount + 1);
  assert.throws(() => verifyProductionTsManifest(baseline, changed), /does not match/);
  assert.equal(verifyProductionTsManifest(changed, changed), true);
});

async function fixtureRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "count-production-ts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init");
  await git(root, "config", "user.name", "V32 Test");
  await git(root, "config", "user.email", "v32@example.invalid");
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "nested", "b.ts"), "export const b = 1;\nexport const c = 2;\n");
  await writeFile(path.join(root, "src", "a.test.ts"), "throw new Error('not production');\n");
  await writeFile(path.join(root, "outside.ts"), "export const ignored = true;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return root;
}

async function git(cwd, ...args) {
  return exec("git", ["-C", cwd, ...args]);
}
