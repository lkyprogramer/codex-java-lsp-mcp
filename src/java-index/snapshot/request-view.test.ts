import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startBuildProcess } from "../../index-builder/build-process.js";
import type { BuildAttempt } from "../../index-builder/build-scheduler.js";
import { probeLayout } from "../../layout-probe.js";
import { ownerChildStdio } from "../../mac-platform/owner-lock.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { IndexOwner, type IndexOwnerOptions, type OwnerEvent } from "./index-owner.js";
import type { QueryRequest } from "./query-ops.js";
import { snapshotIndexStatus, SnapshotJavaIndexClient, withRequestView, type RequestView } from "./request-view.js";
import { FSEVENT_FLAGS, type TrackerSourceFactory } from "./workspace-tracker.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const orderRel = "src/main/java/demospring/Order.java";
const FILE_MODIFIED = 0x1000 | FSEVENT_FLAGS.ItemIsFile;

const evidence: Array<Record<string, unknown>> = [];
after(async () => {
  const root = process.env.ILV2_EVIDENCE_ROOT;
  if (!root) return;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "request-view.json"), JSON.stringify({ fixture: "fixtures/java-index-v2 copies; deterministic tracker signals; real builder and query processes", evidence }, null, 2));
});

/** Deterministic change streams per root: the test owns every hint and its order. */
function fakeSources() {
  const emitters = new Map<string, (flags: number, file: string) => void>();
  const factory = (root: string): TrackerSourceFactory => async onSignal => {
    emitters.set(root, onSignal);
    let lose!: (error: Error) => void;
    const closed = new Promise<void>((_, reject) => { lose = reject; });
    void lose;
    closed.catch(() => undefined);
    return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => {}, closed };
  };
  return { factory, emit: (root: string, relative: string) => emitters.get(root)!(FILE_MODIFIED, path.join(root, relative)) };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
async function setup(t: TestContext, options: Partial<IndexOwnerOptions> & { roots?: number; stalledRoot?: Promise<void> } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-request-view-")));
  const roots: string[] = [];
  for (let index = 0; index < (options.roots ?? 1); index += 1) {
    const repo = path.join(base, `repo-${index}`);
    await cp(fixturesRoot, repo, { recursive: true });
    roots.push(repo);
  }
  const sources = fakeSources();
  const events: OwnerEvent[] = [];
  const { roots: _roots, stalledRoot: _stalled, ...ownerOptions } = options;
  const owner = await IndexOwner.open({ cacheRoot: path.join(base, "cache"), trackerSource: root => sources.factory(root), roundDelayMs: 5,
    onEvent: event => events.push(event), ...ownerOptions });
  t.after(async () => {
    await owner.stop();
    const writable = async (dir: string): Promise<void> => {
      await chmod(dir, 0o755).catch(() => undefined);
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    await writable(base);
    await rm(base, { recursive: true, force: true });
  });
  return { base, roots, repo: roots[0]!, owner, sources, events };
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

/** The workspace's first verified binding (a real full build through the scheduler). */
async function bound(ctx: Ctx, root = ctx.repo) {
  const workspace = await ctx.owner.workspace(root);
  await until(() => ctx.owner.store.binding(workspace.workspaceId) && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, `first publish ${root}`, 120_000);
  return { workspace, binding: ctx.owner.store.binding(workspace.workspaceId)! };
}

async function edit(ctx: Ctx, root: string, relative: string, transform: (text: string) => string) {
  const file = path.join(root, relative);
  await writeFile(file, transform(await readFile(file, "utf8")));
  ctx.sources.emit(root, relative);
}

function request<T>(ctx: Ctx, root: string, timeoutMs: number, handler: (view: RequestView) => Promise<T>, extra: { resolve?: () => Promise<string>; signal?: AbortSignal } = {}) {
  const budget = DeadlineBudget.fromTimeout(timeoutMs);
  const started = performance.now();
  const run = withRequestView({ owner: ctx.owner, budget, signal: extra.signal, resolve: extra.resolve ?? (async () => root), handler });
  return { budget, started, run };
}

/** Settles within deadline + 1000 ms (contract §2.6), whatever the outcome. */
async function settledWithin<T>(call: { budget: DeadlineBudget; started: number; run: Promise<T> }, label: string) {
  const outcome = await call.run.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const returnedAt = performance.now();
  const lateMs = returnedAt - call.budget.deadlineAtMs;
  evidence.push({ label, elapsedMs: returnedAt - call.started, lateMs, ok: outcome.ok, error: outcome.ok ? undefined : String((outcome.error as Error).message) });
  assert.ok(lateMs <= 1000, `${label}: returned ${lateMs.toFixed(0)} ms after its deadline`);
  return outcome;
}

const code = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "OK" : outcome.error instanceof JavaIntelligenceError ? outcome.error.code : "OTHER";

function clientFor(view: RequestView, status: Awaited<ReturnType<RequestView["snapshotStatus"]>>) {
  return new SnapshotJavaIndexClient(view.owner, view.snapshotId!, view.canonicalRoot, snapshotIndexStatus(status, view.snapshotId!), probeLayout(view.canonicalRoot));
}

const sleeper = `setInterval(() => {}, 1000); process.on('message', () => {});`;
/** A builder stuck in its job: the round it belongs to cannot finish while it runs. */
async function stuckBuilders(t: TestContext) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-request-view-sleeper-")));
  const file = path.join(base, "sleeper.mjs");
  await writeFile(file, sleeper);
  const held: BuildAttempt[] = [];
  t.after(async () => {
    for (const attempt of held) attempt.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  });
  return { held, start(): BuildAttempt {
    const child = fork(file, [], { execArgv: [], stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) });
    const attempt = { child, result: new Promise<never>(() => {}) };
    held.push(attempt);
    return attempt;
  } };
}

test("nonzero-deadline-bounds-all-stages", { timeout: 240_000 }, async t => {
  let holdBuild = false;
  const stuck = await stuckBuilders(t);
  const held = stuck.held;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const blocked = new Set<string>();
  const ctx = await setup(t, {
    roots: 2,
    startBuild: input => holdBuild ? stuck.start() : startBuildProcess(input),
    queryTestBlockMs: (query: QueryRequest) => blocked.has(query.op) ? 60_000 : undefined
  });
  const stalledRoot = ctx.roots[1]!;
  // The second root's change source never comes up until released: workspace create stalls.
  const sources = ctx.sources;
  (ctx.owner.options as { trackerSource?: (root: string) => TrackerSourceFactory }).trackerSource = root => root !== stalledRoot ? sources.factory(root)
    : async (onSignal, onResume) => { await createGate; return sources.factory(root)(onSignal, onResume); };
  const { workspace, binding } = await bound(ctx);

  // 1. resolve stalls.
  const resolveStall = await settledWithin(request(ctx, ctx.repo, 800, async () => "unreachable", { resolve: () => new Promise<string>(() => {}) }), "resolve-stall");
  assert.equal(code(resolveStall), "DEADLINE_EXCEEDED");

  // 2. create stalls; the shared create keeps going and is reused once its source comes up.
  const createStall = await settledWithin(request(ctx, stalledRoot, 800, async () => "unreachable"), "create-stall");
  assert.equal(code(createStall), "DEADLINE_EXCEEDED");
  assert.equal(ctx.owner.peek(stalledRoot), undefined);

  // 3. prepare is capped at min(1000 ms, remaining) while a round cannot finish; the request then serves the held binding as STALE.
  holdBuild = true;
  await edit(ctx, ctx.repo, serviceRel, text => text.replace("class OrderService {", "class OrderService {\n  void prepareStall() {}"));
  await until(() => held.length === 1, "stuck builder started");
  const prepareCall = request(ctx, ctx.repo, 5000, async view => ({ labels: view.labels, hits: await view.query({ op: "type", args: { typeText: "demospring.OrderService" } }) }));
  const prepared = await settledWithin(prepareCall, "prepare-stall");
  assert.equal(prepared.ok, true);
  const preparedElapsed = evidence.at(-1)!.elapsedMs as number;
  assert.ok(preparedElapsed < 2000, `prepare took ${preparedElapsed} ms`);
  assert.equal(prepared.ok && prepared.value.labels.state, "STALE");
  assert.equal(prepared.ok && prepared.value.labels.snapshotId, binding.snapshotId);
  assert.equal(prepared.ok && prepared.value.hits.state, "RESOLVED");
  const shortPrepare = await settledWithin(request(ctx, ctx.repo, 300, async view => view.labels.state), "prepare-stall-short");
  assert.equal(shortPrepare.ok && shortPrepare.value, "STALE", "a short request keeps time to answer from its binding");

  // 4. a stuck SQL step in a query worker: the caller returns at its deadline, the worker is killed and reaped.
  blocked.add("search");
  const eventsBefore = ctx.events.length;
  const sqlCall = request(ctx, ctx.repo, 1500, view => view.query({ op: "search", args: { task: "OrderService", limit: 5, mode: "auto" } }));
  const stallPids = new Set<number>();
  let sampling = true;
  void sqlCall.run.finally(() => { sampling = false; }).catch(() => undefined);
  const sample = (async () => { while (sampling) { for (const pid of ctx.owner.pool.status().pids) stallPids.add(pid); await delay(10); } })();
  const sqlStall = await settledWithin(sqlCall, "sql-stall");
  await sample;
  assert.equal(code(sqlStall), "DEADLINE_EXCEEDED");
  // §2.6: the stalled worker itself is SIGKILLed and reaped within 2 s of the request deadline.
  type PoolClose = { type: string; pid?: number; signal?: NodeJS.Signals | null };
  const killed = await until(() => ctx.events.slice(eventsBefore).map(event => event.type === "pool" ? event.event as PoolClose : undefined)
    .find(event => event?.type === "worker-close" && event.signal === "SIGKILL"), "stalled worker reaped", Math.max(1, sqlCall.budget.deadlineAtMs + 2000 - performance.now()));
  evidence.push({ test: "sql-stall-reap", killedPid: killed.pid, stallPids: [...stallPids], reapedAfterDeadlineMs: performance.now() - sqlCall.budget.deadlineAtMs });
  assert.ok(killed.pid !== undefined && stallPids.has(killed.pid), `the killed worker ${killed.pid} served the stalled query (${[...stallPids]})`);
  assert.throws(() => process.kill(killed.pid!, 0), /ESRCH/, "the stalled worker is gone");
  assert.equal(ctx.owner.pool.status().pids.includes(killed.pid!), false);
  blocked.delete("search");

  // 5. a live preview that never finishes reading (a FIFO in place of the source).
  const fifoRel = orderRel;
  await rm(path.join(ctx.repo, fifoRel));
  execFileSync("/usr/bin/mkfifo", [path.join(ctx.repo, fifoRel)]);
  const previewStall = await settledWithin(request(ctx, ctx.repo, 1500, async view => {
    const client = clientFor(view, await view.snapshotStatus());
    return client.queryReadRanges([{ file: path.join(ctx.repo, fifoRel), positions: [{ line: 3, column: 7 }] }], { budget: view.budget });
  }), "preview-stall");
  assert.equal(code(previewStall), "DEADLINE_EXCEEDED");

  // Convergence: release every stall; no lease or worker is left, the stuck round is abandoned and caught up.
  await rm(path.join(ctx.repo, fifoRel));
  await cp(path.join(fixturesRoot, orderRel), path.join(ctx.repo, orderRel));
  ctx.sources.emit(ctx.repo, orderRel);
  holdBuild = false;
  for (const attempt of held) attempt.child.kill("SIGKILL");
  releaseCreate();
  await until(() => ctx.owner.store.binding(workspace.workspaceId)!.snapshotId !== binding.snapshotId && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, "stuck round caught up", 120_000);
  const second = await ctx.owner.workspace(stalledRoot);
  assert.equal(ctx.owner.peek(stalledRoot), second, "the stalled create converged and is shared");
  const caughtUp = await settledWithin(request(ctx, ctx.repo, 5000, async view => ({ labels: view.labels,
    method: await view.query({ op: "search", args: { task: "prepareStall", limit: 5, mode: "auto" } }) })), "after-stalls");
  assert.equal(caughtUp.ok && caughtUp.value.labels.state, "FRESH");
  assert.ok(caughtUp.ok && caughtUp.value.method.hits.some(hit => hit.simpleName === "prepareStall"), "the caught-up snapshot has the method only the stuck round added");
  await until(() => ctx.owner.pool.status().running === 0 && ctx.owner.pool.status().reaping === 0, "pool idle", 5000);
  const current = ctx.owner.store.binding(workspace.workspaceId)!.snapshotId;
  await until(() => ctx.owner.store.leaseCount(current) === ctx.owner.pool.status().leases, "only worker connection leases remain", 5000);
  await ctx.owner.reclaim();
  assert.equal(existsSync(path.join(ctx.owner.store.layout.snapshots, binding.snapshotId)), false, "the superseded snapshot was reclaimed");
});

test("publish-does-not-upgrade-held-view", { timeout: 180_000 }, async t => {
  const ctx = await setup(t);
  const { workspace, binding: first } = await bound(ctx);
  const observed = await request(ctx, ctx.repo, 120_000, async view => {
    const before = { labels: { ...view.labels }, status: await view.snapshotStatus(),
      added: await view.query({ op: "search", args: { task: "addedLater", limit: 5, mode: "exact" } }),
      anchor: await view.query({ op: "anchor", args: { relativePath: serviceRel, line: 8, column: 7 } }) };
    // A publish lands while this request still holds its view.
    await edit(ctx, ctx.repo, serviceRel, text => text.replace("class OrderService {", "class OrderService {\n  void addedLater() {}"));
    await until(() => ctx.owner.store.binding(workspace.workspaceId)!.snapshotId !== first.snapshotId && !workspace.status().roundInFlight, "publish during request", 120_000);
    assert.ok(ctx.owner.store.leaseCount(first.snapshotId) >= 1, "the held view keeps its snapshot leased");
    const client = clientFor(view, before.status);
    // A fresh status read (snapshotStatus() is memoized per view) against the held snapshot.
    const afterPublish = { labels: { ...view.labels }, status: await view.query({ op: "status", args: {} }),
      added: await view.query({ op: "search", args: { task: "addedLater", limit: 5, mode: "exact" } }),
      anchor: await view.query({ op: "anchor", args: { relativePath: serviceRel, line: 8, column: 7 } }),
      preview: await client.queryReadRanges([{ file: path.join(ctx.repo, serviceRel), positions: [{ line: 8, column: 7 }] }], { budget: view.budget }),
      unchangedPreview: await client.queryReadRanges([{ file: path.join(ctx.repo, orderRel), positions: [{ line: 3, column: 7 }] }], { budget: view.budget }) };
    // A captured file deleted from the live tree (no hint emitted, so no round) is a change, not a silent miss.
    const deletedRel = "src/main/java/demospring/OrderCreated.java";
    await rm(path.join(ctx.repo, deletedRel));
    const deletedPreview = await client.queryReadRanges([{ file: path.join(ctx.repo, deletedRel), positions: [{ line: 3, column: 7 }] }], { budget: view.budget });
    return { before, afterPublish, deletedPreview };
  }).run;
  const { before, afterPublish, deletedPreview } = observed;
  evidence.push({ test: "publish-does-not-upgrade-held-view", first: first.snapshotId, labels: afterPublish.labels });
  assert.deepEqual(afterPublish.labels, before.labels, "labels are frozen at the one acquire");
  assert.equal(afterPublish.labels.snapshotId, first.snapshotId);
  assert.equal(afterPublish.labels.state, "FRESH");
  assert.deepEqual(afterPublish.status, before.status, "hash/coverage come from the held snapshot");
  assert.equal(before.added.hits.length, 0);
  assert.equal(afterPublish.added.hits.length, 0, "the held view never sees the newer publish");
  assert.equal(afterPublish.anchor?.file.contentHash, before.anchor?.file.contentHash);
  assert.equal(afterPublish.preview[0]!.ranges.length, 0, "a live file that no longer matches the held snapshot is a gap");
  assert.equal(afterPublish.preview[0]!.sourceChanged, true);
  assert.ok(afterPublish.unchangedPreview[0]!.ranges.length > 0, "an unchanged file previews from the held snapshot");
  assert.equal(deletedPreview[0]!.ranges.length, 0);
  assert.equal(deletedPreview[0]!.sourceChanged, true, "a deleted captured file is an explicit sourceChanged gap");

  const next = await request(ctx, ctx.repo, 10_000, async view => ({ labels: view.labels, added: await view.query({ op: "search", args: { task: "addedLater", limit: 5, mode: "exact" } }),
    anchor: await view.query({ op: "anchor", args: { relativePath: serviceRel, line: 9, column: 7 } }),
    preview: await clientFor(view, await view.snapshotStatus()).queryReadRanges([{ file: path.join(ctx.repo, serviceRel), positions: [{ line: 9, column: 3 }] }], { budget: view.budget }) })).run;
  assert.notEqual(next.labels.snapshotId, first.snapshotId);
  assert.ok(next.added.hits.length > 0, "a new request acquires the new binding");
  assert.notEqual(next.anchor?.file.contentHash, before.anchor?.file.contentHash);
  assert.ok(next.preview[0]!.ranges.length > 0);
  await until(() => ctx.owner.store.leaseCount(first.snapshotId) === 0 || undefined, "old view released", 5000).catch(() => undefined);
  await ctx.owner.reclaim();
  assert.equal(existsSync(path.join(ctx.owner.store.layout.snapshots, first.snapshotId)), false, "released and superseded: reclaimed");
});

test("symbol-id-survives-unrelated-publish", { timeout: 180_000 }, async t => {
  const ctx = await setup(t);
  const { workspace, binding: first } = await bound(ctx);
  const issued = await request(ctx, ctx.repo, 10_000, view => view.query({ op: "symbolIdAt", args: { workspaceId: workspace.workspaceId, relativePath: serviceRel, line: 18, column: 17 } })).run;
  assert.ok(issued?.startsWith("jsym:mac1:"), `symbolId ${issued}`);
  await edit(ctx, ctx.repo, orderRel, text => text.replace("class Order {", "class Order {\n  static final int UNRELATED = 1;"));
  // Prepare runs before the one acquire: a request right after a hint either waits for the round (FRESH, new
  // snapshot) or spends its whole prepare cap and then serves the old binding as STALE; never STALE at once.
  const prepared = await settledWithin(request(ctx, ctx.repo, 10_000, async view => view.labels), "prepare-after-hint");
  const preparedMs = evidence.at(-1)!.elapsedMs as number;
  assert.ok(prepared.ok);
  if (prepared.ok && prepared.value.state === "FRESH") assert.notEqual(prepared.value.snapshotId, first.snapshotId, "FRESH after a hint is the new publish");
  else assert.ok(preparedMs >= 900, `served STALE after ${preparedMs.toFixed(0)} ms without waiting for the round`);
  await until(() => ctx.owner.store.binding(workspace.workspaceId)!.snapshotId !== first.snapshotId && workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight, "unrelated publish", 120_000);
  const later = await request(ctx, ctx.repo, 10_000, async view => ({ labels: view.labels,
    resolved: await view.query({ op: "resolveSymbol", args: { workspaceId: workspace.workspaceId, symbolId: issued! } }),
    reissued: await view.query({ op: "symbolIdAt", args: { workspaceId: workspace.workspaceId, relativePath: serviceRel, line: 18, column: 17 } }) })).run;
  evidence.push({ test: "symbol-id-survives-unrelated-publish", symbolId: issued, first: first.snapshotId, second: later.labels.snapshotId, resolved: later.resolved });
  assert.notEqual(later.labels.snapshotId, first.snapshotId);
  assert.equal(later.resolved.status, "FOUND");
  assert.equal(later.resolved.status === "FOUND" && later.resolved.relativePath, serviceRel);
  assert.equal(later.reissued, issued, "the same declaration keeps the same symbolId across publishes");
  const foreign = await request(ctx, ctx.repo, 10_000, view => view.query({ op: "resolveSymbol", args: { workspaceId: "w-0000000000000000000000000000000000000000", symbolId: issued! } })).run;
  assert.deepEqual(foreign, { status: "REJECTED", reason: "WORKSPACE_MISMATCH" });
});

test("a hint that lands during prepare does not extend the wait", { timeout: 180_000 }, async t => {
  let hold = false;
  let builds = 0;
  let duringFirstBuild: (() => void) | undefined;
  const stuck = await stuckBuilders(t);
  const ctx = await setup(t, { startBuild: input => {
    if (!hold) return startBuildProcess(input);
    builds += 1;
    if (builds > 1) return stuck.start();
    duringFirstBuild?.();
    return startBuildProcess(input);
  } });
  const { workspace, binding: first } = await bound(ctx);
  hold = true;
  // The second hint lands after the first round froze its cut; the round that would cover it never finishes.
  duringFirstBuild = () => {
    const file = path.join(ctx.repo, orderRel);
    writeFileSync(file, readFileSync(file, "utf8").replace("class Order {", "class Order {\n  static final int LATE = 1;"));
    ctx.sources.emit(ctx.repo, orderRel);
  };
  await edit(ctx, ctx.repo, serviceRel, text => text.replace("class OrderService {", "class OrderService {\n  void entryHint() {}"));
  const eventsBefore = ctx.events.length;
  const prepared = await settledWithin(request(ctx, ctx.repo, 10_000, async view => view.labels), "prepare-entry-watermark");
  const preparedMs = evidence.at(-1)!.elapsedMs as number;
  const event = ctx.events.slice(eventsBefore).find(entry => entry.type === "prepare");
  evidence.push({ test: "prepare-entry-watermark", preparedMs, event, builds, labels: prepared.ok ? prepared.value : code(prepared) });
  assert.equal(prepared.ok, true);
  assert.equal(event?.type === "prepare" && event.outcome, "covered", `prepare ended on the entry hints: ${JSON.stringify(event)}`);
  // The entry hint's round published; the late hint is still owed, so the view is STALE but newer.
  const labels = prepared.ok ? prepared.value : undefined;
  assert.notEqual(labels?.snapshotId, first.snapshotId);
  assert.equal(labels?.snapshotId, ctx.owner.store.binding(workspace.workspaceId)!.snapshotId);
  assert.equal(labels?.state, "STALE");
  assert.ok(preparedMs < 1000, `waited ${preparedMs.toFixed(0)} ms: the late hint's round extended prepare to its cap`);
  await until(() => builds === 2, "the late hint starts a round that never finishes", 10_000);
  assert.equal(ctx.owner.store.binding(workspace.workspaceId)!.snapshotId, labels?.snapshotId);
});

test("a workspace without its own verified binding is NOT_READY, never a sibling", { timeout: 180_000 }, async t => {
  let hold = false;
  const stuck = await stuckBuilders(t);
  const ctx = await setup(t, { roots: 2, startBuild: input => hold ? stuck.start() : startBuildProcess(input) });
  await bound(ctx, ctx.roots[0]);
  hold = true;
  const sibling = ctx.roots[1]!;
  const outcome = await request(ctx, sibling, 2000, async view => {
    const refused = await view.query({ op: "type", args: { typeText: "demospring.OrderService" } }).then(() => "served", error => (error as JavaIntelligenceError).code);
    return { labels: view.labels, refused };
  }).run;
  assert.equal(outcome.labels.state, "NOT_READY");
  assert.equal(outcome.labels.snapshotId, undefined);
  assert.equal(outcome.refused, "INDEX_PARTIAL");
  // Status-only: an unknown root is NOT_READY without starting a workspace.
  const third = path.join(ctx.base, "never-started");
  await mkdir(third);
  const statusOnly = await withRequestView({ owner: ctx.owner, budget: DeadlineBudget.fromTimeout(1000), start: false, resolve: async () => third, handler: async view => view.labels });
  assert.equal(statusOnly.state, "NOT_READY");
  assert.equal(ctx.owner.peek(third), undefined, "status-only never starts a workspace");
});

test("requests during a failed round's retry backoff answer STALE without forcing extra rounds", { timeout: 180_000 }, async t => {
  let fail = false;
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-request-view-failing-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const failing = path.join(base, "fail.mjs");
  await writeFile(failing, "process.exit(3);");
  const ctx = await setup(t, { startBuild: input => fail
    ? { child: fork(failing, [], { execArgv: [], stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) }), result: Promise.reject(new Error("injected builder failure")) }
    : startBuildProcess(input) });
  const { workspace, binding } = await bound(ctx);
  fail = true;
  const failedRounds = () => ctx.events.filter(event => event.type === "round" && event.outcome === "failed").length;
  await edit(ctx, ctx.repo, serviceRel, text => text.replace("class OrderService {", "class OrderService {\n  void retryBackoff() {}"));
  await until(() => failedRounds() === 1 && !workspace.status().roundInFlight, "first failed round");
  const roundsBefore = workspace.status().rounds;
  const started = performance.now();
  const states: string[] = [];
  for (let index = 0; index < 5; index += 1) states.push(await request(ctx, ctx.repo, 3000, async view => view.labels.state).run);
  const elapsedMs = performance.now() - started;
  const roundsAfter = workspace.status().rounds;
  evidence.push({ test: "retry-backoff", states, elapsedMs, roundsBefore, roundsAfter, failedRounds: failedRounds() });
  assert.deepEqual(states, ["STALE", "STALE", "STALE", "STALE", "STALE"]);
  // Before the fix every prepare cleared the 1 s retry timer and ran a new failing round at once.
  assert.ok(elapsedMs < 800, `requests waited on the retry: ${elapsedMs.toFixed(0)} ms`);
  assert.equal(roundsAfter, roundsBefore, "no prepare overrides the retry backoff");
  assert.equal(ctx.owner.store.binding(workspace.workspaceId)?.snapshotId, binding.snapshotId, "the old binding keeps serving");
  // The backoff still retries on its own and recovers once the builder works again.
  fail = false;
  await until(() => ctx.owner.store.binding(workspace.workspaceId)?.snapshotId !== binding.snapshotId, "retry publishes after recovery", 60_000);
});

test("a snapshot with a broken file reports non-COMPLETE coverage, not a confident negative", { timeout: 180_000 }, async t => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.repo, "src/main/java/demospring/Broken.java"), "package demospring;\nclass Broken {\n  void open( {\n");
  const { binding } = await bound(ctx);
  const outcome = await request(ctx, ctx.repo, 10_000, async view => ({ status: await view.snapshotStatus(),
    missing: await view.query({ op: "type", args: { typeText: "demospring.DoesNotExist" } }) })).run;
  evidence.push({ test: "partial", snapshotId: binding.snapshotId, coverage: outcome.status.coverage, missing: outcome.missing });
  assert.ok(outcome.status.coverage.some(entry => entry.failedFiles > 0 || entry.state !== "COMPLETE"), JSON.stringify(outcome.status.coverage));
  assert.equal(outcome.missing.state, "UNRESOLVED");
  // A source root with a failed file maps to DEGRADED in the type-lookup vocabulary (COMPLETE | PARTIAL | DEGRADED).
  assert.equal(outcome.missing.state === "UNRESOLVED" && outcome.missing.coverage, "DEGRADED");
});

test("a per-call budget or signal only narrows the request's own", { timeout: 180_000 }, async t => {
  let block = false;
  const ctx = await setup(t, { queryTestBlockMs: request => block && request.op === "type" ? 8_000 : undefined });
  await bound(ctx);
  block = true;
  const longer = DeadlineBudget.fromTimeout(60_000);
  const eventsBefore = ctx.events.length;
  const call = request(ctx, ctx.repo, 2_000, async view => {
    const started = performance.now();
    const outcome = await view.query({ op: "type", args: { typeText: "demospring.OrderService" } }, { budget: longer })
      .then(() => "served", error => (error as JavaIntelligenceError).code);
    const viaClient = await clientFor(view, await view.snapshotStatus()).queryType("demospring.OrderService", undefined, { budget: longer })
      .then(() => "served", error => (error as JavaIntelligenceError).code);
    return { outcome, viaClient, elapsedMs: performance.now() - started };
  });
  const settled = await settledWithin(call, "per-call-budget-narrowed");
  evidence.push({ test: "per-call-budget-narrowed", value: settled.ok ? settled.value : code(settled) });
  if (settled.ok) {
    assert.equal(settled.value.outcome, "DEADLINE_EXCEEDED", "a longer per-call budget cannot outlive the request's");
    assert.notEqual(settled.value.viaClient, "served");
  } else {
    assert.equal(code(settled), "DEADLINE_EXCEEDED");
  }
  // The worker running the read with the longer budget is SIGKILLed at the request's deadline, not the per-call one.
  type PoolClose = { type: string; pid?: number; signal?: NodeJS.Signals | null };
  const killed = await until(() => ctx.events.slice(eventsBefore).map(event => event.type === "pool" ? event.event as PoolClose : undefined)
    .find(event => event?.type === "worker-close" && event.signal === "SIGKILL"), "per-call worker killed at the request deadline",
  Math.max(1, call.budget.deadlineAtMs + 2000 - performance.now()));
  evidence.push({ test: "per-call-budget-worker-kill", pid: killed.pid, afterRequestDeadlineMs: performance.now() - call.budget.deadlineAtMs });
  const controller = new AbortController();
  const cancelled = request(ctx, ctx.repo, 20_000, view => view.query({ op: "type", args: { typeText: "demospring.OrderService" } }, { budget: longer, signal: new AbortController().signal }),
    { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const aborted = await settledWithin(cancelled, "per-call-signal-narrowed");
  assert.equal(code(aborted), "CANCELLED", "the request's cancel reaches a read that passed its own signal");
});

test("a snapshot client reads each file bundle once and serves it frozen across requests", { timeout: 180_000 }, async t => {
  const fetches: string[][] = [];
  const ctx = await setup(t, { queryTestBlockMs: request => {
    if (request.op === "files") fetches.push([...(request as QueryRequest<"files">).args.relativePaths]);
    return undefined;
  } });
  await bound(ctx);
  const absentRel = "src/main/java/demospring/Absent.java", userRel = "src/main/java/a/User.java";
  const service = path.join(ctx.repo, serviceRel), order = path.join(ctx.repo, orderRel), absent = path.join(ctx.repo, absentRel), user = path.join(ctx.repo, userRel);
  const client = await request(ctx, ctx.repo, 20_000, async view => clientFor(view, await view.snapshotStatus())).run;
  const budget = () => ({ budget: DeadlineBudget.fromTimeout(10_000) });
  const first = await request(ctx, ctx.repo, 20_000, async () => ({
    both: await client.queryFiles([service, order], budget()),
    again: await client.queryFiles([order, absent, service, order], budget()),
    absentAgain: await client.queryFiles([absent], budget())
  })).run;
  assert.deepEqual(first.both.map(bundle => bundle.file.relativePath), [serviceRel, orderRel]);
  // Request order and duplicates are kept; a path the snapshot does not hold is omitted, as an uncached read omits it.
  assert.deepEqual(first.again.map(bundle => bundle.file.relativePath), [orderRel, serviceRel, orderRel]);
  assert.equal(first.again[1], first.both[0], "the held bundle is reused, not fetched again");
  assert.deepEqual(first.absentAgain, []);
  assert.deepEqual(fetches, [[serviceRel, orderRel], [absentRel]], "only paths not yet held reach a query worker");
  // Production keeps one client per snapshot across requests: a later request reuses the same bundle.
  const later = await request(ctx, ctx.repo, 20_000, async () => client.queryFiles([service], budget())).run;
  assert.equal(later[0], first.both[0]);
  assert.equal(fetches.length, 2);
  const shared = later[0]!;
  assert.ok(Object.isFrozen(shared) && Object.isFrozen(shared.file) && Object.isFrozen(shared.methods) && Object.isFrozen(shared.methods[0]));
  assert.throws(() => { (shared.methods as unknown[]).push({}); }, TypeError, "a caller cannot corrupt the bundle other requests share");
  // A held bundle is still refused without a live budget or after a cancel, as an uncached read is.
  await assert.rejects(client.queryFiles([service]), (error: JavaIntelligenceError) => error.code === "INVALID_INPUT");
  const expired = DeadlineBudget.fromTimeout(1);
  await delay(5);
  await assert.rejects(client.queryFiles([service], { budget: expired }), (error: JavaIntelligenceError) => error.code === "DEADLINE_EXCEEDED");
  await assert.rejects(client.queryFiles([service], { ...budget(), signal: AbortSignal.abort() }), (error: JavaIntelligenceError) => error.code === "CANCELLED");
  // Bounded by facts: past the bound the least recently used bundle goes, and one larger than the bound is never held.
  const facts = (bundle: typeof shared) => 1 + bundle.types.length + bundle.fields.length + bundle.methods.length + bundle.edges.length;
  const sizes = first.both.map(facts);
  const userFacts = facts((await request(ctx, ctx.repo, 20_000, async () => client.queryFiles([user], budget())).run)[0]!);
  fetches.length = 0;
  assert.ok(sizes[0]! > sizes[1]! && sizes[1]! >= userFacts, `OrderService outweighs Order, Order outweighs a.User: ${sizes} ${userFacts}`);
  const bounded = await request(ctx, ctx.repo, 20_000, async view => {
    const status = snapshotIndexStatus(await view.snapshotStatus(), view.snapshotId!);
    const capped = (cap: number) => new SnapshotJavaIndexClient(view.owner, view.snapshotId!, view.canonicalRoot, status, probeLayout(view.canonicalRoot), cap);
    const one = capped(Math.max(...sizes));
    fetches.length = 0;
    for (const file of [service, order, order, service]) await one.queryFiles([file], budget());
    const oneFetches = fetches.splice(0);
    // Room for OrderService and Order: a hit refreshes OrderService, so the third file evicts Order instead.
    const recent = capped(sizes[0]! + sizes[1]!);
    for (const file of [service, order, service, user, service]) await recent.queryFiles([file], budget());
    const recentFetches = fetches.splice(0);
    const small = capped(sizes[1]!);
    for (const file of [order, service, service, order]) await small.queryFiles([file], budget());
    return { oneFetches, recentFetches, smallFetches: fetches.splice(0) };
  }).run;
  assert.deepEqual(bounded.oneFetches, [[serviceRel], [orderRel], [serviceRel]], "holding one bundle at a time evicts the older one");
  assert.deepEqual(bounded.recentFetches, [[serviceRel], [orderRel], [userRel]], "the least recently used bundle is the one evicted");
  assert.deepEqual(bounded.smallFetches, [[orderRel], [serviceRel], [serviceRel]], "a bundle larger than the bound is fetched every time and never evicts what fits");
  evidence.push({ test: "file-bundle-cache", sizes, fetches: bounded });
});

test("a bundle held when a call starts survives a concurrent call that evicts it", { timeout: 180_000 }, async t => {
  const userRel = "src/main/java/a/User.java";
  let blockUser = false;
  const ctx = await setup(t, { queryTestBlockMs: request =>
    blockUser && request.op === "files" && (request as QueryRequest<"files">).args.relativePaths.includes(userRel) ? 1_500 : undefined });
  await bound(ctx);
  const [service, order, user] = [serviceRel, orderRel, userRel].map(relative => path.join(ctx.repo, relative));
  const budget = () => ({ budget: DeadlineBudget.fromTimeout(20_000) });
  type Cache = { bundles: Map<string, { types: unknown[]; fields: unknown[]; methods: unknown[]; edges: unknown[] } | null>; bundleFacts: number };
  const outcome = await request(ctx, ctx.repo, 30_000, async view => {
    const status = snapshotIndexStatus(await view.snapshotStatus(), view.snapshotId!);
    const probe = new SnapshotJavaIndexClient(view.owner, view.snapshotId!, view.canonicalRoot, status, probeLayout(view.canonicalRoot));
    const facts = (bundle: { types: unknown[]; fields: unknown[]; methods: unknown[]; edges: unknown[] }) => 1 + bundle.types.length + bundle.fields.length + bundle.methods.length + bundle.edges.length;
    const sizes = Object.fromEntries((await probe.queryFiles([service, order, user], budget())).map(bundle => [bundle.file.relativePath, facts(bundle)]));
    // Room for OrderService alone: caching it evicts Order, which call A took as a hit before its fetch of a.User.
    const client = new SnapshotJavaIndexClient(view.owner, view.snapshotId!, view.canonicalRoot, status, probeLayout(view.canonicalRoot), sizes[serviceRel]!);
    await client.queryFiles([order], budget());
    blockUser = true;
    const a = client.queryFiles([order, user], budget());
    await delay(300);
    const b = await client.queryFiles([service], budget());
    const cache = client as unknown as Cache;
    const evictedDuringA = !cache.bundles.has(orderRel);
    const aResult = await a;
    blockUser = false;
    const later = await client.queryFiles([order], budget());
    const held = [...cache.bundles.values()].reduce((sum, bundle) => sum + (bundle ? facts(bundle) : 1), 0);
    return { sizes, evictedDuringA, b: b.map(bundle => bundle.file.relativePath), a: aResult.map(bundle => bundle.file.relativePath),
      later: later.map(bundle => bundle.file.relativePath), nulls: [...cache.bundles.values()].filter(bundle => bundle === null).length,
      accounted: cache.bundleFacts, held, cap: sizes[serviceRel] };
  }).run;
  evidence.push({ test: "file-bundle-cache-concurrent-eviction", ...outcome });
  assert.ok(outcome.sizes[orderRel]! <= outcome.sizes[serviceRel]!, `Order fits the OrderService-sized bound: ${JSON.stringify(outcome.sizes)}`);
  assert.equal(outcome.evictedDuringA, true, "call B evicted Order while call A was fetching a.User");
  assert.deepEqual(outcome.b, [serviceRel]);
  assert.deepEqual(outcome.a, [orderRel, userRel], "a hit taken at entry is returned even after a concurrent eviction");
  assert.deepEqual(outcome.later, [orderRel], "the evicted path is fetched again, never cached as absent");
  assert.equal(outcome.nulls, 0);
  assert.equal(outcome.accounted, outcome.held, "the fact count matches what the cache holds");
  assert.ok(outcome.accounted <= outcome.cap!);
});

test("a handler that outlives its deadline loses its view and its snapshot lease", { timeout: 180_000 }, async t => {
  const ctx = await setup(t);
  const { workspace, binding: first } = await bound(ctx);
  let held: RequestView | undefined;
  let leasedWhileHeld = -1;
  const call = request(ctx, ctx.repo, 1_500, async view => {
    held = view;
    await view.snapshotStatus();
    // The request's own lease is one more than the workers' connection leases.
    leasedWhileHeld = ctx.owner.store.leaseCount(first.snapshotId) - ctx.owner.pool.status().leases;
    return new Promise<never>(() => {});
  });
  const outcome = await settledWithin(call, "never-settling-handler");
  assert.equal(code(outcome), "DEADLINE_EXCEEDED");
  assert.equal(leasedWhileHeld, 1, "the handler held exactly one request lease");
  // No request lease remains by deadline + 2 s although the handler never settles.
  await until(() => ctx.owner.store.leaseCount(first.snapshotId) === ctx.owner.pool.status().leases, "request lease released",
    Math.max(1, call.budget.deadlineAtMs + 2000 - performance.now()));
  assert.ok(held?.closed, "the view closes when the request returns at its deadline");
  await assert.rejects(held!.query({ op: "status", args: {} }), /already released/);
  await edit(ctx, ctx.repo, serviceRel, text => text.replace("class OrderService {", "class OrderService {\n  void afterAbandon() {}"));
  await until(() => ctx.owner.store.binding(workspace.workspaceId)!.snapshotId !== first.snapshotId && !workspace.status().roundInFlight, "publish after abandon", 120_000);
  // Query workers drop their connection to the superseded snapshot; the abandoned request holds nothing.
  await until(() => ctx.owner.store.leaseCount(first.snapshotId) === 0 || undefined, "superseded snapshot unleased", 10_000);
  await ctx.owner.reclaim();
  assert.equal(existsSync(path.join(ctx.owner.store.layout.snapshots, first.snapshotId)), false, "the superseded snapshot is reclaimed although the handler never settled");
});

test("owner stop is not held by a workspace start whose change source never comes up", { timeout: 30_000 }, async t => {
  const ctx = await setup(t, { startStopGraceMs: 300 });
  (ctx.owner.options as { trackerSource?: (root: string) => TrackerSourceFactory }).trackerSource = () => () => new Promise(() => {});
  const stalled = ctx.owner.workspace(ctx.repo);
  stalled.catch(() => undefined);
  await delay(50);
  const started = performance.now();
  await ctx.owner.stop();
  const elapsed = performance.now() - started;
  evidence.push({ test: "stop-with-stalled-start", elapsedMs: elapsed });
  assert.ok(elapsed < 2000, `stop took ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed >= 250, `stop waited ${elapsed.toFixed(0)} ms for the pending start, less than its grace`);
  assert.equal(ctx.owner.peek(ctx.repo), undefined);
  await assert.rejects(ctx.owner.workspace(ctx.repo), /index owner stopped/);
});

test("a start that lands after stop() stops its own source and is never adopted", { timeout: 30_000 }, async t => {
  const ctx = await setup(t, { startStopGraceMs: 5_000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sourceStops = 0;
  (ctx.owner.options as { trackerSource?: (root: string) => TrackerSourceFactory }).trackerSource = () => async () => {
    await gate;
    return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => { sourceStops += 1; }, closed: new Promise<void>(() => {}) };
  };
  const late = ctx.owner.workspace(ctx.repo);
  late.catch(() => undefined);
  await delay(50);
  const stopping = ctx.owner.stop();
  await delay(100);
  release();
  await stopping;
  await assert.rejects(late, /index owner stopped/);
  evidence.push({ test: "late-start-after-stop", sourceStops });
  assert.equal(sourceStops, 1, "stop() waited for the landing start, which stopped its own source");
  assert.equal(ctx.owner.peek(ctx.repo), undefined);
  assert.ok(!ctx.events.some(event => event.type === "round" || event.type === "scheduler"), "no round or build ran for the unadopted start");
});
