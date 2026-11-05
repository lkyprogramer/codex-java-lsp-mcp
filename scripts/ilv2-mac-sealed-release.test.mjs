import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReleaseInventory, releaseInventory } from "./ilv2-mac-sealed-release.mjs";

test("sealed release identity follows the bytes, modes, and relative dependency links across paths", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sealed-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const installed = path.join(root, "installed");
  for (const directory of [candidate, installed]) {
    await mkdir(path.join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(directory, "run.sh"), "exit 0\n", { mode: 0o755 });
    await writeFile(path.join(directory, "node_modules", "cli.js"), "export {};\n");
    await symlink("../cli.js", path.join(directory, "node_modules", ".bin", "cli"));
  }
  await mkdir(path.join(candidate, ".git"));
  const seal = await releaseInventory(candidate);
  assertReleaseInventory(seal, await releaseInventory(installed));
  const script = path.join(installed, "run.sh");
  const originalMode = (await stat(script)).mode & 0o7777;
  await chmod(script, originalMode ^ 0o100);
  const changedMode = await releaseInventory(installed);
  assert.throws(() => assertReleaseInventory(seal, changedMode), /file tree mismatch/);
  await chmod(script, originalMode);
  await writeFile(path.join(installed, "node_modules", "cli.js"), "throw 0;\n");
  const changedDependency = await releaseInventory(installed);
  assert.throws(() => assertReleaseInventory(seal, changedDependency), /dependency tree mismatch/);
});
