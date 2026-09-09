import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { repoWatchBackend, watchRepoTargets } from "./repo-fs-watch.js";

test("darwin uses recursive native watches; other platforms stay on chokidar", () => {
  assert.equal(repoWatchBackend("darwin"), "fs-watch-recursive");
  assert.equal(repoWatchBackend("linux"), "chokidar");
});

test("recursive native watcher opens one handle per directory target, not per nested dir", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fsx1-watch-"));
  let cursor = root;
  for (let i = 0; i < 40; i += 1) {
    cursor = path.join(cursor, `d${i}`);
    mkdirSync(cursor);
  }
  writeFileSync(path.join(cursor, "A.java"), "class A {}\n");
  const watcher = watchRepoTargets([root], { persistent: false });
  try {
    if (repoWatchBackend() === "fs-watch-recursive") {
      assert.equal(watcher.handleCount(), 1, "nested tree must not open one fs.watch per directory");
    } else {
      assert.equal(watcher.handleCount(), 0);
    }
  } finally {
    await watcher.close();
  }
});
