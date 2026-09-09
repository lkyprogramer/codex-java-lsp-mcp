// input: watch targets from buildRepoWatchPlan (source/resource/generated/build files).
// output: add/change/unlink events with one OS watch handle per target on macOS.
// pos: FSX1. chokidar 5 dropped fsevents and calls fs.watch per directory; lishuedu
// source trees alone are ~19k dirs and fork() then fails with spawn EBADF.
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { existsSync, statSync, watch as fsWatch, type FSWatcher as NodeFSWatcher } from "node:fs";
import path from "node:path";

export type RepoWatchBackend = "fs-watch-recursive" | "chokidar";

export function repoWatchBackend(platform: NodeJS.Platform = process.platform): RepoWatchBackend {
  return platform === "darwin" ? "fs-watch-recursive" : "chokidar";
}

export type RepoFsWatcher = {
  on(event: "add" | "change" | "unlink", listener: (file: string) => void): RepoFsWatcher;
  on(event: "error", listener: (error: Error) => void): RepoFsWatcher;
  on(event: "ready", listener: () => void): RepoFsWatcher;
  once(event: "ready", listener: () => void): RepoFsWatcher;
  once(event: "error", listener: (error: Error) => void): RepoFsWatcher;
  add(paths: string | string[]): void;
  unwatch(paths: string | string[]): void;
  close(): Promise<void>;
  /** Test/diagnostics: native backend handle count. Chokidar reports 0. */
  handleCount(): number;
};

export function watchRepoTargets(
  targets: readonly string[],
  options: {
    ignored?: (candidate: string) => boolean;
    persistent?: boolean;
  } = {}
): RepoFsWatcher {
  if (repoWatchBackend() === "fs-watch-recursive") {
    return new RecursiveNativeWatcher(targets, options);
  }
  const watcher = chokidarWatch([...targets], {
    ignoreInitial: true,
    persistent: options.persistent ?? true,
    followSymlinks: false,
    atomic: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    ignored: options.ignored
  });
  return wrapChokidar(watcher);
}

function wrapChokidar(watcher: ChokidarWatcher): RepoFsWatcher {
  const bind = watcher as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    add(paths: string | string[]): void;
    unwatch(paths: string | string[]): void;
    close(): Promise<void>;
  };
  const wrapped: RepoFsWatcher = {
    on(event: string, listener: (...args: unknown[]) => void) {
      bind.on(event, listener);
      return wrapped;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      bind.once(event, listener);
      return wrapped;
    },
    add(paths) {
      bind.add(paths);
    },
    unwatch(paths) {
      bind.unwatch(paths);
    },
    async close() {
      await bind.close();
    },
    handleCount() {
      return 0;
    }
  } as RepoFsWatcher;
  return wrapped;
}

type WatchListeners = {
  add: Array<(file: string) => void>;
  change: Array<(file: string) => void>;
  unlink: Array<(file: string) => void>;
  error: Array<(error: Error) => void>;
  ready: Array<() => void>;
};

/**
 * One fs.watch handle per target. Directories use {recursive:true} (FSEvents on
 * Darwin, a single kqueue/fd). Files use a non-recursive handle. Missing paths
 * are skipped until add() when they exist (build markers are often prospective).
 */
export class RecursiveNativeWatcher implements RepoFsWatcher {
  private readonly handles = new Map<string, NodeFSWatcher>();
  private readonly listeners: WatchListeners = {
    add: [],
    change: [],
    unlink: [],
    error: [],
    ready: []
  };
  private closed = false;
  private ready = false;

  constructor(
    targets: readonly string[],
    private readonly options: { ignored?: (candidate: string) => boolean; persistent?: boolean }
  ) {
    for (const target of targets) this.watchTarget(target);
    queueMicrotask(() => {
      if (this.closed || this.ready) return;
      this.ready = true;
      for (const listener of this.listeners.ready) listener();
    });
  }

  handleCount(): number {
    return this.handles.size;
  }

  on(event: "add" | "change" | "unlink" | "error" | "ready", listener: (...args: never[]) => void): RepoFsWatcher {
    this.push(event, listener);
    if (event === "ready" && this.ready) (listener as () => void)();
    return this;
  }

  once(event: "ready" | "error", listener: (...args: never[]) => void): RepoFsWatcher {
    const wrapped = (...args: never[]) => {
      this.remove(event, wrapped);
      listener(...args);
    };
    this.push(event, wrapped);
    if (event === "ready" && this.ready) (wrapped as () => void)();
    return this;
  }

  add(paths: string | string[]): void {
    for (const target of Array.isArray(paths) ? paths : [paths]) this.watchTarget(target);
  }

  unwatch(paths: string | string[]): void {
    for (const target of Array.isArray(paths) ? paths : [paths]) {
      const handle = this.handles.get(target);
      if (!handle) continue;
      handle.close();
      this.handles.delete(target);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }

  private push(event: keyof WatchListeners, listener: (...args: never[]) => void): void {
    this.listeners[event].push(listener as never);
  }

  private remove(event: keyof WatchListeners, listener: (...args: never[]) => void): void {
    const bucket = this.listeners[event] as Array<(...args: never[]) => void>;
    const index = bucket.indexOf(listener);
    if (index >= 0) bucket.splice(index, 1);
  }

  private watchTarget(target: string): void {
    if (this.closed || this.handles.has(target) || !existsSync(target)) return;
    let directory = false;
    try {
      directory = statSync(target).isDirectory();
    } catch {
      return;
    }
    try {
      const handle = fsWatch(target, {
        persistent: this.options.persistent ?? true,
        recursive: directory
      }, (eventType, filename) => this.onNativeEvent(target, directory, eventType, filename));
      handle.on("error", (error: Error) => this.emitError(error));
      this.handles.set(target, handle);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onNativeEvent(
    target: string,
    directory: boolean,
    eventType: string,
    filename: string | Buffer | null
  ): void {
    if (this.closed) return;
    const name = typeof filename === "string" ? filename : filename ? filename.toString() : "";
    const absolute = directory && name ? path.resolve(target, name) : path.resolve(target);
    if (this.options.ignored?.(absolute)) return;
    let exists = false;
    try {
      exists = existsSync(absolute);
    } catch {
      exists = false;
    }
    if (!exists) {
      this.emitPath("unlink", absolute);
      return;
    }
    if (eventType === "rename") this.emitPath("add", absolute);
    else this.emitPath("change", absolute);
  }

  private emitPath(event: "add" | "change" | "unlink", file: string): void {
    for (const listener of this.listeners[event]) listener(file);
  }

  private emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error);
  }
}
