// input: one canonical workspace root and the raw signals of its native FSEvents stream.
// output: dispatch rounds frozen at a fenced local seq, content-verified views, and FRESH/STALE/INVALID_ROOT.
// pos: MAC-03B (contract §2.4). The confirmation watermark is (workspaceGeneration, trackerEpoch, seq).
//      Native cursors (eventId) never leave this process: nothing here is persisted, and a new stream
//      is a new epoch whose first round hashes every file. This is the only change source (MAC-08B
//      removed the fs.watch tracker).
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { BUILD_MARKER_RELATIVE_PATHS, computeInputFingerprints } from "../build-fingerprint.js";
import { IGNORED_DIRECTORY_NAMES, javaSourceRoot, resourceMemberRoot } from "../manifest.js";
import { hashSourceWithin } from "../source-capture.js";
import { probeLayoutOffThread, type LayoutContext } from "../../layout-probe.js";
import { MacFSEvents } from "../../mac-platform/fsevents.js";
import { contentManifestIdOf, currentBuildKey, type ContentEntry } from "../sql/snapshot-manifest.js";
import type { RootIdentity, WorkspaceBinding } from "./binding.js";
import type { BindPlan, TrackedWorkspace } from "./snapshot-store.js";

/** FSEventStreamEventFlags the tracker acts on (CoreServices FSEvents.h). */
export const FSEVENT_FLAGS = {
  MustScanSubDirs: 0x1, UserDropped: 0x2, KernelDropped: 0x4, EventIdsWrapped: 0x8, HistoryDone: 0x10, RootChanged: 0x20,
  Mount: 0x40, Unmount: 0x80, ItemIsFile: 0x10000, ItemIsDir: 0x20000, ItemIsSymlink: 0x40000
} as const;

/** A full content hash of every active workspace at least this often (§2.4). */
export const FULL_HASH_INTERVAL_MS = 10 * 60 * 1000;

/** One event stream: its random epoch, a fence over the flushed prefix, and stop. */
export type TrackerSource = { readonly epoch: string; fence(timeoutMs: number): Promise<void>; stop(timeoutMs: number): Promise<void>; readonly closed: Promise<void> };
/** `onResume`: the native helper saw the system wake; content may have changed without events. */
export type TrackerSourceFactory = (onSignal: (flags: number, path: string) => void, onResume: () => void) => Promise<TrackerSource>;

/** The production source: the native helper's raw flags, paths and wake signals, its epoch as trackerEpoch. */
export function nativeTrackerSource(canonicalRoot: string): TrackerSourceFactory {
  return async (onSignal, onResume) => {
    const events = await MacFSEvents.start(canonicalRoot, event => onSignal(event.flags, event.path), () => onResume());
    const ready = await events.ready;
    return { epoch: ready.epoch, fence: async timeoutMs => { await events.fence(timeoutMs); }, stop: timeoutMs => events.stop(timeoutMs), closed: events.closed };
  };
}

export async function rootIdentityOf(canonicalRoot: string): Promise<RootIdentity> {
  if (!path.isAbsolute(canonicalRoot) || await realpath(canonicalRoot) !== canonicalRoot) throw new TrackerRootInvalid(`${canonicalRoot} is not canonical`);
  const info = await stat(canonicalRoot, { bigint: true });
  if (!info.isDirectory()) throw new TrackerRootInvalid(`${canonicalRoot} is not a directory`);
  if (info.dev > BigInt(Number.MAX_SAFE_INTEGER) || info.ino > BigInt(Number.MAX_SAFE_INTEGER)) throw new TrackerRootInvalid("root identity exceeds 2^53");
  return { canonicalRoot, dev: Number(info.dev), ino: Number(info.ino), volume: String(info.dev) };
}

/** The workspace identity (§2.9): a root replaced at the same path is another workspace. */
export function workspaceIdFor(root: RootIdentity): string {
  return `w-${createHash("sha256").update(`${root.canonicalRoot}\0${root.volume}\0${root.dev}\0${root.ino}`).digest("hex").slice(0, 40)}`;
}

/**
 * The verification's capture against `base`: changed/deleted members and whether it is a verified noop.
 * Without a base every captured member is changed. The capture itself (entries, manifest id) is kept,
 * so the same round can be judged against a sibling workspace's snapshot (seed) instead of its own.
 */
export function rebase(verification: TrackerVerification, base?: { entries: ReadonlyMap<string, ContentEntry>; buildKey: string }): TrackerVerification {
  const { entries } = verification;
  const changed: string[] = [];
  const deleted: string[] = [];
  if (base) {
    for (const entry of entries.values()) if (base.entries.get(entry.path)?.hash !== entry.hash || base.entries.get(entry.path)?.kind !== entry.kind) changed.push(entry.path);
    for (const name of base.entries.keys()) if (!entries.has(name)) deleted.push(name);
  } else changed.push(...entries.keys());
  changed.sort();
  deleted.sort();
  return { ...verification, changed, deleted, noop: Boolean(base) && !changed.length && !deleted.length && base!.buildKey === verification.round.buildKey };
}

export class TrackerRootInvalid extends Error {
  constructor(message: string, readonly replacement?: RootIdentity) { super(`INVALID_ROOT: ${message}`); }
}

export type TrackerStatus = "STALE" | "FRESH" | "INVALID_ROOT";
export type RoundMode = "full-hash" | "full-stat" | "paths";

/** What a dispatch froze: everything a result may later clear is bounded by `cut`. */
export type TrackerRound = {
  readonly epoch: string;
  readonly cut: number;
  readonly workspaceGeneration: number;
  readonly root: RootIdentity;
  readonly layout: LayoutContext;
  readonly buildKey: string;
  /** The buildKey's inputs without build file bytes (build-fingerprint.ts): what a build-file-only change keeps. */
  readonly layoutFingerprint: string;
  readonly bindingVersion: number;
  readonly captureId: string;
  readonly mode: RoundMode;
  /** Clock at dispatch: a confirmed full-hash round restarts the 10-minute interval from here. */
  readonly dispatchedAt: number;
  readonly pending: ReadonlyMap<string, number>;
  readonly subtrees: ReadonlyMap<string, number>;
  /** The tracker's workMark at the cut: work owed later is not this round's. */
  readonly workMark: number;
};

export type TrackerVerification = {
  readonly round: TrackerRound;
  readonly contentManifestId: string;
  readonly entries: ReadonlyMap<string, ContentEntry>;
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
  /** The verified content equals the base and the buildKey matches: a verified-noop may confirm it. */
  readonly noop: boolean;
  readonly hashed: number;
  readonly statted: number;
};

type StatKey = string;
type Cached = { key: StatKey; hash: string };

export type WorkspaceTrackerOptions = {
  canonicalRoot: string;
  /** The generation to continue from (a restored binding's), default 1; a function is asked with this root's workspaceId. */
  workspaceGeneration?: number | ((workspaceId: string) => number | undefined);
  source: TrackerSourceFactory;
  now?: () => number;
  /** RootChanged found the root gone or replaced: refresh SnapshotStore.track() from trackedState() now. */
  onInvalidRoot?: (error: TrackerRootInvalid) => void;
  /** Test seam: awaited after each file of a verification is read. */
  afterRead?: (relativePath: string) => void | Promise<void>;
  /** Test seam: the periodic full-hash interval (default FULL_HASH_INTERVAL_MS). */
  fullHashIntervalMs?: number;
};

export class WorkspaceTracker {
  readonly workspaceId: string;
  private source!: TrackerSource;
  private epoch = "";
  private seq = 0;
  private generation: number;
  private readonly pending = new Map<string, number>();
  private readonly subtrees = new Map<string, number>();
  /** Highest seq that requires every file hashed (startup, restart, drop, root, resume, unbounded). */
  private fullHashThrough = 0;
  /** Highest seq that requires a full stat walk (layout or source-root change). */
  private fullStatThrough = 0;
  /** Build files changed: the next dispatch recomputes the fingerprint. */
  private envThrough = 0;
  private layout?: LayoutContext;
  private layoutKey = "";
  private fingerprint = "";
  private readonly cache = new Map<string, Cached>();
  /** The last verified content view of this epoch; partial rounds start from it. */
  private view?: Map<string, ContentEntry>;
  private lastFullHashAt = -Infinity;
  private inFlight?: TrackerRound;
  private verified?: TrackerRound;
  private confirmed?: { seq: number; bindingVersion: number };
  private invalid?: TrackerRootInvalid;
  private streamLost?: Error;
  private readonly now: () => number;
  private readonly fullHashIntervalMs: number;
  private readonly signalled = { ignored: 0, wrapped: 0 };
  /** Counts every time work became owed (a signal that owes something, resume, due full hash, new epoch); never reset. */
  private work = 0;
  /** The fence in flight, and the one queued behind it for callers that arrived after it was sent. */
  private flushing?: Promise<void>;
  private nextFlush?: Promise<void>;

  private constructor(readonly root: RootIdentity, private readonly options: WorkspaceTrackerOptions) {
    this.workspaceId = workspaceIdFor(root);
    const restored = typeof options.workspaceGeneration === "function" ? options.workspaceGeneration(this.workspaceId) : options.workspaceGeneration;
    this.generation = restored ?? 1;
    this.now = options.now ?? Date.now;
    this.fullHashIntervalMs = options.fullHashIntervalMs ?? FULL_HASH_INTERVAL_MS;
  }

  /** The watcher starts first; the startup full hash is then owed at seq 1 (§2.4). */
  static async start(options: WorkspaceTrackerOptions): Promise<WorkspaceTracker> {
    const tracker = new WorkspaceTracker(await rootIdentityOf(options.canonicalRoot), options);
    await tracker.openStream();
    return tracker;
  }

  private async openStream(): Promise<void> {
    const source = await this.options.source((flags, file) => this.onNativeSignal(flags, file), () => { this.resume(); });
    this.source = source;
    this.epoch = source.epoch;
    this.seq = 0;
    this.pending.clear();
    this.subtrees.clear();
    this.fullStatThrough = this.envThrough = 0;
    this.view = undefined;
    this.inFlight = undefined;
    this.verified = undefined;
    this.confirmed = undefined;
    this.streamLost = undefined;
    // A new epoch never trusts the stat cache: every file is hashed again.
    this.fullHashThrough = this.bump();
    this.work += 1;
    void source.closed.catch(error => { if (this.source === source) this.streamLost = error instanceof Error ? error : new Error(String(error)); });
  }

  /** The stream failed or must be rebuilt: a new epoch, all earlier rounds rejected, full hash owed. */
  async restartStream(timeoutMs = 5000): Promise<void> {
    await this.source.stop(timeoutMs).catch(() => undefined);
    await this.openStream();
  }

  async stop(timeoutMs = 5000): Promise<void> {
    await this.source.stop(timeoutMs);
  }

  /** The tracker's truth for SnapshotStore.track(): plans with another root, generation or epoch are refused. */
  trackedState(): TrackedWorkspace {
    // INVALID_ROOT: the replacement (or a root that matches nothing) under a new generation refuses every plan.
    const root = this.invalid ? this.invalid.replacement ?? { canonicalRoot: this.root.canonicalRoot, dev: 0, ino: 0, volume: "gone" } : { ...this.root };
    return { root, workspaceGeneration: this.generation, trackerEpoch: this.epoch };
  }

  get trackerEpoch(): string { return this.epoch; }
  get currentSeq(): number { return this.seq; }
  /**
   * Grows whenever new work becomes owed, across stream restarts (unlike seqs). A signal that owes
   * nothing (a write under target/, an ignored file) leaves it alone, so a caller backing off a
   * failing round can tell the two apart.
   */
  get workMark(): number { return this.work; }

  /**
   * Deliver every signal the native stream still holds (FSEvents coalesces for its latency window)
   * before the caller reads status(). Concurrent callers share one fence; a caller arriving while one
   * is in flight waits for the next, so the fence always starts after its own entry.
   */
  flush(timeoutMs = FLUSH_FENCE_TIMEOUT_MS): Promise<void> {
    if (!this.flushing) {
      const flushed: Promise<void> = this.source.fence(timeoutMs).finally(() => { if (this.flushing === flushed) this.flushing = undefined; });
      this.flushing = flushed;
      return flushed;
    }
    return this.nextFlush ??= this.flushing.catch(() => undefined).then(() => {
      this.nextFlush = undefined;
      return this.flush(timeoutMs);
    });
  }

  status(): TrackerStatus {
    if (this.invalid) return "INVALID_ROOT";
    if (!this.confirmed || this.streamLost || this.pending.size || this.subtrees.size || this.fullHashThrough || this.fullStatThrough || this.envThrough) return "STALE";
    return "FRESH";
  }

  /** A committed round covers every signal up to `seq` of `epoch`; a later epoch's confirmed startup hash covers all of an earlier one. */
  confirmedThrough(epoch: string, seq: number): boolean {
    if (!this.confirmed || this.streamLost) return false;
    return this.epoch !== epoch || this.confirmed.seq >= seq;
  }

  /** Something is owed: pending paths, a rescan, unconfirmed startup, or the periodic full hash. */
  hasWork(): boolean {
    return !this.invalid && (this.status() !== "FRESH" || this.now() - this.lastFullHashAt >= this.fullHashIntervalMs);
  }

  /** When the periodic full hash falls due (§2.4: every active workspace at least every 10 minutes). */
  fullHashDueAt(): number {
    return this.lastFullHashAt + this.fullHashIntervalMs;
  }

  /** The periodic full hash is due: it is owed like a resume, so the workspace is STALE until a full-hash round confirms. */
  requireDueFullHash(): boolean {
    if (this.invalid || this.fullHashThrough || this.now() < this.fullHashDueAt()) return false;
    this.fullHashThrough = this.bump();
    this.work += 1;
    return true;
  }

  diagnostics() {
    return { epoch: this.epoch, seq: this.seq, pending: this.pending.size, subtrees: [...this.subtrees.keys()], fullHashThrough: this.fullHashThrough,
      fullStatThrough: this.fullStatThrough, envThrough: this.envThrough, confirmed: this.confirmed, ...this.signalled };
  }

  /** A resume-from-sleep hint: content may have changed without events (§2.4). */
  resume(): number {
    this.work += 1;
    return this.fullHashThrough = this.bump();
  }

  private bump(): number {
    this.seq += 1;
    return this.seq;
  }

  // ------------------------------------------------------------ signals

  /** Every signal, with or without a path, takes the next local seq. eventId is never consulted. */
  onNativeSignal(flags: number, file: string): number {
    const seq = this.signal(flags, file);
    const relative = this.relativeOf(file);
    // Only this signal's own path can carry its seq: no scan over every pending path.
    if (this.fullHashThrough === seq || this.fullStatThrough === seq || this.envThrough === seq
      || (relative !== undefined && (this.pending.get(relative) === seq || this.subtrees.get(relative) === seq))) this.work += 1;
    return seq;
  }

  private signal(flags: number, file: string): number {
    const seq = this.bump();
    const F = FSEVENT_FLAGS;
    if (flags & (F.UserDropped | F.KernelDropped | F.RootChanged | F.Mount | F.Unmount)) this.fullHashThrough = seq;
    if (flags & F.EventIdsWrapped) this.signalled.wrapped += 1; // A discontinuity is not a drop.
    // Checked at once, so a round already in flight cannot commit against a replaced root.
    if (flags & F.RootChanged) this.recheckRootSync();
    const relative = this.relativeOf(file);
    if (relative === undefined) {
      // No path inside the root: the scope cannot be bounded.
      if (!(flags & (F.HistoryDone | F.EventIdsWrapped))) this.fullHashThrough = seq;
      return seq;
    }
    if (flags & F.MustScanSubDirs) {
      if (relative === "") this.fullHashThrough = seq; else this.subtrees.set(relative, seq);
    }
    if (relative === "") return seq;
    const layout = this.layout;
    if (!layout) { this.fullHashThrough = seq; return seq; }
    if (memberKind(relative, layout)) this.pending.set(relative, seq);
    else if (isBuildMarker(relative)) this.envThrough = seq;
    if (flags & F.ItemIsDir || !(flags & (F.ItemIsFile | F.ItemIsSymlink))) {
      if (underContentRoot(relative, layout)) this.subtrees.set(relative, seq);
      else if (!relative.split("/").some(part => IGNORED_DIRECTORY_NAMES.has(part))) {
        // A module or root directory came, went or moved: the layout is recomputed and walked.
        this.envThrough = seq;
        if (aboveContentRoot(relative, layout)) this.fullStatThrough = seq;
      }
    } else if (!memberKind(relative, layout) && !isBuildMarker(relative)) this.signalled.ignored += 1;
    return seq;
  }

  private relativeOf(file: string): string | undefined {
    const root = this.root.canonicalRoot;
    if (file === root) return "";
    if (!file.startsWith(`${root}/`)) return undefined;
    return file.slice(root.length + 1);
  }

  // ------------------------------------------------------------ dispatch

  /** Fence the stream, then freeze the cut, root/environment identity and the owed work (§2.4). */
  async dispatch(input: { bindingVersion: number; fenceTimeoutMs?: number }): Promise<TrackerRound> {
    if (this.invalid) throw this.invalid;
    if (this.streamLost) throw new Error(`event stream lost (${this.streamLost.message}); restartStream() first`);
    if (this.inFlight) throw new Error("a round is already in flight");
    await this.source.fence(input.fenceTimeoutMs ?? 5000);
    // Frozen right after the fence, before any await: a signal during the reads below takes a higher seq.
    const epoch = this.epoch;
    const cut = this.seq;
    const workMark = this.work;
    const pending = new Map(this.pending);
    const subtrees = new Map(this.subtrees);
    const owedFullHash = this.fullHashThrough > 0;
    const owedFullStat = this.fullStatThrough > 0;
    const dispatchedAt = this.now();
    await this.checkRoot();
    // Off this thread: the walk is synchronous fs, and the owner serves requests while rounds run.
    const layout = await probeLayoutOffThread(this.root.canonicalRoot);
    const layoutKey = JSON.stringify([layout.sourceRoots, layout.resourceRoots, layout.layout]);
    const { buildFingerprint: fingerprint, layoutFingerprint } = await computeInputFingerprints(this.root.canonicalRoot, layout);
    if (this.epoch !== epoch) throw new Error("event stream restarted during dispatch");
    // A layout this round reads differently from the last one is walked in full by this round itself.
    const layoutMoved = Boolean(this.layout) && layoutKey !== this.layoutKey;
    // Owed until a full walk at or after this cut is confirmed, even if this round is abandoned.
    if (layoutMoved) this.fullStatThrough = Math.max(this.fullStatThrough, cut);
    // The input boundary moved: results dispatched under the old environment are refused.
    const fingerprintMoved = Boolean(this.fingerprint) && fingerprint !== this.fingerprint;
    if (fingerprintMoved) {
      this.generation += 1;
      // A different build key can use a sibling base. Validate the entire census before comparing it.
      this.fullHashThrough = Math.max(this.fullHashThrough, cut);
    }
    this.layout = layout;
    this.layoutKey = layoutKey;
    this.fingerprint = fingerprint;
    const mode: RoundMode = owedFullHash || fingerprintMoved || !this.view || dispatchedAt - this.lastFullHashAt >= this.fullHashIntervalMs ? "full-hash"
      : owedFullStat || layoutMoved ? "full-stat" : "paths";
    const round: TrackerRound = { epoch, cut, workspaceGeneration: this.generation, root: { ...this.root }, layout, buildKey: currentBuildKey(fingerprint), layoutFingerprint,
      bindingVersion: input.bindingVersion, captureId: `c-${randomUUID().replaceAll("-", "")}`, mode, dispatchedAt, pending, subtrees, workMark };
    this.inFlight = round;
    return round;
  }

  private async checkRoot(): Promise<void> {
    let current: RootIdentity | undefined;
    try { current = await rootIdentityOf(this.root.canonicalRoot); } catch { current = undefined; }
    this.judgeRoot(current);
  }

  private recheckRootSync(): void {
    if (this.invalid) return;
    let current: RootIdentity | undefined;
    try {
      const root = this.root.canonicalRoot;
      const info = statSync(root);
      current = realpathSync(root) === root && info.isDirectory() ? { canonicalRoot: root, dev: info.dev, ino: info.ino, volume: String(info.dev) } : undefined;
    } catch { current = undefined; }
    try { this.judgeRoot(current); } catch { /* recorded in this.invalid and reported through onInvalidRoot */ }
  }

  private judgeRoot(current: RootIdentity | undefined): void {
    if (this.invalid) throw this.invalid;
    if (current && current.dev === this.root.dev && current.ino === this.root.ino) return;
    this.invalid = new TrackerRootInvalid(current ? `${this.root.canonicalRoot} was replaced` : `${this.root.canonicalRoot} is gone`, current);
    this.generation += 1;
    this.inFlight = undefined;
    this.options.onInvalidRoot?.(this.invalid);
    throw this.invalid;
  }

  /** Abandon a round (job failed or was rejected): nothing is cleared, everything stays owed. */
  abandon(round: TrackerRound): void {
    if (this.inFlight === round) this.inFlight = undefined;
    if (this.verified === round) this.verified = undefined;
  }

  // ------------------------------------------------------------ verification

  /**
   * Read the round's scope once, without waiting for quiet: suspects are always hashed, stable paths
   * may reuse the stat cache (ns mtime/ctime, size, ino, dev). Later events keep higher seqs for the next round.
   */
  async verify(round: TrackerRound, base?: { entries: ReadonlyMap<string, ContentEntry>; buildKey: string }): Promise<TrackerVerification> {
    if (this.inFlight !== round) throw new Error("round is not the one in flight");
    const root = this.root.canonicalRoot;
    const entries = round.mode === "paths" ? new Map(this.view!) : new Map<string, ContentEntry>();
    const counts = { hashed: 0, statted: 0 };
    const suspect = (relative: string) => round.mode === "full-hash" || round.pending.has(relative)
      || [...round.subtrees.keys()].some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
    // A hinted path did not come from readdir. On a case-insensitive volume lstat("UserDAO.java")
    // still succeeds after a rename to UserDao.java, which would keep a ghost member (a duplicate
    // declaration) until the next full hash; each component must exist under exactly that name.
    const listings = new Map<string, Promise<Listing>>();
    // A hinted spelling that is not on disk but still opens: the member exists under another spelling
    // (a case-only rename reported only under its old name, or a save reported under the spelling it
    // was opened with). The listings name it, and this round reads it there; a spelling they cannot
    // name uniquely is left to a full walk owed after this round.
    let respelled = false;
    const opens = (relative: string) => lstat(path.join(root, relative)).then(() => true, () => false);
    /** The spelling a full walk would record for a hinted path (readdir's), or undefined when nothing opens under it. */
    const spelled = async (relative: string): Promise<string | undefined> => {
      const exact = await exactlyNamed(root, relative, listings);
      if (exact !== undefined) return exact;
      if (!await opens(relative)) return undefined;
      // Listed before a safe-save renamed the name back: list again before folding case, so a
      // case-sensitive volume (where an opening path is always exactly named) never folds.
      listings.clear();
      const actual = await exactlyNamed(root, relative, listings) ?? await diskSpelling(root, relative, listings);
      if (actual === undefined) respelled = true;
      return actual;
    };
    const gone = (relative: string) => { entries.delete(relative); this.cache.delete(relative); };
    // `respelt`: a hint reached this path under another spelling, so it is as suspect as the hint was.
    const read = async (relative: string, kind: ContentEntry["kind"], respelt = false) => {
      const absolute = path.join(root, relative);
      let before;
      try { before = await lstat(absolute, { bigint: true }); } catch (error) { if (isMissing(error)) { gone(relative); return; } throw error; }
      if (!before.isFile()) { gone(relative); return; }
      counts.statted += 1;
      const key = statKey(before);
      const cached = this.cache.get(relative);
      let hash: string;
      if (!respelt && !suspect(relative) && cached && cached.key === key) hash = cached.hash;
      else {
        try { hash = await hashSourceWithin(root, absolute); } catch (error) { if (isMissing(error)) { gone(relative); return; } throw error; }
        counts.hashed += 1;
        const after = await lstat(absolute, { bigint: true }).catch(() => undefined);
        // Cached only when the read was stable; a racing write has its own, later event.
        if (after && statKey(after) === key) this.cache.set(relative, { key, hash }); else this.cache.delete(relative);
      }
      entries.set(relative, { kind, path: relative, hash });
      await this.options.afterRead?.(relative);
    };
    // Each path is read on its own (distinct entries and cache keys), so the reads overlap; the phases stay in order.
    if (round.mode === "paths") {
      await eachLimited([...round.pending.keys()], VERIFY_READS, async relative => {
        const kind = memberKind(relative, round.layout);
        if (!kind) { gone(relative); return; }
        const actual = await spelled(relative);
        if (actual !== relative) gone(relative);
        if (actual === undefined) return;
        const actualKind = actual === relative ? kind : memberKind(actual, round.layout);
        if (actualKind) await read(actual, actualKind, actual !== relative);
      });
      for (const prefix of round.subtrees.keys()) {
        for (const existing of [...entries.keys()]) if (existing === prefix || existing.startsWith(`${prefix}/`)) gone(existing);
        // A directory renamed by case only: the old spelling still opens, its members are not there.
        const walked = await spelled(prefix);
        if (walked === undefined) continue;
        if (walked !== prefix) for (const existing of [...entries.keys()]) if (existing === walked || existing.startsWith(`${walked}/`)) gone(existing);
        await eachLimited(await walkMembers(root, walked, round.layout), VERIFY_READS, found => read(found.path, found.kind, walked !== prefix));
      }
    } else {
      await eachLimited(await walkMembers(root, "", round.layout), VERIFY_READS, found => read(found.path, found.kind));
      // A full walk saw every member: stat keys of paths that are gone are dropped, so the cache never outgrows the census.
      for (const cached of [...this.cache.keys()]) if (!entries.has(cached)) this.cache.delete(cached);
    }
    // Owed after this round's cut, so its completion cannot clear it: the next round walks every root.
    if (respelled && this.epoch === round.epoch) {
      this.fullStatThrough = this.bump();
      this.work += 1;
    }
    const content = contentManifestIdOf(entries.values());
    if (this.epoch === round.epoch && this.inFlight === round) {
      this.view = entries;
      this.verified = round;
    }
    return rebase({ round, contentManifestId: content.id, entries, changed: [], deleted: [], noop: false, ...counts }, base);
  }

  /** The confirmation a SnapshotStore publish or noop asks for, frozen at this round's dispatch. */
  planFor(verification: TrackerVerification, contentManifestId = verification.contentManifestId): BindPlan {
    const { round } = verification;
    return { workspaceId: this.workspaceId, workspaceGeneration: round.workspaceGeneration, trackerEpoch: round.epoch, bindingVersion: round.bindingVersion,
      coveredThroughSeq: round.cut, root: { ...round.root }, captureId: round.captureId, contentManifestId, buildKey: round.buildKey };
  }

  /**
   * The store committed `binding` for `round`: clear only what the round verified up to its cut.
   * Later seqs, a newer drop and other epochs' state are kept.
   */
  complete(round: TrackerRound, binding: WorkspaceBinding): TrackerStatus {
    if (this.invalid) throw this.invalid;
    if (round.epoch !== this.epoch) throw new Error(`round from epoch ${round.epoch} cannot confirm epoch ${this.epoch}`);
    if (this.inFlight !== round) throw new Error("round is not the one in flight");
    if (this.verified !== round) throw new Error("round was never verified");
    if (binding.trackerEpoch !== round.epoch || binding.coveredThroughSeq !== round.cut || binding.workspaceGeneration !== round.workspaceGeneration
      || binding.bindingVersion !== round.bindingVersion + 1
      || binding.workspaceId !== this.workspaceId || binding.root.ino !== round.root.ino || binding.root.dev !== round.root.dev) {
      throw new Error("binding was not committed for this round");
    }
    this.inFlight = undefined;
    const covered = (seq: number) => seq > 0 && seq <= round.cut;
    for (const [relative, seq] of round.pending) if ((this.pending.get(relative) ?? Infinity) <= round.cut && covered(seq)) this.pending.delete(relative);
    for (const [prefix, seq] of round.subtrees) if ((this.subtrees.get(prefix) ?? Infinity) <= round.cut && covered(seq)) this.subtrees.delete(prefix);
    if (round.mode !== "paths") {
      // A full walk covers every path and subtree hinted up to the cut.
      for (const [relative, seq] of [...this.pending]) if (seq <= round.cut) this.pending.delete(relative);
      for (const [prefix, seq] of [...this.subtrees]) if (seq <= round.cut) this.subtrees.delete(prefix);
      if (this.fullStatThrough <= round.cut) this.fullStatThrough = 0;
    }
    if (round.mode === "full-hash") {
      if (this.fullHashThrough <= round.cut) this.fullHashThrough = 0;
      // Only a confirmed full hash restarts the interval; an abandoned one leaves it owed.
      this.lastFullHashAt = round.dispatchedAt;
    }
    if (this.envThrough <= round.cut) this.envThrough = 0;
    this.confirmed = { seq: round.cut, bindingVersion: binding.bindingVersion };
    return this.status();
  }
}

function statKey(info: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint }): StatKey {
  return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.dev}`;
}

/**
 * A request's fence (flush) may wait this long. A fence that times out fails the native stream, so the
 * request path never uses a shorter limit than dispatch (5 s): a helper that is merely slow under load
 * is not killed by a request, and one that is stuck is still caught by the next dispatch's fence.
 */
const FLUSH_FENCE_TIMEOUT_MS = 30_000;

/** Reads one verify round keeps in flight: a new worktree hashes its whole census, latency-bound one file at a time. */
const VERIFY_READS = 16;

/** Runs `work` over `items` with at most `limit` in flight. After a failure no item starts; it rejects once every read in flight ended. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failure: { error: unknown } | undefined;
  const lane = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Whether every component of `relative` is a directory entry under exactly that spelling. Listings
 * are shared through `listings` for one verification. Names equal after NFC normalization count as
 * the same entry (APFS is normalization-insensitive, and a signal may spell a name in either form);
 * case is never folded.
 */
type Listing = { names: Set<string>; nfc?: Map<string, string> } | "missing" | "unlisted";

function listingOf(root: string, parent: string, listings: Map<string, Promise<Listing>>): Promise<Listing> {
  let listing = listings.get(parent);
  if (!listing) {
    // A directory that can be searched but not listed (mode --x) proves nothing: lstat decides, as before.
    listing = readdir(path.join(root, parent)).then((names): Listing => ({ names: new Set(names) }),
      (error: unknown): Listing => isMissing(error) ? "missing" : "unlisted");
    listings.set(parent, listing);
  }
  return listing;
}

/**
 * The spelling readdir gives a path that opens under another one (a case-insensitive volume): each
 * component matched exactly, or by its only case-insensitive match in its parent's listing. Undefined
 * when a component has no unique match (or a parent cannot be listed): a full walk decides instead.
 * The result is the spelling a full walk records, readdir's own.
 */
async function diskSpelling(root: string, relative: string, listings: Map<string, Promise<Listing>>): Promise<string | undefined> {
  const fold = (name: string) => name.normalize("NFC").toLowerCase();
  let parent = "";
  for (const part of relative.split("/")) {
    const found = await listingOf(root, parent, listings);
    if (found === "missing" || found === "unlisted") return undefined;
    let actual: string | undefined = found.names.has(part) ? part : undefined;
    if (actual === undefined) {
      const folded = fold(part);
      const matches = [...found.names].filter(name => fold(name) === folded);
      if (matches.length !== 1) return undefined;
      actual = matches[0];
    }
    parent = parent ? `${parent}/${actual}` : actual!;
  }
  return parent;
}

/**
 * The hinted path with each component as its parent's listing spells it (readdir's, so a full walk
 * records the same key), matched exactly or by NFC equivalence; case is never folded. Undefined when
 * a component is not listed. A directory that cannot be listed (mode --x) proves nothing: the rest of
 * the hinted spelling stands and lstat decides, as before.
 */
async function exactlyNamed(root: string, relative: string, listings: Map<string, Promise<Listing>>): Promise<string | undefined> {
  const parts = relative.split("/");
  const spelled: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const found = await listingOf(root, spelled.join("/"), listings);
    if (found === "missing") return undefined;
    if (found === "unlisted") return [...spelled, ...parts.slice(index)].join("/");
    if (found.names.has(part)) { spelled.push(part); continue; }
    // Built once per directory, only when some spelling missed.
    found.nfc ??= new Map([...found.names].map(name => [name.normalize("NFC"), name]));
    const actual = found.nfc.get(part.normalize("NFC"));
    if (actual === undefined) return undefined;
    spelled.push(actual);
  }
  return spelled.join("/");
}

/** The index census membership of a relative path, by the same rules discovery uses. */
export function memberKind(relative: string, layout: LayoutContext): ContentEntry["kind"] | undefined {
  if (javaSourceRoot(relative, layout)) return "java";
  return resourceMemberRoot(relative, layout) ? "resource" : undefined;
}

function contentRoots(layout: LayoutContext): string[] {
  return [...layout.sourceRoots.map(root => root.relativePath), ...layout.resourceRoots];
}
function underContentRoot(relative: string, layout: LayoutContext): boolean {
  return contentRoots(layout).some(root => relative === root || relative.startsWith(`${root}/`));
}
function aboveContentRoot(relative: string, layout: LayoutContext): boolean {
  return contentRoots(layout).some(root => root.startsWith(`${relative}/`));
}
function isBuildMarker(relative: string): boolean {
  return BUILD_MARKER_RELATIVE_PATHS.some(marker => relative === marker || relative.endsWith(`/${marker}`));
}

/** Census members under `prefix` ("" for the whole root), never following symlinks out. */
async function walkMembers(root: string, prefix: string, layout: LayoutContext): Promise<Array<{ path: string; kind: ContentEntry["kind"] }>> {
  const found: Array<{ path: string; kind: ContentEntry["kind"] }> = [];
  const starts = prefix ? [prefix] : contentRoots(layout);
  const seen = new Set<string>();
  // Level by level, VERIFY_READS directories at a time: one directory after another left the
  // threadpool idle (a 2394-directory tree took 240-400 ms that way, about 45 ms overlapped).
  const walk = async (start: string): Promise<void> => {
    for (let level = [start]; level.length > 0;) {
      const next: string[] = [];
      await eachLimited(level, VERIFY_READS, async relative => {
        let entries;
        try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch (error) { if (isMissing(error)) return; throw error; }
        for (const entry of entries) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) next.push(child); }
          else if (entry.isFile() && !seen.has(child)) {
            const kind = memberKind(child, layout);
            if (kind) { seen.add(child); found.push({ path: child, kind }); }
          }
        }
      });
      level = next;
    }
  };
  for (const start of starts) {
    const info = await lstat(path.join(root, start)).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) await walk(start);
    else if (info.isFile() && memberKind(start, layout) && !seen.has(start)) { seen.add(start); found.push({ path: start, kind: memberKind(start, layout)! }); }
  }
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
