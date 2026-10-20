import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { IndexOwner, type IndexOwnerOptions, type OwnerEvent } from "./index-owner.js";
import { FSEVENT_FLAGS, type TrackerSourceFactory } from "./workspace-tracker.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const FILE_MODIFIED = 0x1000 | FSEVENT_FLAGS.ItemIsFile;

/** Deterministic change streams: the test owns every hint. */
function fakeSources() {
  const emitters = new Map<string, (flags: number, file: string) => void>();
  const factory = (root: string): TrackerSourceFactory => async onSignal => {
    emitters.set(root, onSignal);
    const closed = new Promise<void>(() => undefined);
    return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => {}, closed };
  };
  return { factory, emit: (root: string, relative: string) => emitters.get(root)!(FILE_MODIFIED, path.join(root, relative)) };
}

async function until<T>(probe: () => T | undefined | false, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

async function base(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-owner-gc-")));
  t.after(async () => {
    const writable = async (current: string): Promise<void> => {
      await chmod(current, 0o755).catch(() => undefined);
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await writable(path.join(current, entry.name));
    };
    await writable(dir);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function openOwner(t: TestContext, cacheRoot: string, options: Partial<IndexOwnerOptions> = {}) {
  const sources = fakeSources();
  const events: OwnerEvent[] = [];
  const owner = await IndexOwner.open({ cacheRoot, trackerSource: root => sources.factory(root), roundDelayMs: 5, onEvent: event => events.push(event), ...options });
  t.after(() => owner.stop());
  return { owner, sources, events, sweeps: () => events.filter(event => event.type === "sweep") };
}

async function repo(dir: string, name: string): Promise<string> {
  const root = path.join(dir, name);
  await cp(fixturesRoot, root, { recursive: true });
  return root;
}

async function bound(ctx: Awaited<ReturnType<typeof openOwner>>, root: string) {
  const workspace = await ctx.owner.workspace(root);
  await until(() => ctx.owner.store.binding(workspace.workspaceId) && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, `first publish ${root}`, 120_000);
  return { workspace, binding: ctx.owner.store.binding(workspace.workspaceId)! };
}

test("the owner's first sweep removes what a dead incarnation left, before any workspace starts, and nothing else", async t => {
  const dir = await base(t);
  const cacheRoot = path.join(dir, "cache");
  const root = await repo(dir, "repo");
  const first = await openOwner(t, cacheRoot);
  const { binding } = await bound(first, root);
  // A sealed candidate and an open job of the first incarnation, then it is gone (stop never finishes them).
  const sealedJob = await first.owner.store.createJob({ workspaceId: binding.workspaceId, captureId: "cap-dead-00001" });
  const base0 = first.owner.store.acquire(binding.snapshotId, "base");
  await first.owner.store.cloneBase(base0, sealedJob);
  base0.release();
  const candidate = await first.owner.store.seal(sealedJob);
  const openJob = await first.owner.store.createJob({ workspaceId: binding.workspaceId, captureId: "cap-dead-00002" });
  await writeFile(openJob.dbPath, "half-written");
  await first.owner.stop();
  // Outside the store's objects: never touched by any cycle.
  const service = path.join(dir, "service-state", "jdt-gradle-home", "daemon", "9.3.1", "registry.bin");
  const legacy = path.join(cacheRoot, "repos", "legacy", "index.sqlite");
  for (const file of [service, legacy, path.join(cacheRoot, "mac1", "owner", "owner.lock")]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "keep"); }

  const second = await openOwner(t, cacheRoot, { gcCycleMs: 60_000 });
  const [sweep] = await until(() => second.sweeps().length > 0 && second.sweeps(), "recovery sweep");
  assert.equal(sweep!.type === "sweep" && sweep.error, undefined);
  const report = sweep!.type === "sweep" ? sweep.report! : undefined;
  assert.deepEqual(report?.snapshots, [candidate.snapshotId]);
  assert.ok(report?.jobs.includes(sealedJob.jobId) && report.jobs.includes(openJob.jobId));
  assert.deepEqual(await readdir(second.owner.store.layout.jobs), []);
  assert.deepEqual(await readdir(second.owner.store.layout.snapshots), [binding.snapshotId]);
  assert.deepEqual(second.owner.store.binding(binding.workspaceId)?.snapshotId, binding.snapshotId, "the recovered binding is served");
  assert.equal(second.owner.list().length, 0, "recovery started no tracker and no build");
  for (const file of [service, legacy, path.join(cacheRoot, "mac1", "owner", "owner.lock")]) assert.equal(await readFile(file, "utf8"), "keep", file);
});

test("without the owner lock (gc: false) no cycle ever runs: a live process's jobs and unbound candidates stay", async t => {
  const dir = await base(t);
  const cacheRoot = path.join(dir, "cache");
  const root = await repo(dir, "repo");
  const live = await openOwner(t, cacheRoot);
  const { binding } = await bound(live, root);
  const job = await live.owner.store.createJob({ workspaceId: binding.workspaceId, captureId: "cap-live-00001" });
  const lease = live.owner.store.acquire(binding.snapshotId, "base");
  await live.owner.store.cloneBase(lease, job);
  lease.release();
  const candidate = await live.owner.store.seal(job);
  const openJob = await live.owner.store.createJob({ workspaceId: binding.workspaceId, captureId: "cap-live-00002" });

  const unlocked = await openOwner(t, cacheRoot, { gc: false, gcCycleMs: 20 });
  assert.equal(await unlocked.owner.sweep(), undefined, "an explicit cycle is refused too");
  await delay(200);
  assert.deepEqual(unlocked.sweeps(), []);
  assert.deepEqual((await readdir(unlocked.owner.store.layout.snapshots)).sort(), [binding.snapshotId, candidate.snapshotId].sort());
  assert.deepEqual((await readdir(unlocked.owner.store.layout.jobs)).sort(), [job.jobId, openJob.jobId].sort());
});

test("a superseded snapshot under a held lease survives every cycle and goes within two cycles of the release", async t => {
  const dir = await base(t);
  const root = await repo(dir, "repo");
  const ctx = await openOwner(t, path.join(dir, "cache"), { gcCycleMs: 150 });
  const { binding: first } = await bound(ctx, root);
  const held = ctx.owner.store.acquire(first.snapshotId, "request");
  const file = path.join(root, serviceRel);
  await writeFile(file, `${await readFile(file, "utf8")}\n// superseding edit\n`);
  ctx.sources.emit(root, serviceRel);
  await until(() => ctx.owner.store.binding(first.workspaceId)!.snapshotId !== first.snapshotId, "second publish");
  const before = ctx.sweeps().length;
  await until(() => ctx.sweeps().length >= before + 3, "three cycles while leased");
  assert.ok(existsSync(held.dbPath), "a held lease keeps its snapshot through every cycle");
  const releasedAt = ctx.sweeps().length;
  // Released without the request-view fast path: only the periodic sweep can collect it.
  held.release();
  await until(() => !existsSync(path.join(ctx.owner.store.layout.snapshots, first.snapshotId)), "reclaimed after release", 10_000);
  assert.ok(ctx.sweeps().length - releasedAt <= 2, `collected within two cycles (${ctx.sweeps().length - releasedAt})`);
});

test("a retired workspace whose root was replaced loses binding and snapshot; a retired live one keeps them", async t => {
  const dir = await base(t);
  const replacedRoot = await repo(dir, "replaced");
  const liveRoot = await repo(dir, "live");
  // Distinct content: an identical twin would be seeded onto the same snapshot (MAC-11).
  const liveService = path.join(liveRoot, serviceRel);
  await writeFile(liveService, `${await readFile(liveService, "utf8")}\n// live\n`);
  const ctx = await openOwner(t, path.join(dir, "cache"), { gcCycleMs: 60_000 });
  const replaced = await bound(ctx, replacedRoot);
  const live = await bound(ctx, liveRoot);
  await ctx.owner.retire(replacedRoot);
  await ctx.owner.retire(liveRoot);
  await rename(replacedRoot, `${replacedRoot}-moved`);
  await mkdir(replacedRoot);
  // The live root seeded from the replaced one's snapshot, so a query worker kept a connection to it;
  // retire() trims that connection, and its lease goes once the worker confirms the close.
  await until(() => ctx.owner.store.leaseCount(replaced.binding.snapshotId) === 0, "seed read connection closed", 5_000);
  const report = (await ctx.owner.sweep())!;
  assert.deepEqual(report.workspaces, [replaced.workspace.workspaceId]);
  assert.deepEqual(report.snapshots, [replaced.binding.snapshotId]);
  assert.equal(ctx.owner.store.binding(replaced.workspace.workspaceId), undefined);
  assert.equal(ctx.owner.store.binding(live.workspace.workspaceId)?.snapshotId, live.binding.snapshotId);
  assert.ok(existsSync(path.join(ctx.owner.store.layout.snapshots, live.binding.snapshotId)));
  assert.equal(report.kept["root-live"], 1);
});

test("the periodic full hash falls due on a FRESH workspace: STALE until a full-hash round confirms it", async t => {
  const dir = await base(t);
  const root = await repo(dir, "repo");
  const ctx = await openOwner(t, path.join(dir, "cache"), { gcCycleMs: 60_000, fullHashIntervalMs: 5_000 });
  const { workspace } = await bound(ctx, root);
  const roundsBefore = ctx.events.filter(event => event.type === "round").length;
  const staleSeen = await until(() => workspace.trackerStatus() === "STALE" || undefined, "periodic hash owed", 10_000);
  assert.equal(staleSeen, true);
  await until(() => ctx.events.filter(event => event.type === "round").length > roundsBefore && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight,
    "periodic round", 30_000);
  const round = ctx.events.filter(event => event.type === "round").at(-1);
  assert.deepEqual(round?.type === "round" && [round.mode, round.outcome], ["full-hash", "noop"]);
  // Nothing changed: no new snapshot, the binding only moved its watermark.
  assert.equal(ctx.owner.store.binding(workspace.workspaceId)!.bindingVersion, 2);
});
