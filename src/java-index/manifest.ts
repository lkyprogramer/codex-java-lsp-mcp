import { opendir } from "node:fs/promises";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";

// Build artifacts and tool caches that must never be walked into, even if
// they happen to sit inside a detected source root (e.g. a broken build
// leaving `target/classes` nested under `src/main/java`). Files outside any
// known source root are never visited in the first place, since the walk is
// scoped per-root rather than repo-wide.
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git", ".gradle", "build", "target", "out", "bin", "node_modules", "dist"
]);

// Recursively discovers every .java file under the repo's known source
// roots (per layout-probe.ts's LayoutContext, reused rather than a second
// module/source-root classifier) via async fs.promises.opendir - never a
// sync walk, and never `git diff`/`git ls-files` (untracked files must still
// be discovered). Returns absolute paths.
export async function discoverJavaFiles(repoRoot: string, layout: LayoutContext): Promise<string[]> {
  const files: string[] = [];
  for (const sourceRoot of layout.sourceRoots) {
    await walkDirectory(path.join(repoRoot, sourceRoot.relativePath), files);
  }
  return files.sort();
}

async function walkDirectory(absoluteDir: string, files: string[]): Promise<void> {
  let dir;
  try {
    dir = await opendir(absoluteDir);
  } catch {
    // The source root itself (e.g. a module's src/test/java) may not exist;
    // not every module has both main and test trees.
    return;
  }
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkDirectory(path.join(absoluteDir, entry.name), files);
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      files.push(path.join(absoluteDir, entry.name));
    }
  }
}
