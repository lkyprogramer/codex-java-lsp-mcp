import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { startBuildProcess } from "../../index-builder/build-process.js";
import type { BuildSchedulerEvent } from "../../index-builder/build-scheduler.js";
import type { BuilderJob } from "../../index-builder/incremental.js";
import { close, openImmutableIndexDb } from "../sql/driver.js";
import { logicalDigest } from "../sql/logical-export.js";
import { IndexOwner, MAX_SEED_CANDIDATES, type IndexOwnerOptions, type OwnerEvent } from "./index-owner.js";
import { PUBLICATION_HISTORY_FILE, type SnapshotPublication } from "./publication-history.js";
import { readSnapshotContent } from "./seal.js";
import { FSEVENT_FLAGS, type TrackerSourceFactory } from "./workspace-tracker.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const FILE_MODIFIED = 0x1000 | FSEVENT_FLAGS.ItemIsFile;

function fakeSources() {
  const emitters = new Map<string, (flags: number, file: string) => void>();
  const factory = (root: string): TrackerSourceFactory => async onSignal => {
    emitters.set(root, onSignal);
    return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => {}, closed: new Promise<void>(() => undefined) };
  };
  return { factory, emit: (root: string, relative: string) => emitters.get(root)!(FILE_MODIFIED, path.join(root, relative)) };
}

async function until<T>(probe: () => T | undefined | false, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

async function base(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-owner-seed-")));
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

/** An owner whose builder starts are recorded per workspace root. */
async function openOwner(t: TestContext, cacheRoot: string, options: Partial<IndexOwnerOptions> = {}) {
  const sources = fakeSources();
  const events: OwnerEvent[] = [];
  const jobs: Array<{ repoRoot: string; job: BuilderJob }> = [];
  const owner = await IndexOwner.open({ cacheRoot, trackerSource: root => sources.factory(root), roundDelayMs: 5, gcCycleMs: 60_000,
    onEvent: event => events.push(event), startBuild: input => { jobs.push({ repoRoot: input.repoRoot, job: input.job }); return startBuildProcess(input); }, ...options });
  t.after(() => owner.stop());
  return { owner, sources, events, jobs, jobsFor: (root: string) => jobs.filter(job => job.repoRoot === root).map(job => job.job) };
}

async function repo(dir: string, name: string): Promise<string> {
  const root = path.join(dir, name);
  await cp(fixturesRoot, root, { recursive: true });
  return realpath(root);
}

async function bound(ctx: Awaited<ReturnType<typeof openOwner>>, root: string) {
  const workspace = await ctx.owner.workspace(root);
  await until(() => ctx.owner.store.binding(workspace.workspaceId) && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, `first binding ${root}`);
  return { workspace, binding: ctx.owner.store.binding(workspace.workspaceId)! };
}

function rounds(ctx: Awaited<ReturnType<typeof openOwner>>, workspaceId: string) {
  return ctx.events.filter((event): event is Extract<OwnerEvent, { type: "round" }> => event.type === "round" && event.workspaceId === workspaceId);
}

async function publications(owner: IndexOwner): Promise<SnapshotPublication[]> {
  const history = await readFile(path.join(owner.store.layout.root, PUBLICATION_HISTORY_FILE), "utf8");
  return history.trimEnd().split("\n").map(row => JSON.parse(row));
}

function digestOf(owner: IndexOwner, snapshotId: string): string {
  const db = openImmutableIndexDb(owner.store.snapshotPath(snapshotId));
  try { return logicalDigest(db).digest; } finally { close(db); }
}

async function addMethod(root: string, name: string): Promise<void> {
  const file = path.join(root, serviceRel);
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/}\s*$/, `  public String ${name}() { return "${name}"; }\n}\n`));
}

test("a clean worktree without the main checkout's empty roots binds the sibling's sealed snapshot", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const twin = path.join(dir, "twin");
  await mkdir(path.join(main, "empty-module"));
  await writeFile(path.join(main, "empty-module", "pom.xml"), "<project><artifactId>empty-module</artifactId></project>");
  const git = (...args: string[]) => execFileSync("git", ["-C", main, "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "pipe" });
  git("init");
  git("add", ".");
  git("commit", "-m", "Fixture");
  await mkdir(path.join(main, "empty-module", "src/main/java/deep"), { recursive: true });
  await mkdir(path.join(main, "empty-module", "src/main/resources"), { recursive: true });
  git("worktree", "add", "--detach", twin);
  assert.equal(existsSync(path.join(twin, "empty-module", "src")), false);
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  assert.deepEqual(ctx.jobsFor(main).map(job => job.kind), ["full"]);
  const second = await bound(ctx, twin);
  assert.equal(second.binding.snapshotId, first.binding.snapshotId, "the verified twin is bound to the same snapshot");
  assert.equal(second.binding.contentManifestId, first.binding.contentManifestId);
  assert.notEqual(second.workspace.workspaceId, first.workspace.workspaceId);
  assert.deepEqual(ctx.jobsFor(twin), [], "a zero-diff seed starts no builder");
  assert.deepEqual(await readdir(ctx.owner.store.layout.snapshots), [first.binding.snapshotId]);
  const round = rounds(ctx, second.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.outcome, round.kind, round.seedFrom, round.changed, round.deleted], ["noop", "seed-bind", first.binding.snapshotId, 0, 0]);
  const [built, seeded] = await publications(ctx.owner);
  assert.deepEqual([built.plannedMode, built.actualBuildMode, built.fullReason], ["full", "full", "no-base"]);
  assert.deepEqual([seeded.plannedMode, seeded.actualBuildMode, seeded.comparisonBaseSnapshotId, seeded.cloneBaseSnapshotId],
    ["seed-bind", "none", first.binding.snapshotId, undefined]);
});

test("an exact twin of the latest sibling seed-binds after the candidate limit is exceeded", async t => {
  const dir = await base(t);
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const siblings: Array<{ root: string } & Awaited<ReturnType<typeof bound>>> = [];
  for (let index = 0; index <= MAX_SEED_CANDIDATES; index += 1) {
    const root = await repo(dir, `candidate-${index}`);
    await addMethod(root, `onlyCandidate${index}`);
    siblings.push({ root, ...await bound(ctx, root) });
  }
  const snapshotIds = new Set(siblings.map(sibling => sibling.binding.snapshotId));
  assert.equal(snapshotIds.size, MAX_SEED_CANDIDATES + 1, "every sibling keeps a distinct bound snapshot");
  assert.equal(ctx.jobs.filter(({ job }) => job.kind === "full").length, 1, "only the first sibling needs a cold build");

  const latest = siblings.at(-1)!;
  const twinPath = path.join(dir, "latest-twin");
  await cp(latest.root, twinPath, { recursive: true });
  const twin = await realpath(twinPath);
  const workspace = await ctx.owner.workspace(twin);
  const candidates = ctx.owner.store.seedCandidates(workspace.workspaceId, latest.binding.buildKey);
  assert.equal(candidates.length, MAX_SEED_CANDIDATES + 1, "the twin has more real candidates than one bounded scan accepts");
  assert.ok(candidates.includes(latest.binding.snapshotId));

  const second = await bound(ctx, twin);
  assert.deepEqual(ctx.jobsFor(twin), [], "the latest exact-content sibling must avoid a builder even beyond the candidate limit");
  assert.equal(second.binding.snapshotId, latest.binding.snapshotId);
  assert.equal(second.binding.contentManifestId, latest.binding.contentManifestId);
  const round = rounds(ctx, second.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.outcome, round.kind, round.seedFrom, round.changed, round.deleted],
    ["noop", "seed-bind", latest.binding.snapshotId, 0, 0]);
  for (const sibling of siblings) {
    assert.equal(ctx.owner.store.binding(sibling.workspace.workspaceId)?.snapshotId, sibling.binding.snapshotId,
      "older sibling bindings remain available throughout candidate selection");
  }
  assert.equal((await readdir(ctx.owner.store.layout.snapshots)).length, snapshotIds.size, "the twin creates no new snapshot");
});

test("a worktree one file away seeds a delta from the sibling's base: only that file is rebuilt, and the result equals its own full", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const branch = await repo(dir, "branch");
  await addMethod(branch, "seededOnlyHere");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const second = await bound(ctx, branch);
  assert.notEqual(second.binding.snapshotId, first.binding.snapshotId);
  assert.deepEqual(ctx.jobsFor(branch), [{ kind: "refresh", generation: 2, changed: [serviceRel], deleted: [], buildKey: first.binding.buildKey }]);
  const round = rounds(ctx, second.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.outcome, round.kind, round.seedFrom, round.changed], ["published", "delta", first.binding.snapshotId, 1]);
  // The sibling keeps its own snapshot; the seed did not supersede it.
  assert.equal(ctx.owner.store.binding(first.workspace.workspaceId)?.snapshotId, first.binding.snapshotId);
  assert.ok(existsSync(path.join(ctx.owner.store.layout.snapshots, first.binding.snapshotId)));
  // An independent full of the same tree (another store) is logically equal to the seeded delta.
  const independent = await openOwner(t, path.join(dir, "cache-full"));
  const full = await bound(independent, branch);
  assert.deepEqual(independent.jobsFor(branch).map(job => job.kind), ["full"]);
  assert.equal(second.binding.contentManifestId, full.binding.contentManifestId);
  assert.equal(digestOf(ctx.owner, second.binding.snapshotId), digestOf(independent.owner, full.binding.snapshotId));
});

test("a mapper XML edit is a path delta of that file, not a census rescan, and equals its own full", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const xmlRel = "src/main/resources/mapper/ItemMapper.xml";
  const file = path.join(main, xmlRel);
  await writeFile(file, (await readFile(file, "utf8")).replace("</mapper>", `  <select id="findActive" resultType="demomybatis.ItemEntity">select * from items where active</select>\n</mapper>`));
  ctx.sources.emit(main, xmlRel);
  await until(() => rounds(ctx, first.workspace.workspaceId).some(round => round.outcome === "published" && round.kind !== "full"), "xml delta");
  assert.deepEqual(ctx.jobsFor(main).slice(1), [{ kind: "refresh", generation: 2, changed: [xmlRel], deleted: [], buildKey: first.binding.buildKey }]);
  assert.equal(rounds(ctx, first.workspace.workspaceId).at(-1)!.kind, "delta");
  const published = ctx.owner.store.binding(first.workspace.workspaceId)!;
  const independent = await openOwner(t, path.join(dir, "cache-full"));
  const full = await bound(independent, main);
  assert.equal(published.contentManifestId, full.binding.contentManifestId);
  assert.equal(digestOf(ctx.owner, published.snapshotId), digestOf(independent.owner, full.binding.snapshotId));
});

test("K21: after a sealed seed, an XML-only edit and delete in the twin serve the twin's own content", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const twin = await repo(dir, "twin");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const seeded = await bound(ctx, twin);
  assert.equal(seeded.binding.snapshotId, first.binding.snapshotId, "the twin starts from the sibling's sealed snapshot");
  assert.deepEqual(ctx.jobsFor(twin), []);
  const xmlRel = "src/main/resources/mapper/ItemMapper.xml";
  const resourceHash = (snapshotId: string) => {
    const db = openImmutableIndexDb(ctx.owner.store.snapshotPath(snapshotId));
    try { return (db.prepare("SELECT content_hash AS hash FROM mybatis_resource WHERE path=?").get(xmlRel) as { hash: string } | undefined)?.hash; }
    finally { close(db); }
  };
  const mainHash = resourceHash(first.binding.snapshotId);
  assert.ok(mainHash);
  const twinRounds = () => rounds(ctx, seeded.workspace.workspaceId).filter(round => round.outcome === "published");
  const sameAsOwnFull = async (label: string) => {
    const published = ctx.owner.store.binding(seeded.workspace.workspaceId)!;
    const independent = await openOwner(t, path.join(dir, `cache-full-${label}`));
    const full = await bound(independent, twin);
    assert.equal(published.contentManifestId, full.binding.contentManifestId, `${label}: the twin's capture`);
    assert.equal(digestOf(ctx.owner, published.snapshotId), digestOf(independent.owner, full.binding.snapshotId), `${label}: equals the twin's own full`);
    await independent.owner.stop();
    return published;
  };

  // Modify: only the XML changes; the Java of both worktrees stays identical.
  const file = path.join(twin, xmlRel);
  const text = (await readFile(file, "utf8")).replace("</mapper>", `  <select id="findTwinOnly" resultType="demomybatis.ItemEntity">select * from items where twin</select>\n</mapper>`);
  await writeFile(file, text);
  ctx.sources.emit(twin, xmlRel);
  await until(() => twinRounds().length === 1 && !seeded.workspace.status().roundInFlight, "xml modify");
  assert.deepEqual(ctx.jobsFor(twin), [{ kind: "refresh", generation: 2, changed: [xmlRel], deleted: [], buildKey: first.binding.buildKey }]);
  const modified = await sameAsOwnFull("modify");
  assert.notEqual(modified.snapshotId, first.binding.snapshotId);
  assert.equal(resourceHash(modified.snapshotId), createHash("sha256").update(text).digest("hex"), "the twin's XML, not the sibling's");

  // Delete the XML.
  await rm(file);
  ctx.sources.emit(twin, xmlRel);
  await until(() => twinRounds().length === 2 && !seeded.workspace.status().roundInFlight, "xml delete");
  assert.deepEqual(ctx.jobsFor(twin).at(-1), { kind: "refresh", generation: 3, changed: [], deleted: [xmlRel], buildKey: first.binding.buildKey });
  const deleted = await sameAsOwnFull("delete");
  assert.equal(resourceHash(deleted.snapshotId), undefined);

  // The sibling keeps its own binding and content throughout.
  assert.equal(ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId, first.binding.snapshotId);
  assert.equal(resourceHash(first.binding.snapshotId), mainHash);
});

test("a sibling under another buildKey is never a seed base: the worktree builds its own full", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const other = await repo(dir, "other-build");
  for (const [root, version] of [[main, "17"], [other, "21"]]) {
    const moduleDir = path.join(root, "empty-module");
    await mkdir(moduleDir);
    await writeFile(path.join(moduleDir, "pom.xml"),
      `<project><properties><maven.compiler.release>${version}</maven.compiler.release></properties></project>`);
  }
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const second = await bound(ctx, other);
  assert.notEqual(second.binding.buildKey, first.binding.buildKey);
  assert.deepEqual(ctx.jobsFor(other).map(job => job.kind), ["full"]);
  const round = rounds(ctx, second.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.kind, round.seedFrom], ["full", undefined]);
});

test("a worktree with an old build key uses a compatible sibling while the full slot is busy", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const exact = await repo(dir, "exact");
  const edited = await repo(dir, "edited");
  const blocker = await repo(dir, "blocker");
  const pom = path.join(main, "pom.xml");
  const currentPom = (await readFile(pom, "utf8")).replace("</project>", "  <!-- current configuration -->\n</project>");
  await writeFile(pom, currentPom);
  await writeFile(path.join(blocker, "pom.xml"), currentPom.replace("current configuration", "different configuration"));
  const ctx = await openOwner(t, path.join(dir, "cache"), { startBuild: input => {
    ctx.jobs.push({ repoRoot: input.repoRoot, job: input.job });
    if (input.repoRoot !== blocker) return startBuildProcess(input);
    return { child: spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      result: new Promise(() => {}) };
  } });
  const seed = await bound(ctx, main);
  const oldExact = await bound(ctx, exact);
  const oldEdited = await bound(ctx, edited);
  const exactBuilds = ctx.jobsFor(exact).length;
  const editedBuilds = ctx.jobsFor(edited).length;
  assert.notEqual(oldExact.binding.buildKey, seed.binding.buildKey);
  await ctx.owner.workspace(blocker);
  await until(() => ctx.owner.scheduler.status().full === 1, "full slot occupied");
  await addMethod(edited, "onlyInWorktree");
  for (const root of [exact, edited]) {
    await writeFile(path.join(root, "pom.xml"), currentPom);
    ctx.sources.emit(root, "pom.xml");
  }
  const oldLease = ctx.owner.store.acquire(oldEdited.binding.snapshotId, "request");
  try {
    assert.equal(ctx.owner.store.binding(oldEdited.workspace.workspaceId)?.snapshotId, oldEdited.binding.snapshotId);
    const nextExact = await bound(ctx, exact);
    const nextEdited = await bound(ctx, edited);
    assert.equal(nextExact.binding.snapshotId, seed.binding.snapshotId);
    assert.equal(nextEdited.binding.buildKey, seed.binding.buildKey);
    assert.notEqual(nextEdited.binding.snapshotId, seed.binding.snapshotId);
    assert.ok(existsSync(oldLease.dbPath), "an outstanding request can still read the old snapshot");
    assert.equal(ctx.owner.scheduler.status().full, 1);
    const schedulerEvents = ctx.events.flatMap(e => e.type === "scheduler" ? [e.event as BuildSchedulerEvent] : [])
      .filter(e => e.workspaceId === oldEdited.workspace.workspaceId);
    const dispatched = schedulerEvents.filter(e => e.type === "dispatched").at(-1);
    const result = schedulerEvents.filter(e => e.type === "result").at(-1);
    assert.equal(dispatched?.kind, "delta");
    assert.equal(result?.ok, true);
    assert.deepEqual(ctx.jobsFor(exact).slice(exactBuilds), []);
    assert.deepEqual(ctx.jobsFor(edited).slice(editedBuilds).map(job => job.kind), ["refresh"]);
    const records = await publications(ctx.owner);
    const rebound = records.find(r => r.workspaceId === oldExact.workspace.workspaceId && r.snapshotId === nextExact.binding.snapshotId);
    const delta = records.find(r => r.workspaceId === oldEdited.workspace.workspaceId && r.snapshotId === nextEdited.binding.snapshotId);
    assert.deepEqual([rebound?.plannedMode, rebound?.comparisonBaseSnapshotId, rebound?.cloneBaseSnapshotId],
      ["seed-bind", seed.binding.snapshotId, undefined]);
    assert.deepEqual([delta?.actualBuildMode, delta?.comparisonBaseSnapshotId, delta?.cloneBaseSnapshotId],
      ["delta", seed.binding.snapshotId, seed.binding.snapshotId]);
    const deltaRound = rounds(ctx, oldEdited.workspace.workspaceId).at(-1);
    t.diagnostic(JSON.stringify({ dispatched, result, exact: rounds(ctx, oldExact.workspace.workspaceId).at(-1)?.timings,
      delta: deltaRound?.timings }));
  } finally { oldLease.release(); }
});

test("a snapshot bound by a seeded twin survives its first workspace's next publish and every sweep", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const twin = await repo(dir, "twin");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const second = await bound(ctx, twin);
  assert.equal(second.binding.snapshotId, first.binding.snapshotId);
  await addMethod(main, "movedOn");
  ctx.sources.emit(main, serviceRel);
  await until(() => ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId !== first.binding.snapshotId
    && first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "main publishes");
  await ctx.owner.reclaim();
  await ctx.owner.sweep();
  await ctx.owner.sweep();
  assert.equal(ctx.owner.store.binding(second.workspace.workspaceId)?.snapshotId, first.binding.snapshotId);
  assert.ok(existsSync(path.join(ctx.owner.store.layout.snapshots, first.binding.snapshotId, "index.sqlite")), "the twin's bound snapshot is kept");
});

test("a bound workspace whose build-file bytes changed (same layout) gets a new buildKey from a rescan delta on its own base", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const pom = path.join(main, "pom.xml");
  await writeFile(pom, (await readFile(pom, "utf8")).replace("</project>", "  <!-- changed build input -->\n</project>"));
  ctx.sources.emit(main, "pom.xml");
  await until(() => ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId !== first.binding.snapshotId
    && first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "main republishes");
  const jobs = ctx.jobsFor(main);
  assert.deepEqual(jobs.map(job => job.kind), ["full", "reconcile"], "a dependency or comment edit is not a full rebuild");
  assert.equal(jobs[1]!.buildInputsMoved, true, "the builder is told its base was published under another buildKey");
  const round = rounds(ctx, first.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.outcome, round.kind], ["published", "rescan"]);
  assert.ok(round.timings?.cloneMs !== undefined, "the own base was cloned");
  // The buildKey still moves: JDT and the router learn of the build change from this publish (buildKeyChanged).
  assert.notEqual(ctx.owner.store.binding(first.workspace.workspaceId)!.buildKey, first.binding.buildKey);
  const published = (await publications(ctx.owner)).at(-1)!;
  assert.deepEqual([published.fullReason, published.comparisonBaseSnapshotId, published.cloneBaseSnapshotId],
    [undefined, first.binding.snapshotId, first.binding.snapshotId]);
});

test("a bound workspace whose build inputs moved its layout gets an explicit full on an empty job, never a rescan delta", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  // A new active source root changes the layout fingerprint the base recorded: its facts (source roots,
  // modules) no longer describe the workspace, so the owner decides the full before cloning anything.
  const testRel = "src/test/java/demospring/OrderServiceTest.java";
  await mkdir(path.join(main, path.dirname(testRel)), { recursive: true });
  await writeFile(path.join(main, testRel), "package demospring;\n\nclass OrderServiceTest {}\n");
  const pom = path.join(main, "pom.xml");
  await writeFile(pom, (await readFile(pom, "utf8")).replace("</project>", "  <!-- changed build input -->\n</project>"));
  ctx.sources.emit(main, testRel);
  ctx.sources.emit(main, "pom.xml");
  await until(() => ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId !== first.binding.snapshotId
    && first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "main republishes");
  assert.deepEqual(ctx.jobsFor(main).map(job => job.kind), ["full", "full"]);
  assert.ok(ctx.jobsFor(main).every(job => !job.buildInputsMoved));
  const round = rounds(ctx, first.workspace.workspaceId).at(-1)!;
  assert.deepEqual([round.outcome, round.kind, round.timings?.cloneMs], ["published", "full", undefined], "no base clone for an explicit full");
  const published = (await publications(ctx.owner)).at(-1)!;
  assert.deepEqual([published.fullReason, published.comparisonBaseSnapshotId, published.cloneBaseSnapshotId],
    ["build-key-changed", first.binding.snapshotId, undefined]);
});

test("a reopened workspace whose binding carries a later generation keeps publishing: the new tracker starts at that generation", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"));
  const first = await bound(ctx, main);
  const pom = path.join(main, "pom.xml");
  await writeFile(pom, (await readFile(pom, "utf8")).replace("</project>", "  <!-- changed build input -->\n</project>"));
  ctx.sources.emit(main, "pom.xml");
  await until(() => ctx.owner.store.binding(first.workspace.workspaceId)!.workspaceGeneration === 2
    && first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "the build-input change publishes at generation 2");
  // Idle retirement and a daemon restart both start a new tracker for the same root.
  await ctx.owner.retire(main);
  const reopened = await bound(ctx, main);
  const before = ctx.owner.store.binding(reopened.workspace.workspaceId)!;
  await addMethod(main, "afterReopen");
  ctx.sources.emit(main, serviceRel);
  await until(() => ctx.owner.store.binding(reopened.workspace.workspaceId)!.snapshotId !== before.snapshotId
    && reopened.workspace.trackerStatus() === "FRESH" && !reopened.workspace.status().roundInFlight, "the reopened workspace publishes the edit", 60_000);
  assert.equal(rounds(ctx, first.workspace.workspaceId).filter(round => round.outcome === "failed").length, 0, "no round is refused for a generation below the binding's");
  assert.equal(ctx.owner.store.binding(reopened.workspace.workspaceId)!.workspaceGeneration, 2);
});

test("a delta that ran out its job deadline is followed by a full, not by the same delta again", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  let failed = 0;
  const ctx = await openOwner(t, path.join(dir, "cache"), { startBuild: input => {
    ctx.jobs.push({ repoRoot: input.repoRoot, job: input.job });
    if (input.job.kind !== "refresh" || failed > 0) return startBuildProcess(input);
    failed += 1;
    // The scheduler's own deadline message, without waiting the real 60 s.
    return { child: spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { stdio: "ignore" }), result: Promise.reject(new Error("delta build deadline exceeded")) };
  } });
  const first = await bound(ctx, main);
  await addMethod(main, "afterDeadline");
  ctx.sources.emit(main, serviceRel);
  await until(() => ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId !== first.binding.snapshotId
    && first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "main publishes after the failed delta");
  assert.deepEqual(ctx.jobsFor(main).map(job => job.kind), ["full", "refresh", "full"]);
  assert.deepEqual(rounds(ctx, first.workspace.workspaceId).filter(round => round.kind !== "noop").map(round => [round.kind, round.outcome]),
    [["full", "published"], ["delta", "failed"], ["full", "published"]]);
  const history = await publications(ctx.owner);
  assert.equal(history.length, 2);
  assert.equal(history[1]?.fullReason, "delta-deadline");
});

test("publication history reports a full builder that escalated after cloning the comparison base", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"), { startBuild: input => {
    if (input.job.kind !== "refresh") return startBuildProcess(input);
    return {
      child: spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      result: Promise.resolve({ kind: "needs-full", captures: [], reason: "delta escalated to full: dependency closure 401 > 400 files" })
    };
  } });
  const first = await bound(ctx, main);
  await addMethod(main, "afterEscalation");
  ctx.sources.emit(main, serviceRel);
  const second = await until(() => {
    const binding = ctx.owner.store.binding(first.workspace.workspaceId);
    return binding && binding.snapshotId !== first.binding.snapshotId && !first.workspace.status().roundInFlight && binding;
  }, "full publication after escalation");
  const [initial, published] = await publications(ctx.owner);
  assert.equal(initial.indexedGeneration, 1);
  assert.deepEqual({ ...published, at: undefined }, {
    at: undefined, workspaceId: second.workspaceId, bindingVersion: second.bindingVersion, snapshotId: second.snapshotId,
    indexedGeneration: 2, plannedMode: "delta", actualBuildMode: "full", fullReason: "closure-limit",
    comparisonBaseSnapshotId: first.binding.snapshotId, cloneBaseSnapshotId: first.binding.snapshotId, bindingResult: "bound"
  });
});

test("a divergent builder census publishes usable content but owes a full hash before confirming freshness", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  let race = false;
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const extra = "src/main/java/demospring/Late.java";
  const children: ReturnType<typeof startBuildProcess>["child"][] = [];
  // Release a paused follow-up before the owner's after hook waits for it.
  t.after(release);
  const ctx = await openOwner(t, path.join(dir, "cache"), {
    faultAt: async stage => { if (hold && stage === "round-full-hash") await gate; },
    startBuild: input => {
      ctx.jobs.push({ repoRoot: input.repoRoot, job: input.job });
      if (race) {
        race = false;
        hold = true;
        const file = path.join(main, serviceRel);
        writeFileSync(file, readFileSync(file, "utf8").replace(/}\s*$/, "  public void capturedLater() {}\n}\n"));
        writeFileSync(path.join(main, extra), "package demospring; public class Late {}\n");
        // No native hint: the observed census disagreement itself must schedule the rescan.
      }
      const attempt = startBuildProcess(input);
      children.push(attempt.child);
      return attempt;
    }
  });
  const first = await bound(ctx, main);
  const confirmed = first.workspace.tracker.diagnostics().confirmed;
  await addMethod(main, "dispatchEdit");
  race = true;
  ctx.sources.emit(main, serviceRel);
  const event = await until(() => rounds(ctx, first.workspace.workspaceId).find(round => round.censusDiverged), "divergent publish");
  try {
    assert.equal(event.outcome, "published");
    assert.notEqual(ctx.owner.store.binding(first.workspace.workspaceId)!.snapshotId, first.binding.snapshotId);
    assert.equal(first.workspace.trackerStatus(), "STALE", "the builder census cannot confirm a different verified census");
    assert.equal(first.workspace.status().view, "STALE");
    assert.deepEqual(first.workspace.tracker.diagnostics().confirmed, confirmed, "no confirmation watermark advances");
    assert.equal(first.workspace.tracker.diagnostics().pending, 1, "the dispatched hint is still owed");
    assert.ok(first.workspace.tracker.diagnostics().fullHashThrough > ctx.owner.store.binding(first.workspace.workspaceId)!.coveredThroughSeq);
    const content = await readSnapshotContent(ctx.owner.store.layout, event.snapshotId!);
    assert.equal(content.entries.get(serviceRel)!.hash, createHash("sha256").update(await readFile(path.join(main, serviceRel))).digest("hex"),
      "the usable binding records the bytes the real builder captured");
    assert.equal(content.entries.has(extra), false, "the delta did not pretend to capture an unplanned member");
  } finally { hold = false; release(); }
  await until(() => first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "rescan converges");
  const final = ctx.owner.store.binding(first.workspace.workspaceId)!;
  assert.ok((await readSnapshotContent(ctx.owner.store.layout, final.snapshotId)).entries.has(extra));
  assert.equal(first.workspace.tracker.diagnostics().pending, 0);
  assert.equal(rounds(ctx, first.workspace.workspaceId).at(-1)!.mode, "full-hash");
  assert.ok(children.length >= 3);
  assert.ok(children.every(child => child.exitCode === 0), "every real builder exited before its round settled");
});

test("a builder that reads a later build key is refused without clearing hints, then retries the stable environment", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  let race = false;
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const children: ReturnType<typeof startBuildProcess>["child"][] = [];
  t.after(release);
  const ctx = await openOwner(t, path.join(dir, "cache"), {
    faultAt: async stage => { if (hold && stage.startsWith("round-")) await gate; },
    startBuild: input => {
      ctx.jobs.push({ repoRoot: input.repoRoot, job: input.job });
      if (race) {
        race = false;
        hold = true;
        const pom = path.join(main, "pom.xml");
        writeFileSync(pom, `${readFileSync(pom, "utf8")}<!-- after dispatch -->\n`);
      }
      const attempt = startBuildProcess(input);
      children.push(attempt.child);
      return attempt;
    }
  });
  const first = await bound(ctx, main);
  const confirmed = first.workspace.tracker.diagnostics().confirmed;
  await addMethod(main, "keyRace");
  race = true;
  ctx.sources.emit(main, serviceRel);
  const failed = await until(() => rounds(ctx, first.workspace.workspaceId).find(round => round.outcome === "failed"), "build key refusal");
  try {
    // The builder reads the later key at start and refuses before spending the build (the publish check is the backstop).
    assert.match(failed.error!, /buildKey changed before build/);
    assert.deepEqual(ctx.owner.store.binding(first.workspace.workspaceId), first.binding, "the safe refusal preserves the old binding");
    assert.equal(first.workspace.trackerStatus(), "STALE");
    assert.deepEqual(first.workspace.tracker.diagnostics().confirmed, confirmed);
    assert.equal(first.workspace.tracker.diagnostics().pending, 1);
  } finally { hold = false; release(); }
  await until(() => first.workspace.trackerStatus() === "FRESH" && !first.workspace.status().roundInFlight, "stable key retry");
  const final = ctx.owner.store.binding(first.workspace.workspaceId)!;
  assert.notEqual(final.buildKey, first.binding.buildKey);
  assert.equal(final.workspaceGeneration, first.binding.workspaceGeneration + 1);
  assert.equal(first.workspace.tracker.diagnostics().pending, 0);
  // The stable key's retry: the pom edit (a comment) keeps the layout the base recorded, so a rescan delta on it.
  assert.equal(rounds(ctx, first.workspace.workspaceId).at(-1)!.kind, "rescan");
  assert.equal(ctx.jobsFor(main).at(-1)!.buildInputsMoved, true);
  assert.ok(children.length >= 3);
  assert.ok(children.every(child => child.exitCode === 0), "the refused and successful real builders were reaped");
});

test("a delta publish is verified in the background; a FAILED verdict takes the workspace out of service until a full rebuild", async t => {
  const dir = await base(t);
  const main = await repo(dir, "main");
  const ctx = await openOwner(t, path.join(dir, "cache"), { verifyDelayMs: 300 });
  const first = await bound(ctx, main);
  const id = first.workspace.workspaceId;
  assert.equal(first.workspace.status().verified, true, "a full seal is verified before it is bound");
  const verdicts = () => ctx.events.filter((event): event is Extract<OwnerEvent, { type: "verification" }> => event.type === "verification");
  const publishOf = async (name: string, corrupt?: (file: string) => Promise<void>) => {
    const previous = ctx.owner.store.binding(id)!.snapshotId;
    let published: string | undefined;
    // Inside the quiet delay, before the background check reads the file.
    const off = ctx.owner.onPublished(event => { if (event.workspaceId === id) void (corrupt ? corrupt(ctx.owner.store.snapshotPath(event.snapshotId)) : Promise.resolve()).then(() => { published = event.snapshotId; }); });
    await addMethod(main, name);
    ctx.sources.emit(main, serviceRel);
    // Polling keeps the event loop alive: the owner's own timers are unref'd.
    const snapshotId = await until(() => published, `publish ${name}`);
    off();
    assert.notEqual(snapshotId, previous);
    return snapshotId;
  };
  const delta = await publishOf("verifiedLater");
  assert.equal(rounds(ctx, id).at(-1)!.kind, "delta");
  assert.equal(ctx.owner.store.isVerified(delta), false, "bound before its full check");
  await until(() => verdicts().some(event => event.snapshotId === delta && event.outcome === "verified"), "background verdict");
  assert.equal(first.workspace.status().verified, true);
  // A corrupt row the delta did not write: past the pre-publish check, caught by the background one.
  const broken = await publishOf("brokenLater", async file => {
    const dir = path.dirname(file);
    await chmod(dir, 0o755); await chmod(file, 0o644);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const changed = db.prepare(`UPDATE kg_edge SET kind_sym=999999999 WHERE id=(SELECT max(id) FROM kg_edge WHERE id NOT IN
        (SELECT edge_id FROM kg_edge_owner WHERE owner_sym=(SELECT id FROM sym WHERE text=?)))`).run(serviceRel).changes;
      assert.equal(Number(changed), 1);
    }
    finally { db.close(); }
    await chmod(file, 0o444); await chmod(dir, 0o555);
  });
  const failed = await until(() => verdicts().find(event => event.snapshotId === broken && event.outcome !== "skipped"), "failed verdict");
  assert.equal(failed.outcome, "failed", JSON.stringify(failed));
  assert.deepEqual(failed.quarantined, [id]);
  const rebuilt = await until(() => {
    const binding = ctx.owner.store.binding(id);
    return binding && binding.snapshotId !== broken && !first.workspace.status().roundInFlight && binding;
  }, "full rebuild after the failed verdict");
  assert.equal(rounds(ctx, id).at(-1)!.kind, "full");
  assert.equal(ctx.owner.store.isVerified(rebuilt.snapshotId), true);
  assert.equal(rebuilt.bindingVersion, ctx.owner.store.bindingVersionOf(id));
  assert.equal((await publications(ctx.owner)).at(-1)?.fullReason, "verification-failed");
});
