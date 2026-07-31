import { createHash } from "node:crypto";
import { open, opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";
import { isMyBatisMapperFile } from "./mybatis-xml-extractor.js";

// Build artifacts and tool caches that must never be walked into, even if
// they happen to sit inside a detected source root (e.g. a broken build
// leaving `target/classes` nested under `src/main/java`). Files outside any
// known source root are never visited in the first place, since the walk is
// scoped per-root rather than repo-wide.
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git", ".gradle", "build", "target", "out", "bin", "node_modules", "dist"
]);

export type DiscoveredResourceFile = {
  absolutePath: string;
  /** Repo-relative, forward-slash-joined - the same convention as JavaFileFacts.relativePath. */
  relativePath: string;
  /** The resource root that owns the XML file, needed by the typed snapshot manifest. */
  sourceRoot: string;
};

/**
 * Recursively discovers every .xml file under the repo's known resource
 * roots (LayoutContext.resourceRoots - src/main/resources per module, never
 * src/test/resources). A file being discovered here does not mean it is a
 * MyBatis mapper - the extractor decides that per-file from the parsed root
 * element; this is the same "discover broadly, filter narrowly" split
 * discoverJavaFiles already uses for build-artifact directories.
 */
export async function discoverMyBatisResourceFiles(repoRoot: string, layout: LayoutContext): Promise<DiscoveredResourceFile[]> {
  const files: DiscoveredResourceFile[] = [];
  for (const resourceRoot of layout.resourceRoots) {
    await walkResourceDirectory(path.join(repoRoot, resourceRoot), repoRoot, resourceRoot, files);
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export function resourceSourceRoot(relativePath: string, layout: LayoutContext): string | undefined {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  return [...layout.resourceRoots]
    .map(root => root.replace(/\\/g, "/"))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(root => normalizedPath === root || normalizedPath.startsWith(`${root}/`));
}

async function walkResourceDirectory(
  absoluteDir: string,
  repoRoot: string,
  sourceRoot: string,
  files: DiscoveredResourceFile[]
): Promise<void> {
  let dir;
  try {
    dir = await opendir(absoluteDir);
  } catch {
    return;
  }
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkResourceDirectory(path.join(absoluteDir, entry.name), repoRoot, sourceRoot, files);
    } else if (entry.isFile() && entry.name.endsWith(".xml")) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      files.push({ absolutePath, relativePath, sourceRoot });
    }
  }
}

export type DiscoveredJavaFile = {
  absolutePath: string;
  /** Repo-relative, forward-slash-joined - the same convention as JavaFileFacts.relativePath. */
  relativePath: string;
  /** The source root (as in LayoutContext.sourceRoots[].relativePath) this file was discovered under. */
  sourceRoot: string;
};

// Recursively discovers every .java file under the repo's known source
// roots (per layout-probe.ts's LayoutContext, reused rather than a second
// module/source-root classifier) via async fs.promises.opendir - never a
// sync walk, and never `git diff`/`git ls-files` (untracked files must still
// be discovered). The source root a file was discovered under is known for
// free at walk time, so it is returned alongside each path rather than
// forcing every caller to re-derive it.
export async function discoverJavaFiles(repoRoot: string, layout: LayoutContext): Promise<DiscoveredJavaFile[]> {
  const files: DiscoveredJavaFile[] = [];
  for (const sourceRoot of layout.sourceRoots) {
    await walkDirectory(path.join(repoRoot, sourceRoot.relativePath), repoRoot, sourceRoot.relativePath, files);
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

async function walkDirectory(
  absoluteDir: string,
  repoRoot: string,
  sourceRoot: string,
  files: DiscoveredJavaFile[]
): Promise<void> {
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
      await walkDirectory(path.join(absoluteDir, entry.name), repoRoot, sourceRoot, files);
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      files.push({ absolutePath, relativePath, sourceRoot });
    }
  }
}

export type SnapshotManifestKind = "JAVA" | "MYBATIS_XML";

export type ManifestEntry = {
  /** Omitted only by pre-Task-28 Java callers; snapshot V3 always supplies it. */
  kind?: SnapshotManifestKind;
  relativePath: string;
  contentHash: string;
  sourceRoot: string;
};

/**
 * Persisted file metadata sufficient to identify the small set of files whose
 * content hashes must be re-read after restoring an own snapshot.  `ctimeMs`
 * is intentionally required for a metadata match: old snapshots without it
 * take the conservative slow path once, rather than trusting only a size and
 * user-settable mtime.
 */
export type SnapshotManifestFile = {
  relativePath: string;
  sourceRoot: string;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
};

export type SnapshotManifestDiff = {
  discovered: DiscoveredJavaFile[];
  changed: DiscoveredJavaFile[];
  deletedRelativePaths: string[];
  metadataMatches: boolean;
};

/**
 * Performs the cheap half of own-snapshot validation: discover source files
 * and stat each one, then return only the paths that differ from persisted
 * file metadata.  Callers hash/re-parse that returned delta, not every source
 * file.  A metadata match is safe for normal filesystem edits because ctime
 * changes whenever content or mtime is changed; snapshots created before
 * ctime was recorded deliberately never match and fall back to content
 * verification.
 */
export async function scanSnapshotManifestDiff(
  repoRoot: string,
  layout: LayoutContext,
  snapshotFiles: readonly SnapshotManifestFile[]
): Promise<SnapshotManifestDiff> {
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const snapshotByPath = new Map(snapshotFiles.map(file => [file.relativePath, file]));
  const currentPaths = new Set(discovered.map(file => file.relativePath));
  const changed: DiscoveredJavaFile[] = [];

  for (const file of discovered) {
    const previous = snapshotByPath.get(file.relativePath);
    try {
      const current = await stat(file.absolutePath);
      const metadataMatches = previous !== undefined
        && previous.sourceRoot === file.sourceRoot
        && previous.size === current.size
        && previous.mtimeMs === current.mtimeMs
        && previous.ctimeMs !== undefined
        && previous.ctimeMs === current.ctimeMs;
      if (!metadataMatches) changed.push(file);
    } catch {
      // A file that disappears or becomes unreadable between discovery and
      // stat cannot be trusted as unchanged.  The caller's normal refresh or
      // governed sweep will surface the concrete failure and retain safe
      // non-COMPLETE coverage.
      changed.push(file);
    }
  }

  const deletedRelativePaths = snapshotFiles
    .map(file => file.relativePath)
    .filter(relativePath => !currentPaths.has(relativePath));
  return {
    discovered,
    changed,
    deletedRelativePaths,
    metadataMatches: changed.length === 0 && deletedRelativePaths.length === 0
  };
}

/**
 * Hashes sorted typed `kind + relativePath + contentHash + sourceRoot` entries - the
 * "target manifest" fingerprint used to decide whether an own snapshot's
 * facts still match the repo's current files (Step 6a) without a full AST
 * sweep. This is the single normalization point both sides must share:
 * writing a snapshot from `JavaIndexStore.toSnapshotData()`'s facts, and
 * verifying against an independent disk re-scan
 * (`computeCurrentManifestFingerprint`) both funnel through this function,
 * so neither side can drift in how it formats an entry.
 */
export function computeManifestFingerprint(entries: readonly ManifestEntry[]): string {
  const lines = entries
    .map(entry => `${entry.kind ?? "JAVA"}:${entry.relativePath}:${entry.contentHash}:${entry.sourceRoot}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Independently re-derives the manifest entries from the repo's current
 * files on disk (discovery + content read + hash), rather than from any
 * previously-indexed facts - this is what lets a caller detect a file added,
 * removed, or edited while the process was not running, which entries
 * derived only from already-known facts could never notice. Content is
 * hashed the same way `refreshFile` computes `JavaFileFacts.contentHash`
 * (decode as UTF-8 text, then hash that string as UTF-8) so a file whose
 * facts came from a foreground refresh and a file re-scanned here for
 * verification always agree on the same file's hash. Returns the discovered
 * files alongside the entries so a caller diffing against a prior manifest
 * (Step 6a) does not need to re-walk the repo a second time.
 */
export async function scanCurrentManifest(
  repoRoot: string,
  layout: LayoutContext
): Promise<{ discovered: DiscoveredJavaFile[]; entries: ManifestEntry[] }> {
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const entries: ManifestEntry[] = [];
  for (const file of discovered) {
    const content = await readFile(file.absolutePath, "utf8");
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    entries.push({ relativePath: file.relativePath, contentHash, sourceRoot: file.sourceRoot });
  }
  return { discovered, entries };
}

export async function computeCurrentManifestFingerprint(repoRoot: string, layout: LayoutContext): Promise<string> {
  const { entries } = await scanCurrentManifest(repoRoot, layout);
  return computeManifestFingerprint(entries);
}

/**
 * Reads one file the way sibling-worktree seeding (Task 21a) must: open the
 * path once, fstat the resulting *file descriptor* before and after reading
 * its bytes, and report whether size/mtime changed in between. Using the
 * same fd for both stats (rather than two separate path-based `stat()`
 * calls) also catches the path being replaced/renamed mid-read, not just the
 * original inode being mutated - a plain `readFile` cannot distinguish "this
 * content is exactly what the target has right now" from "this content was
 * true for a moment that already passed," which matters here because a
 * seeded fact wrongly treated as still-matching would be reused as if it
 * were current.
 */
export async function readFileStable(absolutePath: string): Promise<{ content: string; stable: boolean } | undefined> {
  let handle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return undefined;
  }
  try {
    const before = await handle.stat();
    const buffer = await handle.readFile();
    const after = await handle.stat();
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
    return { content: buffer.toString("utf8"), stable };
  } finally {
    await handle.close();
  }
}

/**
 * Same shape as `scanCurrentManifest`, but every file is read via
 * `readFileStable` and an entry whose stat changed during its own read is
 * reported in `unstablePaths` instead of `entries` - sibling seeding (Task
 * 21a) must treat such a file as dirty (never reusable), since its content
 * hash cannot be trusted to reflect any single point in time.
 */
export async function scanCurrentManifestStable(
  repoRoot: string,
  layout: LayoutContext
): Promise<{ discovered: DiscoveredJavaFile[]; entries: ManifestEntry[]; unstablePaths: string[] }> {
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const entries: ManifestEntry[] = [];
  const unstablePaths: string[] = [];
  for (const file of discovered) {
    const read = await readFileStable(file.absolutePath);
    if (!read) {
      unstablePaths.push(file.relativePath);
      continue;
    }
    if (!read.stable) {
      unstablePaths.push(file.relativePath);
      continue;
    }
    const contentHash = createHash("sha256").update(read.content, "utf8").digest("hex");
    entries.push({ relativePath: file.relativePath, contentHash, sourceRoot: file.sourceRoot });
  }
  return { discovered, entries, unstablePaths };
}

export type MyBatisManifestEntry = {
  relativePath: string;
  contentHash: string;
  sourceRoot: string;
};

/**
 * Same stable-read contract as `scanCurrentManifestStable`, for MyBatis
 * mapper resources instead of Java files: `discoverMyBatisResourceFiles`
 * finds every `.xml` under the resource roots, but only ones whose content
 * passes `isMyBatisMapperFile` (the same inclusion check the extractor and
 * the store's own indexing already use) become an entry - a non-mapper
 * resource XML changing must never affect this manifest, since the store
 * never held a fact for it to begin with. `sourceRoot` is deliberately not
 * part of the entry (unlike Java's): MyBatisMapperResourceFacts carries no
 * module/sourceSet attribution for anything to key on.
 */
export async function scanCurrentMyBatisManifestStable(
  repoRoot: string,
  layout: LayoutContext
): Promise<{ discovered: DiscoveredResourceFile[]; entries: MyBatisManifestEntry[]; unstablePaths: string[] }> {
  const allDiscovered = await discoverMyBatisResourceFiles(repoRoot, layout);
  const discovered: DiscoveredResourceFile[] = [];
  const entries: MyBatisManifestEntry[] = [];
  const unstablePaths: string[] = [];
  for (const file of allDiscovered) {
    const read = await readFileStable(file.absolutePath);
    if (!read || !read.stable) {
      unstablePaths.push(file.relativePath);
      continue;
    }
    if (!isMyBatisMapperFile(read.content)) continue;
    discovered.push(file);
    const contentHash = createHash("sha256").update(read.content, "utf8").digest("hex");
    entries.push({ relativePath: file.relativePath, contentHash, sourceRoot: file.sourceRoot });
  }
  return { discovered, entries, unstablePaths };
}

/**
 * Builds the schema-3 typed manifest from the worker's already-indexed facts.
 * A resource outside a discovered resource root is not snapshot-safe: omitting
 * it would make the snapshot claim a smaller manifest than the facts it holds.
 */
export function snapshotManifestEntries(
  javaEntries: readonly ManifestEntry[],
  resourceEntries: readonly MyBatisManifestEntry[]
): ManifestEntry[] {
  return [
    ...javaEntries.map(entry => ({ ...entry, kind: "JAVA" as const })),
    ...resourceEntries.map(entry => ({ ...entry, kind: "MYBATIS_XML" as const }))
  ];
}

/** Re-hashes the current Java and mapper XML manifest together for snapshot publication. */
export async function computeCurrentSnapshotManifestFingerprint(repoRoot: string, layout: LayoutContext): Promise<string> {
  const [{ entries: javaEntries }, resources] = await Promise.all([
    scanCurrentManifest(repoRoot, layout),
    scanCurrentMyBatisManifestStable(repoRoot, layout)
  ]);
  if (resources.unstablePaths.length > 0) {
    throw new Error(`mapper resources changed while snapshot manifest was read: ${resources.unstablePaths.join(", ")}`);
  }
  return computeManifestFingerprint(snapshotManifestEntries(javaEntries, resources.entries));
}
