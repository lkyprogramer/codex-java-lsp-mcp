// G06C owner entry: a real BuildScheduler and QueryPool behind OwnerAdmission,
// with real builder and query processes. Not the formal binding/transport.
import { appendFileSync, closeSync, fstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { assertOwnerLock } from "../dist/mac-platform/owner-lock.js";
import { GradleDomain } from "../dist/mac-platform/gradle-domain.js";
import { BuildScheduler } from "../dist/index-builder/build-scheduler.js";
import { builderJobFor, startBuildProcess } from "../dist/index-builder/build-process.js";
import { OwnerAdmission } from "../dist/index-builder/owner-admission.js";
import { QueryPool } from "../dist/java-index/snapshot/query-pool.js";
import { queryOpTask, spawnQueryWorker } from "../dist/java-index/snapshot/query-process.js";
import { DeadlineBudget } from "../dist/runtime/deadline-budget.js";

const root = process.argv[2];
const options = JSON.parse(readFileSync(path.join(root, "options.json"), "utf8"));
const settings = options.scheduler;
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const record = value => appendFileSync(path.join(root, "timeline.jsonl"), `${JSON.stringify({ ...value, pid: process.pid, pgid, at: performance.timeOrigin + performance.now() })}\n`);
assertOwnerLock();
const lock = fstatSync(4);
record({ type: "ready", execPath: process.execPath, lock: { dev: lock.dev, ino: lock.ino } });

// The fixture's Gradle domain has no daemons; its cleanup runs only when the
// test reports the external cleanup done (recover-semantic).
const gradleHome = path.join(realpathSync(root), "gradle-home");
mkdirSync(gradleHome, { recursive: true });
const domain = new GradleDomain(gradleHome, [{ version: "9.3.1", launcher: "/ilv2-fixture/gradle", launcherSha256: "0".repeat(64), javaHome: "/ilv2-fixture/jdk" }], {
  async execute(_distribution, args) { return args[0] === "--status" ? "No Gradle daemons are running.\n" : "Stopping Daemon(s)\n"; },
  alive: () => false
});
const admission = new OwnerAdmission(() => assertOwnerLock(), domain);
const roots = new Map(settings.roots.map(item => [item.id, item]));
const status = () => ({ scheduler: scheduler.status(), pool: pool.status(), admission: admission.status() });
const heldBuilders = new Set();
const snapshot = reason => record({ type: "status", reason, ...status() });
const scheduler = new BuildScheduler({
  admitted: admission.admitted,
  onEvent: event => { record({ type: "scheduler-event", event }); snapshot("scheduler-event"); },
  select(hint) {
    const target = roots.get(hint.workspaceId);
    if (!target) throw new Error(`unknown workspace ${hint.workspaceId}`);
    const kind = hint.kind;
    return { kind, baseId: target.id, start(grant) {
      const attempt = startBuildProcess({ repoRoot: target.repo, dbPath: target.db, job: builderJobFor(hint, kind), grant });
      record({ type: "fork", role: "builder", workspaceId: hint.workspaceId, kind, childPid: attempt.child.pid, parserTokens: grant.parserTokens });
      // Test hook: a held full stays active (fd4 and PGID are inherited at fork) until release-builders, however fast the build would be.
      if (kind === "full" && settings.holdFullBuilds?.includes(hint.workspaceId)) {
        attempt.child.kill("SIGSTOP");
        heldBuilders.add(attempt.child);
        attempt.child.once("close", () => heldBuilders.delete(attempt.child));
        record({ type: "builder-held", workspaceId: hint.workspaceId, childPid: attempt.child.pid });
      }
      attempt.child.once("close", (code, signal) => { record({ type: "close", role: "builder", workspaceId: hint.workspaceId, childPid: attempt.child.pid, code, signal }); snapshot("builder-close"); });
      attempt.result.then(outcome => record({ type: "build-result", workspaceId: hint.workspaceId, kind, outcome: outcome.kind,
        ok: outcome.kind === "result" ? outcome.result.ok : undefined, reason: outcome.kind === "needs-full" ? outcome.reason : undefined }), () => undefined);
      queueMicrotask(() => snapshot("builder-fork"));
      return attempt;
    } };
  }
});
// Persistent query workers: each fork/close is recorded with the query it was running (by lease key).
const runningOn = new Map();
const pool = new QueryPool({ admitted: admission.admitted, onEvent: event => { record({ type: "pool-event", event }); snapshot("pool-event"); },
  // The fixture leases are per query: no connection outlives its query.
  retain: () => false,
  spawn() {
    const child = spawnQueryWorker();
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message?.type === "run") runningOn.set(child, keyNames.get(message.key));
      return send(message, ...rest);
    };
    record({ type: "fork", role: "query", childPid: child.pid });
    child.on("message", message => {
      if (message?.type === "started") record({ type: "query-started", name: runningOn.get(child) });
    });
    child.once("close", (code, signal) => {
      const name = runningOn.get(child);
      record({ type: "close", role: "query", name, childPid: child.pid, code, signal, leaseHeld: [...held].some(key => keyNames.get(key) === name) });
      snapshot("query-close");
    });
    queueMicrotask(() => snapshot("query-fork"));
    return child;
  } });
admission.onOpen(() => { scheduler.wake(); pool.wake(); });
let leaseCounter = 0;
const held = new Set();
const keyNames = new Map();
const queries = new Map();

for (const hint of settings.startup ?? []) {
  void scheduler.submit(hint).then(completion => record({ type: "build-complete", workspaceId: hint.workspaceId, generation: hint.generation, ...summary(completion) }));
}
if ((settings.startup ?? []).length > 0) {
  await delay(50);
  snapshot("queued-before-admission");
}
function summary(completion) {
  return { ok: completion.ok, error: completion.error, forcedExit: completion.forcedExit, files: completion.result?.files, indexedGeneration: completion.result?.indexedGeneration };
}

function query(command) {
  const target = roots.get(command.workspaceId);
  const controller = new AbortController();
  const budget = DeadlineBudget.fromTimeout(command.timeoutMs ?? 10_000);
  const task = queryOpTask({ budget, signal: controller.signal, allowTestHooks: settings.allowTestHooks === true, testBlockMs: command.testBlockMs,
    request: { op: "search", args: { task: command.task, limit: command.limit ?? 10, mode: command.mode ?? "auto" } },
    acquire: () => {
      const snapshotId = `${target.id}-${++leaseCounter}`;
      held.add(snapshotId);
      keyNames.set(snapshotId, command.name);
      record({ type: "lease-acquire", name: command.name, snapshotId });
      return { snapshotId, dbPath: target.db, release() { held.delete(snapshotId); record({ type: "lease-release", name: command.name, snapshotId }); } };
    } });
  queries.set(command.name, controller);
  const submittedAt = performance.timeOrigin + performance.now();
  void pool.submit(task).then(completion => record({ type: "query-complete", name: command.name, status: completion.status, error: completion.error,
    hits: completion.status === "ok" ? completion.value.results?.length ?? completion.value.hits?.length : undefined, deadlineAt: submittedAt + (command.timeoutMs ?? 10_000) }));
}

async function run(command) {
  if (command.type === "submit") {
    const hint = { workspaceId: command.workspaceId, kind: command.kind, generation: command.generation, ...(command.changed ? { changed: command.changed } : {}), ...(command.rescan ? { rescan: true } : {}) };
    void scheduler.submit(hint).then(completion => record({ type: "build-complete", workspaceId: hint.workspaceId, generation: hint.generation, ...summary(completion) }));
  }
  if (command.type === "query") query(command);
  if (command.type === "cancel-query") queries.get(command.name)?.abort();
  if (command.type === "release-builders") {
    for (const child of heldBuilders) child.kill("SIGCONT");
    record({ type: "builders-released", pids: [...heldBuilders].map(child => child.pid) });
    heldBuilders.clear();
  }
  // Only this process's reference: its workers keep theirs (fd4), so the group still holds the lock.
  if (command.type === "close-lock") { closeSync(4); record({ type: "lock-closed" }); }
  if (command.type === "open-static") {
    try { admission.openStatic(); record({ type: "static-open", ...status() }); }
    catch (error) { record({ type: "static-open-failed", error: error.message }); }
  }
  if (command.type === "check-semantic") {
    try { admission.assertSemanticAdmission(); record({ type: "semantic-admitted", admission: admission.status() }); }
    catch (error) { record({ type: "semantic-blocked", code: error.code, admission: admission.status() }); }
  }
  if (command.type === "recover-semantic") {
    await domain.recover(async () => {});
    record({ type: "semantic-recovered", admission: admission.status() });
  }
  if (command.type === "stop") {
    await Promise.all([scheduler.stop(), pool.stop()]);
    record({ type: "stopped", held: held.size, ...status() });
    process.exit(0);
  }
}

const sampler = setInterval(() => snapshot("sample"), 100);
sampler.unref();
let lastCommand;
for (;;) {
  try {
    const command = JSON.parse(readFileSync(path.join(root, "command.json"), "utf8"));
    if (command.id !== lastCommand) {
      lastCommand = command.id;
      await run(command);
      record({ type: "ack", commandId: command.id, command: command.type });
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await delay(25);
}
