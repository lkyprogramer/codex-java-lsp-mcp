// input: Filesystem events under a repo's source/resource/build roots.
// output: Debounced, merged RepoChangeBatch objects that advance the generation
//         clock — independent of whether JDT LS is running.
// pos: The repo's freshness engine. Owns one chokidar watcher per worktree; the
//      JDT session is only a listener, never the source of invalidation.
import { watch, type FSWatcher } from "chokidar";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LayoutContext } from "./layout-probe.js";
import type { LayoutSource } from "./layout-manager.js";
import { isWithin } from "./path-utils.js";
import {
  GenerationClock,
  isStormBatch,
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

/** A pathological module count must never make a storm's diagnostic root list unbounded. */
const AFFECTED_ROOTS_LIMIT = 20;

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
  /** Diagnostics only: never the raw changed-path list, which can run into the hundreds. */
  lastStorm?: { observedAt: string; changeCount: number; affectedRoots: string[] };
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
  private lastStorm?: RepoChangeCoordinatorStatus["lastStorm"];

  constructor(
    private readonly repoRoot: string,
    private readonly identity: WorktreeIdentity,
    private readonly cacheBase: string,
    private readonly clock: GenerationClock,
    private readonly layoutSource: LayoutSource,
    private readonly debounceMs = 150,
    /** How many Java files are currently indexed, for the storm-size ratio check. */
    private readonly indexedFileCount: () => number = () => 0
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
        // Reads `this.plan` dynamically (not the `plan` captured above) so a
        // build-change reconfigure keeps the generated-root allowlist current.
        ignored: candidate => isIgnoredRepoPath(candidate, this.identity, this.cacheBase, this.plan?.generatedRoots ?? [])
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
      this.plan = buildRepoWatchPlan(this.repoRoot, this.layoutSource.current());
    }
    return this.plan;
  }

  /**
   * Diagnostic summary of a storm batch: which watched roots it touched, as
   * repo-relative paths, capped so a huge module count can never make this
   * grow unbounded. Never the raw per-file change list.
   */
  private affectedRoots(changes: readonly RepoChange[]): string[] {
    const plan = this.ensurePlan();
    const roots = [...plan.sourceRoots, ...plan.resourceRoots, ...plan.generatedRoots];
    const affected = new Set<string>();
    for (const change of changes) {
      const root = roots.find(candidate => isWithin(candidate, change.absolutePath));
      if (root) affected.add(path.relative(this.repoRoot, root) || ".");
      if (affected.size >= AFFECTED_ROOTS_LIMIT) break;
    }
    return [...affected];
  }

  /**
   * Called once per flush round when the round's changes include a
   * BUILD_CHANGE. A layout-affecting build edit (new/removed module) is rare
   * enough that a full LayoutManager.refresh() fingerprint check per such
   * round is cheap; an edit that leaves layout unchanged is a no-op here.
   */
  private reconfigureIfLayoutChanged(): void {
    const result = this.layoutSource.refresh();
    if (!result.changed) return;
    const nextPlan = buildRepoWatchPlan(this.repoRoot, result.layout);
    const oldTargets = new Set(this.plan?.targets ?? []);
    const newTargets = new Set(nextPlan.targets);
    const toRemove = [...oldTargets].filter(target => !newTargets.has(target));
    const toAdd = [...newTargets].filter(target => !oldTargets.has(target));
    // Update the plan before touching the watcher: the `ignored` predicate
    // above reads `this.plan` live, and chokidar only honors `.add()` for a
    // target the predicate already allows at add-time.
    this.plan = nextPlan;
    if (this.watcher) {
      if (toRemove.length > 0) this.watcher.unwatch(toRemove);
      if (toAdd.length > 0) this.watcher.add(toAdd);
    }
    // A layout change can silently orphan cached facts under a root that no
    // longer exists or was never watched before; no unlink event will ever
    // announce that. Force the next request through a full reconcile.
    this.clock.markDirty("repo layout changed");
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
        if (changes.some(change => change.kind === "BUILD_CHANGE")) {
          this.reconfigureIfLayoutChanged();
        }
        const storm = isStormBatch(changes.length, this.indexedFileCount());
        const observedAt = new Date().toISOString();
        const affectedRoots = storm ? this.affectedRoots(changes) : [];
        // A storm still advances generation exactly once, but is handled the
        // same way a degraded watcher is: the batch is delivered so listeners
        // can do coarse (not per-path) invalidation, and the run is marked
        // dirty so the existing reconcile-on-next-request path (Task 11)
        // catches anything a coarse pass under-invalidated. Known limit: this
        // reports freshnessMode WATCHER_DEGRADED for a storm even though the
        // watcher itself is healthy — see the Iteration B phase report.
        const generation = storm
          ? this.clock.markDirty(`change storm: ${changes.length} files`)
          : this.clock.advance(summarizeChanges(changes));
        if (storm) {
          this.lastStorm = { observedAt, changeCount: changes.length, affectedRoots };
        }
        const batch: RepoChangeBatch = {
          generation,
          observedAt,
          changes,
          storm,
          affectedRoots
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
      changes: [{ kind: "WATCHER_DEGRADED", absolutePath: this.repoRoot }],
      storm: false,
      affectedRoots: []
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
      degraded: this.degraded,
      lastStorm: this.lastStorm
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
