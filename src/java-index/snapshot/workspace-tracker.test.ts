import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { readMeta } from "../../index-builder/progress.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { contentManifestId } from "../sql/snapshot-manifest.js";
import type { WorkspaceBinding } from "./binding.js";
import { readSnapshotContent } from "./seal.js";
import { BindRejected, SnapshotStore } from "./snapshot-store.js";
import { FSEVENT_FLAGS, TrackerRootInvalid, WorkspaceTracker, workspaceIdFor, type TrackerRound, type TrackerSourceFactory, type TrackerVerification, type WorkspaceTrackerOptions } from "./workspace-tracker.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const orderRel = "src/main/java/demospring/Order.java";
const mapperRel = "src/main/resources/mapper/OrderMapper.xml";
const MEMBERS = 29; // 27 Java files and 2 MyBatis XML files in the fixture.
const F = FSEVENT_FLAGS;
const FILE_MODIFIED = 0x1000 | F.ItemIsFile;
const FILE_RENAMED = 0x800 | F.ItemIsFile;
const DIR_RENAMED = 0x800 | F.ItemIsDir;

type FakeStream = { epoch: string; emit(flags: number, relative: string): void; fences: number; stopped: boolean; lose(error: Error): void };

/** A deterministic stream: the tests own every signal and its order (protocol-level, not OS-induced). */
function fakeSource(root: () => string) {
  const streams: FakeStream[] = [];
  const hooks: { onFence?: () => void } = {};
  const factory: TrackerSourceFactory = async onSignal => {
    let lose!: (error: Error) => void;
    const closed = new Promise<void>((_, reject) => { lose = reject; });
    const stream: FakeStream = { epoch: randomBytes(16).toString("hex"), fences: 0, stopped: false, lose,
      emit: (flags, relative) => { if (!stream.stopped) onSignal(flags, relative === "" ? root() : relative.startsWith("/") ? relative : `${root()}/${relative}`); } };
    streams.push(stream);
    return { epoch: stream.epoch, fence: async () => { stream.fences += 1; hooks.onFence?.(); }, stop: async () => { stream.stopped = true; }, closed };
  };
  return { factory, streams, hooks, emit: (flags: number, relative: string) => streams.at(-1)!.emit(flags, relative) };
}

type Ctx = { base: string; repo: string; store: SnapshotStore; source: ReturnType<typeof fakeSource>; tracker: WorkspaceTracker; built: number };

async function setup(options: Partial<WorkspaceTrackerOptions> = {}, prepare?: (repo: string, base: string) => Promise<void>): Promise<Ctx> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-tracker-")));
  const repo = path.join(base, "repo");
  await cp(fixturesRoot, repo, { recursive: true });
  await prepare?.(repo, base);
  const { store } = await SnapshotStore.open(path.join(base, "cache"));
  const source = fakeSource(() => repo);
  const tracker = await WorkspaceTracker.start({ canonicalRoot: repo, source: source.factory, ...options });
  store.track(tracker.workspaceId, tracker.trackedState());
  return { base, repo, store, source, tracker, built: 0 };
}

async function teardown(ctx: Ctx): Promise<void> {
  const writable = async (dir: string): Promise<void> => {
    await chmod(dir, 0o755);
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
  };
  await writable(ctx.base);
  await rm(ctx.base, { recursive: true, force: true });
}

async function dispatch(ctx: Ctx): Promise<TrackerRound> {
  const round = await ctx.tracker.dispatch({ bindingVersion: ctx.store.bindingVersionOf(ctx.tracker.workspaceId) });
  ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
  return round;
}

async function verify(ctx: Ctx, round: TrackerRound): Promise<TrackerVerification> {
  const bound = ctx.store.binding(ctx.tracker.workspaceId);
  const base = bound ? await readSnapshotContent(ctx.store.layout, bound.snapshotId) : undefined;
  return ctx.tracker.verify(round, base && { entries: base.entries, buildKey: base.manifest.buildKey });
}

/** Build from the live tree after the fence: the candidate's own capture is the published content (§2.3). */
async function publish(ctx: Ctx, verification: TrackerVerification): Promise<{ binding: WorkspaceBinding; builtContent: string }> {
  const job = await ctx.store.createJob({ workspaceId: ctx.tracker.workspaceId, captureId: verification.round.captureId });
  const db = openIndexDb(job.dbPath);
  let builtContent: string;
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: ctx.repo, db, generation: verification.round.workspaceGeneration });
    builtContent = contentManifestId(db).id;
  } finally { close(db); }
  ctx.built += 1;
  return { binding: await ctx.store.publish(ctx.tracker.planFor(verification, builtContent), job), builtContent };
}

/** One owner cycle: dispatch, verify, noop or publish, complete. */
async function cycle(ctx: Ctx, expect: { noop?: boolean; agree?: boolean } = {}) {
  const round = await dispatch(ctx);
  const verification = await verify(ctx, round);
  if (expect.noop !== undefined) assert.equal(verification.noop, expect.noop, `noop for ${JSON.stringify(verification.changed)}/${JSON.stringify(verification.deleted)}`);
  let binding: WorkspaceBinding;
  if (verification.noop) binding = await ctx.store.confirmNoop(ctx.tracker.planFor(verification));
  else {
    const published = await publish(ctx, verification);
    // The tracker's capture-side digest equals the builder's when nothing raced the round.
    if (expect.agree !== false) assert.equal(verification.contentManifestId, published.builtContent, "tracker and builder content manifests agree");
    binding = published.binding;
  }
  return { round, verification, binding, status: ctx.tracker.complete(round, binding) };
}

/** A cold build of the live tree into a scratch DB: the coverage and paths a publish of it claims. */
async function builtClaims(ctx: Ctx): Promise<{ buildState?: string; coverage: Record<string, string>; paths: string[] }> {
  const db = openIndexDb(path.join(ctx.base, `claims-${randomBytes(4).toString("hex")}.sqlite`));
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: ctx.repo, db, generation: 1 });
    const coverage = Object.fromEntries((db.prepare("SELECT root, state FROM source_root_coverage").all() as Array<{ root: string; state: string }>).map(row => [row.root, row.state]));
    const paths = (db.prepare("SELECT path FROM file ORDER BY path").all() as Array<{ path: string }>).map(row => row.path);
    return { buildState: readMeta(db, "buildState"), coverage, paths };
  } finally { close(db); }
}

/**
 * A content root reached through a symlink: the tracker census never follows links, so the
 * builder must not either. Both skip it, agree on content, and the publish reports the gap.
 */
async function symlinkedRootCase(link: string, target: (repo: string, base: string) => Promise<string>): Promise<Ctx> {
  const ctx = await setup({}, async (repo, base) => {
    await mkdir(path.dirname(path.join(repo, link)), { recursive: true });
    await symlink(await target(repo, base), path.join(repo, link));
  });
  try {
    const first = await cycle(ctx, { noop: false });
    assert.equal(first.status, "FRESH");
    const claimed = [...(await readSnapshotContent(ctx.store.layout, first.binding.snapshotId)).entries.keys()];
    assert.equal(claimed.length, MEMBERS, "only the fixture's own members are claimed");
    const built = await builtClaims(ctx);
    assert.equal(built.paths.some(file => file.startsWith(`${link.split("/")[0]}/`)), false, "nothing is indexed under the link");
    assert.equal(built.coverage[link], "DEGRADED", "the symlinked root is a reported coverage gap");
    assert.equal(built.buildState, "DEGRADED");
    return ctx;
  } catch (error) { await teardown(ctx); throw error; }
}

const extraJava = "package demospring;\npublic class Extra {}\n";

test("symlinked-root-inside-repo-is-a-coverage-gap-not-a-false-fresh", async () => {
  const ctx = await symlinkedRootCase("lib/src/main/java", async repo => {
    await mkdir(path.join(repo, "shared", "java", "demospring"), { recursive: true });
    await writeFile(path.join(repo, "shared", "java", "demospring", "Extra.java"), extraJava);
    return "../../../shared/java";
  });
  try {
    // FSEvents reports the real path, outside every content root: nothing claimed it, so FRESH stays true.
    await writeFile(path.join(ctx.repo, "shared", "java", "demospring", "Extra.java"), extraJava.replace("{}", "{ int x; }"));
    ctx.source.emit(FILE_MODIFIED, "shared/java/demospring/Extra.java");
    assert.equal(ctx.tracker.status(), "FRESH");
    assert.equal((await builtClaims(ctx)).paths.some(file => file.startsWith("shared/")), false);
  } finally { await teardown(ctx); }
});

test("symlinked-root-aliasing-another-root-is-indexed-once", async () => {
  const ctx = await symlinkedRootCase("alias/src/main/java", async () => "../../../src/main/java");
  try {
    // A java edit under the real root is a delta of that root only; the alias never appears or flaps.
    await writeFile(path.join(ctx.repo, serviceRel), (await readFile(path.join(ctx.repo, serviceRel), "utf8")).replace("class OrderService", "class OrderService "));
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const next = await cycle(ctx, { noop: false });
    assert.deepEqual([next.verification.changed, next.verification.deleted], [[serviceRel], []]);
  } finally { await teardown(ctx); }
});

test("symlinked-root-outside-repo-builds-instead-of-failing", async () => {
  const ctx = await symlinkedRootCase("ext/src/main/java", async (_repo, base) => {
    await mkdir(path.join(base, "outside", "demospring"), { recursive: true });
    await writeFile(path.join(base, "outside", "demospring", "Extra.java"), extraJava);
    return path.join(base, "outside");
  });
  await teardown(ctx);
});

/** A whole-second mtime survives utimes exactly; pinned before the tracker caches the file's stat. */
async function pinMtime(file: string): Promise<number> {
  const second = Math.floor(Date.now() / 1000) - 60;
  await utimes(file, second, second);
  return second;
}

/** Same size and the same (pinned) mtime: only ctime/inode can tell the edit apart. */
async function sameStatEdit(file: string, from: string, to: string, second?: number): Promise<void> {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  second ??= await pinMtime(file);
  const before = await lstat(file);
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(from), `${from} in ${file}`);
  await writeFile(file, text.replace(from, to));
  await utimes(file, second, second);
  const after = await lstat(file);
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs], "size and mtime are unchanged");
}

test("same-stat-changes-are-hashed", async () => {
  const ctx = await setup();
  try {
    const first = await cycle(ctx);
    assert.deepEqual([first.round.mode, first.verification.hashed, first.status], ["full-hash", MEMBERS, "FRESH"]);
    // A suspect path is hashed even though size and mtime say nothing changed.
    await sameStatEdit(path.join(ctx.repo, serviceRel), "class OrderService", "class OrderServicf");
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    assert.equal(ctx.tracker.status(), "STALE");
    const second = await cycle(ctx, { noop: false });
    assert.deepEqual([second.round.mode, second.verification.changed, second.verification.hashed, second.status], ["paths", [serviceRel], 1, "FRESH"]);
    // Without any event, a full stat walk still finds a same size+mtime edit (ctime and inode are in the key).
    // The mtime is pinned and cached first, so a size+mtime-only key would match and skip the edit.
    const mapper = path.join(ctx.repo, mapperRel);
    const pinned = await pinMtime(mapper);
    ctx.source.emit(FILE_MODIFIED, mapperRel);
    assert.equal((await cycle(ctx, { noop: true })).status, "FRESH");
    await sameStatEdit(mapper, "OrderMapper", "OrderMappes", pinned);
    await mkdir(path.join(ctx.repo, "docs", "sql"), { recursive: true }); // An empty resource root moves the layout only.
    ctx.source.emit(F.ItemIsDir | 0x100, "docs/sql");
    const third = await cycle(ctx, { noop: false });
    assert.equal(third.round.mode, "full-stat");
    assert.deepEqual(third.verification.changed, [mapperRel]);
    assert.equal(third.verification.hashed, 1, "unchanged files were not re-hashed");
    assert.equal(third.round.buildKey, first.round.buildKey, "an empty resource root keeps the build key");
    assert.equal(third.round.layoutFingerprint, first.round.layoutFingerprint, "an empty resource root keeps the indexed inputs");
    assert.equal(third.round.workspaceGeneration, first.round.workspaceGeneration, "an empty resource root keeps the input generation");
    assert.equal(third.status, "FRESH");

    // The first XML activates the resource root and moves the indexed input boundary.
    const addedMapper = "docs/sql/ExtraMapper.xml";
    await writeFile(path.join(ctx.repo, addedMapper), '<mapper namespace="demospring.ExtraMapper"><select id="find">select 1</select></mapper>\n');
    ctx.source.emit(FILE_MODIFIED, addedMapper);
    const fourth = await cycle(ctx, { noop: false });
    assert.equal(fourth.round.mode, "full-hash");
    assert.notEqual(fourth.round.buildKey, third.round.buildKey);
    assert.notEqual(fourth.round.layoutFingerprint, third.round.layoutFingerprint);
    assert.equal(fourth.round.workspaceGeneration, third.round.workspaceGeneration + 1, "an active resource root is a new input boundary");
    assert.deepEqual(fourth.verification.changed, [addedMapper]);
    assert.equal(fourth.verification.hashed, MEMBERS + 1);
    assert.equal(fourth.status, "FRESH");
  } finally { await teardown(ctx); }
});

test("touch-edit-revert-startup-noop", async () => {
  const ctx = await setup();
  try {
    const first = await cycle(ctx);
    const snapshotId = first.binding.snapshotId;
    const file = path.join(ctx.repo, serviceRel);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const touched = await cycle(ctx, { noop: true });
    assert.deepEqual([touched.binding.snapshotId, touched.binding.bindingVersion, touched.status], [snapshotId, 2, "FRESH"]);
    const original = await readFile(file, "utf8");
    await writeFile(file, `${original}// edit\n`);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    await writeFile(file, original);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const reverted = await cycle(ctx, { noop: true });
    assert.deepEqual([reverted.binding.snapshotId, reverted.binding.coveredThroughSeq, reverted.status], [snapshotId, reverted.round.cut, "FRESH"]);
    // A restart never restores FRESH from the persisted watermark: a new epoch hashes everything first.
    await ctx.tracker.stop();
    ctx.tracker = await WorkspaceTracker.start({ canonicalRoot: ctx.repo, source: ctx.source.factory, workspaceGeneration: reverted.binding.workspaceGeneration });
    ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
    assert.equal(ctx.tracker.status(), "STALE");
    assert.ok(ctx.store.binding(ctx.tracker.workspaceId), "the binding itself survives");
    const startup = await cycle(ctx, { noop: true });
    assert.deepEqual([startup.round.mode, startup.verification.hashed, startup.binding.snapshotId, startup.status], ["full-hash", MEMBERS, snapshotId, "FRESH"]);
    assert.notEqual(startup.binding.trackerEpoch, reverted.binding.trackerEpoch);
    assert.equal(ctx.built, 1, "touch, edit-revert and startup built nothing");
    assert.equal((await readdir(ctx.store.layout.snapshots)).length, 1);
  } finally { await teardown(ctx); }
});

test("a case-only file rename replaces the old census entry on an old-name hint", async t => {
  const ctx = await setup();
  try {
    const actual = serviceRel.replace("OrderService.java", "Orderservice.java");
    if (!existsSync(path.join(ctx.repo, actual))) return t.skip("requires case-insensitive path lookup");
    await cycle(ctx);
    await rename(path.join(ctx.repo, serviceRel), path.join(ctx.repo, actual));
    ctx.source.emit(FILE_RENAMED, serviceRel);

    const { round, verification, status } = await cycle(ctx, { noop: false });
    assert.equal(round.mode, "paths");
    assert.deepEqual(verification.changed, [actual]);
    assert.deepEqual(verification.deleted, [serviceRel]);
    assert.equal(status, "FRESH");
  } finally { await teardown(ctx); }
});

test("a case-only directory rename replaces the old subtree on an old-name hint", async t => {
  const ctx = await setup();
  try {
    const old = path.dirname(serviceRel);
    const actual = old.replace("demospring", "DemoSpring");
    if (!existsSync(path.join(ctx.repo, actual))) return t.skip("requires case-insensitive path lookup");
    const first = await cycle(ctx);
    const members = [...first.verification.entries.keys()].filter(file => file.startsWith(`${old}/`)).sort();
    assert.ok(members.length > 1);
    await rename(path.join(ctx.repo, old), path.join(ctx.repo, actual));
    ctx.source.emit(DIR_RENAMED, old);

    const { round, verification, status } = await cycle(ctx, { noop: false });
    assert.equal(round.mode, "paths");
    assert.deepEqual(verification.changed, members.map(file => `${actual}${file.slice(old.length)}`));
    assert.deepEqual(verification.deleted, members);
    assert.equal(status, "FRESH");
  } finally { await teardown(ctx); }
});

test("a hint with no unique disk spelling leaves a full-stat walk owed after its cut", async t => {
  const actual = path.join(path.dirname(serviceRel), "ſample.java");
  const hint = path.join(path.dirname(serviceRel), "Sample.java");
  const ctx = await setup({}, async repo => { await writeFile(path.join(repo, actual), extraJava); });
  try {
    // APFS matches long s with S, but JavaScript's lowercase mapping does not.
    if (!existsSync(path.join(ctx.repo, hint))) return t.skip("requires APFS long-s equivalence");
    await cycle(ctx);
    await writeFile(path.join(ctx.repo, actual), `${extraJava}// edit\n`);
    ctx.source.emit(FILE_MODIFIED, hint);

    const paths = await cycle(ctx, { noop: true });
    assert.equal(paths.round.mode, "paths");
    assert.equal(paths.status, "STALE");
    assert.ok(ctx.tracker.diagnostics().fullStatThrough > paths.round.cut);

    const full = await cycle(ctx, { noop: false });
    assert.equal(full.round.mode, "full-stat");
    assert.deepEqual(full.verification.changed, [actual]);
    assert.equal(full.status, "FRESH");
  } finally { await teardown(ctx); }
});

test("drop-during-scan-keeps-new-rescan-cut", async () => {
  let duringScan: (() => Promise<void>) | undefined;
  const ctx = await setup({ afterRead: async () => { const run = duringScan; duringScan = undefined; await run?.(); } });
  try {
    await cycle(ctx);
    await writeFile(path.join(ctx.repo, serviceRel), `${await readFile(path.join(ctx.repo, serviceRel), "utf8")}// a\n`);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const round = await dispatch(ctx);
    assert.equal(round.mode, "paths");
    duringScan = async () => {
      // Both arrive after the cut: a kernel drop and an edit of another file.
      ctx.source.emit(F.KernelDropped, "");
      await writeFile(path.join(ctx.repo, orderRel), `${await readFile(path.join(ctx.repo, orderRel), "utf8")}// b\n`);
      ctx.source.emit(FILE_MODIFIED, orderRel);
    };
    const verification = await verify(ctx, round);
    assert.deepEqual(verification.changed, [serviceRel]);
    const { binding } = await publish(ctx, verification);
    assert.equal(ctx.tracker.complete(round, binding), "STALE", "first round: published but still STALE");
    const owed = ctx.tracker.diagnostics();
    assert.ok(owed.fullHashThrough > round.cut, "the drop's rescan cut is kept");
    assert.equal(owed.pending, 1);
    // The candidate was built after both edits; the full-hash round verifies exactly that and confirms it.
    const second = await cycle(ctx, { noop: true });
    assert.deepEqual([second.round.mode, second.verification.hashed], ["full-hash", MEMBERS]);
    assert.equal(second.status, "FRESH", "second round confirms");
    assert.equal(ctx.tracker.diagnostics().fullHashThrough, 0);
  } finally { await teardown(ctx); }
});

test("root-replacement-invalidates-binding", async () => {
  const invalid: TrackerRootInvalid[] = [];
  const ctx = await setup({ onInvalidRoot: error => invalid.push(error) });
  try {
    const first = await cycle(ctx);
    const workspaceId = ctx.tracker.workspaceId;
    assert.ok(ctx.store.acquireBound(workspaceId, "request"));
    // A round is in flight when the root is replaced at the same path.
    await writeFile(path.join(ctx.repo, serviceRel), `${await readFile(path.join(ctx.repo, serviceRel), "utf8")}// x\n`);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const round = await dispatch(ctx);
    const verification = await verify(ctx, round);
    await rename(ctx.repo, `${ctx.repo}.old`);
    await cp(fixturesRoot, ctx.repo, { recursive: true });
    ctx.source.emit(F.RootChanged, "");
    assert.equal(ctx.tracker.status(), "INVALID_ROOT");
    assert.equal(invalid.length, 1);
    const replacement = invalid[0]!.replacement!;
    assert.notEqual(replacement.ino, first.binding.root.ino);
    assert.notEqual(workspaceIdFor(replacement), workspaceId, "the replaced root is another workspace");
    ctx.store.track(workspaceId, ctx.tracker.trackedState());
    await assert.rejects(publish(ctx, verification), error => error instanceof BindRejected && ["generation", "root"].includes(error.reason));
    await assert.rejects(ctx.store.confirmNoop(ctx.tracker.planFor(verification)), error => error instanceof BindRejected);
    assert.equal(ctx.store.acquireBound(workspaceId, "request"), undefined, "the old binding is no longer served");
    await assert.rejects(ctx.tracker.dispatch({ bindingVersion: 1 }), /INVALID_ROOT/);
    assert.throws(() => ctx.tracker.complete(round, first.binding), /INVALID_ROOT/);
    // Gone entirely: also invalid, and the tracked root matches nothing.
    const gone = await setup();
    try {
      await cycle(gone);
      await rename(gone.repo, `${gone.repo}.moved`);
      gone.source.emit(F.RootChanged, "");
      assert.equal(gone.tracker.status(), "INVALID_ROOT");
      gone.store.track(gone.tracker.workspaceId, gone.tracker.trackedState());
      assert.equal(gone.store.acquireBound(gone.tracker.workspaceId, "request"), undefined);
    } finally { await teardown(gone); }
  } finally { await teardown(ctx); }
});

test("stream-restart-requires-full-hash", async () => {
  const ctx = await setup();
  try {
    const first = await cycle(ctx);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const ordinary = await cycle(ctx, { noop: true });
    assert.deepEqual([ordinary.round.mode, ordinary.verification.hashed], ["paths", 1]);
    // An edit while the stream is down produces no event at all.
    await sameStatEdit(path.join(ctx.repo, orderRel), "class Order", "class Ordes");
    const oldEpoch = ctx.tracker.trackerEpoch;
    await ctx.tracker.restartStream();
    assert.notEqual(ctx.tracker.trackerEpoch, oldEpoch);
    assert.equal(ctx.tracker.status(), "STALE");
    assert.deepEqual([ctx.tracker.currentSeq, ctx.tracker.diagnostics().fullHashThrough], [1, 1]);
    ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
    const restarted = await cycle(ctx, { noop: false });
    assert.deepEqual([restarted.round.mode, restarted.verification.hashed, restarted.verification.changed], ["full-hash", MEMBERS, [orderRel]]);
    assert.deepEqual([restarted.binding.trackerEpoch, restarted.binding.coveredThroughSeq, restarted.status], [ctx.tracker.trackerEpoch, 1, "FRESH"]);
    assert.ok(first.binding.coveredThroughSeq >= 1);
  } finally { await teardown(ctx); }
});

test("confirmed-through-follows-the-cut-and-the-epoch", async () => {
  const ctx = await setup();
  try {
    assert.equal(ctx.tracker.confirmedThrough(ctx.tracker.trackerEpoch, 0), false, "nothing is confirmed before the startup hash");
    await cycle(ctx);
    const epoch = ctx.tracker.trackerEpoch;
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const entry = ctx.tracker.currentSeq;
    assert.equal(ctx.tracker.confirmedThrough(epoch, entry), false);
    const round = await dispatch(ctx);
    // A later hint beyond the round's cut.
    ctx.source.emit(FILE_MODIFIED, orderRel);
    const verification = await verify(ctx, round);
    assert.equal(verification.noop, true);
    assert.equal(ctx.tracker.complete(round, await ctx.store.confirmNoop(ctx.tracker.planFor(verification))), "STALE");
    assert.equal(ctx.tracker.confirmedThrough(epoch, entry), true, "the entry hint is covered while a later one is still owed");
    assert.equal(ctx.tracker.confirmedThrough(epoch, ctx.tracker.currentSeq), false);
    // A lost stream may have dropped hints of its own: no earlier confirmation stands for it.
    ctx.source.streams.at(-1)!.lose(new Error("helper exited"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctx.tracker.confirmedThrough(epoch, entry), false);
    // A new epoch confirms nothing until its startup hash, which then covers every seq of the old one.
    await ctx.tracker.restartStream();
    ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
    assert.equal(ctx.tracker.confirmedThrough(epoch, entry), false);
    await cycle(ctx);
    assert.equal(ctx.tracker.confirmedThrough(epoch, Number.MAX_SAFE_INTEGER), true);
    assert.equal(ctx.tracker.confirmedThrough(ctx.tracker.trackerEpoch, ctx.tracker.currentSeq), true);
  } finally { await teardown(ctx); }
});

test("new-epoch-rejects-old-result-with-same-seq", async () => {
  const ctx = await setup();
  try {
    await cycle(ctx);
    for (let index = 0; index < 3; index += 1) ctx.source.emit(FILE_MODIFIED, serviceRel);
    const old = await dispatch(ctx);
    const oldVerification = await verify(ctx, old);
    await ctx.tracker.restartStream();
    // The new stream reaches the old round's seq: the seq alone cannot tell them apart.
    while (ctx.tracker.currentSeq < old.cut) ctx.source.emit(FILE_MODIFIED, orderRel);
    assert.equal(ctx.tracker.currentSeq, old.cut);
    ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
    await assert.rejects(ctx.store.confirmNoop(ctx.tracker.planFor(oldVerification)), error => error instanceof BindRejected && error.reason === "tracker-epoch");
    await assert.rejects(publish(ctx, oldVerification), error => error instanceof BindRejected && error.reason === "tracker-epoch");
    const forged = { ...ctx.store.binding(ctx.tracker.workspaceId)!, trackerEpoch: old.epoch, coveredThroughSeq: old.cut };
    assert.throws(() => ctx.tracker.complete(old, forged), /cannot confirm epoch/);
    assert.equal(ctx.tracker.status(), "STALE");
    assert.equal(ctx.tracker.diagnostics().pending, 1, "the new epoch's pending path is untouched");
    const fresh = await cycle(ctx, { noop: true });
    assert.deepEqual([fresh.round.mode, fresh.status], ["full-hash", "FRESH"]);
  } finally { await teardown(ctx); }
});

test("continuous edits during a scan finish the round and stay STALE instead of restarting", async () => {
  let edits = 0;
  let editing = false;
  const ctx = await setup({ afterRead: async relative => {
    if (!editing || relative !== serviceRel) return;
    edits += 1;
    await writeFile(path.join(ctx.repo, serviceRel), `${await readFile(path.join(ctx.repo, serviceRel), "utf8")}// ${edits}\n`);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
  } });
  try {
    await cycle(ctx);
    // A path round: the pending path itself is edited again while it is being read.
    editing = true;
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const round = await dispatch(ctx);
    assert.equal(round.mode, "paths");
    const verification = await verify(ctx, round);
    assert.equal(edits, 1, "each file is read once per round; the scan does not wait for quiet");
    const { binding } = await publish(ctx, verification);
    assert.equal(ctx.tracker.complete(round, binding), "STALE", "the later seq of the same path is kept");
    assert.equal(ctx.tracker.diagnostics().pending, 1);
    // A full-hash round: a second drop and an edit land during the scan.
    let dropped = false;
    const full = await setup({ afterRead: async relative => {
      if (dropped || relative !== serviceRel) return;
      dropped = true;
      full.source.emit(F.KernelDropped, "");
      await writeFile(path.join(full.repo, serviceRel), `${await readFile(path.join(full.repo, serviceRel), "utf8")}// d\n`);
      full.source.emit(FILE_MODIFIED, serviceRel);
    } });
    try {
      const fullRound = await dispatch(full);
      assert.equal(fullRound.mode, "full-hash");
      const fullVerification = await verify(full, fullRound);
      const published = await publish(full, fullVerification);
      assert.equal(full.tracker.complete(fullRound, published.binding), "STALE");
      assert.ok(full.tracker.diagnostics().fullHashThrough > fullRound.cut, "the drop during the full scan keeps its own rescan cut");
      assert.equal(full.tracker.diagnostics().pending, 1);
      assert.deepEqual([(await cycle(full, { noop: true })).status], ["FRESH"]);
    } finally { await teardown(full); }
    editing = false;
    // The builder read after the fence, so the candidate already holds that edit: the follow-up confirms it.
    const next = await cycle(ctx, { noop: true });
    assert.deepEqual([next.round.mode, next.verification.hashed, next.status], ["paths", 1, "FRESH"]);
  } finally { await teardown(ctx); }
});

test("subtree signals, directory renames and unbounded signals pick the right scope", async () => {
  const ctx = await setup();
  try {
    await cycle(ctx);
    const from = path.join(ctx.repo, "src/main/java/demojpa");
    await rename(from, path.join(ctx.repo, "src/main/java/demojpa2"));
    ctx.source.emit(DIR_RENAMED, "src/main/java/demojpa");
    ctx.source.emit(DIR_RENAMED, "src/main/java/demojpa2");
    const moved = await cycle(ctx, { noop: false });
    assert.equal(moved.round.mode, "paths");
    assert.deepEqual(moved.verification.deleted.map(file => path.basename(path.dirname(file))), ["demojpa", "demojpa", "demojpa"]);
    assert.ok(moved.verification.changed.every(file => file.startsWith("src/main/java/demojpa2/")) && moved.verification.changed.length === 3);
    assert.equal(moved.verification.hashed, 3);
    ctx.source.emit(F.MustScanSubDirs, "src/main/resources");
    const scanned = await cycle(ctx, { noop: true });
    assert.deepEqual([scanned.round.mode, scanned.verification.hashed], ["paths", 2]);
    // Wrapped event ids are not a drop; a signal outside the root cannot be bounded.
    ctx.source.emit(F.EventIdsWrapped, "");
    assert.equal(ctx.tracker.diagnostics().fullHashThrough, 0);
    ctx.source.emit(FILE_MODIFIED, "README.md");
    assert.deepEqual([ctx.tracker.diagnostics().pending, ctx.tracker.diagnostics().ignored], [0, 1]);
    ctx.source.emit(FILE_MODIFIED, "/somewhere/else.java");
    assert.ok(ctx.tracker.diagnostics().fullHashThrough > 0);
    const unbounded = await cycle(ctx, { noop: true });
    assert.equal(unbounded.round.mode, "full-hash");
    // A build file edit is a new input boundary: the plan must not be confirmed as a noop of the old build.
    await writeFile(path.join(ctx.repo, "pom.xml"), `${await readFile(path.join(ctx.repo, "pom.xml"), "utf8")}<!-- dep -->\n`);
    ctx.source.emit(FILE_MODIFIED, "pom.xml");
    const env = await cycle(ctx, { noop: false });
    assert.equal(env.round.workspaceGeneration, unbounded.round.workspaceGeneration + 1);
    assert.notEqual(env.round.buildKey, unbounded.round.buildKey);
    assert.deepEqual([env.verification.changed, env.status], [[], "FRESH"]);
  } finally { await teardown(ctx); }
});

test("an active workspace is fully hashed at least every 10 minutes", async () => {
  let now = 1_000_000;
  const ctx = await setup({ now: () => now });
  try {
    await cycle(ctx);
    assert.equal(ctx.tracker.hasWork(), false);
    now += 10 * 60 * 1000 - 1;
    assert.equal(ctx.tracker.hasWork(), false);
    now += 1;
    assert.equal(ctx.tracker.hasWork(), true);
    const periodic = await cycle(ctx, { noop: true });
    assert.deepEqual([periodic.round.mode, periodic.verification.hashed, periodic.status], ["full-hash", MEMBERS, "FRESH"]);
    assert.equal(ctx.tracker.hasWork(), false);
  } finally { await teardown(ctx); }
});

test("a resume hint forces a full hash, and a lost stream must restart before dispatching", async () => {
  const ctx = await setup();
  try {
    await cycle(ctx);
    ctx.tracker.resume();
    assert.equal(ctx.tracker.status(), "STALE");
    const resumed = await cycle(ctx, { noop: true });
    assert.equal(resumed.round.mode, "full-hash");
    const round = await dispatch(ctx);
    assert.throws(() => ctx.tracker.complete(round, resumed.binding), /never verified/);
    await verify(ctx, round);
    assert.throws(() => ctx.tracker.complete(round, resumed.binding), /not committed for this round/);
    await assert.rejects(ctx.tracker.dispatch({ bindingVersion: 0 }), /already in flight/);
    ctx.tracker.abandon(round);
    // The stream dies: nothing may be dispatched on it, FRESH is withdrawn, a restart owes a full hash.
    ctx.source.streams.at(-1)!.lose(new Error("helper exited"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctx.tracker.status(), "STALE");
    await assert.rejects(ctx.tracker.dispatch({ bindingVersion: 0 }), /restartStream/);
    await ctx.tracker.restartStream();
    ctx.store.track(ctx.tracker.workspaceId, ctx.tracker.trackedState());
    const restarted = await cycle(ctx, { noop: true });
    assert.deepEqual([restarted.round.mode, restarted.status], ["full-hash", "FRESH"]);
  } finally { await teardown(ctx); }
});

test("signals that arrive while dispatch reads root and build identity stay owed", async () => {
  const ctx = await setup();
  try {
    await cycle(ctx);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    // After the fence, while the round reads root, layout and build files: a pom edit lands.
    ctx.source.hooks.onFence = () => setImmediate(() => {
      writeFileSync(path.join(ctx.repo, "pom.xml"), `${readFileSync(path.join(ctx.repo, "pom.xml"), "utf8")}<!-- during dispatch -->\n`);
      ctx.source.emit(FILE_MODIFIED, "pom.xml");
    });
    const round = await dispatch(ctx);
    ctx.source.hooks.onFence = undefined;
    assert.ok(ctx.tracker.currentSeq > round.cut, "the in-dispatch signal took a seq above the frozen cut");
    const verification = await verify(ctx, round);
    const binding = verification.noop ? await ctx.store.confirmNoop(ctx.tracker.planFor(verification)) : (await publish(ctx, verification)).binding;
    assert.equal(ctx.tracker.complete(round, binding), "STALE");
    assert.ok(ctx.tracker.diagnostics().envThrough > round.cut);
    const next = await cycle(ctx);
    assert.equal(next.status, "FRESH");
    assert.ok(next.round.cut > round.cut);
  } finally { await teardown(ctx); }
});

test("a full-stat signal during a path round survives it, and an abandoned periodic hash stays owed", async () => {
  let now = 1_000_000;
  let during: (() => void) | undefined;
  const ctx = await setup({ now: () => now, afterRead: () => { const run = during; during = undefined; run?.(); } });
  try {
    await cycle(ctx);
    ctx.source.emit(FILE_MODIFIED, serviceRel);
    const round = await dispatch(ctx);
    assert.equal(round.mode, "paths");
    during = () => ctx.source.emit(DIR_RENAMED, "src"); // above every content root
    const verification = await verify(ctx, round);
    const binding = await ctx.store.confirmNoop(ctx.tracker.planFor(verification));
    assert.equal(ctx.tracker.complete(round, binding), "STALE");
    assert.ok(ctx.tracker.diagnostics().fullStatThrough > round.cut);
    assert.equal((await cycle(ctx, { noop: true })).round.mode, "full-stat");
    // A layout move seen by a round that is then abandoned is still owed to the next round.
    await mkdir(path.join(ctx.repo, "docs", "sql"), { recursive: true });
    ctx.source.emit(F.ItemIsDir | 0x100, "docs/sql");
    const moved = await dispatch(ctx);
    assert.equal(moved.mode, "full-stat");
    assert.equal(moved.buildKey, round.buildKey, "an empty resource root changes the layout, not the build key");
    ctx.tracker.abandon(moved);
    assert.equal((await cycle(ctx, { noop: true })).round.mode, "full-stat");
    now += 10 * 60 * 1000;
    const periodic = await dispatch(ctx);
    assert.equal(periodic.mode, "full-hash");
    await verify(ctx, periodic);
    ctx.tracker.abandon(periodic);
    assert.equal(ctx.tracker.hasWork(), true, "an abandoned periodic hash does not restart the interval");
    assert.equal((await cycle(ctx, { noop: true })).round.mode, "full-hash");
    assert.equal(ctx.tracker.hasWork(), false);
  } finally { await teardown(ctx); }
});
