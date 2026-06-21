import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaFileWatcher } from "./file-watcher.js";

test("JavaFileWatcher watches plain Maven and one-level module source roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-file-watcher-"));
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
});
