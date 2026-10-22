import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, appendFile, chmod, copyFile, cp, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { logicalDigest } from "../sql/logical-export.js";
import { deflateRawSync } from "node:zlib";
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

test("orphan references and corrupt facts cannot replace a valid binding", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const original = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const mutations: Array<{ sql: string; value: number | bigint | string | Buffer; error: RegExp }> = [
    { sql: "UPDATE kg_edge SET kind_sym=? WHERE id=(SELECT min(id) FROM kg_edge)", value: 999999999, error: /orphan reference/ },
    { sql: "UPDATE kg_edge SET from_sym=? WHERE id=(SELECT min(id) FROM kg_edge)", value: 999999999, error: /orphan reference/ },
    { sql: "UPDATE search_doc SET declaration_sym=? WHERE id=(SELECT min(id) FROM search_doc)", value: 999999999, error: /orphan reference/ },
    { sql: "UPDATE entity_token SET tf=? WHERE (entity_sym, field, token_sym)=(SELECT entity_sym, field, token_sym FROM entity_token LIMIT 1)", value: 9223372036854775807n, error: /unsafe integer/ },
    { sql: "UPDATE file SET facts=? WHERE id=(SELECT min(id) FROM file)", value: "not a blob", error: /expected facts blob/ },
    { sql: "UPDATE file SET facts=? WHERE id=(SELECT min(id) FROM file)", value: Buffer.from("invalid deflate"), error: /invalid|incorrect|unexpected|unknown/i },
    { sql: "UPDATE file SET facts=? WHERE id=(SELECT min(id) FROM file)", value: deflateRawSync(Buffer.from("not JSON")), error: /JSON/ }
  ];
  for (const mutation of mutations) {
    const job = await jobFrom(store, fixture.b, "cap-00000002");
    const db = openIndexDb(job.dbPath);
    try { db.prepare(mutation.sql).run(mutation.value); } finally { close(db); }
    await assert.rejects(store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), job), mutation.error);
    assert.deepEqual(store.binding(WS), original);
    assert.deepEqual(await readBinding(store.layout, WS), original);
    assert.deepEqual(await snapshotsOf(root), [original.snapshotId]);
  }
});

test("a file changed during verification or after manifest construction cannot replace a valid binding", async () => {
  const root = await cacheRoot();
  let mutateAt = "", source = "";
  const { store } = await openStore(root, { faultAt: async at => {
    if (at !== mutateAt) return;
    await chmod(source, 0o644);
    const db = new DatabaseSync(source);
    try { db.exec("INSERT INTO meta(key, value) VALUES('sealMutation', 'changed')"); }
    finally { db.close(); await chmod(source, 0o444); }
  } });
  const original = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  for (const step of ["verification-planned", "sealed-verified"]) {
    const job = await jobFrom(store, fixture.b, "cap-00000002");
    source = job.dbPath;
    mutateAt = step;
    await assert.rejects(store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), job), /database changed during verification/);
    assert.deepEqual(store.binding(WS), original);
    assert.deepEqual(await readBinding(store.layout, WS), original);
    assert.deepEqual(await snapshotsOf(root), [original.snapshotId]);
  }
});

const SEAL_STEPS = ["sealed-checkpointed", "verification-planned", "sealed-verified", "manifest-written", "snapshot-renamed"];
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

test("recovery quarantines the old manifest format until a verified publish replaces it", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const original = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const manifest = await readSealedManifest(store.layout, original.snapshotId);
  const db = openSealedDatabase(store.layout, original.snapshotId);
  let logical;
  try { logical = logicalDigest(db); } finally { db.close(); }
  const file = path.join(store.layout.snapshots, original.snapshotId, MANIFEST_FILE);
  await chmod(file, 0o644);
  await writeFile(file, JSON.stringify({ ...manifest, formatVersion: "ilv2-snapshot-manifest/mac1", logical }));
  await chmod(file, 0o444);
  const reopened = await openStore(root);
  assert.deepEqual(reopened.recovery.invalidBindings.map(entry => [entry.workspaceId, entry.bindingVersion]), [[WS, 1]]);
  assert.equal(reopened.store.acquireBound(WS, "request"), undefined);
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: original.snapshotId }), { reclaimed: false, reason: "bound" });
  const next = await reopened.store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }),
    await jobFrom(reopened.store, fixture.b, "cap-00000002"));
  assert.equal(next.bindingVersion, 2);
  assert.equal((await readSealedManifest(reopened.store.layout, next.snapshotId)).formatVersion, "ilv2-snapshot-manifest/mac3");
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: original.snapshotId }), { reclaimed: true });
});

test("one sweep removes a dead incarnation's jobs, unbound snapshots and empty workspace dirs, and nothing it does not own", async () => {
  const root = await cacheRoot();
  const first = await openStore(root);
  const published = await jobFrom(first.store, fixture.a);
  const bound = await first.store.publish(plan(fixture.a), published);
  // Left by the dead incarnation: an open job, a sealed but unbound candidate, an empty workspace dir.
  const open = await jobFrom(first.store, fixture.b, "cap-00000002");
  const sealed = await jobFrom(first.store, fixture.b, "cap-00000003");
  const candidate = await first.store.seal(sealed);
  await mkdir(path.join(root, "mac1", "workspaces", "ws-crashed-before-binding"));
  // Not store objects: the owner lock directory, a legacy cache, Finder files, an odd name.
  const foreign = [path.join(root, "mac1", "owner", "keep.lock"), path.join(root, "legacy-v9", "index.sqlite"),
    path.join(root, "mac1", "snapshots", ".DS_Store"), path.join(root, "mac1", "jobs", "short")];
  for (const file of foreign) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "keep"); }
  const second = await openStore(root);
  const report = await second.store.sweep();
  assert.deepEqual(report.snapshots, [candidate.snapshotId]);
  // Every job dir of a dead incarnation is stale, including the finished one of the bound snapshot.
  assert.deepEqual(report.jobs.sort(), [published.jobId, open.jobId, sealed.jobId].sort());
  assert.deepEqual(report.workspaces, ["ws-crashed-before-binding"]);
  assert.equal(report.kept.bound, 1);
  assert.equal(report.kept.tracked, 1);
  assert.deepEqual(await snapshotsOf(root), [".DS_Store", bound.snapshotId]);
  assert.deepEqual(await jobsOf(root), ["short"]);
  for (const file of foreign) assert.equal(readFileSync(file, "utf8"), "keep", file);
  await readSealedManifest(second.store.layout, bound.snapshotId, { verifyFile: true });
  // Converged: a second cycle finds nothing more to delete.
  const again = await second.store.sweep();
  assert.deepEqual([again.snapshots, again.jobs, again.workspaces], [[], [], []]);
});

test("no lease of any purpose loses its snapshot to a sweep; the last release makes it reclaimable", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  await store.publish(plan(fixture.b, { bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-00000002" }), await jobFrom(store, fixture.b, "cap-00000002"));
  for (const purpose of ["request", "query-worker", "candidate-scan", "base", "publish"] as const) {
    const lease = store.acquire(first.snapshotId, purpose);
    const report = await store.sweep();
    assert.deepEqual(report.snapshots, [], purpose);
    assert.equal(report.kept.leased, 1, purpose);
    assert.ok(existsSync(lease.dbPath), purpose);
    lease.release();
  }
  assert.deepEqual((await store.sweep()).snapshots, [first.snapshotId]);
});

test("a workspace binding goes only when its root is gone and no tracker, job or lease still serves it", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const parent = await realpath(await mkdtemp(path.join(fixture.base, "roots-")));
  const identity = async (dir: string): Promise<RootIdentity> => { const info = await stat(dir); return { canonicalRoot: dir, dev: info.dev, ino: info.ino, volume: String(info.dev) }; };
  const bindAt = async (workspaceId: string, rootIdentity: RootIdentity, captureId: string) => {
    store.track(workspaceId, { root: rootIdentity, workspaceGeneration: 1, trackerEpoch: EPOCH });
    return store.publish(plan(fixture.a, { workspaceId, root: rootIdentity, captureId }), await jobFrom(store, fixture.a, captureId, workspaceId));
  };
  await mkdir(path.join(parent, "live"));
  const live = await identity(path.join(parent, "live"));
  const replacedDir = path.join(parent, "replaced");
  await mkdir(replacedDir);
  const replaced = await identity(replacedDir);
  const removedDir = path.join(parent, "removed");
  await mkdir(removedDir);
  const removed = await identity(removedDir);
  // A root on a volume that is not mounted now: its parent is on another device, so it may come back.
  const unmounted: RootIdentity = { canonicalRoot: path.join(parent, "volume-gone", "repo"), dev: live.dev + 7, ino: 42, volume: String(live.dev + 7) };
  const bindings = {
    live: await bindAt("ws-live-0000001", live, "cap-live-0001"),
    replaced: await bindAt("ws-replaced-001", replaced, "cap-repl-0001"),
    removed: await bindAt("ws-removed-0001", removed, "cap-remv-0001"),
    unmounted: await bindAt("ws-unmounted-01", unmounted, "cap-unmt-0001")
  };
  await rm(replacedDir, { recursive: true });
  await mkdir(replacedDir);
  await rm(removedDir, { recursive: true });
  // Still tracked with the bound root: the tracker judges it, not the sweep.
  assert.deepEqual(await store.tryReclaim({ workspaceId: "ws-replaced-001" }), { reclaimed: false, reason: "tracked" });
  for (const id of ["ws-live-0000001", "ws-replaced-001", "ws-removed-0001", "ws-unmounted-01"]) store.untrack(id);
  const job = await store.createJob({ workspaceId: "ws-removed-0001", captureId: "cap-remv-0002" });
  const lease = store.acquire(bindings.replaced.snapshotId, "request");
  assert.deepEqual(await store.tryReclaim({ workspaceId: "ws-removed-0001" }), { reclaimed: false, reason: "in-flight" });
  assert.deepEqual(await store.tryReclaim({ workspaceId: "ws-replaced-001" }), { reclaimed: false, reason: "leased" });
  assert.deepEqual(await store.tryReclaim({ workspaceId: "ws-live-0000001" }), { reclaimed: false, reason: "root-live" });
  assert.deepEqual(await store.tryReclaim({ workspaceId: "ws-unmounted-01" }), { reclaimed: false, reason: "root-unconfirmed" });
  store.finishJob(job);
  lease.release();
  const report = await store.sweep();
  assert.deepEqual(report.workspaces, ["ws-removed-0001", "ws-replaced-001"]);
  // The freed snapshots go in the same cycle; zero-diff siblings share none here.
  assert.deepEqual(report.snapshots.sort(), [bindings.removed.snapshotId, bindings.replaced.snapshotId].sort());
  assert.equal(store.binding("ws-replaced-001"), undefined);
  assert.equal(existsSync(path.join(root, "mac1", "workspaces", "ws-replaced-001")), false);
  assert.ok(store.binding("ws-live-0000001") && store.binding("ws-unmounted-01"));
  const reopened = await openStore(root);
  assert.deepEqual(reopened.recovery.bindings.map(entry => entry.workspaceId).sort(), ["ws-live-0000001", "ws-unmounted-01"]);
});

test("a job is registered before its directory exists, so a concurrent sweep never deletes it", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  for (let index = 0; index < 20; index += 1) {
    const [job] = await Promise.all([store.createJob({ workspaceId: WS, captureId: `cap-race-${String(index).padStart(4, "0")}` }), store.sweep(), store.sweep()]);
    assert.ok(existsSync(job.dir), `job ${index}`);
    assert.deepEqual(await store.tryReclaim({ jobId: job.jobId }), { reclaimed: false, reason: "in-flight" });
  }
});

// ------------------------------------------------------------ MAC-12 plan B: delta seal, background verification

/** A delta job: cloned from `baseId`, then holding `template`'s build in which only `serviceRel` was rewritten (generation 2). */
async function deltaJob(store: SnapshotStore, baseId: string, template: Template, captureId: string, mutate?: (db: DatabaseSync) => void): Promise<BuildJob> {
  const base = store.acquire(baseId, "base");
  const job = await store.createJob({ workspaceId: WS, captureId });
  try { await store.cloneBase(base, job); } finally { base.release(); }
  await copyFile(template.file, job.dbPath);
  const db = new DatabaseSync(job.dbPath);
  try {
    db.exec("UPDATE meta SET value='2' WHERE key='indexedGeneration'");
    db.prepare("UPDATE file SET generation=2 WHERE path=?").run(serviceRel);
    mutate?.(db);
  } finally { db.close(); }
  return job;
}

const nextPlan = (template: Template, bindingVersion: number, seq: number) =>
  plan(template, { bindingVersion, coveredThroughSeq: seq, captureId: `cap-0000000${seq}` });

test("a delta publish checks only the rows its build wrote and leaves the full check to a background verdict", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  assert.equal(store.verification(first.snapshotId)?.result, "VERIFIED", "a full seal is verified at once");
  // A corrupt row of the rewritten file is refused before publish.
  const touched = await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002", db =>
    db.prepare("UPDATE file SET facts=? WHERE path=?").run(Buffer.from("invalid deflate"), serviceRel));
  await assert.rejects(store.publish(nextPlan(fixture.b, 1, 2), touched), /invalid|incorrect|unexpected|unknown/i);
  assert.deepEqual(store.binding(WS)?.snapshotId, first.snapshotId);
  store.finishJob(touched);
  // So is an orphan in a graph row the rewritten file owns.
  const owned = await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002", db => {
    const changed = db.prepare(`UPDATE kg_edge SET kind_sym=999999999 WHERE id=(SELECT min(edge_id) FROM kg_edge_owner
      WHERE owner_sym=(SELECT id FROM sym WHERE text=?))`).run(serviceRel).changes;
    assert.equal(Number(changed), 1, "the rewritten file owns graph edges");
  });
  await assert.rejects(store.publish(nextPlan(fixture.b, 1, 2), owned), /orphan reference in kg_edge/);
  store.finishJob(owned);
  const job = await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002");
  const second = await store.publish(nextPlan(fixture.b, 1, 2), job);
  assert.equal(job.sealTimings?.hashMs, undefined, "no file digest on the delta publish path");
  assert.equal(store.verification(second.snapshotId), undefined);
  assert.deepEqual(store.unverifiedBound(), [second.snapshotId]);
  const manifest = await readSealedManifest(store.layout, second.snapshotId);
  assert.deepEqual(Object.keys(manifest.file).sort(), ["bytes", "pageSize", "pages"]);
  await assert.rejects(readSealedManifest(store.layout, second.snapshotId, { verifyFile: true }), /not verified/);
  // An unverified snapshot is still a seed: its verdict applies to every binding on it.
  assert.deepEqual(store.seedCandidates("ws-other-00001", fixture.b.buildKey), [second.snapshotId]);
  assert.deepEqual(await store.verifySnapshot(second.snapshotId), { result: "VERIFIED" });
  const record = JSON.parse(await readFile(path.join(root, "mac1", "verified", `${second.snapshotId}.json`), "utf8"));
  assert.deepEqual([record.result, record.bytes, record.sha256], ["VERIFIED", (await stat(store.snapshotPath(second.snapshotId))).size, sha(store.snapshotPath(second.snapshotId))]);
  await readSealedManifest(store.layout, second.snapshotId, { verifyFile: true });
  const reopened = await openStore(root);
  assert.equal(reopened.store.isVerified(second.snapshotId), true);
  assert.deepEqual(reopened.recovery.unverified, []);
});

test("a background FAILED verdict quarantines the binding and every unverified descendant, persistently", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  // A graph row the rewritten file does not own, with an orphan reference: outside the delta check.
  const job = await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002", db =>
    db.prepare(`UPDATE kg_edge SET kind_sym=999999999 WHERE id=(SELECT min(id) FROM kg_edge WHERE id NOT IN
      (SELECT edge_id FROM kg_edge_owner WHERE owner_sym=(SELECT id FROM sym WHERE text=?)))`).run(serviceRel));
  const second = await store.publish(nextPlan(fixture.b, 1, 2), job);
  store.finishJob(job);
  // Built on the unverified snapshot before its verdict: a sealed child and an open job.
  const child = await deltaJob(store, second.snapshotId, fixture.b, "cap-00000003");
  const childManifest = await store.seal(child);
  const open = await deltaJob(store, second.snapshotId, fixture.b, "cap-00000004");
  // A zero-diff sibling shares the unverified snapshot.
  const twin = "ws-twin-000001";
  store.track(twin, { root: fixture.otherRoot, workspaceGeneration: 1, trackerEpoch: EPOCH });
  await store.bindVerified(plan(fixture.b, { workspaceId: twin, root: fixture.otherRoot, captureId: "cap-twin-0001" }), second.snapshotId);
  const verdict = await store.verifySnapshot(second.snapshotId);
  assert.equal(verdict.result, "FAILED");
  assert.match((verdict as { error: string }).error, /orphan reference in kg_edge/);
  assert.deepEqual((verdict as { quarantined: string[] }).quarantined, [WS, twin].sort());
  assert.deepEqual(store.seedCandidates("ws-other-00001", fixture.b.buildKey), [], "a failed snapshot is nobody's seed");
  assert.equal(store.binding(WS), undefined, "NOT_READY, never the failed snapshot");
  assert.equal(store.acquireBound(WS, "request"), undefined);
  assert.equal(store.bindingVersionOf(WS), 2, "the quarantined version stays the CAS base");
  await rejectedWith(store.publish(nextPlan(fixture.b, 2, 3), child), "base-failed");
  assert.equal(store.isBound(childManifest.snapshotId), false);
  // Quarantined, not garbage: kept until a verified publish replaces the binding.
  assert.deepEqual(await store.tryReclaim({ snapshotId: second.snapshotId }), { reclaimed: false, reason: "bound" });
  await rejectedWith(store.publish(nextPlan(fixture.b, 2, 4), open), "base-failed");
  const base = store.acquire(second.snapshotId, "base");
  try { await rejectedWith(store.cloneBase(base, await store.createJob({ workspaceId: WS, captureId: "cap-00000005" })), "base-failed"); }
  finally { base.release(); }
  const reopened = await openStore(root);
  assert.deepEqual(reopened.recovery.invalidBindings.map(entry => [entry.workspaceId, entry.bindingVersion]), [[WS, 2], [twin, 1]].sort());
  assert.match(reopened.recovery.invalidBindings[0]!.error, /failed verification/);
  // A full rebuild replaces it; then the failed snapshot and its verdict go.
  const full = await reopened.store.publish(nextPlan(fixture.b, 2, 6), await jobFrom(reopened.store, fixture.b, "cap-00000006"));
  assert.equal(full.bindingVersion, 3);
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: second.snapshotId }), { reclaimed: false, reason: "bound" }, "the twin still holds it");
  reopened.store.track(twin, { root: fixture.otherRoot, workspaceGeneration: 1, trackerEpoch: EPOCH });
  await reopened.store.publish(plan(fixture.b, { workspaceId: twin, root: fixture.otherRoot, bindingVersion: 1, coveredThroughSeq: 2, captureId: "cap-twin-0002" }),
    await jobFrom(reopened.store, fixture.b, "cap-twin-0002", twin));
  assert.deepEqual(await reopened.store.tryReclaim({ snapshotId: second.snapshotId }), { reclaimed: true });
  assert.equal(existsSync(path.join(root, "mac1", "verified", `${second.snapshotId}.json`)), false);
});

test("an aborted background check records nothing; the sweep removes orphan verdicts and dead tmp files only", async () => {
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const second = await store.publish(nextPlan(fixture.b, 1, 2), await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002"));
  const controller = new AbortController();
  controller.abort(new Error("superseded"));
  await assert.rejects(store.verifySnapshot(second.snapshotId, { signal: controller.signal }), /superseded/);
  assert.equal(store.verification(second.snapshotId), undefined);
  assert.equal(store.leaseCount(second.snapshotId), 0);
  const verified = path.join(root, "mac1", "verified");
  await writeFile(path.join(verified, "s-gone-000000000000.json"), "{}");
  await writeFile(path.join(verified, `${first.snapshotId}.json.tmp-1-dead`), "{}");
  await writeFile(path.join(verified, ".DS_Store"), "finder");
  const report = await store.sweep();
  assert.deepEqual(report.snapshots, [first.snapshotId], "the superseded full snapshot goes with its verdict");
  assert.equal(existsSync(path.join(verified, `${first.snapshotId}.json`)), false);
  assert.deepEqual(report.records, ["s-gone-000000000000"]);
  assert.deepEqual(await readdir(verified), [".DS_Store"]);
});

test("the background verifier checks only served snapshots, stops a superseded check and waits for its readers on stop", async t => {
  const { SnapshotVerifier } = await import("./snapshot-verifier.js");
  const { sealWorkerUsage } = await import("./seal.js");
  const root = await cacheRoot();
  const { store } = await openStore(root);
  const first = await store.publish(plan(fixture.a), await jobFrom(store, fixture.a));
  const second = await store.publish(nextPlan(fixture.b, 1, 2), await deltaJob(store, first.snapshotId, fixture.b, "cap-00000002"));
  // The verifier's timers are unref'd (they never hold an owner open); this test is the only work.
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  const events: Array<{ snapshotId: string; outcome: string }> = [];
  let settle!: () => void;
  let settled = new Promise<void>(resolve => { settle = resolve; });
  const verifier = new SnapshotVerifier(store, { delayMs: 0, onEvent: event => events.push({ snapshotId: event.snapshotId, outcome: event.outcome }), onSettled: () => settle() });
  verifier.enqueue(second.snapshotId);
  await settled;
  assert.deepEqual(events, [{ snapshotId: second.snapshotId, outcome: "verified" }]);
  // Not served any more: skipped without a check.
  const third = await store.publish(nextPlan(fixture.a, 2, 3), await deltaJob(store, second.snapshotId, fixture.a, "cap-00000003"));
  verifier.enqueue(second.snapshotId);
  settled = new Promise<void>(resolve => { settle = resolve; });
  verifier.enqueue(third.snapshotId);
  await settled;
  assert.deepEqual(events.slice(1), [{ snapshotId: second.snapshotId, outcome: "skipped" }, { snapshotId: third.snapshotId, outcome: "verified" }]);
  // stop() during a check: no verdict, every reader gone.
  const fourth = await store.publish(nextPlan(fixture.b, 3, 4), await deltaJob(store, third.snapshotId, fixture.b, "cap-00000004"));
  verifier.enqueue(fourth.snapshotId);
  await new Promise(resolve => setTimeout(resolve, 5));
  await verifier.stop();
  assert.equal(sealWorkerUsage().active, 0);
  assert.equal(store.leaseCount(fourth.snapshotId), 0);
  assert.ok(["aborted", "verified"].includes(events.at(-1)?.outcome ?? "aborted"));
  verifier.enqueue(fourth.snapshotId);
  assert.deepEqual(verifier.status(), { pending: [], current: undefined }, "a stopped verifier takes no work");
});
