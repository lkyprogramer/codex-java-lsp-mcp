// input: lishuedu repo root and JDT LS notification callbacks.
// output: Debounced workspace file-change events for Java sources and Gradle config.
// pos: Lightweight fs.watch bridge between the worktree filesystem and JDT LS.
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { toFileUri } from "./repo-layout.js";

export const enum WatchedFileChangeType {
  Created = 1,
  Changed = 2,
  Deleted = 3
}

export type WatchedFileChange = {
  uri: string;
  type: WatchedFileChangeType;
  filePath: string;
};

export type FileWatcherStatus = {
  enabled: boolean;
  active: boolean;
  watchedRoots: string[];
  pendingChanges: number;
  lastFlushAt?: string;
  lastFlushSize: number;
  lastError?: string;
};

type WatchRoot = {
  root: string;
  recursive: boolean;
  accepts: (filePath: string) => boolean;
};

type WatchCallbacks = {
  notifyChanges: (changes: WatchedFileChange[]) => Promise<void> | void;
  syncOpenDocument: (change: WatchedFileChange) => Promise<void> | void;
};

const DEBOUNCE_MS = 250;
const IGNORED_SEGMENTS = new Set([".git", ".gradle", "build", "bin", "out", "target", "node_modules", "dist"]);

export class JavaFileWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly knownFiles = new Set<string>();
  private readonly pendingChanges = new Map<string, WatchedFileChange>();
  private watchedRoots: string[] = [];
  private flushTimer?: NodeJS.Timeout;
  private active = false;
  private lastFlushAt?: string;
  private lastFlushSize = 0;
  private lastError?: string;

  constructor(
    private readonly repoRoot: string,
    private readonly callbacks: WatchCallbacks,
    private readonly enabled = isFileWatchEnabled()
  ) {
  }

  async start(): Promise<void> {
    if (!this.enabled || this.active) {
      return;
    }

    try {
      const roots = await this.buildWatchRoots();
      await this.seedKnownFiles(roots);
      for (const watchRoot of roots) {
        const watcher = watch(watchRoot.root, { recursive: watchRoot.recursive }, (_eventType, filename) => {
          this.handleFsEvent(watchRoot, filename);
        });
        watcher.on("error", error => this.recordError(error));
        this.watchers.push(watcher);
      }
      this.watchedRoots = roots.map(root => root.root);
      this.active = this.watchers.length > 0;
    } catch (error) {
      this.recordError(error);
      this.close();
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const watcher of this.watchers.splice(0)) {
      watcher.close();
    }
    this.pendingChanges.clear();
    this.active = false;
  }

  status(): FileWatcherStatus {
    return {
      enabled: this.enabled,
      active: this.active,
      watchedRoots: this.watchedRoots,
      pendingChanges: this.pendingChanges.size,
      lastFlushAt: this.lastFlushAt,
      lastFlushSize: this.lastFlushSize,
      lastError: this.lastError
    };
  }

  private async buildWatchRoots(): Promise<WatchRoot[]> {
    const sourceRoots = await this.sourceRoots();
    const configFiles = await this.configFiles();
    const configFileSet = new Set(configFiles);
    const configDirs = [...new Set(configFiles.map(file => path.dirname(file)))];

    return [
      ...sourceRoots.map(root => ({
        root,
        recursive: true,
        accepts: (filePath: string) => this.isJavaSource(filePath)
      })),
      ...configDirs.map(root => ({
        root,
        recursive: false,
        accepts: (filePath: string) => configFileSet.has(path.normalize(filePath))
      }))
    ];
  }

  private async sourceRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const topLevel of ["modules", "apps"]) {
      const base = path.join(this.repoRoot, topLevel);
      for (const child of await listDirectories(base)) {
        for (const sourceSet of ["main", "test"]) {
          const sourceRoot = path.join(base, child, "src", sourceSet, "java");
          if (isDirectory(sourceRoot)) {
            roots.push(sourceRoot);
          }
        }
      }
    }
    return roots;
  }

  private async configFiles(): Promise<string[]> {
    const files = [
      path.join(this.repoRoot, "settings.gradle.kts"),
      path.join(this.repoRoot, "build.gradle.kts"),
      path.join(this.repoRoot, "gradle.properties"),
      path.join(this.repoRoot, "gradle", "libs.versions.toml")
    ];

    for (const topLevel of ["modules", "apps"]) {
      const base = path.join(this.repoRoot, topLevel);
      for (const child of await listDirectories(base)) {
        files.push(path.join(base, child, "build.gradle.kts"));
      }
    }

    return files.filter(file => existsSync(file)).map(file => path.normalize(file));
  }

  private async seedKnownFiles(roots: WatchRoot[]): Promise<void> {
    for (const root of roots) {
      if (root.recursive) {
        await this.collectKnownFiles(root.root, root.accepts);
      } else if (root.accepts(root.root) && existsSync(root.root)) {
        this.knownFiles.add(toFileUri(root.root));
      } else {
        const entries = await listFiles(root.root);
        for (const entry of entries) {
          if (root.accepts(entry)) {
            this.knownFiles.add(toFileUri(entry));
          }
        }
      }
    }
  }

  private async collectKnownFiles(dir: string, accepts: (filePath: string) => boolean): Promise<void> {
    for (const entry of await listDirectoryEntries(dir)) {
      if (isIgnoredPath(entry)) {
        continue;
      }
      if (isDirectory(entry)) {
        await this.collectKnownFiles(entry, accepts);
      } else if (accepts(entry)) {
        this.knownFiles.add(toFileUri(entry));
      }
    }
  }

  private handleFsEvent(root: WatchRoot, rawFilename: string | Buffer | null): void {
    if (!rawFilename) {
      return;
    }

    const filename = rawFilename.toString();
    const filePath = path.normalize(path.isAbsolute(filename) ? filename : path.join(root.root, filename));
    if (isIgnoredPath(filePath) || !root.accepts(filePath)) {
      return;
    }

    const uri = toFileUri(filePath);
    const exists = existsSync(filePath);
    const wasKnown = this.knownFiles.has(uri);
    let type: WatchedFileChangeType | undefined;

    if (exists && wasKnown) {
      type = WatchedFileChangeType.Changed;
    } else if (exists && !wasKnown) {
      type = WatchedFileChangeType.Created;
      this.knownFiles.add(uri);
    } else if (!exists && wasKnown) {
      type = WatchedFileChangeType.Deleted;
      this.knownFiles.delete(uri);
    }

    if (!type) {
      return;
    }

    this.pendingChanges.set(uri, { uri, type, filePath });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();
    if (changes.length === 0) {
      return;
    }

    try {
      await this.callbacks.notifyChanges(changes);
      for (const change of changes) {
        await this.callbacks.syncOpenDocument(change);
      }
      this.lastFlushAt = new Date().toISOString();
      this.lastFlushSize = changes.length;
    } catch (error) {
      this.recordError(error);
    }
  }

  private isJavaSource(filePath: string): boolean {
    return filePath.endsWith(".java") && !isIgnoredPath(filePath);
  }

  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    console.error(`[codex-java-lsp] file watcher disabled or degraded: ${message}`);
  }
}

export function isFileWatchEnabled(): boolean {
  return process.env.JDTLS_FILEWATCH?.toLowerCase() !== "off";
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !IGNORED_SEGMENTS.has(name));
  } catch {
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile())
      .map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function listDirectoryEntries(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function isIgnoredPath(filePath: string): boolean {
  return path.normalize(filePath).split(path.sep).some(segment => IGNORED_SEGMENTS.has(segment));
}
