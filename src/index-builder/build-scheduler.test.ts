import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ownerChildStdio } from "../mac-platform/owner-lock.js";
import type { SourceCapture } from "../java-index/source-capture.js";
import { BuildScheduler, type BuildHint, type BuildOutcome } from "./build-scheduler.js";

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
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ilv2-scheduler-"));
  const script = path.join(root, "builder.mjs");
  await writeFile(script, fixtureScript);
  const attempts: Attempt[] = [];
  const selections: BuildHint[] = [];
  const scheduler = new BuildScheduler({ select(input) {
    const selected = { ...input, changed: [...input.changed ?? []], deleted: [...input.deleted ?? []] };
    selections.push(selected);
    const kind = options.selectKind?.(input) ?? input.kind;
    return { kind, baseId: options.baseId?.() ?? `base-${input.workspaceId}`, start(grant) {
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
  return { root, scheduler, attempts, selections, started, result, finish, budget };
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
