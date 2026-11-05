import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ownerChildStdio } from "../mac-platform/owner-lock.js";
import type { SourceCapture } from "../java-index/source-capture.js";
import { builderJobFor, startBuildProcess } from "./build-process.js";
import { BuildScheduler, type BuildHint, type BuildOutcome, type BuildSchedulerEvent, type BuildSchedulerOptions } from "./build-scheduler.js";

const fixtureScript = `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const release = process.argv[2];
process.on('message', async message => {
  if (message !== 'result') return;
  process.send({ kind: 'result' });
  const deadline = Date.now() + 15000;
  while (!existsSync(release) && Date.now() < deadline) await delay(5);
  process.exit(existsSync(release) ? 0 : 2);
});
process.send({ kind: 'ready' });
`;
const evidence: Array<Record<string, unknown>> = [];
after(async () => {
  const root = process.env.ILV2_EVIDENCE_ROOT;
  if (!root) return;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "build-scheduler.json"), JSON.stringify({ events: evidence }, null, 2));
  await writeFile(path.join(root, "build-scheduler-pids.json"), JSON.stringify(evidence.filter(event => event.event === "fork" || event.event === "close"), null, 2));
});

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}
const hint = (workspaceId: string, kind: "full" | "delta" = "delta", generation = 1): BuildHint => ({ workspaceId, kind, generation });
/** The fault reports among the scheduler's events (the rest is lifecycle telemetry). */
const faults = (events: BuildSchedulerEvent[]) => events.filter(event => event.type === "forced-exit" || event.type === "reap-overdue");
const capture = (root: string, name: string): SourceCapture => ({ repoRoot: root, inputPath: path.join(root, name), bytes: Buffer.from(name), contentHash: name });
type Attempt = {
  hint: BuildHint; kind: "full" | "delta"; child: ChildProcess;
  captures: readonly SourceCapture[]; parserTokens: number; ready: Promise<void>;
  closed: Promise<void>; isClosed: boolean; release: string;
};

async function fixture(t: TestContext, options: {
  selectKind?: (hint: BuildHint) => "full" | "delta";
  outcome?: (attempt: Attempt) => BuildOutcome;
  throwStart?: (hint: BuildHint) => boolean;
  baseId?: () => string;
  execPath?: string;
  scheduler?: Omit<BuildSchedulerOptions, "select">;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ilv2-scheduler-"));
  const script = path.join(root, "builder.mjs");
  await writeFile(script, fixtureScript);
  const attempts: Attempt[] = [];
  const selections: BuildHint[] = [];
  // Every selection is released exactly once: unstarted, or after its child closed.
  const selectionLog: Array<{ workspaceId: string; attempt?: Attempt; releases: number; closedAtRelease?: boolean }> = [];
  const scheduler = new BuildScheduler({ ...options.scheduler, select(input) {
    const selected = { ...input, changed: [...input.changed ?? []], deleted: [...input.deleted ?? []] };
    selections.push(selected);
    const kind = options.selectKind?.(input) ?? input.kind;
    const logged: (typeof selectionLog)[number] = { workspaceId: input.workspaceId, releases: 0 };
    selectionLog.push(logged);
    return { kind, baseId: options.baseId?.() ?? `base-${input.workspaceId}`, release() {
      logged.releases += 1;
      logged.closedAtRelease = logged.attempt ? logged.attempt.isClosed : undefined;
    }, start(grant) {
      if (options.throwStart?.(input)) throw new Error("fixture fork failed");
      const release = path.join(root, `release-${attempts.length}`);
      const child = fork(script, [release], { execPath: options.execPath ?? process.execPath, execArgv: [], stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"]) });
      let ready!: () => void;
      let result!: (outcome: BuildOutcome) => void;
      const readyPromise = new Promise<void>(resolve => { ready = resolve; });
      const resultPromise = new Promise<BuildOutcome>(resolve => { result = resolve; });
      const attempt: Attempt = { hint: selected, kind, child, captures: grant.captures, parserTokens: grant.parserTokens, ready: readyPromise, closed: Promise.resolve(), isClosed: false, release };
      attempt.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
        attempt.isClosed = true;
        evidence.push({ test: t.name, event: "close", pid: child.pid, code, signal });
        resolve();
      }));
      child.on("message", message => {
        const event = (message as { kind?: string }).kind;
        if (event === "ready") ready();
        if (event === "result") {
          evidence.push({ test: t.name, event: "result", pid: child.pid });
          result(options.outcome?.(attempt) ?? { kind: "result", result: { id: attempts.indexOf(attempt), ok: true, files: 1, indexedGeneration: selected.generation } });
        }
      });
      attempts.push(attempt);
      logged.attempt = attempt;
      evidence.push({ test: t.name, event: "fork", workspaceId: input.workspaceId, kind, pid: child.pid, parserTokens: grant.parserTokens });
      assert.equal(grant.parserTokens, 2);
      return { child, result: resultPromise };
    } };
  } });
  t.after(async () => {
    const stopping = scheduler.stop();
    try { await bounded(stopping, "cleanup scheduler.stop"); }
    finally {
      for (const attempt of attempts) if (!attempt.isClosed) attempt.child.kill("SIGKILL");
      await bounded(Promise.all(attempts.map(attempt => attempt.closed)), "cleanup real child close");
      await bounded(stopping, "stop after child cleanup");
      for (const logged of selectionLog) {
        assert.equal(logged.releases, 1, `selection for ${logged.workspaceId} released ${logged.releases} times`);
        if (logged.attempt) assert.equal(logged.closedAtRelease, true, `selection for ${logged.workspaceId} released before its child closed`);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  function budget() {
    const status = scheduler.status();
    assert.ok(status.builders <= 2);
    assert.ok(status.full <= 1);
    assert.ok(status.parserTokens <= 4);
    assert.equal(status.parserTokens, status.builders * 2);
    evidence.push({ test: t.name, event: "status", status });
    return status;
  }
  async function started(workspaceId: string, occurrence = 0): Promise<Attempt> {
    await until(() => attempts.filter(a => a.hint.workspaceId === workspaceId).length > occurrence, `start ${workspaceId} #${occurrence}`);
    const attempt = attempts.filter(a => a.hint.workspaceId === workspaceId)[occurrence]!;
    await bounded(attempt.ready, `ready ${workspaceId}`);
    budget();
    return attempt;
  }
  async function result(attempt: Attempt) {
    await bounded(attempt.ready, "ready before result");
    attempt.child.send("result");
    await until(() => evidence.some(e => e.test === t.name && e.event === "result" && e.pid === attempt.child.pid), "IPC result");
  }
  async function finish(attempt: Attempt) {
    await result(attempt);
    await writeFile(attempt.release, "release");
    await bounded(attempt.closed, "released child close");
  }
  return { root, scheduler, attempts, selections, selectionLog, started, result, finish, budget };
}

test("short-delta-not-starved-by-full", async t => {
  const f = await fixture(t);
  const first = f.scheduler.submit(hint("full-a", "full"));
  const a = await f.started("full-a");
  const queued = f.scheduler.submit(hint("full-b", "full"));
  const submittedAt = performance.now();
  const small = f.scheduler.submit(hint("small"));
  const delta = await f.started("small");
  evidence.push({ test: t.name, event: "short-delta-ready", waitMs: performance.now() - submittedAt });
  assert.equal(f.attempts.length, 2);
  assert.equal(f.budget().queued, 1);
  await f.finish(delta);
  assert.equal((await bounded(small, "short delta")).ok, true);
  assert.equal(a.isClosed, false);
  assert.equal(f.attempts.some(x => x.hint.workspaceId === "full-b"), false);
  await f.finish(a);
  await f.finish(await f.started("full-b"));
  assert.ok((await first).ok && (await queued).ok);
});

test("lifecycle telemetry: each job is queued, dispatched with its wait and occupancy, gets a result, then closes", async t => {
  const events: BuildSchedulerEvent[] = [];
  const f = await fixture(t, { scheduler: { onEvent: event => events.push(event) } });
  const full = f.scheduler.submit(hint("full-a", "full"));
  const a = await f.started("full-a");
  const waiting = f.scheduler.submit(hint("full-b", "full"));
  await delay(120);
  await f.finish(a);
  const b = await f.started("full-b");
  await f.finish(b);
  assert.ok((await full).ok && (await waiting).ok);
  const of = (workspaceId: string) => events.filter(event => "workspaceId" in event && event.workspaceId === workspaceId).map(event => event.type);
  assert.deepEqual(of("full-a"), ["queued", "dispatched", "result", "closed"]);
  assert.deepEqual(of("full-b"), ["queued", "dispatched", "result", "closed"]);
  const dispatchedB = events.find(event => event.type === "dispatched" && event.workspaceId === "full-b") as Extract<BuildSchedulerEvent, { type: "dispatched" }>;
  const closedA = events.find(event => event.type === "closed" && event.workspaceId === "full-a") as Extract<BuildSchedulerEvent, { type: "closed" }>;
  // The waiting full queued behind the running one; it is dispatched with one full and one builder in the domain.
  assert.ok(dispatchedB.waitedMs >= 100, `full-b waited ${dispatchedB.waitedMs} ms`);
  assert.deepEqual([dispatchedB.kind, dispatchedB.builders, dispatchedB.full, dispatchedB.parserTokens, dispatchedB.pid], ["full", 1, 1, 2, b.child.pid]);
  assert.deepEqual([closedA.kind, closedA.code, closedA.pid], ["full", 0, a.child.pid]);
  assert.ok(closedA.runMs > 0);
});

test("result-before-exit-keeps-slot", async t => {
  const f = await fixture(t);
  let settled = false;
  const first = f.scheduler.submit(hint("a")).then(value => { settled = true; return value; });
  const a = await f.started("a");
  const second = f.scheduler.submit(hint("b"));
  const b = await f.started("b");
  const queued = f.scheduler.submit(hint("c"));
  await f.result(a);
  await until(() => f.scheduler.status().jobs.some(job => job.workspaceId === "a" && job.state === "RESULT_RECEIVED"), "result received state");
  assert.equal(settled, false);
  assert.equal(a.isClosed, false);
  assert.equal(f.budget().builders, 2);
  assert.equal(f.attempts.length, 2);
  await writeFile(a.release, "release");
  await bounded(a.closed, "a close");
  assert.equal((await first).ok, true);
  await f.finish(await f.started("c"));
  await f.finish(b);
  assert.ok((await second).ok && (await queued).ok);
});

test("stop-settles-queued-promises", async t => {
  const f = await fixture(t);
  const running = f.scheduler.submit(hint("a"));
  await f.started("a");
  const other = f.scheduler.submit(hint("b"));
  await f.started("b");
  const queued = f.scheduler.submit(hint("c"));
  const merged = f.scheduler.submit(hint("c", "delta", 2));
  await bounded(f.scheduler.stop(), "stop");
  const outcomes = await bounded(Promise.all([running, other, queued, merged]), "all submit promises stopped");
  assert.ok(outcomes.every(value => !value.ok));
  assert.ok(f.attempts.every(attempt => attempt.isClosed));
  assert.equal(f.budget().builders, 0);
  assert.equal(f.scheduler.status().queued, 0);
  assert.equal(f.scheduler.status().stopped, true);
  assert.equal((await f.scheduler.submit(hint("after-stop"))).ok, false);
  assert.equal(f.attempts.length, 2);
});

test("full and delta queues are FIFO with full priority for its available slot", async t => {
  const f = await fixture(t);
  const promises = [f.scheduler.submit(hint("a", "full"))];
  const a = await f.started("a");
  promises.push(f.scheduler.submit(hint("occupant")));
  const occupant = await f.started("occupant");
  promises.push(f.scheduler.submit(hint("b", "full")), f.scheduler.submit(hint("c", "full")), f.scheduler.submit(hint("delta-a")), f.scheduler.submit(hint("delta-b")));
  await f.finish(a);
  const b = await f.started("b");
  assert.equal(f.attempts.some(x => x.hint.workspaceId === "delta-a"), false);
  await f.finish(b);
  await f.finish(await f.started("c"));
  const deltaA = await f.started("delta-a");
  assert.equal(f.attempts.some(x => x.hint.workspaceId === "delta-b"), false);
  await f.finish(deltaA);
  await f.finish(await f.started("delta-b"));
  await f.finish(occupant);
  assert.deepEqual(f.attempts.filter(x => x.kind === "full").map(x => x.hint.workspaceId), ["a", "b", "c"]);
  assert.ok((await Promise.all(promises)).every(x => x.ok));
});

test("same workspace merges one pending hint by generation and arrival ties", async t => {
  const f = await fixture(t);
  const promises = [f.scheduler.submit(hint("a"))];
  const a = await f.started("a");
  promises.push(f.scheduler.submit({ ...hint("a", "delta", 8), changed: ["x", "y"], deleted: ["z"] }));
  promises.push(f.scheduler.submit({ ...hint("a", "delta", 7), changed: ["z"], deleted: ["x"] }));
  promises.push(f.scheduler.submit({ ...hint("a", "delta", 8), changed: ["z"], deleted: ["y"] }));
  assert.equal(f.budget().queued, 1);
  assert.equal(f.attempts.length, 1);
  await f.finish(a);
  const pending = await f.started("a", 1);
  assert.equal(pending.hint.generation, 8);
  assert.deepEqual([...pending.hint.changed ?? []].sort(), ["x", "z"]);
  assert.deepEqual([...pending.hint.deleted ?? []], ["y"]);
  await f.finish(pending);
  const outcomes = await Promise.all(promises);
  assert.ok(outcomes.every(x => x.ok));
  assert.equal(f.attempts.length, 2);
  assert.ok(outcomes.slice(1).every(x => x.result?.indexedGeneration === 8));
});

test("pending full dominates delta and rescan survives merging", async t => {
  const f = await fixture(t);
  const promises = [f.scheduler.submit(hint("a"))];
  const a = await f.started("a");
  promises.push(f.scheduler.submit({ ...hint("a", "delta", 2), rescan: true }));
  promises.push(f.scheduler.submit(hint("a", "full", 3)));
  promises.push(f.scheduler.submit(hint("a", "delta", 4)));
  await f.finish(a);
  const pending = await f.started("a", 1);
  assert.equal(pending.kind, "full");
  assert.equal(pending.hint.rescan, true);
  assert.equal(pending.hint.generation, 4);
  await f.finish(pending);
  assert.ok((await Promise.all(promises)).every(x => x.ok));
});

test("dispatch reselects promoted delta again after waiting for full capacity", async t => {
  let promote = false;
  let base = "old-base";
  const f = await fixture(t, { baseId: () => base, selectKind: input => input.workspaceId === "target" && promote ? "full" : input.kind });
  const full = f.scheduler.submit(hint("full", "full"));
  const a = await f.started("full");
  const busy = f.scheduler.submit(hint("busy"));
  const b = await f.started("busy");
  const pending = f.scheduler.submit(hint("target"));
  const before = f.selections.filter(x => x.workspaceId === "target").length;
  promote = true;
  await f.finish(b);
  await until(() => f.selections.filter(x => x.workspaceId === "target").length > before, "promoted dispatch selection");
  assert.equal(f.attempts.some(x => x.hint.workspaceId === "target"), false);
  const waiting = f.selections.filter(x => x.workspaceId === "target").length;
  base = "new-base";
  await f.finish(a);
  const target = await f.started("target");
  assert.equal(target.kind, "full");
  assert.ok(f.selections.filter(x => x.workspaceId === "target").length > waiting);
  await f.finish(target);
  assert.ok((await full).ok && (await busy).ok);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.baseId, "new-base");
});

test("OS fork error is reaped before settling and returns reserved capacity", async t => {
  const f = await fixture(t, { execPath: "/nonexistent-ilv2-node" });
  const outcome = await bounded(f.scheduler.submit(hint("broken", "full")), "OS fork failure");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /ENOENT/);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0]!.isClosed, true);
  assert.equal(f.budget().builders, 0);
});

test("fork throw settles failure and releases all reserved capacity", async t => {
  const f = await fixture(t, { throwStart: input => input.workspaceId === "broken" });
  const broken = await bounded(f.scheduler.submit(hint("broken", "full")), "throw settlement");
  assert.equal(broken.ok, false);
  assert.match(broken.error ?? "", /fixture fork failed/);
  assert.equal(f.budget().builders, 0);
  assert.equal(f.scheduler.status().full, 0);
  const next = f.scheduler.submit(hint("next", "full"));
  await f.finish(await f.started("next"));
  assert.equal((await next).ok, true);
});

test("escalation retains unmodified captures and yields the small slot", async t => {
  let captures: SourceCapture[] = [];
  const f = await fixture(t, { outcome: attempt => attempt.hint.workspaceId === "target" && attempt.kind === "delta"
    ? { kind: "needs-full", captures, reason: "base incomplete" }
    : { kind: "result", result: { id: 1, ok: true, indexedGeneration: attempt.hint.generation, files: 1 } } });
  captures = [capture(f.root, "keep"), capture(f.root, "changed"), capture(f.root, "deleted")];
  const full = f.scheduler.submit(hint("full", "full"));
  const a = await f.started("full");
  const target = f.scheduler.submit(hint("target"));
  const delta = await f.started("target");
  const newer = f.scheduler.submit({ ...hint("target", "delta", 2), changed: [path.join(f.root, "changed")], deleted: [path.join(f.root, "deleted")] });
  const small = f.scheduler.submit(hint("small"));
  await f.finish(delta);
  const smallAttempt = await f.started("small");
  assert.equal(f.attempts.filter(x => x.hint.workspaceId === "target").length, 1);
  assert.equal(f.budget().parserTokens, 4);
  await f.finish(a);
  const retry = await f.started("target", 1);
  assert.equal(retry.kind, "full");
  assert.equal(f.scheduler.status().jobs.find(job => job.workspaceId === "target")?.state, "RUNNING");
  assert.deepEqual(retry.captures, [captures[0]]);
  assert.strictEqual(retry.captures[0], captures[0]);
  assert.equal(retry.hint.generation, 2);
  await f.finish(retry);
  await f.finish(smallAttempt);
  assert.ok((await Promise.all([full, target, newer, small])).every(x => x.ok));
});

test("rescan clears escalation captures and full cannot escalate again", async t => {
  let captures: SourceCapture[] = [];
  const f = await fixture(t, { outcome: () => ({ kind: "needs-full", captures, reason: "fixture needs full" }) });
  captures = [capture(f.root, "old")];
  const target = f.scheduler.submit(hint("target"));
  const delta = await f.started("target");
  const newer = f.scheduler.submit({ ...hint("target", "delta", 2), rescan: true });
  await f.finish(delta);
  const full = await f.started("target", 1);
  assert.equal(full.kind, "full");
  assert.deepEqual(full.captures, []);
  assert.equal(full.hint.rescan, true);
  await f.finish(full);
  const outcomes = await bounded(Promise.all([target, newer]), "full escalation rejection");
  assert.ok(outcomes.every(x => !x.ok));
  assert.equal(f.attempts.length, 2);
  assert.equal(f.budget().builders, 0);
});

test("a builder hung after its result is forced to exit and still reports the result", async t => {
  const events: BuildSchedulerEvent[] = [];
  const f = await fixture(t, { scheduler: { timing: { exitGraceMs: 300 }, onEvent: event => events.push(event) } });
  const completion = f.scheduler.submit(hint("hung"));
  const attempt = await f.started("hung");
  const queued = f.scheduler.submit(hint("next-1"));
  const other = f.scheduler.submit(hint("next-2"));
  const second = await f.started("next-1");
  await f.result(attempt);
  assert.equal(f.budget().builders, 2, "the slot is held through the grace period");
  await bounded(attempt.closed, "forced exit");
  const outcome = await completion;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.forcedExit, true);
  assert.deepEqual(faults(events).map(event => event.type), ["forced-exit"]);
  await f.finish(await f.started("next-2"));
  await f.finish(second);
  assert.ok((await queued).ok && (await other).ok);
});

test("a selection discarded for full capacity is released unstarted, a started one after close", async t => {
  const f = await fixture(t, { selectKind: input => input.workspaceId === "promoted" ? "full" : input.kind });
  const full = f.scheduler.submit(hint("full", "full"));
  const a = await f.started("full");
  const promoted = f.scheduler.submit(hint("promoted"));
  await until(() => f.selectionLog.some(x => x.workspaceId === "promoted"), "promoted selection");
  const discarded = f.selectionLog.find(x => x.workspaceId === "promoted")!;
  assert.equal(discarded.releases, 1);
  assert.equal(discarded.attempt, undefined);
  const fullSelection = f.selectionLog.find(x => x.workspaceId === "full")!;
  assert.equal(fullSelection.releases, 0, "a running selection is not released");
  await f.finish(a);
  assert.equal(fullSelection.releases, 1);
  await f.finish(await f.started("promoted"));
  assert.ok((await full).ok && (await promoted).ok);
});

test("closed admission starts no builder until wake", async t => {
  let open = false;
  const f = await fixture(t, { scheduler: { admitted: () => open } });
  const completion = f.scheduler.submit(hint("gated"));
  await delay(50);
  assert.equal(f.selections.length, 0);
  assert.equal(f.scheduler.status().queued, 1);
  assert.equal(f.scheduler.status().admitted, false);
  open = true;
  f.scheduler.wake();
  await f.finish(await f.started("gated"));
  assert.equal((await completion).ok, true);
});

function fakeChild(pid: number, reap: boolean, killError?: string) {
  const child = Object.assign(new EventEmitter(), { pid, kills: 0, kill() {
    child.kills += 1;
    // Node emits a failed kill (other than ESRCH) as a synchronous "error".
    if (killError) { child.emit("error", Object.assign(new Error(`kill ${killError}`), { code: killError })); return false; }
    if (reap) setImmediate(() => { child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); });
    return true;
  } });
  return child;
}

test("an unreaped kill is reported and keeps the builder slot until actual close", async () => {
  const events: BuildSchedulerEvent[] = [];
  const child = fakeChild(515151, false);
  let releases = 0;
  const scheduler = new BuildScheduler({ timing: { reapWatchMs: 100 }, onEvent: event => events.push(event),
    select: () => ({ kind: "delta", release: () => { releases += 1; },
      start: () => ({ child: child as unknown as ChildProcess, result: new Promise<BuildOutcome>(() => {}) }) }) });
  const completion = scheduler.submit(hint("stuck"));
  await until(() => scheduler.status().builders === 1 && scheduler.status().jobs.length === 1, "started");
  const stopping = scheduler.stop();
  await until(() => faults(events).length === 1, "reap overdue");
  assert.deepEqual(faults(events), [{ type: "reap-overdue", workspaceId: "stuck", pid: 515151, exited: false }]);
  assert.equal(scheduler.status().builders, 1);
  assert.equal(scheduler.status().reapOverdue, 1);
  assert.equal(releases, 0);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await bounded(stopping, "stop after actual close");
  assert.equal((await completion).ok, false);
  assert.equal(releases, 1);
  assert.equal(scheduler.status().builders, 0);
});

test("repeated child errors do not crash the owner and settle once", async () => {
  const child = fakeChild(525252, true);
  const scheduler = new BuildScheduler({ select: () => ({ kind: "delta",
    start: () => ({ child: child as unknown as ChildProcess, result: new Promise<BuildOutcome>(() => {}) }) }) });
  const completion = scheduler.submit(hint("noisy"));
  await until(() => scheduler.status().jobs.length === 1, "started");
  child.emit("error", new Error("send failed"));
  child.emit("error", new Error("kill failed"));
  const outcome = await bounded(completion, "error settles");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /send failed/);
  await scheduler.stop();
});

test("a kill that fails synchronously is sent once and reported, not re-entered", async () => {
  const events: BuildSchedulerEvent[] = [];
  const child = fakeChild(545454, false, "EPERM");
  const scheduler = new BuildScheduler({ timing: { reapWatchMs: 100 }, onEvent: event => events.push(event), select: () => ({ kind: "delta",
    start: () => ({ child: child as unknown as ChildProcess, result: new Promise<BuildOutcome>(() => {}) }) }) });
  const completion = scheduler.submit(hint("eperm"));
  await until(() => scheduler.status().jobs.length === 1, "started");
  child.emit("error", new Error("send failed"));
  const stopping = scheduler.stop();
  assert.equal(child.kills, 1);
  await until(() => faults(events).length === 1, "reap overdue");
  assert.deepEqual(faults(events), [{ type: "reap-overdue", workspaceId: "eperm", pid: 545454, exited: false }]);
  assert.equal(scheduler.status().builders, 1);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await bounded(stopping, "stop after actual close");
  const outcome = await completion;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /send failed/);
  assert.equal(child.kills, 1);
});

test("stop during an escalation settles its waiters instead of re-queueing", async () => {
  const child = fakeChild(535353, true);
  const scheduler = new BuildScheduler({ select: () => ({ kind: "delta",
    start: () => ({ child: child as unknown as ChildProcess, result: Promise.resolve<BuildOutcome>({ kind: "needs-full", captures: [], reason: "fixture" }) }) }) });
  const completion = scheduler.submit(hint("escalating"));
  await until(() => scheduler.status().jobs[0]?.state === "RESULT_RECEIVED", "needs-full received");
  await bounded(scheduler.stop(), "stop");
  const outcome = await bounded(completion, "escalation settled by stop");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "scheduler stopped");
  assert.equal(scheduler.status().queued, 0);
});

// ---------------------------------------------------------------- MAC-06C: real builder/query processes

type Row = Record<string, any> & { type: string; at: number; pid: number; pgid: number };
type OwnerFixtures = {
  createOwnerFixture(t: TestContext, options: Record<string, unknown>): Promise<{
    root: string; cacheRoot: string; ready(excludePid?: number): Promise<Row>; records(): Promise<Row[]>;
    command(command: Record<string, unknown>): Promise<void>; close(): Promise<void>;
  }>;
  eventually<T>(operation: () => T | Promise<T>, timeoutMs?: number): Promise<T>;
  processAlive(pid: number): boolean;
  processGroup(pid: number): Promise<number>;
};
type OwnerFixture = Awaited<ReturnType<OwnerFixtures["createOwnerFixture"]>>;
const HARNESS_ENTRY = "scripts/ilv2-mac-owner-scheduler.mjs";
const execFileAsync = promisify(execFile);
const epochNow = () => performance.timeOrigin + performance.now();

/** A synthetic repo: `packages` x `perPackage` classes, each calling its predecessor. */
async function writeRepo(dir: string, packages: number, perPackage: number): Promise<string[]> {
  const files: string[] = [];
  for (let p = 0; p < packages; p += 1) {
    const pkg = path.join(dir, "src/main/java/demo", `p${p}`);
    await mkdir(pkg, { recursive: true });
    for (let i = 0; i < perPackage; i += 1) {
      const file = path.join(pkg, `C${i}.java`);
      const body = i === 0
        ? `package demo.p${p};\npublic class C0 { public int value; public int get0() { return value; } }\n`
        : `package demo.p${p};\npublic class C${i} { private final C${i - 1} prev = new C${i - 1}(); public int get${i}() { return prev.get${i - 1}() + ${i}; } }\n`;
      await writeFile(file, body);
      files.push(file);
    }
  }
  return files;
}

async function rootsFor(base: string, layout: Array<[string, number, number]>) {
  const roots: Array<{ id: string; repo: string; db: string; files: string[] }> = [];
  for (const [id, packages, perPackage] of layout) {
    const repo = path.join(base, "repos", id);
    // One directory per index: the workspace stat store is a sibling file.
    await mkdir(path.join(base, "db", id), { recursive: true });
    roots.push({ id, repo, db: path.join(base, "db", id, "index.sqlite"), files: await writeRepo(repo, packages, perPackage) });
  }
  return roots;
}

function assertBudgets(rows: readonly Row[], label: string): number {
  const statuses = rows.filter(row => row.type === "status" || row.type === "static-open" || row.type === "stopped");
  for (const row of statuses) {
    assert.ok(row.scheduler.builders <= 2, `${label}: builders ${row.scheduler.builders}`);
    assert.ok(row.scheduler.full <= 1, `${label}: full ${row.scheduler.full}`);
    assert.ok(row.scheduler.parserTokens <= 4, `${label}: parser tokens ${row.scheduler.parserTokens}`);
    assert.ok(row.pool.workers <= 2, `${label}: query workers ${row.pool.workers}`);
    assert.ok(row.pool.leases <= row.pool.workers, `${label}: leases ${row.pool.leases} > workers ${row.pool.workers}`);
  }
  return statuses.length;
}

test("owner-restart-admission-with-active-workers", { timeout: 240_000 }, async t => {
  const fixtures = await import(new URL("../../scripts/ilv2-mac-owner-fixture.mjs", import.meta.url).href) as OwnerFixtures;
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-g06c-")));
  // After hooks run in registration order: close the owners (and their writers) before removing their files.
  const owners: OwnerFixture[] = [];
  t.after(async () => {
    for (const owner of owners.reverse()) await owner.close();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const roots = await rootsFor(base, [["big", 120, 100], ["small-1", 2, 5], ["small-2", 2, 5]]);
  const settings = { roots: roots.map(({ id, repo, db }) => ({ id, repo, db })), allowTestHooks: true };
  const send = async (fixture: OwnerFixture, command: Record<string, unknown>) => {
    const acks = (await fixture.records()).filter(row => row.type === "ack").length;
    await fixture.command(command);
    await fixtures.eventually(async () => (await fixture.records()).filter(row => row.type === "ack").length > acks, 20_000);
  };
  const when = async (fixture: OwnerFixture, predicate: (row: Row) => boolean, timeoutMs = 60_000): Promise<Row> =>
    (await fixtures.eventually(async () => (await fixture.records()).find(predicate), timeoutMs))!;
  const busy = (fixture: OwnerFixture) => fixtures.eventually(async () =>
    (await readFile(path.join(fixture.root, "stdout.log"), "utf8").catch(() => "")).includes('"code":"OWNER_BUSY"'), 6500);
  const open = (rows: readonly Row[]) => rows.filter(row => row.type === "fork" && !rows.some(close => close.type === "close" && close.childPid === row.childPid));

  // 1. Owner A runs a real full and two stalled real queries; a third query waits for a worker slot.
  // The big full is held (stopped) until just before the fault: it is active there however fast the build is.
  const a = await fixtures.createOwnerFixture(t, { route: "direct", entry: HARNESS_ENTRY, scheduler: { ...settings, holdFullBuilds: ["big"] } });
  owners.push(a);
  const readyA = await a.ready();
  await send(a, { type: "open-static" });
  await send(a, { type: "submit", workspaceId: "small-2", kind: "full", generation: 1 });
  assert.equal((await when(a, row => row.type === "build-complete" && row.workspaceId === "small-2")).ok, true);
  await send(a, { type: "submit", workspaceId: "big", kind: "full", generation: 1 });
  await send(a, { type: "submit", workspaceId: "small-1", kind: "delta", generation: 1 });
  await when(a, row => row.type === "fork" && row.role === "builder" && row.workspaceId === "big");
  for (const name of ["stuck-a", "stuck-b", "queued-q"]) {
    await send(a, { type: "query", name, workspaceId: "small-2", task: "C1", testBlockMs: 120_000, timeoutMs: 120_000 });
  }
  await when(a, row => row.type === "query-started" && row.name === "stuck-a");
  await when(a, row => row.type === "query-started" && row.name === "stuck-b");
  const poolFull = await when(a, row => row.type === "status" && row.pool.workers === 2 && row.pool.queued === 1);
  assert.equal(poolFull.pool.leases, 2);

  // 2. The workers hold the owner's lock themselves: with A's own fd4 closed, a second owner is still refused.
  let recordsA = await a.records();
  // The big full and both stalled queries outlive this check; a short small-1 job may not.
  const lockedWorkers = open(recordsA).filter(row => row.role === "query" || row.workspaceId === "big");
  assert.deepEqual(lockedWorkers.map(row => row.role).sort(), ["builder", "query", "query"]);
  const lockFds: Array<{ pid: number; role: string; dev: string; ino: number }> = [];
  for (const worker of lockedWorkers) {
    const fields = (await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(worker.childPid), "-d", "4", "-F", "Di"])).stdout.split("\n");
    const ino = Number(fields.find(line => line.startsWith("i"))?.slice(1));
    lockFds.push({ pid: worker.childPid, role: worker.role, dev: fields.find(line => line.startsWith("D"))?.slice(1) ?? "", ino });
    assert.equal(ino, readyA.lock.ino, `${worker.role} ${worker.childPid} inherited the owner lock as fd4`);
    assert.equal(await fixtures.processGroup(worker.childPid), readyA.pgid, "workers keep the owner PGID");
  }
  await send(a, { type: "close-lock" });
  await when(a, row => row.type === "lock-closed");
  const b = await fixtures.createOwnerFixture(t, { route: "direct", entry: HARNESS_ENTRY, scheduler: settings, cacheRoot: a.cacheRoot });
  owners.push(b);
  await busy(b);
  assert.equal((await b.records()).length, 0, "a refused owner must not exec Node or open slots");
  await b.close();

  // 3. SIGKILL A while its builder and queries are active.
  recordsA = await a.records();
  const oldWorkers = open(recordsA);
  const bigBaseBeforeFault = recordsA.some(row => row.type === "build-complete" && row.workspaceId === "big" && row.ok === true);
  assert.equal(bigBaseBeforeFault, false, "the held big full cannot have completed before the fault");
  assert.ok(oldWorkers.some(row => row.role === "builder") && oldWorkers.filter(row => row.role === "query").length === 2, "active builder and queries at the fault");
  await send(a, { type: "release-builders" });
  assert.ok((await a.records()).some(row => row.type === "builders-released" && row.pids.length === 1), "the held big full runs again before the fault");
  const faultAt = epochNow();
  process.kill(readyA.pid, "SIGKILL");
  await fixtures.eventually(() => [readyA.pid, ...oldWorkers.map(row => row.childPid)].every(pid => !fixtures.processAlive(pid)), 10_000);
  const oldExitedMs = epochNow() - faultAt;
  await a.close();

  // 4. Restart: queued work waits for static admission; semantic admission waits for external cleanup.
  const c = await fixtures.createOwnerFixture(t, { route: "direct", entry: HARNESS_ENTRY, cacheRoot: a.cacheRoot, scheduler: { ...settings, startup: [
    { workspaceId: "big", kind: "delta", generation: 100 },
    { workspaceId: "small-1", kind: "delta", generation: 100 },
    { workspaceId: "small-2", kind: "delta", generation: 100, changed: [roots[2]!.files[0]] }
  ] } });
  owners.push(c);
  const readyC = await c.ready();
  assert.notEqual(readyC.pgid, readyA.pgid);
  const gated = await when(c, row => row.type === "status" && row.reason === "queued-before-admission");
  assert.equal(gated.admission.staticAdmission, "CLOSED");
  assert.equal(gated.scheduler.builders, 0);
  assert.equal(gated.scheduler.queued, 3);
  await send(c, { type: "check-semantic" });
  assert.equal((await when(c, row => row.type === "semantic-blocked")).code, "JDT_NOT_READY");
  await delay(200);
  assert.equal((await c.records()).some(row => row.type === "fork"), false, "no worker before static admission");
  await send(c, { type: "open-static" });
  const staticOpen = await when(c, row => row.type === "static-open");
  for (const id of ["big", "small-1", "small-2"]) {
    const done = await when(c, row => row.type === "build-complete" && row.workspaceId === id, 120_000);
    assert.equal(done.ok, true, `${id}: ${done.error}`);
  }
  let recordsC = await c.records();
  assert.ok(recordsC.filter(row => row.type === "fork").every(row => row.at >= staticOpen.at), "workers start only after static admission");
  // The killed full rolled back: C's delta sees the last committed base, or none.
  const bigResultsC = recordsC.filter(row => row.type === "build-result" && row.workspaceId === "big").map(row => row.outcome);
  assert.deepEqual(bigResultsC, bigBaseBeforeFault ? ["result"] : ["needs-full", "result"]);
  assert.deepEqual(recordsC.filter(row => row.type === "fork" && row.workspaceId === "big").map(row => row.kind), bigBaseBeforeFault ? ["delta"] : ["delta", "full"]);
  await send(c, { type: "check-semantic" });
  assert.equal((await c.records()).filter(row => row.type === "semantic-blocked").length, 2, "static work ran while semantic admission waited");

  // 5. Result, deadline and cancellation converge with real query processes.
  await send(c, { type: "query", name: "normal", workspaceId: "big", task: "C42", timeoutMs: 10_000 });
  const normal = await when(c, row => row.type === "query-complete" && row.name === "normal");
  assert.equal(normal.status, "ok");
  assert.ok(normal.hits > 0);
  await send(c, { type: "query", name: "deadline", workspaceId: "small-2", task: "C1", testBlockMs: 60_000, timeoutMs: 1500 });
  const deadline = await when(c, row => row.type === "query-complete" && row.name === "deadline");
  assert.equal(deadline.status, "deadline");
  assert.ok(deadline.at <= deadline.deadlineAt + 1000);
  const deadlineClose = await when(c, row => row.type === "close" && row.name === "deadline", 5000);
  assert.ok(deadlineClose.at - deadline.deadlineAt <= 2000, `deadline reap ${deadlineClose.at - deadline.deadlineAt} ms`);
  assert.equal(deadlineClose.leaseHeld, true, "the lease outlives the caller until close");
  await send(c, { type: "query", name: "cancel", workspaceId: "small-2", task: "C1", testBlockMs: 60_000, timeoutMs: 60_000 });
  await when(c, row => row.type === "query-started" && row.name === "cancel");
  const cancelAt = epochNow();
  await send(c, { type: "cancel-query", name: "cancel" });
  assert.equal((await when(c, row => row.type === "query-complete" && row.name === "cancel")).status, "cancelled");
  const cancelClose = await when(c, row => row.type === "close" && row.name === "cancel", 5000);
  assert.ok(cancelClose.at - cancelAt <= 2000, `cancel reap ${cancelClose.at - cancelAt} ms`);

  // 6. Semantic admission opens only after the external cleanup.
  await send(c, { type: "recover-semantic" });
  assert.equal((await when(c, row => row.type === "semantic-recovered")).admission.semanticState, "READY");
  await send(c, { type: "check-semantic" });
  await when(c, row => row.type === "semantic-admitted");
  await c.command({ type: "stop" });
  const stopped = await when(c, row => row.type === "stopped", 20_000);
  assert.equal(stopped.held, 0);
  assert.equal(stopped.scheduler.builders, 0);
  assert.equal(stopped.pool.workers, 0);
  recordsC = await c.records();
  assert.deepEqual(open(recordsC), [], "every worker of the restarted owner closed");
  const samples = assertBudgets(recordsA, "owner A") + assertBudgets(recordsC, "owner C");
  evidence.push({ test: t.name, event: "owner-restart", ownerA: { pid: readyA.pid, pgid: readyA.pgid }, ownerC: { pid: readyC.pid, pgid: readyC.pgid },
    oldWorkers: oldWorkers.map(row => ({ role: row.role, pid: row.childPid, workspaceId: row.workspaceId ?? row.name })), oldExitedMs,
    refusedOwnerRecords: 0, refusedWhileOnlyWorkersHeldLock: true, lockFds, ownerLock: readyA.lock, poolFull: poolFull.pool, bigBaseBeforeFault, bigResultsC, gated: { admission: gated.admission, queued: gated.scheduler.queued, builders: gated.scheduler.builders },
    staticOpenAfterReadyMs: staticOpen.at - readyC.at, deadlineReapMs: deadlineClose.at - deadline.deadlineAt, cancelReapMs: cancelClose.at - cancelAt,
    budgetSamples: samples, forksC: recordsC.filter(row => row.type === "fork").length });
  await writeTimeline(t.name, { ownerA: recordsA, ownerC: recordsC });
  await c.close();
});

async function writeTimeline(name: string, value: unknown): Promise<void> {
  const root = process.env.ILV2_EVIDENCE_ROOT;
  if (!root) return;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `${name}.json`), JSON.stringify(value, null, 2));
}

test("a real builder's liveness lines reach onHeartbeat through the scheduler's process adapter", { timeout: 60_000 }, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-liveness-builder-")));
  let scheduler: BuildScheduler | undefined;
  t.after(async () => {
    await scheduler?.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const [root] = await rootsFor(base, [["beat", 20, 60]]);
  const beats: Array<{ seq: number; stage: string; work: number }> = [];
  scheduler = new BuildScheduler({ select: hint => ({ kind: hint.kind, start: grant =>
    startBuildProcess({ repoRoot: root!.repo, dbPath: root!.db, job: builderJobFor(hint), grant, onHeartbeat: beat => beats.push(beat) }) }) });
  const outcome = await scheduler.submit({ workspaceId: "beat", kind: "full", generation: 1 });
  assert.equal(outcome.ok, true, outcome.error);
  assert.ok(beats.length >= 1, "the builder's first liveness line is written at start");
  assert.deepEqual(beats.map(beat => beat.seq), beats.map((_, index) => index + 1));
  assert.ok(beats.every((beat, index) => index === 0 || beat.work >= beats[index - 1]!.work), "work never moves backwards");
});

test("a delta whose own inputs exceed the closure limit reports escalation before parsing any of them", { timeout: 120_000 }, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-early-escalation-")));
  let scheduler: BuildScheduler | undefined;
  t.after(async () => {
    await scheduler?.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const [root] = await rootsFor(base, [["wide", 10, 45]]);
  const events: BuildSchedulerEvent[] = [];
  scheduler = new BuildScheduler({ onEvent: event => events.push(event), select: hint => ({ kind: hint.kind, start: grant =>
    startBuildProcess({ repoRoot: root!.repo, dbPath: root!.db, job: builderJobFor(hint), grant }) }) });
  assert.equal((await scheduler.submit({ workspaceId: "wide", kind: "full", generation: 1 })).ok, true);
  const changed = root!.files.slice(0, 401);
  for (const file of changed) await writeFile(file, `${await readFile(file, "utf8")}// wide edit\n`);
  events.length = 0;
  const outcome = await scheduler.submit({ workspaceId: "wide", kind: "delta", generation: 2, changed });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.buildKind, "full");
  assert.match(outcome.escalationReason ?? "", /401 changed\/deleted inputs > 400 files/);
  const results = events.filter((event): event is Extract<BuildSchedulerEvent, { type: "result" }> => event.type === "result");
  assert.deepEqual(results.map(event => event.kind), ["delta", "full"], "the delta escalates, the full publishes");
  assert.match(results[0]!.escalation ?? "", /401 changed\/deleted inputs > 400 files/, "escalated on its inputs, before any parse or closure");
});

test("mixed-full-load-short-delta-queue-latency", { timeout: 240_000 }, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ilv2-g06c-fair-")));
  let scheduler: BuildScheduler | undefined;
  // Stop the builders before removing the files they write.
  t.after(async () => {
    await scheduler?.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const roots = await rootsFor(base, [["full-a", 30, 100], ["full-b", 30, 100], ["s1", 1, 5], ["s2", 1, 5], ["s3", 1, 5], ["s4", 1, 5]]);
  const byId = new Map(roots.map(root => [root.id, root]));
  const forks: Array<{ workspaceId: string; kind: string; at: number }> = [];
  const closes: Array<{ workspaceId: string; kind: string; at: number }> = [];
  scheduler = new BuildScheduler({ select: hint => {
    const target = byId.get(hint.workspaceId)!;
    return { kind: hint.kind, start: grant => {
      const attempt = startBuildProcess({ repoRoot: target.repo, dbPath: target.db, job: builderJobFor(hint), grant });
      forks.push({ workspaceId: hint.workspaceId, kind: hint.kind, at: epochNow() });
      attempt.child.once("close", () => closes.push({ workspaceId: hint.workspaceId, kind: hint.kind, at: epochNow() }));
      return attempt;
    } };
  } });
  const small = ["s1", "s2", "s3", "s4"];
  // Unbuilt small roots: each delta reports escalation and runs as a full.
  for (const outcome of await Promise.all(small.map(id => scheduler.submit({ workspaceId: id, kind: "delta", generation: 1 })))) assert.equal(outcome.ok, true, outcome.error);
  for (const id of small) assert.deepEqual(forks.filter(fork => fork.workspaceId === id).map(fork => fork.kind), ["delta", "full"]);
  const fullA = scheduler.submit({ workspaceId: "full-a", kind: "full", generation: 1 });
  await until(() => forks.some(fork => fork.workspaceId === "full-a"), "full-a dispatch");
  const fullB = scheduler.submit({ workspaceId: "full-b", kind: "full", generation: 1 });
  const waits: number[] = [];
  const deltas: Array<Promise<unknown>> = [];
  for (let index = 0; index < 12; index += 1) {
    const id = small[index % small.length]!;
    const file = byId.get(id)!.files[1]!;
    await writeFile(file, `${await readFile(file, "utf8")}// edit ${index}\n`);
    const submittedAt = epochNow();
    const seen = forks.length;
    deltas.push(scheduler.submit({ workspaceId: id, kind: "delta", generation: 2 + index, changed: [file] }).then(outcome => {
      assert.equal(outcome.ok, true, outcome.error);
      const fork = forks.slice(seen).find(item => item.workspaceId === id);
      waits.push(fork!.at - submittedAt);
    }));
    await delay(500);
  }
  await Promise.all(deltas);
  assert.equal((await fullA).ok, true);
  assert.equal((await fullB).ok, true);
  const aClose = closes.find(item => item.workspaceId === "full-a")!;
  const bFork = forks.find(item => item.workspaceId === "full-b")!;
  const sorted = [...waits].sort((x, y) => x - y);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  const overlapped = forks.filter(fork => small.includes(fork.workspaceId) && fork.at > forks.find(item => item.workspaceId === "full-a")!.at && fork.at < aClose.at).length;
  evidence.push({ test: t.name, event: "fairness", deltas: waits.length, waitsMs: waits, p95Ms: p95, maxMs: sorted.at(-1),
    fullHandoffMs: bFork.at - aClose.at, deltasDuringFullA: overlapped,
    runsMs: forks.map(fork => ({ workspaceId: fork.workspaceId, kind: fork.kind, ms: (closes.find(close => close.workspaceId === fork.workspaceId && close.at >= fork.at)?.at ?? Number.NaN) - fork.at })), fullAMs: aClose.at - forks.find(item => item.workspaceId === "full-a")!.at });
  assert.ok(overlapped > 0, "short deltas ran while a full held its slot");
  assert.ok(p95 <= 2000, `short delta queued p95 ${p95} ms`);
  assert.ok(sorted.at(-1)! <= 5000, `short delta queued max ${sorted.at(-1)} ms`);
  assert.ok(bFork.at - aClose.at <= 5000, `waiting full dispatched ${bFork.at - aClose.at} ms after the previous full exited`);
});
