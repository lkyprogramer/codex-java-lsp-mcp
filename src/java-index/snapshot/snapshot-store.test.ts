import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, appendFile, chmod, copyFile, cp, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { buildKeyOf, contentManifestId } from "../sql/snapshot-manifest.js";
import { BINDING_FILE, readBinding, type RootIdentity } from "./binding.js";
import { DB_FILE, MANIFEST_FILE, openSealedDatabase, readSealedManifest } from "./seal.js";
import { BindRejected, SnapshotStore, type BindPlan, type BuildJob, type RejectReason } from "./snapshot-store.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const WS = "ws-alpha-0001";
const EPOCH = "epoch-0001";

type Template = { file: string; contentManifestId: string; buildKey: string };
type Fixture = { base: string; root: RootIdentity; otherRoot: RootIdentity; a: Template; b: Template };

let fixture: Fixture;
test.before(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "snapshot-store-")));
  const template = async (name: string, change?: (repo: string) => Promise<void>): Promise<Template> => {
    const repo = path.join(base, `repo-${name}`);
    await cp(fixturesRoot, repo, { recursive: true });
    await change?.(repo);
    // One directory per index: the workspace-stat sidecar is a sibling file.
    const file = path.join(base, `tpl-${name}`, DB_FILE);
    const db = openIndexDb(file);
    try {
      ensureSchema(db);
      await runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
      return { file, contentManifestId: contentManifestId(db).id, buildKey: buildKeyOf(db) };
    } finally { close(db); }
  };
  const a = await template("a");
  const b = await template("b", repo => appendFile(path.join(repo, serviceRel), "\n// changed for snapshot B\n"));
  assert.notEqual(a.contentManifestId, b.contentManifestId);
  assert.equal(a.buildKey, b.buildKey);
  const identity = async (dir: string): Promise<RootIdentity> => {
    const info = await stat(dir);
    return { canonicalRoot: dir, dev: info.dev, ino: info.ino, volume: "test-volume" };
  };
  fixture = { base, root: await identity(path.join(base, "repo-a")), otherRoot: await identity(path.join(base, "repo-b")), a, b };
});
test.after(async () => {
  if (!fixture) return;
  // Sealed directories are 0555 by design; only the test's own teardown lifts that.
  const writable = async (dir: string): Promise<void> => {
    await chmod(dir, 0o755);
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
  };
  await writable(fixture.base);
  await rm(fixture.base, { recursive: true, force: true });
});

async function cacheRoot(): Promise<string> {
  return mkdtemp(path.join(fixture.base, "cache-"));
}

function plan(template: Template, overrides: Partial<BindPlan> = {}): BindPlan {
  return { workspaceId: WS, workspaceGeneration: 1, trackerEpoch: EPOCH, bindingVersion: 0, coveredThroughSeq: 1, root: fixture.root,
    captureId: "cap-00000001", contentManifestId: template.contentManifestId, buildKey: template.buildKey, ...overrides };
}

async function openStore(root: string, options: Parameters<typeof SnapshotStore.open>[1] = {}) {
  const opened = await SnapshotStore.open(root, options);
  opened.store.track(WS, { root: fixture.root, workspaceGeneration: 1, trackerEpoch: EPOCH });
  return opened;
}

async function jobFrom(store: SnapshotStore, template: Template, captureId = "cap-00000001", workspaceId = WS): Promise<BuildJob> {
  const job = await store.createJob({ workspaceId, captureId });
  await copyFile(template.file, job.dbPath);
  return job;
}

async function rejectedWith(promise: Promise<unknown>, reason: RejectReason): Promise<void> {
  await assert.rejects(promise, error => error instanceof BindRejected && error.reason === reason);
}

const snapshotsOf = async (root: string) => (await readdir(path.join(root, "mac1", "snapshots"))).sort();
const jobsOf = async (root: string) => (await readdir(path.join(root, "mac1", "jobs"))).sort();
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mode = async (file: string) => (await stat(file)).mode & 0o777;

test("a sealed snapshot is exactly an immutable database and manifest, read only through immutable mode", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const binding = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  assert.equal(binding.bindingVersion, 1);
  const dir = path.join(root, "mac1", "snapshots", binding.snapshotId);
  assert.deepEqual((await readdir(dir)).sort(), [DB_FILE, MANIFEST_FILE]);
  assert.equal(await mode(dir), 0o555);
  assert.equal(await mode(path.join(dir, DB_FILE)), 0o444);
  assert.equal(await mode(path.join(dir, MANIFEST_FILE)), 0o444);
  await assert.rejects(access(path.join(dir, DB_FILE), constants.W_OK));
  const manifest = await readSealedManifest(store.layout, binding.snapshotId, { verifyFile: true });
  assert.equal(manifest.contentManifestId, fixture.a.contentManifestId);
  assert.equal(manifest.buildKey, fixture.a.buildKey);
  assert.equal(binding.contentManifestId, manifest.contentManifestId);
  const db = openSealedDatabase(store.layout, binding.snapshotId);
  try {
    assert.ok((db.prepare("SELECT count(*) AS n FROM file").get() as { n: number }).n > 0);
    assert.throws(() => db.exec("DELETE FROM meta"), /readonly/i);
  } finally { db.close(); }
  assert.deepEqual((await readdir(dir)).sort(), [DB_FILE, MANIFEST_FILE], "immutable reads create no WAL/SHM");
  // Code entry point as well as mode: no writer opens a sealed path.
  assert.throws(() => openIndexDb(path.join(dir, DB_FILE)), /sealed snapshots are read-only/);
  close(openIndexDb(path.join(dir, DB_FILE), { readOnly: true }));
  // The job directory of a published candidate holds no database any more.
  assert.equal((await jobsOf(root)).length, 1);
  assert.equal(existsSync(path.join(root, "mac1", "jobs", (await jobsOf(root))[0]!, DB_FILE)), false);
  const persisted = await readBinding(store.layout, WS);
  assert.deepEqual(persisted, binding);
});

test("sealing refuses a database with a live writer or an incomplete build and publishes nothing", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const busy = await jobFrom(store, fixture.a);
  const writer = openIndexDb(busy.dbPath);
  try {
    writer.exec("BEGIN; UPDATE meta SET value=value WHERE key='schemaVersion';");
    await assert.rejects(store.publish(plan(fixture.a), busy), /locked|busy|writer still holds/i);
    writer.exec("ROLLBACK");
  } finally { close(writer); }
  // An idle writer handle is still a writer: its later writes would land in a sealed file.
  const idle = await jobFrom(store, fixture.a);
  const idleWriter = openIndexDb(idle.dbPath);
  try {
    idleWriter.prepare("SELECT count(*) FROM meta").get();
    await assert.rejects(store.publish(plan(fixture.a), idle), /locked|busy|writer still holds|journal_mode/i);
  } finally { close(idleWriter); }
  const incomplete = await jobFrom(store, fixture.a);
  const db = openIndexDb(incomplete.dbPath);
  try { db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('buildState', 'BUILDING')").run(); } finally { close(db); }
  await assert.rejects(store.publish(plan(fixture.a), incomplete), /incomplete build/);
  assert.deepEqual(await snapshotsOf(root), []);
  assert.equal(store.binding(WS), undefined);
  assert.equal(await readBinding(store.layout, WS), undefined);
});

const SEAL_STEPS = ["sealed-checkpointed", "sealed-verified", "manifest-written", "snapshot-renamed"];
const BINDING_STEPS = ["binding-tmp-written", "binding-renamed", "workspace-synced"];
const NEW_BINDING = new Set(["binding-renamed", "workspace-synced", "none"]);

async function assertRecovered(root: string, step: string, oldSnapshot: string, extra: { newSnapshot?: string; jobId?: string }) {
  const { store, recovery } = await openStore(root);
  const binding = store.binding(WS)!;
  assert.ok(binding, `${step}: a binding survives`);
  assert.deepEqual(recovery.invalidBindings, [], `${step}: binding is complete`);
  assert.deepEqual(await readBinding(store.layout, WS), binding);
  if (NEW_BINDING.has(step)) {
    assert.equal(binding.bindingVersion, 2, step);
    assert.notEqual(binding.snapshotId, oldSnapshot, step);
    assert.equal(binding.contentManifestId, fixture.b.contentManifestId, step);
  } else {
    assert.equal(binding.bindingVersion, 1, step);
    assert.equal(binding.snapshotId, oldSnapshot, step);
    assert.equal(binding.contentManifestId, fixture.a.contentManifestId, step);
  }
  assert.equal(recovery.removedBindingTmp.length, step === "binding-tmp-written" ? 1 : 0, step);
  assert.deepEqual((await readdir(path.join(root, "mac1", "workspaces", WS))).sort(), [BINDING_FILE], step);
  // The bound snapshot verifies; everything else is reclaimable now, for real.
  await readSealedManifest(store.layout, binding.snapshotId, { verifyFile: true });
  const unbound = recovery.unboundSnapshots;
  if (extra.newSnapshot && !NEW_BINDING.has(step) && ["snapshot-renamed", ...BINDING_STEPS].includes(step)) assert.deepEqual(unbound, [extra.newSnapshot], step);
  for (const snapshotId of unbound) assert.deepEqual(await store.tryReclaim({ snapshotId }), { reclaimed: true });
  assert.deepEqual(await store.tryReclaim({ snapshotId: binding.snapshotId }), { reclaimed: false, reason: "bound" });
  for (const jobId of recovery.staleJobs) assert.deepEqual(await store.tryReclaim({ jobId }), { reclaimed: true });
  if (extra.jobId) assert.ok(recovery.staleJobs.includes(extra.jobId), step);
  assert.deepEqual(await snapshotsOf(root), [binding.snapshotId], step);
  assert.deepEqual(await jobsOf(root), [], step);
}

test("an in-process failure at every seal, rename and binding boundary leaves the complete old or new binding", async () => {
  for (const step of [...SEAL_STEPS, ...BINDING_STEPS]) {
    const root = await cacheRoot();
    let failAt = "";
    const { store } = await openStore(root, { faultAt: at => { if (at === failAt) throw new Error(`fault ${at}`); } });
    const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
    failAt = step;
    const job = await jobFrom(store, fixture.b, "cap-00000002");
    await assert.rejects(store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), job), new RegExp(`fault ${step}`));
    // Memory follows the disk: the served binding is what a restart would see.
    assert.deepEqual(store.binding(WS), await readBinding(store.layout, WS), step);
    store.finishJob(job);
    await assertRecovered(root, step, first.snapshotId, { newSnapshot: job.snapshotId, jobId: job.jobId });
  }
});

test("a SIGKILL at every publish boundary recovers the complete old or new binding", async () => {
  for (const step of [...SEAL_STEPS, ...BINDING_STEPS, "none"]) {
    const root = await cacheRoot();
    const { store } = await openStore(root);
    const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
    const child = fork(path.join(dirname, "publish-crash-child.js"), [JSON.stringify({ cacheRoot: root, template: fixture.b.file, step,
      plan: plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }) })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
    if (step === "none") assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    else assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, `${step}: ${stderr}`);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line) as { jobId?: string; published?: string });
    const jobId = lines[0]!.jobId!;
    const newSnapshot = (await snapshotsOf(root)).find(id => id !== first.snapshotId);
    await assertRecovered(root, step, first.snapshotId, { newSnapshot, jobId });
  }
});

test("a wrong root, generation, buildKey, capture or content cannot confirm a binding", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const next = (overrides: Partial<BindPlan>) => plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002", ...overrides });
  const job = await jobFrom(store, fixture.b, "cap-00000002");
  await rejectedWith(store.publish(next({ captureId: "cap-00000003" }), job), "capture");
  await rejectedWith(store.publish(next({ root: { ...fixture.root, ino: fixture.root.ino + 1 } }), job), "root");
  await rejectedWith(store.publish(next({ root: fixture.otherRoot }), job), "root");
  await rejectedWith(store.publish(next({ workspaceGeneration: 2 }), job), "generation");
  await rejectedWith(store.publish(next({ buildKey: "0".repeat(64) }), job), "build-key");
  await rejectedWith(store.publish(next({ contentManifestId: fixture.a.contentManifestId }), job), "content");
  await rejectedWith(store.publish(next({ workspaceId: "ws-untracked-01" }), await jobFrom(store, fixture.b, "cap-00000002", "ws-untracked-01")), "not-tracked");
  // The workspace root was replaced at the same path: the tracker moves on, old plans cannot land.
  store.track(WS, { root: { ...fixture.root, ino: fixture.root.ino + 1 }, workspaceGeneration: 2, trackerEpoch: EPOCH });
  await rejectedWith(store.publish(next({ workspaceGeneration: 2, root: { ...fixture.root, ino: fixture.root.ino + 1 } }), job), "root");
  assert.equal(store.binding(WS)!.snapshotId, first.snapshotId);
  assert.equal((await readBinding(store.layout, WS))!.bindingVersion, 1);
});

test("a verified noop moves only the watermark: no database is written and no snapshot is added", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a, { coveredThroughSeq: 5 }), await jobFrom(store, fixture.a));
  const file = store.snapshotPath(first.snapshotId);
  const before = { sha: sha(file), mtime: (await stat(file)).mtimeMs, snapshots: await snapshotsOf(root), jobs: await jobsOf(root) };
  const noop = await store.confirmNoop(plan(fixture.a, { bindingVersion: 1, coveredThroughSeq: 9, captureId: "cap-00000002" }));
  assert.deepEqual({ snapshotId: noop.snapshotId, bindingVersion: noop.bindingVersion, coveredThroughSeq: noop.coveredThroughSeq }, { snapshotId: first.snapshotId, bindingVersion: 2, coveredThroughSeq: 9 });
  assert.deepEqual(await readBinding(store.layout, WS), noop);
  assert.deepEqual({ sha: sha(file), mtime: (await stat(file)).mtimeMs, snapshots: await snapshotsOf(root), jobs: await jobsOf(root) }, before);
  await rejectedWith(store.confirmNoop(plan(fixture.b, { bindingVersion: 2, coveredThroughSeq: 10 })), "content");
  await rejectedWith(store.confirmNoop(plan(fixture.a, { bindingVersion: 2, coveredThroughSeq: 8 })), "watermark");
  // A new event stream: the old epoch is refused even with the same seq; the new one may restart its seq.
  store.track(WS, { root: fixture.root, workspaceGeneration: 1, trackerEpoch: "epoch-0002" });
  await rejectedWith(store.confirmNoop(plan(fixture.a, { bindingVersion: 2, coveredThroughSeq: 9 })), "tracker-epoch");
  const restarted = await store.confirmNoop(plan(fixture.a, { bindingVersion: 2, coveredThroughSeq: 0, trackerEpoch: "epoch-0002" }));
  assert.deepEqual([restarted.bindingVersion, restarted.trackerEpoch, restarted.coveredThroughSeq], [3, "epoch-0002", 0]);
  const unbound = await SnapshotStore.open(await cacheRoot());
  unbound.store.track(WS, { root: fixture.root, workspaceGeneration: 1, trackerEpoch: EPOCH });
  await rejectedWith(unbound.store.confirmNoop(plan(fixture.a)), "no-binding");
});

test("concurrent publishes and noops cannot carry a stale verification onto a newer binding", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const dispatched = plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" });
  const [left, right] = await Promise.allSettled([
    store.publish(dispatched, await jobFrom(store, fixture.b, "cap-00000002")),
    store.publish(dispatched, await jobFrom(store, fixture.b, "cap-00000002"))
  ]);
  const outcomes = [left, right].map(result => result.status === "fulfilled" ? "bound" : (result.reason as BindRejected).reason).sort();
  assert.deepEqual(outcomes, ["binding-version", "bound"]);
  // A noop verified against version 1 cannot confirm version 2's different content.
  await rejectedWith(store.confirmNoop(plan(fixture.a, { bindingVersion: 1, coveredThroughSeq: 3 })), "binding-version");
  const race = await Promise.allSettled([
    store.confirmNoop(plan(fixture.b, { bindingVersion: 2, coveredThroughSeq: 4 })),
    store.publish(plan(fixture.a, { bindingVersion: 2, coveredThroughSeq: 4, captureId: "cap-00000004" }), await jobFrom(store, fixture.a, "cap-00000004"))
  ]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(race.filter(result => result.status === "rejected" && (result.reason as BindRejected).reason === "binding-version").length, 1);
  assert.equal(store.binding(WS)!.bindingVersion, 3);
  assert.deepEqual(await readBinding(store.layout, WS), store.binding(WS));
});

test("zero-diff binds an existing snapshot to another workspace only after full verification", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const other = "ws-beta-00001";
  store.track(other, { root: fixture.otherRoot, workspaceGeneration: 1, trackerEpoch: "epoch-beta-1" });
  const otherPlan = (template: Template, overrides: Partial<BindPlan> = {}) =>
    plan(template, { workspaceId: other, root: fixture.otherRoot, trackerEpoch: "epoch-beta-1", captureId: "cap-beta-0001", ...overrides });
  await rejectedWith(store.bindVerified(otherPlan(fixture.b), first.snapshotId), "content");
  await rejectedWith(store.bindVerified(otherPlan(fixture.a, { root: fixture.root }), first.snapshotId), "root");
  const bound = await store.bindVerified(otherPlan(fixture.a), first.snapshotId);
  assert.deepEqual([bound.snapshotId, bound.bindingVersion, bound.root], [first.snapshotId, 1, fixture.otherRoot]);
  assert.deepEqual(await snapshotsOf(root), [first.snapshotId]);
  assert.equal(store.leaseCount(first.snapshotId), 0);
  // A file that no longer matches its manifest digest is never bound.
  const third = "ws-gamma-0001";
  store.track(third, { root: fixture.otherRoot, workspaceGeneration: 1, trackerEpoch: "epoch-gamma" });
  const dir = path.join(root, "mac1", "snapshots", first.snapshotId);
  await chmod(dir, 0o755);
  await chmod(path.join(dir, DB_FILE), 0o644);
  const handle = await open(path.join(dir, DB_FILE), "r+");
  try { await handle.write(Buffer.from([0x5a]), 0, 1, (await handle.stat()).size - 1); } finally { await handle.close(); }
  await chmod(path.join(dir, DB_FILE), 0o444);
  await chmod(dir, 0o555);
  await assert.rejects(store.bindVerified(otherPlan(fixture.a, { workspaceId: third, trackerEpoch: "epoch-gamma" }), first.snapshotId), /digest mismatch/);
  assert.equal(store.binding(third), undefined);
});

test("a paused base survives other publishes and concurrent reclaim; release makes it really deletable", async () => {
  const root = await cacheRoot();
  let onMarked: (() => void) | undefined;
  const { store } = await openStore(root, { faultAt: at => { if (at === "reclaim-marked") onMarked?.(); } });
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const base = store.acquire(first.snapshotId, "base");
  const job = await store.createJob({ workspaceId: WS, captureId: "cap-00000002" });
  await store.cloneBase(base, job);
  assert.equal(sha(job.dbPath), sha(base.dbPath));
  assert.equal(await mode(job.dbPath), 0o644);
  // An open job and its directory are in flight.
  assert.deepEqual(await store.tryReclaim({ jobId: job.jobId }), { reclaimed: false, reason: "in-flight" });
  const second = await store.publish(plan(fixture.a, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), job);
  assert.notEqual(second.snapshotId, first.snapshotId);
  // Unbound now, but the base lease pauses it against every reclaimer.
  const blocked = await Promise.all([store.tryReclaim({ snapshotId: first.snapshotId }), store.tryReclaim({ snapshotId: first.snapshotId })]);
  assert.deepEqual(blocked, [{ reclaimed: false, reason: "leased" }, { reclaimed: false, reason: "leased" }]);
  assert.ok(existsSync(base.dbPath));
  base.release();
  base.release();
  let markedRefusal: unknown;
  onMarked = () => { try { store.acquire(first.snapshotId, "request"); } catch (error) { markedRefusal = error; } };
  const results = await Promise.all([store.tryReclaim({ snapshotId: first.snapshotId }), store.tryReclaim({ snapshotId: first.snapshotId })]);
  assert.deepEqual(results, [{ reclaimed: true }, { reclaimed: false, reason: "missing" }]);
  assert.match(String(markedRefusal), /being reclaimed/);
  assert.equal(existsSync(path.join(root, "mac1", "snapshots", first.snapshotId)), false);
  assert.throws(() => store.acquire(first.snapshotId, "request"), /not sealed/);
  assert.deepEqual(await store.tryReclaim({ snapshotId: second.snapshotId }), { reclaimed: false, reason: "bound" });
  assert.deepEqual(await store.tryReclaim({ jobId: job.jobId }), { reclaimed: true });
  assert.equal((await jobsOf(root)).includes(job.jobId), false);
});

test("a sealed candidate is in flight until finished, and a reader lease keeps its view across publishes", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  assert.equal(store.acquireBound(WS, "request"), undefined);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const reader = store.acquireBound(WS, "request")!;
  assert.equal(reader.lease.snapshotId, first.snapshotId);
  const sealedOnly = await jobFrom(store, fixture.b, "cap-00000009");
  const manifest = await store.seal(sealedOnly);
  assert.deepEqual(await store.tryReclaim({ snapshotId: manifest.snapshotId }), { reclaimed: false, reason: "in-flight" });
  store.finishJob(sealedOnly);
  assert.deepEqual(await store.tryReclaim({ snapshotId: manifest.snapshotId }), { reclaimed: true });
  await store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), await jobFrom(store, fixture.b, "cap-00000002"));
  assert.notEqual(store.binding(WS)!.snapshotId, first.snapshotId);
  const serviceHash = (snapshotId: string) => {
    const db = openSealedDatabase(store.layout, snapshotId);
    try { return (db.prepare("SELECT content_hash AS h FROM file WHERE path=?").get(serviceRel) as { h: string }).h; } finally { db.close(); }
  };
  assert.notEqual(serviceHash(reader.lease.snapshotId), serviceHash(store.binding(WS)!.snapshotId), "the old lease still reads the old content");
  assert.deepEqual(await store.tryReclaim({ snapshotId: first.snapshotId }), { reclaimed: false, reason: "leased" });
  reader.lease.release();
  assert.deepEqual(await store.tryReclaim({ snapshotId: first.snapshotId }), { reclaimed: true });
});

test("a snapshot with a WAL, SHM or journal sidecar is not a sealed snapshot", async () => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const root = await cacheRoot();
    const { store } = await openStore(root);
    const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
    const dir = path.join(root, "mac1", "snapshots", first.snapshotId);
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, `${DB_FILE}${suffix}`), "");
    await chmod(dir, 0o555);
    await assert.rejects(readSealedManifest(store.layout, first.snapshotId), new RegExp(`${suffix} present`));
    const other = "ws-beta-00001";
    store.track(other, { root: fixture.otherRoot, workspaceGeneration: 1, trackerEpoch: EPOCH });
    await assert.rejects(store.bindVerified(plan(fixture.a, { workspaceId: other, root: fixture.otherRoot }), first.snapshotId), /present/);
    const reopened = await openStore(root);
    assert.deepEqual(reopened.recovery.invalidBindings.map(entry => entry.workspaceId), [WS], suffix);
  }
});

test("recovery ignores foreign entries such as .DS_Store and never deletes them", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  for (const dir of ["workspaces", "snapshots", "jobs"]) await writeFile(path.join(root, "mac1", dir, ".DS_Store"), "finder");
  const snapshots = path.join(root, "mac1", "snapshots");
  const reopened = await openStore(root);
  assert.deepEqual(reopened.recovery.ignored, ["jobs/.DS_Store", "snapshots/.DS_Store", "workspaces/.DS_Store"]);
  assert.deepEqual(reopened.recovery.bindings.map(entry => entry.snapshotId), [first.snapshotId]);
  assert.deepEqual(reopened.recovery.unboundSnapshots, []);
  assert.ok(existsSync(path.join(snapshots, ".DS_Store")));
});

test("a sealed snapshot whose directory became writable is not sealed", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  await chmod(path.join(root, "mac1", "snapshots", first.snapshotId), 0o755);
  await assert.rejects(readSealedManifest(store.layout, first.snapshotId), /directory is writable/);
  assert.deepEqual((await openStore(root)).recovery.invalidBindings.map(entry => entry.workspaceId), [WS]);
});

test("recovery refuses a binding that does not match its snapshot manifest", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const file = path.join(root, "mac1", "workspaces", WS, BINDING_FILE);
  await writeFile(file, (await readFile(file, "utf8")).replace(first.contentManifestId, fixture.b.contentManifestId));
  const reopened = await openStore(root);
  assert.deepEqual(reopened.recovery.invalidBindings.map(entry => [entry.workspaceId, entry.bindingVersion]), [[WS, 1]]);
  assert.equal(reopened.store.bindingVersionOf(WS), 1);
  assert.equal(reopened.store.acquireBound(WS, "request"), undefined);
  // Not served, but not garbage either: the snapshot stays until a verified publish replaces the binding.
  assert.deepEqual(reopened.recovery.unboundSnapshots, []);
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: first.snapshotId }), { reclaimed: false, reason: "bound" });
  const rebound = await reopened.store.publish(plan(fixture.b, { bindingVersion: reopened.store.bindingVersionOf(WS), coveredThroughSeq: 2, captureId: "cap-00000002" }),
    await jobFrom(reopened.store, fixture.b, "cap-00000002"));
  assert.equal(rebound.bindingVersion, 2);
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: first.snapshotId }), { reclaimed: true });
});
