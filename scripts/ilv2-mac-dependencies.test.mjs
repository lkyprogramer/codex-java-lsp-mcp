import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execute, sha256 } from "./ilv2-mac-contracts.mjs";
import { dependencyTreeInventory } from "./isolation-utils.mjs";
import { restoreDependencyArchive } from "./ilv2-mac-dependencies.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("./ilv2-mac-dependencies.mjs", import.meta.url));
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-dependencies-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "run-root.txt"), root + "\n");
  return root;
}
async function parserFixture(t) {
  const root = await fixture(t);
  await mkdir(path.join(root, "node_modules"));
  for (const name of ["tree-sitter", "tree-sitter-java", "node-gyp-build"]) {
    await cp(await realpath(path.join(source, "node_modules", name)), path.join(root, "node_modules", name), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  return root;
}

test("dependency check loads the real native Java parser in a fresh process", async t => {
  const root = await parserFixture(t);
  const result = JSON.parse((await execute(process.execPath, [cli, "check", "--repo-root", root])).stdout);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.parse, { rootType: "program", hasError: false });
  assert.equal(result.bindings.length, 2);
  assert.ok(result.bindings.every(row => row.bytes > 163 && /^[a-f0-9]{64}$/.test(row.sha256)));
});

test("dependency check rejects an AppleDouble binding without changing it", async t => {
  const root = await parserFixture(t);
  const selected = path.join(root, "node_modules/tree-sitter/build/Release/._tree_sitter_runtime_binding.node");
  const bytes = Buffer.alloc(163); Buffer.from("0005160700020000", "hex").copy(bytes);
  await writeFile(selected, bytes);
  await assert.rejects(execute(process.execPath, [cli, "check", "--repo-root", root]), error => /AppleDouble selected as native binding/.test(error.stderr));
  assert.deepEqual(await readFile(selected), bytes);
});

test("dependency check rejects a native binding symlink outside dependencies", async t => {
  const root = await parserFixture(t);
  const selected = path.join(root, "node_modules/tree-sitter/build/Release/tree_sitter_runtime_binding.node");
  await cp(selected, path.join(root, "outside.node"));
  await rm(selected);
  await symlink("../../../../outside.node", selected);
  await assert.rejects(execute(process.execPath, [cli, "check", "--repo-root", root]), error => /binding resolved outside dependencies/.test(error.stderr));
});

test("native tar restoration consumes metadata and preserves relative npm links", { skip: process.platform !== "darwin" }, async t => {
  const root = await fixture(t);
  const input = path.join(root, "input"), output = path.join(root, "restored"), archive = path.join(root, "dependencies.tar.gz");
  await mkdir(path.join(input, "node_modules/fixture"), { recursive: true });
  await mkdir(path.join(input, "node_modules/.bin"));
  const binary = path.join(input, "node_modules/fixture/tool.js");
  await writeFile(binary, "process.stdout.write('fixture');\n");
  await execute("/usr/bin/xattr", ["-w", "com.lky.ilv2.test", "metadata", binary]);
  await symlink("../fixture/tool.js", path.join(input, "node_modules/.bin/tool"));
  const expectedDependencies = await dependencyTreeInventory(path.join(input, "node_modules"));
  await execute("/usr/bin/tar", ["-czf", archive, "-C", input, "./node_modules"]);
  const result = await restoreDependencyArchive({ archive, destination: output, expectedArchiveSha256: sha256(await readFile(archive)), expectedDependencies, runRoot: root });
  assert.deepEqual(result.dependencies, expectedDependencies);
  assert.equal(await readlink(path.join(output, "node_modules/.bin/tool")), "../fixture/tool.js");
  assert.equal((await execute("/usr/bin/xattr", ["-p", "com.lky.ilv2.test", path.join(output, "node_modules/fixture/tool.js")])).stdout.trim(), "metadata");
});

test("dependency restoration refuses a wrong archive hash before creating output", { skip: process.platform !== "darwin" }, async t => {
  const root = await fixture(t), archive = path.join(root, "invalid.tar.gz"), destination = path.join(root, "restored");
  await writeFile(archive, "wrong archive");
  await assert.rejects(restoreDependencyArchive({ archive, destination, expectedArchiveSha256: "0".repeat(64), expectedDependencies: {}, runRoot: root }), /SHA-256 mismatch/);
  await assert.rejects(access(destination), { code: "ENOENT" });
});
