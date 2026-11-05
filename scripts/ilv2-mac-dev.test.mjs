import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireDevLock, parseDevCli, prunableRuns, pruneStaleDist, runsToPrune } from "./ilv2-mac-dev.mjs";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-dev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("dev CLI keeps the command after -- verbatim", () => {
  assert.deepEqual(parseDevCli(["--name", "owner", "--keep-runs", "2", "--env", "A=b=c", "--", "node", "--test", "dist/x.test.js"]),
    { name: "owner", keepRuns: 2, environment: { A: "b=c" }, command: ["node", "--test", "dist/x.test.js"] });
  assert.deepEqual(parseDevCli([]).command, []);
  assert.throws(() => parseDevCli(["--name", "../x"]), /name/);
  assert.throws(() => parseDevCli(["--keep-runs", "0"]), /keep-runs/);
  assert.throws(() => parseDevCli(["--profile", "full"]), /unknown argument/);
});

test("stale compiled files without a source are pruned; native and non-js outputs stay", async t => {
  const tree = await tempRoot(t);
  for (const file of ["src/a.ts", "src/sub/b.ts", "dist/a.js", "dist/a.js.map", "dist/gone.js", "dist/gone.js.map", "dist/sub/b.js", "dist/sub/old.test.js",
    "dist/native/helper.js", "dist/build-stamp.json"]) {
    await mkdir(path.dirname(path.join(tree, file)), { recursive: true });
    await writeFile(path.join(tree, file), "x");
  }
  assert.deepEqual(await pruneStaleDist(tree), ["gone.js", "gone.js.map", "sub/old.test.js"]);
  assert.deepEqual(await pruneStaleDist(tree), []);
  assert.equal(await readFile(path.join(tree, "dist/native/helper.js"), "utf8"), "x");
});

test("run pruning keeps the newest runs by timestamp name", () => {
  assert.deepEqual(runsToPrune(["20261014T010000Z-aa", "20261014T030000Z-bb", "20261014T020000Z-cc"], 1), ["20261014T020000Z-cc", "20261014T010000Z-aa"]);
  assert.deepEqual(runsToPrune(["20261014T010000Z-aa"], 2), []);
});

test("only finished older runs are pruning candidates", async t => {
  const root = await tempRoot(t);
  for (const [name, finished] of [["20261014T010000Z-aa", true], ["20261014T020000Z-bb", false], ["20261014T030000Z-cc", true], ["20261014T040000Z-dd", true]]) {
    await mkdir(path.join(root, name));
    if (finished) await writeFile(path.join(root, name, "dev-run.json"), "{}");
  }
  // bb is still running (no dev-run.json); dd is the current run.
  assert.deepEqual(await prunableRuns(root, "20261014T040000Z-dd", 1), ["20261014T010000Z-aa"]);
  assert.deepEqual(await prunableRuns(root, "20261014T040000Z-dd", 0), ["20261014T030000Z-cc", "20261014T010000Z-aa"]);
});

test("dev lock rejects a live holder and takes over a dead one", async t => {
  const root = await tempRoot(t);
  const release = await acquireDevLock(root);
  await assert.rejects(acquireDevLock(root), new RegExp(`busy: pid ${process.pid}`));
  await release();
  await writeFile(path.join(root, "lock.json"), JSON.stringify({ pid: spawnSync("/usr/bin/true").pid }));
  const again = await acquireDevLock(root);
  assert.equal(JSON.parse(await readFile(path.join(root, "lock.json"), "utf8")).pid, process.pid);
  await again();
});
