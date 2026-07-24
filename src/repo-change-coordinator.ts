// input: Filesystem events under a repo's source/resource/build roots.
// output: Debounced, merged RepoChangeBatch objects that advance the generation
//         clock — independent of whether JDT LS is running.
// pos: The repo's freshness engine. Owns one chokidar watcher per worktree; the
//      JDT session is only a listener, never the source of invalidation.
import { watch, type FSWatcher } from "chokidar";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LayoutContext } from "./layout-probe.js";
import { isWithin } from "./path-utils.js";
import {
  GenerationClock,
  mergeChangeKind,
  type RepoChange,
  type RepoChangeBatch,
  type RepoChangeKind
} from "./repo-generation.js";
import type { WorktreeIdentity } from "./worktree-identity.js";

const BUILD_MARKER_NAMES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  ".java-version",
  ".sdkmanrc"
]);

const BUILD_MARKER_RELATIVE = [
  ".mvn/jvm.config",
  "gradle/libs.versions.toml"
];

// Conventional annotation-processing output roots. Only these, when they exist,
// bypass the ignore of build output directories.
const GENERATED_ROOT_CANDIDATES = [
  "target/generated-sources/annotations",
  "target/generated-test-sources/test-annotations",
  "build/generated/sources/annotationProcessor"
];

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".gradle",
  "build",
  "target",
  "out",
  "bin",
  "node_modules",
  "dist"
]);

const RESOURCE_EXTENSIONS = new Set([".xml", ".sql", ".yml", ".yaml", ".properties"]);

export type RepoWatchPlan = {
  sourceRoots: string[];
  resourceRoots: string[];
  generatedRoots: string[];
  buildFiles: string[];
  targets: string[];
};

export function buildRepoWatchPlan(repoRoot: string, layout: LayoutContext): RepoWatchPlan {
  const sourceRoots = layout.sourceRoots
    .map(root => path.resolve(repoRoot, root.relativePath))
    .filter(existsSync);
  const resourceRoots = layout.resourceRoots
    .map(root => path.resolve(repoRoot, root))
    .filter(existsSync);
  const generatedRoots: string[] = [];
  for (const relative of GENERATED_ROOT_CANDIDATES) {
    const absolute = path.resolve(repoRoot, relative);
    if (existsSync(absolute)) generatedRoots.push(absolute);
    for (const source of layout.sourceRoots) {
      const moduleBase = path.resolve(repoRoot, source.relativePath, "..", "..", "..");
      const moduleGenerated = path.resolve(moduleBase, relative);
      if (existsSync(moduleGenerated)) generatedRoots.push(moduleGenerated);
    }
  }
  const buildFiles = buildMarkerPaths(repoRoot, layout);
  const targets = unique([
    ...sourceRoots,
    ...resourceRoots,
    ...generatedRoots,
    ...buildFiles
  ]);
  return { sourceRoots, resourceRoots, generatedRoots: unique(generatedRoots), buildFiles, targets };
}

function buildMarkerPaths(repoRoot: string, layout: LayoutContext): string[] {
  const roots = new Set<string>([repoRoot]);
  // Watch build markers at the root and each detected module base.
  for (const source of layout.sourceRoots) {
    roots.add(path.resolve(repoRoot, source.relativePath, "..", "..", ".."));
  }
  const markers: string[] = [];
  for (const root of roots) {
    for (const name of BUILD_MARKER_NAMES) {
      markers.push(path.join(root, name));
    }
    for (const relative of BUILD_MARKER_RELATIVE) {
      markers.push(path.join(root, relative));
    }
  }
  return unique(markers);
}

/**
 * The single ignore contract. Linked-worktree `.git` metadata, the Git
 * common-dir, the MCP cache base and build-output segments never advance the
 * Java generation; an explicitly allowlisted generated root does.
 */
export function isIgnoredRepoPath(
  candidate: string,
  identity: WorktreeIdentity,
  cacheBase: string,
  explicitGeneratedRoots: readonly string[]
): boolean {
  const absolute = path.resolve(candidate);
  if (absolute === path.join(identity.repoRoot, ".git")) return true;
  if (identity.gitCommonDir && isWithin(identity.gitCommonDir, absolute)) return true;
  if (isWithin(cacheBase, absolute)) return true;
  if (explicitGeneratedRoots.some(root => isWithin(root, absolute) || isWithin(absolute, root))) {
    return false;
  }
  return path.normalize(absolute).split(path.sep).some(segment => IGNORED_SEGMENTS.has(segment));
}

export type RepoChangeListener = (batch: RepoChangeBatch) => Promise<void> | void;

export type RepoChangeCoordinatorStatus = {
  ready: boolean;
  watching: number;
  pending: number;
  lastError?: string;
  degraded: boolean;
};

export class RepoChangeCoordinator {
  private watcher?: FSWatcher;
  private plan?: RepoWatchPlan;
  private readonly pending = new Map<string, RepoChangeKind>();
  private readonly listeners = new Set<RepoChangeListener>();
  private flushTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closed = false;
  private ready = false;
  private degraded = false;
  private lastError?: string;

  constructor(
    private readonly repoRoot: string,
    private readonly identity: WorktreeIdentity,
    private readonly cacheBase: string,
    private readonly clock: GenerationClock,
    private readonly layout: () => LayoutContext,
    private readonly debounceMs = 150
  ) {}

  onBatch(listener: RepoChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      if (this.closed) {
        resolve();
        return;
      }
      const plan = this.ensurePlan();
      const watcher = watch(plan.targets, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        atomic: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        ignored: candidate => isIgnoredRepoPath(candidate, this.identity, this.cacheBase, plan.generatedRoots)
      });
      this.watcher = watcher;
      watcher
        .on("add", file => this.queueClassified(file, "add"))
        .on("change", file => this.queueClassified(file, "change"))
        .on("unlink", file => this.queueClassified(file, "unlink"))
        .on("error", error => this.degrade(error));
      watcher.once("ready", () => {
        this.ready = true;
        resolve();
      });
      watcher.once("error", error => {
        if (!this.ready) reject(error instanceof Error ? error : new Error(String(error)));
      });
    }).catch(error => {
      // A watcher that never becomes ready is a degraded, not fatal, condition:
      // requests can still proceed uncached.
      this.degrade(error);
    });
    return this.startPromise;
  }

  private queueClassified(file: string, event: "add" | "change" | "unlink"): void {
    const change = this.classify(file, event);
    if (change) this.queue(change);
  }

  private ensurePlan(): RepoWatchPlan {
    if (!this.plan) {
      this.plan = buildRepoWatchPlan(this.repoRoot, this.layout());
    }
    return this.plan;
  }

  private classify(file: string, event: "add" | "change" | "unlink"): RepoChange | undefined {
    const absolute = path.resolve(file);
    const plan = this.ensurePlan();
    if (isIgnoredRepoPath(absolute, this.identity, this.cacheBase, plan.generatedRoots)) {
      return undefined;
    }
    if (plan.buildFiles.includes(absolute)) {
      return { kind: "BUILD_CHANGE", absolutePath: absolute };
    }
    const underSource = [...plan.sourceRoots, ...plan.generatedRoots].some(root => isWithin(root, absolute));
    if (absolute.endsWith(".java") && underSource) {
      return { kind: javaKind(event), absolutePath: absolute };
    }
    const underResource = plan.resourceRoots.some(root => isWithin(root, absolute));
    if (underResource && RESOURCE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      return { kind: "RESOURCE_CHANGE", absolutePath: absolute };
    }
    return undefined;
  }

  private queue(change: RepoChange): void {
    const previous = this.pending.get(change.absolutePath);
    const merged = previous ? mergeChangeKind(previous, change.kind) : change.kind;
    if (merged === undefined) {
      this.pending.delete(change.absolutePath);
    } else {
      this.pending.set(change.absolutePath, merged);
    }
    this.scheduleFlush();
  }

  /** Test seam: enqueue an already-classified change without a real FS event. */
  queueForTest(change: RepoChange): void {
    this.queue(change);
  }

  /** Test seam: enqueue by raw FS path + event, exercising classification/ignore. */
  queueFsPathForTest(file: string, event: "add" | "change" | "unlink"): void {
    this.queueClassified(file, event);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  /**
   * Waits up to `ms` for the initial scan to finish. A large-repo scan or a
   * watcher failure must not block the whole request, so the caller proceeds
   * DEGRADED when this returns false.
   */
  async awaitReadyWithin(ms: number): Promise<boolean> {
    if (this.ready) return true;
    if (!this.startPromise) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, Math.max(1, ms));
      timer.unref?.();
    });
    try {
      await Promise.race([this.startPromise.catch(() => undefined), timeout]);
      return this.ready;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const operation = (async () => {
      while (this.pending.size > 0) {
        const changes = [...this.pending]
          .map(([absolutePath, kind]) => ({ absolutePath, kind }))
          .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
        this.pending.clear();
        const generation = this.clock.advance(summarizeChanges(changes));
        const batch: RepoChangeBatch = {
          generation,
          observedAt: new Date().toISOString(),
          changes
        };
        for (const listener of this.listeners) {
          try {
            await listener(batch);
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.clock.markDirty(`change listener failed at generation ${generation}`);
          }
        }
      }
    })().finally(() => {
      if (this.flushPromise === operation) this.flushPromise = undefined;
    });
    this.flushPromise = operation;
    return operation;
  }

  private degrade(error: unknown): void {
    this.degraded = true;
    this.lastError = error instanceof Error ? error.message : String(error);
    const generation = this.clock.markDirty("watcher degraded");
    const batch: RepoChangeBatch = {
      generation,
      observedAt: new Date().toISOString(),
      changes: [{ kind: "WATCHER_DEGRADED", absolutePath: this.repoRoot }]
    };
    for (const listener of this.listeners) {
      try {
        void listener(batch);
      } catch {
        // Degrade is best-effort notification; listener errors do not re-degrade.
      }
    }
    void this.watcher?.close();
    this.watcher = undefined;
  }

  status(): RepoChangeCoordinatorStatus {
    return {
      ready: this.ready,
      watching: this.plan?.targets.length ?? 0,
      pending: this.pending.size,
      lastError: this.lastError,
      degraded: this.degraded
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher) await watcher.close();
    // A close during startup must still settle the start promise.
    if (this.startPromise) await this.startPromise.catch(() => undefined);
  }
}

function javaKind(event: "add" | "change" | "unlink"): RepoChangeKind {
  if (event === "add") return "JAVA_ADD";
  if (event === "unlink") return "JAVA_DELETE";
  return "JAVA_CHANGE";
}

function summarizeChanges(changes: readonly RepoChange[]): string {
  const counts = new Map<RepoChangeKind, number>();
  for (const change of changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => `${kind}:${count}`).join(",");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
