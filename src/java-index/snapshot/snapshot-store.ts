// input: sealed candidates, verified captures and the tracker's current workspace state.
// output: atomic workspace bindings, leases on sealed snapshots, and real deletion of unreferenced ones.
// pos: MAC-07 SnapshotStore (contract §2.7). One store per owner: publish, noop, zero-diff bind and
//      reclaim decisions are serialized here; requests, query workers, candidate scans, builder bases
//      and publishing candidates all hold the same kind of lease. The periodic sweeper is MAC-09.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { cloneSealedDatabase } from "../../mac-platform/clonefile.js";
import type { SnapshotManifest } from "../sql/snapshot-manifest.js";
import { BINDING_FORMAT, readBinding, removeStaleBindingTmp, sameRoot, workspaceDir, writeBinding, type RootIdentity, type WorkspaceBinding } from "./binding.js";
import { assertId, DB_FILE, mac1Layout, MANIFEST_FILE, newSnapshotId, readSealedManifest, sealJobDatabase, syncDir, type FaultHook, type Mac1Layout } from "./seal.js";

export type LeasePurpose = "request" | "query-worker" | "candidate-scan" | "base" | "publish";
export type SnapshotLease = { readonly snapshotId: string; readonly purpose: LeasePurpose; readonly dbPath: string; release(): void };

/** What the tracker currently holds for a workspace (in memory, never persisted as FRESH). */
export type TrackedWorkspace = { root: RootIdentity; workspaceGeneration: number; trackerEpoch: string };

/** The confirmation a publish, noop or zero-diff bind asks for, frozen at dispatch. */
export type BindPlan = {
  workspaceId: string;
  workspaceGeneration: number;
  trackerEpoch: string;
  /** The binding version seen at dispatch; 0 when the workspace had none. */
  bindingVersion: number;
  coveredThroughSeq: number;
  root: RootIdentity;
  captureId: string;
  contentManifestId: string;
  buildKey: string;
};

export type RejectReason = "not-tracked" | "generation" | "tracker-epoch" | "root" | "binding-version" | "watermark"
  | "capture" | "content" | "build-key" | "no-binding" | "job-state";
export class BindRejected extends Error {
  constructor(readonly reason: RejectReason, message: string) { super(`${reason}: ${message}`); }
}

export type BuildJob = {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly captureId: string;
  readonly dir: string;
  /** The private, writable database the builder fills (absent until written or cloned). */
  readonly dbPath: string;
  state: "OPEN" | "SEALED" | "FINISHED";
  /** Fixed before sealing starts, so a half-sealed candidate is already in flight. */
  snapshotId?: string;
  manifest?: SnapshotManifest;
};

export type ReclaimTarget = { snapshotId: string } | { jobId: string };
export type ReclaimResult = { reclaimed: true } | { reclaimed: false; reason: "bound" | "leased" | "in-flight" | "missing" };

export type RecoveryReport = {
  bindings: Array<{ workspaceId: string; snapshotId: string; bindingVersion: number }>;
  /** bindingVersion is the CAS base the replacing publish must carry (absent when the file did not parse). */
  invalidBindings: Array<{ workspaceId: string; error: string; bindingVersion?: number }>;
  removedBindingTmp: string[];
  unboundSnapshots: string[];
  staleJobs: string[];
  /** Entries that are not store objects (e.g. Finder's .DS_Store): left alone, never served or deleted. */
  ignored: string[];
};

export type SnapshotStoreOptions = {
  /** Before any binding write or deletion: this process must still be the owner (assertOwnerLock). */
  assertOwner?: () => void;
  /** Test seam: called at each publish boundary; may throw or kill the process. */
  faultAt?: FaultHook;
};

export class SnapshotStore {
  readonly layout: Mac1Layout;
  private readonly bindings = new Map<string, WorkspaceBinding>();
  /** Bindings that failed verification: not served; their snapshot is not reclaimed and their version not reused until rebound. */
  private readonly quarantined = new Map<string, { snapshotId: string; bindingVersion: number }>();
  private readonly tracked = new Map<string, TrackedWorkspace>();
  private readonly leases = new Map<string, Set<SnapshotLease>>();
  private readonly reclaiming = new Set<string>();
  private readonly jobs = new Map<string, BuildJob>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly cacheRoot: string, private readonly options: SnapshotStoreOptions) {
    this.layout = mac1Layout(cacheRoot);
  }

  /** Open the store and recover: tmp bindings are dropped, every binding is verified against its manifest. */
  static async open(cacheRoot: string, options: SnapshotStoreOptions = {}): Promise<{ store: SnapshotStore; recovery: RecoveryReport }> {
    const store = new SnapshotStore(cacheRoot, options);
    const { layout } = store;
    for (const directory of [layout.root, layout.owner, layout.snapshots, layout.workspaces, layout.jobs]) await mkdir(directory, { recursive: true });
    const recovery: RecoveryReport = { bindings: [], invalidBindings: [], removedBindingTmp: [], unboundSnapshots: [], staleJobs: [], ignored: [] };
    const objects = async (directory: string): Promise<string[]> => {
      const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
      const ids: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && /^[A-Za-z0-9_-]{8,128}$/.test(entry.name)) ids.push(entry.name);
        else recovery.ignored.push(path.relative(layout.root, path.join(directory, entry.name)));
      }
      return ids.sort();
    };
    for (const workspaceId of await objects(layout.workspaces)) {
      let named: { snapshotId: string; bindingVersion: number } | undefined;
      try {
        recovery.removedBindingTmp.push(...(await removeStaleBindingTmp(layout, workspaceId)).map(name => `${workspaceId}/${name}`));
        const binding = await readBinding(layout, workspaceId);
        if (!binding) continue;
        named = { snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion };
        const manifest = await readSealedManifest(layout, binding.snapshotId);
        if (manifest.contentManifestId !== binding.contentManifestId || manifest.buildKey !== binding.buildKey) throw new Error("binding does not match its snapshot manifest");
        store.bindings.set(workspaceId, binding);
        recovery.bindings.push({ workspaceId, snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion });
      } catch (error) {
        // Not served: NOT_READY until a new verified publish replaces it.
        recovery.invalidBindings.push({ workspaceId, error: error instanceof Error ? error.message : String(error), ...(named ? { bindingVersion: named.bindingVersion } : {}) });
        if (named) store.quarantined.set(workspaceId, named);
      }
    }
    const bound = new Set([...store.bindings.values()].map(binding => binding.snapshotId).concat([...store.quarantined.values()].map(entry => entry.snapshotId)));
    recovery.unboundSnapshots = (await objects(layout.snapshots)).filter(name => !bound.has(name));
    recovery.staleJobs = await objects(layout.jobs);
    recovery.ignored.sort();
    return { store, recovery };
  }

  // ------------------------------------------------------------ state and leases

  /** The tracker's current truth for a workspace; plans with another generation, epoch or root are rejected. */
  track(workspaceId: string, state: TrackedWorkspace): void {
    assertId("workspaceId", workspaceId);
    this.tracked.set(workspaceId, { root: { ...state.root }, workspaceGeneration: state.workspaceGeneration, trackerEpoch: state.trackerEpoch });
  }

  binding(workspaceId: string): WorkspaceBinding | undefined {
    const binding = this.bindings.get(workspaceId);
    return binding && { ...binding, root: { ...binding.root } };
  }

  /** The bindingVersion a plan dispatched now must carry: the served binding's, else a quarantined one's, else 0. */
  bindingVersionOf(workspaceId: string): number {
    return this.bindings.get(workspaceId)?.bindingVersion ?? this.quarantined.get(workspaceId)?.bindingVersion ?? 0;
  }

  snapshotPath(snapshotId: string): string {
    assertId("snapshotId", snapshotId);
    return path.join(this.layout.snapshots, snapshotId, DB_FILE);
  }

  /** A lease on a sealed snapshot. Marked-for-deletion and missing snapshots are refused. */
  acquire(snapshotId: string, purpose: LeasePurpose): SnapshotLease {
    assertId("snapshotId", snapshotId);
    if (this.reclaiming.has(snapshotId)) throw new Error(`snapshot ${snapshotId} is being reclaimed`);
    if (!existsSync(path.join(this.layout.snapshots, snapshotId, MANIFEST_FILE))) throw new Error(`snapshot ${snapshotId} is not sealed`);
    const held = this.leases.get(snapshotId) ?? new Set<SnapshotLease>();
    this.leases.set(snapshotId, held);
    let released = false;
    const lease: SnapshotLease = { snapshotId, purpose, dbPath: this.snapshotPath(snapshotId), release: () => {
      if (released) return;
      released = true;
      held.delete(lease);
      if (held.size === 0 && this.leases.get(snapshotId) === held) this.leases.delete(snapshotId);
    } };
    held.add(lease);
    return lease;
  }

  /** One acquire for a request: the workspace's verified binding, fixed for the lease's lifetime. */
  acquireBound(workspaceId: string, purpose: LeasePurpose): { lease: SnapshotLease; binding: WorkspaceBinding } | undefined {
    const binding = this.binding(workspaceId);
    if (!binding) return undefined; // NOT_READY: never another workspace's unverified snapshot.
    return { lease: this.acquire(binding.snapshotId, purpose), binding };
  }

  leaseCount(snapshotId: string): number {
    return this.leases.get(snapshotId)?.size ?? 0;
  }

  // ------------------------------------------------------------ jobs and candidates

  /** A private job directory; it cannot be reclaimed while the job is open or sealed. */
  async createJob(input: { workspaceId: string; captureId: string; jobId?: string }): Promise<BuildJob> {
    assertId("workspaceId", input.workspaceId);
    assertId("captureId", input.captureId);
    const jobId = input.jobId ?? `j-${randomUUID().replaceAll("-", "")}`;
    assertId("jobId", jobId);
    const dir = path.join(this.layout.jobs, jobId);
    await mkdir(dir);
    const job: BuildJob = { jobId, workspaceId: input.workspaceId, captureId: input.captureId, dir, dbPath: path.join(dir, DB_FILE), state: "OPEN" };
    this.jobs.set(jobId, job);
    return job;
  }

  /** DeltaPlan start: clone a leased SEALED base into the job. The caller holds `base` until this resolves. */
  async cloneBase(base: SnapshotLease, job: BuildJob): Promise<void> {
    if (job.state !== "OPEN" || existsSync(job.dbPath)) throw new Error(`job ${job.jobId} cannot take a base`);
    if (!this.leases.get(base.snapshotId)?.has(base)) throw new Error("base lease is not held");
    await readSealedManifest(this.layout, base.snapshotId);
    await cloneSealedDatabase(base.dbPath, job.dbPath, this.cacheRoot);
    // The clone keeps the sealed mode; the private copy is the job's to write.
    await chmod(job.dbPath, 0o644);
  }

  /** Seal the job's database (all writers closed). The candidate holds a publish lease until it is bound or discarded. */
  async seal(job: BuildJob): Promise<SnapshotManifest> {
    if (job.state !== "OPEN" || job.snapshotId) throw new BindRejected("job-state", `job ${job.jobId} is ${job.state}`);
    job.snapshotId = newSnapshotId();
    const manifest = await sealJobDatabase(this.layout, job.dir, { snapshotId: job.snapshotId, faultAt: this.options.faultAt });
    job.manifest = manifest;
    job.state = "SEALED";
    return manifest;
  }

  /** Discard a job: its private files and an unbound sealed candidate become reclaimable. */
  finishJob(job: BuildJob): void {
    job.state = "FINISHED";
  }

  // ------------------------------------------------------------ binding CAS

  /** Publish a sealed candidate built for `plan`'s capture. */
  async publish(plan: BindPlan, job: BuildJob): Promise<WorkspaceBinding> {
    if (job.captureId !== plan.captureId || job.workspaceId !== plan.workspaceId) throw new BindRejected("capture", `job ${job.jobId} is for ${job.workspaceId}/${job.captureId}`);
    if (job.state === "OPEN") await this.seal(job);
    if (job.state !== "SEALED" || !job.manifest) throw new BindRejected("job-state", `job ${job.jobId} is ${job.state}`);
    const manifest = job.manifest;
    const candidate = this.acquire(manifest.snapshotId, "publish");
    try {
      return await this.serial(async () => {
        this.checkPlan(plan);
        this.checkContent(plan, manifest);
        const binding = await this.commit(plan, manifest);
        job.state = "FINISHED";
        return binding;
      });
    } finally { candidate.release(); }
  }

  /** verified-noop: the capture equals the bound snapshot; only the watermark and bindingVersion move. No DB is written. */
  async confirmNoop(plan: BindPlan): Promise<WorkspaceBinding> {
    return this.serial(async () => {
      this.checkPlan(plan);
      const current = this.bindings.get(plan.workspaceId);
      if (!current) throw new BindRejected("no-binding", `${plan.workspaceId} has no binding to confirm`);
      const manifest = await readSealedManifest(this.layout, current.snapshotId);
      this.checkContent(plan, manifest);
      return this.commit(plan, manifest);
    });
  }

  /** Zero-diff: bind an existing snapshot whose manifest and file fully verify against this workspace's capture. */
  async bindVerified(plan: BindPlan, snapshotId: string): Promise<WorkspaceBinding> {
    const lease = this.acquire(snapshotId, "candidate-scan");
    try {
      const manifest = await readSealedManifest(this.layout, snapshotId, { verifyFile: true });
      return await this.serial(async () => {
        this.checkPlan(plan);
        this.checkContent(plan, manifest);
        return this.commit(plan, manifest);
      });
    } finally { lease.release(); }
  }

  private checkPlan(plan: BindPlan): void {
    const tracked = this.tracked.get(plan.workspaceId);
    if (!tracked) throw new BindRejected("not-tracked", `${plan.workspaceId} is not tracked`);
    const current = this.bindings.get(plan.workspaceId);
    if (plan.workspaceGeneration !== tracked.workspaceGeneration || (current && plan.workspaceGeneration < current.workspaceGeneration)) {
      throw new BindRejected("generation", `plan generation ${plan.workspaceGeneration}, tracked ${tracked.workspaceGeneration}`);
    }
    // A different epoch is a different event stream: rejected even with the same seq.
    if (plan.trackerEpoch !== tracked.trackerEpoch) throw new BindRejected("tracker-epoch", `plan epoch ${plan.trackerEpoch}, tracked ${tracked.trackerEpoch}`);
    if (!sameRoot(plan.root, tracked.root) || (current && !sameRoot(plan.root, current.root))) throw new BindRejected("root", `${plan.workspaceId} root identity differs`);
    const version = this.bindingVersionOf(plan.workspaceId);
    if (version !== plan.bindingVersion) {
      throw new BindRejected("binding-version", `dispatched at ${plan.bindingVersion}, binding is at ${version}`);
    }
    if (!Number.isSafeInteger(plan.coveredThroughSeq) || plan.coveredThroughSeq < 0
      || (current && current.trackerEpoch === plan.trackerEpoch && plan.coveredThroughSeq < current.coveredThroughSeq)) {
      throw new BindRejected("watermark", `coveredThroughSeq ${plan.coveredThroughSeq} below ${current?.coveredThroughSeq}`);
    }
  }

  private checkContent(plan: BindPlan, manifest: SnapshotManifest): void {
    if (manifest.contentManifestId !== plan.contentManifestId) throw new BindRejected("content", `snapshot ${manifest.snapshotId} content differs from capture ${plan.captureId}`);
    if (manifest.buildKey !== plan.buildKey) throw new BindRejected("build-key", `snapshot ${manifest.snapshotId} buildKey differs`);
  }

  private async commit(plan: BindPlan, manifest: SnapshotManifest): Promise<WorkspaceBinding> {
    this.options.assertOwner?.();
    const binding: WorkspaceBinding = { formatVersion: BINDING_FORMAT, workspaceId: plan.workspaceId, root: { ...plan.root },
      workspaceGeneration: plan.workspaceGeneration, bindingVersion: plan.bindingVersion + 1, snapshotId: manifest.snapshotId,
      contentManifestId: manifest.contentManifestId, buildKey: manifest.buildKey, trackerEpoch: plan.trackerEpoch, coveredThroughSeq: plan.coveredThroughSeq };
    const directory = workspaceDir(this.layout, plan.workspaceId);
    if (!existsSync(directory)) {
      await mkdir(directory);
      await syncDir(this.layout.workspaces);
    }
    try {
      await writeBinding(this.layout, binding, this.options.faultAt);
    } catch (error) {
      // Past the rename the new binding is the commit even though a later sync failed: memory follows the disk.
      const onDisk = await readBinding(this.layout, plan.workspaceId).catch(() => undefined);
      if (onDisk && onDisk.bindingVersion === binding.bindingVersion && onDisk.snapshotId === binding.snapshotId) this.bindings.set(plan.workspaceId, onDisk);
      throw error;
    }
    this.bindings.set(plan.workspaceId, binding);
    this.quarantined.delete(plan.workspaceId);
    return { ...binding, root: { ...binding.root } };
  }

  // ------------------------------------------------------------ reclaim

  /**
   * The one deletion decision (contract §2.7): only an unbound snapshot with no lease and no
   * in-flight publish, or a job that is not open/sealed, is deleted, for real, right here.
   */
  async tryReclaim(target: ReclaimTarget): Promise<ReclaimResult> {
    return this.serial(async () => {
      if ("jobId" in target) {
        assertId("jobId", target.jobId);
        const job = this.jobs.get(target.jobId);
        if (job && job.state !== "FINISHED") return { reclaimed: false, reason: "in-flight" };
        const dir = path.join(this.layout.jobs, target.jobId);
        if (!existsSync(dir)) return { reclaimed: false, reason: "missing" };
        this.options.assertOwner?.();
        await removeTree(dir);
        await syncDir(this.layout.jobs);
        this.jobs.delete(target.jobId);
        return { reclaimed: true };
      }
      const { snapshotId } = target;
      assertId("snapshotId", snapshotId);
      const dir = path.join(this.layout.snapshots, snapshotId);
      if (!existsSync(dir)) return { reclaimed: false, reason: "missing" };
      if ([...this.bindings.values()].some(binding => binding.snapshotId === snapshotId) || [...this.quarantined.values()].some(entry => entry.snapshotId === snapshotId)) return { reclaimed: false, reason: "bound" };
      if (this.leaseCount(snapshotId) > 0) return { reclaimed: false, reason: "leased" };
      if ([...this.jobs.values()].some(job => job.state !== "FINISHED" && job.snapshotId === snapshotId)) return { reclaimed: false, reason: "in-flight" };
      this.options.assertOwner?.();
      // Marked first: no new lease from here on, even while the tree is being removed.
      this.reclaiming.add(snapshotId);
      try {
        await this.options.faultAt?.("reclaim-marked");
        await removeTree(dir);
        await syncDir(this.layout.snapshots);
      } finally { this.reclaiming.delete(snapshotId); }
      return { reclaimed: true };
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

async function removeTree(dir: string): Promise<void> {
  // Sealed trees are read-only by mode; deletion is the store's alone.
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
