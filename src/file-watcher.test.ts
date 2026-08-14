import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaFileWatcher } from "./file-watcher.js";

test("JavaFileWatcher watches plain Maven roots and can close/recreate the watcher owner", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-file-watcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "exam-management", "src", "test", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "modules", "school", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "exam-management", "pom.xml"), "<project></project>\n");

  const watcher = new JavaFileWatcher(root, {
    notifyChanges() {},
    syncOpenDocument() {}
  });

  await watcher.start();
  try {
    const roots = watcher.status().watchedRoots.map(item => path.relative(root, item));
    assert.ok(roots.includes(path.join("src", "main", "java")));
    assert.ok(roots.includes(path.join("exam-management", "src", "test", "java")));
    assert.ok(roots.includes(path.join("modules", "school", "src", "main", "java")));
    assert.ok(roots.includes(""));
    assert.ok(roots.includes("exam-management"));
  } finally {
    watcher.close();
  }
  assert.equal(watcher.status().active, false);

  const replacement = new JavaFileWatcher(root, {
    notifyChanges() {},
    syncOpenDocument() {}
  });
  await replacement.start();
  try {
    assert.equal(replacement.status().active, true);
    assert.ok(replacement.status().watchedRoots.length > 0);
  } finally {
    replacement.close();
  }
});
