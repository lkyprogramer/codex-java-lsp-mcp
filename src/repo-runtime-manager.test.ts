import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepoRuntimeManager, type ManagedToolContext, type RuntimeCoordination } from "./repo-runtime-manager.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import { deferred, delay, type Deferred } from "./test-support/fake-jdtls.js";
import type { JdtlsLifecycleState } from "./jdtls-session.js";
import type { ResolvedRepo } from "./repo-resolver.js";
import { probeLayout } from "./layout-probe.js";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  NoopCrossProcessLeaseStore,
  type CrossProcessLeaseStore
} from "./cross-process-lease.js";
import type { LayoutSource } from "./layout-manager.js";

test("RepoRuntimeManager evicts the oldest idle started runtime before starting another", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 100
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  await manager.withContext({ repoRoot: "/repo-b" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  assert.equal(sessions.get("/repo-a")?.stops, 1);
  assert.equal(sessions.get("/repo-b")?.stops, 0);
});

test("RepoRuntimeManager starts and flushes the coordinator around Java index OPEN so a seed cannot miss its watcher window", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinator = new FakeCoordinator();
  const clock = new GenerationClock();
  const javaIndex = new RecordingJavaIndex(() => coordinator.starts);
  let emitted = false;
  coordinator.flushHook = async () => {
    if (emitted) return;
    emitted = true;
    const generation = clock.advance("changed while seed was validating");
    await coordinator.emit({
      generation,
      observedAt: new Date().toISOString(),
      changes: [{ kind: "JAVA_CHANGE", absolutePath: "/repo-a/src/main/java/demo/Changed.java" }],
      storm: false,
      affectedRoots: []
    });
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    resolved => ({ generation: clock, coordinator, layout: fakeLayoutSource(resolved.repoRoot) }),
    new NoopCrossProcessLeaseStore()
  );

  await manager.contextFor({ repoRoot: "/repo-a" });

  assert.equal(javaIndex.coordinatorStartsAtOpen, 1, "the watcher must be started before sibling seed validation begins");
  assert.ok(coordinator.flushes >= 1, "OPEN must flush any batches buffered while a sibling seed was being validated");
  assert.ok(javaIndex.calls.includes("refresh:2:1:0"), "the flushed batch must refresh its changed Java path before the runtime is exposed");
  assert.ok(javaIndex.calls.includes("reconcile:2"), "a generation change during seed validation receives a target reconcile");

  await manager.shutdownAll();
});

test("RepoRuntimeManager fails fast when all active runtimes are in use", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 30
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());
  const held = deferred<void>();
  const firstEntered = deferred<void>();

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
    firstEntered.resolve();
    await held.promise;
  }, { mayStartLsp: true });
  await firstEntered.promise;

  await assert.rejects(
    () => manager.withContext({ repoRoot: "/repo-b" }, async context => {
      await (context.session as unknown as FakeSession).ensureStarted();
    }, { mayStartLsp: true }),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.lsp-slot/.test(error.message)
  );

  held.resolve();
  await first;
});

test("STARTING sessions count against the active repo limit", async () => {
  const sessions = new Map<string, FakeSession>();
  const gateA = deferred<void>();
  const enteredB = deferred<void>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions, { "/repo-a": gateA }),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  await waitFor(() => sessions.get("/repo-a")?.state === "STARTING");
  assert.equal(sessions.get("/repo-a")!.status().started, false, "A is STARTING, not started");
  assert.equal(manager.reservedCount(), 1, "a STARTING session holds the slot");

  const second = manager.withContext({ repoRoot: "/repo-b" }, async context => {
    enteredB.resolve();
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  await delay(20);
  assert.equal(enteredB.settled, false, "B must not run while A holds the only slot");
  assert.equal(manager.reservedCount(), 1);
  assert.equal(sessions.has("/repo-b"), true);
  assert.equal(sessions.get("/repo-b")!.state, "NEW", "B never spawned while queued");

  gateA.resolve();
  await first;
  await second;

  assert.equal(sessions.get("/repo-a")!.stops, 1, "idle A is evicted so the queued B can run");
  assert.equal(sessions.get("/repo-b")!.state, "READY");
});

test("slot waiters are granted in FIFO order", async () => {
  const sessions = new Map<string, FakeSession>();
  const held = deferred<void>();
  const order: string[] = [];
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  const entered = deferred<void>();
  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
    entered.resolve();
    await held.promise;
  }, { mayStartLsp: true });
  await entered.promise;

  const second = manager.withContext({ repoRoot: "/repo-b" }, async context => {
    order.push("b");
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });
  await delay(10);
  const third = manager.withContext({ repoRoot: "/repo-c" }, async context => {
    order.push("c");
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });
  await delay(10);

  assert.deepEqual(order, [], "neither waiter runs while A holds the slot");

  held.resolve();
  await first;
  await second;
  await third;

  assert.deepEqual(order, ["b", "c"], "B queued before C, so B is granted first");
});

test("a waiter that misses its deadline is removed and never granted later", async () => {
  const sessions = new Map<string, FakeSession>();
  const held = deferred<void>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 40
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  const entered = deferred<void>();
  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
    entered.resolve();
    await held.promise;
  }, { mayStartLsp: true });
  await entered.promise;

  let bRan = false;
  await assert.rejects(
    () => manager.withContext({ repoRoot: "/repo-b" }, async () => { bRan = true; }, { mayStartLsp: true }),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(bRan, false);

  held.resolve();
  await first;
  await delay(30);

  // The cancelled waiter must not be handed a reservation once A releases.
  assert.equal(bRan, false);
  assert.equal(manager.activeRepos().find(item => item.repoRoot === "/repo-b")?.lspReservation, "NONE");
});

test("a reservation taken but never used is released for the next caller", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  // mayStartLsp only means "the handler is allowed to start JDT", not that it will.
  await manager.withContext({ repoRoot: "/repo-a" }, async () => undefined, { mayStartLsp: true });
  assert.equal(manager.reservedCount(), 0, "an unused STARTING reservation is released");
  assert.equal(sessions.get("/repo-a")!.stops, 0, "no eviction was needed");

  await manager.withContext({ repoRoot: "/repo-b" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });
  assert.equal(manager.reservedCount(), 1);
  assert.equal(manager.activeRepos().find(item => item.repoRoot === "/repo-b")?.lspReservation, "READY");
});

test("a session that breaks releases its slot to a queued waiter", async () => {
  const sessions = new Map<string, FakeSession>();
  const held = deferred<void>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  const entered = deferred<void>();
  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    const session = context.session as unknown as FakeSession;
    await session.ensureStarted();
    entered.resolve();
    await held.promise;
    session.transition("BROKEN");
  }, { mayStartLsp: true });
  await entered.promise;

  let bRan = false;
  const second = manager.withContext({ repoRoot: "/repo-b" }, async context => {
    bRan = true;
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });
  await delay(10);
  assert.equal(bRan, false);

  held.resolve();
  await first;
  await second;
  assert.equal(bRan, true);
  assert.equal(sessions.get("/repo-a")!.stops, 0, "a BROKEN session releases without being stopped again");
});

test("activeRepos exposes lifecycle state and reservation", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 2,
    idleTtlMs: 100000,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  const [entry] = manager.activeRepos();
  assert.equal(entry.repoRoot, "/repo-a");
  assert.equal(entry.lifecycleState, "READY");
  assert.equal(entry.lspReservation, "READY");
  assert.equal(entry.started, true);
});

test("two concurrent contextFor calls share one runtime and one coordinator", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinators = new Map<string, FakeCoordinator>();
  let contextCalls = 0;
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { maxActiveRepos: 2, idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => { contextCalls += 1; return fakeContext(resolved, sessions); },
    fakeCoordination(coordinators),
    new NoopCrossProcessLeaseStore()
  );

  const [a, b] = await Promise.all([
    manager.contextFor({ repoRoot: "/repo-a" }),
    manager.contextFor({ repoRoot: "/repo-a" })
  ]);

  assert.equal(a, b, "both callers receive the same context");
  assert.equal(contextCalls, 1, "the runtime is created once");
  assert.equal(coordinators.size, 1, "one coordinator for the shared runtime");
  assert.equal([...coordinators.values()][0].starts, 1, "the watcher is started once");
});

test("initialize() singleflights lease store opening and a degraded store still leaves the fast path usable", async () => {
  let openCalls = 0;
  const degradedLeaseStore: CrossProcessLeaseStore = {
    async open() {
      openCalls += 1;
      throw new Error("disk full");
    },
    async acquireRuntime() { throw new Error("not used by this test"); },
    async tryAcquireJdt() { throw new Error("not used by this test"); },
    async acquireJdt() { throw new Error("not used by this test"); },
    async acquireSweep() { throw new Error("not used by this test"); },
    async activeRuntimeCount() { return 0; },
    async status() {
      return {
        opened: false, configuredJdtSlots: 0, configuredSweepSlots: 0,
        requestedJdtSlots: 0, requestedSweepSlots: 0, capacityConflict: false,
        runtimeLeases: 0, jdtWorktreeLeases: 0, claimedJdtSlots: 0, claimedSweepSlots: 0,
        staleLeaseReclaims: 0
      };
    }
  };
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    fakeCoordination(),
    degradedLeaseStore
  );

  await Promise.all([manager.initialize(), manager.initialize()]);
  assert.equal(openCalls, 1, "open() runs once even under concurrent initialize() calls");

  const status = await manager.leaseStatus();
  assert.match(status.initError ?? "", /disk full/);

  let handlerRan = false;
  await manager.withContext({ repoRoot: "/repo-a" }, async () => { handlerRan = true; }, {});
  assert.equal(handlerRan, true, "a degraded lease store does not block the fast/lexical path");
});

test("a live runtime holds a runtime lease so activeRuntimeCount reflects it, and shutdown releases it", async () => {
  const leaseRoot = mkdtempSync(path.join(tmpdir(), "runtime-lease-"));
  const leaseStore = new FileCrossProcessLeaseStore(leaseRoot, defaultLeaseClockDeps());
  await leaseStore.open({ jdtSlots: 1, sweepSlots: 1 });
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    fakeCoordination(),
    leaseStore
  );

  await manager.withContext({ repoRoot: "/repo-a" }, async () => undefined, {});
  assert.equal(await leaseStore.activeRuntimeCount(), 1, "the live runtime registered a runtime lease");

  await manager.shutdown("/repo-a");
  assert.equal(await leaseStore.activeRuntimeCount(), 0, "shutdown released the runtime lease");
});

test("fully stopped idle runtimes are removed from the runtime map beyond the retention bound", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = managerWith({ maxRetainedStoppedRepos: 2 }, sessions);

  for (const repo of ["/repo-a", "/repo-b", "/repo-c"]) {
    await manager.withContext({ repoRoot: repo }, async () => undefined);
    await manager.shutdown(repo);
  }

  assert.equal(manager.activeRepos().length, 2, "only the bound's worth of stopped repos are retained");
  assert.equal(manager.hasRuntime("/repo-a"), false, "the oldest stopped repo is evicted");
  assert.equal(manager.hasRuntime("/repo-b"), true);
  assert.equal(manager.hasRuntime("/repo-c"), true);
});

test("a runtime reused after shutdown gets a freshly started coordinator, not the closed one", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinators = new Map<string, FakeCoordinator>();
  // A bound of 1 keeps the just-stopped repo retained (not evicted) so this
  // test can prove getOrCreate does not hand back its closed coordinator.
  const manager = managerWith({ maxRetainedStoppedRepos: 1 }, sessions, {}, coordinators);

  await manager.withContext({ repoRoot: "/repo-a" }, async () => undefined);
  await manager.shutdown("/repo-a");
  assert.equal(manager.hasRuntime("/repo-a"), true, "retained within the bound");
  const closedCoordinator = coordinators.get("/repo-a");
  assert.equal(closedCoordinator?.closes, 1);

  await manager.withContext({ repoRoot: "/repo-a" }, async () => undefined);

  const recreatedCoordinator = coordinators.get("/repo-a");
  assert.notEqual(recreatedCoordinator, closedCoordinator, "a fresh coordinator replaced the closed one");
  assert.equal(recreatedCoordinator?.starts, 1, "the new coordinator was started");
});

test("reconcileIfDirty runs once under two concurrent requests and clears dirty via compare-and-set", async () => {
  const clock = new GenerationClock();
  clock.markDirty("test-forced-dirty");
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");

  let reconcileCalls = 0;
  let releaseReconcile!: () => void;
  const reconcileGate = new Promise<void>(resolve => { releaseReconcile = resolve; });
  const sourceIndexStub = {
    async reconcile(): Promise<void> {
      reconcileCalls += 1;
      await reconcileGate;
    }
  };

  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      sourceIndex: sourceIndexStub as never,
      router: { clearRgCache() {} } as never,
      javaIndex: {} as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  const first = manager.withContext({ repoRoot: "/repo-a" }, async () => {}, {});
  await waitFor(() => reconcileCalls === 1);
  const second = manager.withContext({ repoRoot: "/repo-a" }, async () => {}, {});

  releaseReconcile();
  await Promise.all([first, second]);

  assert.equal(reconcileCalls, 1, "two concurrent dirty requests share one reconcile");
  assert.equal(clock.snapshot().dirty, false, "clearDirty succeeds since no new change arrived during reconcile");
});

test("reconcileIfDirty leaves dirty set when reconcile fails, without failing the request", async () => {
  const clock = new GenerationClock();
  clock.markDirty("test-forced-dirty");
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");
  const sourceIndexStub = {
    async reconcile(): Promise<void> {
      throw new Error("reconcile boom");
    }
  };

  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      sourceIndex: sourceIndexStub as never,
      router: { clearRgCache() {} } as never,
      javaIndex: {} as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  let handlerRan = false;
  await manager.withContext({ repoRoot: "/repo-a" }, async () => { handlerRan = true; }, {});

  assert.equal(handlerRan, true, "a reconcile failure does not fail the request");
  assert.equal(clock.snapshot().dirty, true, "dirty remains set so the next request retries reconcile");
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await delay(5);
  }
  assert.equal(condition(), true, "condition never became true");
}

class FakeSession {
  state: JdtlsLifecycleState = "NEW";
  stops = 0;
  startGate?: Deferred<void>;

  private readonly listeners = new Set<(state: JdtlsLifecycleState) => void>();

  status(): { state: JdtlsLifecycleState; started: boolean } {
    return { state: this.state, started: this.state === "READY" };
  }

  onLifecycleChange(listener: (state: JdtlsLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transition(next: JdtlsLifecycleState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  async ensureStarted(): Promise<void> {
    this.transition("STARTING");
    if (this.startGate) await this.startGate.promise;
    this.transition("READY");
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.transition("STOPPED");
  }

  invalidateForRepoChanges(): void {}
}

function fakeResolver(): { resolve(selector: { repoRoot?: string }): Promise<ResolvedRepo> } {
  return {
    async resolve(selector) {
      const repoRoot = selector.repoRoot || "/repo";
      const repoHash = repoRoot.replace(/\W/g, "");
      return {
        repoRoot,
        repoHash,
        rootSource: "explicit",
        aliases: [],
        layoutProfile: "generic-java",
        lsp: {
          enabled: true,
          matchedBy: "direct-root",
          configuredRoot: repoRoot,
          effectiveRepoRoot: repoRoot
        },
        worktree: { repoRoot, repoHash, isLinkedWorktree: false }
      };
    }
  };
}

class FakeCoordinator {
  starts = 0;
  flushes = 0;
  flushHook?: () => void | Promise<void>;
  closes = 0;
  private readonly listeners = new Set<(batch: RepoChangeBatch) => void | Promise<void>>();
  onBatch(listener: (batch: RepoChangeBatch) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(): Promise<void> { this.starts += 1; }
  async flushNow(): Promise<void> {
    this.flushes += 1;
    await this.flushHook?.();
  }
  async emit(batch: RepoChangeBatch): Promise<void> {
    for (const listener of this.listeners) await listener(batch);
  }
  async awaitReadyWithin(): Promise<boolean> { return true; }
  async close(): Promise<void> { this.closes += 1; }
  status(): { ready: boolean; degraded: boolean; pending: number } {
    return { ready: true, degraded: false, pending: 0 };
  }
}

class RecordingJavaIndex {
  readonly calls: string[] = [];
  coordinatorStartsAtOpen: number | undefined;

  constructor(private readonly coordinatorStarts: () => number) {}

  async open(generation: number): Promise<{
    indexedGeneration: number;
    coverage: Array<{ state: "COMPLETE" | "DEGRADED"; generation: number; failedFiles: number; recoveredFiles: number }>;
  }> {
    this.coordinatorStartsAtOpen = this.coordinatorStarts();
    this.calls.push(`open:${generation}`);
    return { indexedGeneration: generation, coverage: [] };
  }

  async reconcile(generation: number): Promise<void> { this.calls.push(`reconcile:${generation}`); }
  async refresh(generation: number, changed: string[], deleted: string[]): Promise<void> {
    this.calls.push(`refresh:${generation}:${changed.length}:${deleted.length}`);
  }
  async close(): Promise<void> { this.calls.push("close"); }
}

function fakeLayoutSource(repoRoot: string): LayoutSource {
  const layout = probeLayout(repoRoot);
  return { current: () => layout, refresh: () => ({ changed: false, layout }) };
}

function fakeCoordination(coordinators?: Map<string, FakeCoordinator>) {
  return (resolved: ResolvedRepo): RuntimeCoordination => {
    const coordinator = new FakeCoordinator();
    coordinators?.set(resolved.repoRoot, coordinator);
    return { generation: new GenerationClock(), coordinator, layout: fakeLayoutSource(resolved.repoRoot) };
  };
}

function managerWith(
  options: Partial<{ maxActiveRepos: number; idleTtlMs: number; requestTimeoutMs: number; maxRetainedStoppedRepos: number }>,
  sessions: Map<string, FakeSession>,
  gates: Record<string, Deferred<void>> = {},
  coordinators?: Map<string, FakeCoordinator>
): RepoRuntimeManager {
  return new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, requestTimeoutMs: 5000, ...options },
    resolved => fakeContext(resolved, sessions, gates),
    fakeCoordination(coordinators),
    new NoopCrossProcessLeaseStore()
  );
}

function fakeContext(
  resolved: ResolvedRepo,
  sessions: Map<string, FakeSession>,
  gates: Record<string, Deferred<void>> = {}
): ManagedToolContext {
  const session = new FakeSession();
  session.startGate = gates[resolved.repoRoot];
  sessions.set(resolved.repoRoot, session);
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    session: session as never,
    sourceIndex: {
      status: () => ({ entries: 0 }),
      applyChanges() {}
    } as never,
    router: {
      clearRgCache() {},
      onRepoChanged() {}
    } as never,
    javaIndex: {
      routerStatus: async () => ({ entries: 0 })
    } as never
  };
}
