import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepoRuntimeManager, type ManagedToolContext, type RuntimeCoordination } from "./repo-runtime-manager.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import type { JavaIndexStatus } from "./java-index/index-types.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import { isJavaIndexPrewarmReady } from "./java-index/java-index-client.js";
import { deferred, delay, type Deferred } from "./test-support/fake-jdtls.test.js";
import type { JdtlsLifecycleState } from "./jdtls-session.js";
import type { ResolvedRepo } from "./repo-resolver.js";
import { probeLayout } from "./layout-probe.js";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  NoopCrossProcessLeaseStore,
  type CrossProcessLeaseStore,
  type LeaseHandle
} from "./cross-process-lease.js";
import type { LayoutSource } from "./layout-manager.js";

test("RepoRuntimeManager evicts the oldest idle started runtime before starting another", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
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

test("prewarmRepo opens a pinned runtime without starting JDT", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), fakeCoordination(), new NoopCrossProcessLeaseStore());
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  assert.equal(manager.activeRepos().length, 1);
  assert.equal(manager.activeRepos()[0]?.started, false);
  assert.equal(sessions.get("/repo-a")?.ensureStartedCalls, 0);
});

test("prewarmRepo does not return until that repo's index is ready", async () => {
  const sessions = new Map<string, FakeSession>();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const events: string[] = [];
  const javaIndexClient = {
    async open() {
      return { indexedGeneration: 1, coverage: [] };
    },
    async awaitPrewarmReady() {
      events.push("wait");
      await gate;
      events.push("ready");
      return {
        state: "READY",
        indexedGeneration: 1,
        files: 3,
        types: 1,
        methods: 1,
        edges: 0,
        snapshotBytes: 10,
        snapshot: { state: "DURABLE" as const, durableGeneration: 1, durableManifestFingerprint: "m" },
        pendingForeground: 0,
        pendingBackground: 0,
        coverage: [{ root: "src", generation: 1, state: "COMPLETE" as const, discoveredFiles: 3, indexedFiles: 3, failedFiles: 0, recoveredFiles: 0, extractorVersion: "test" }],
        resourceCoverage: []
      };
    },
    async flush() {
      events.push("flush");
      return {
        state: "READY",
        indexedGeneration: 1,
        files: 3,
        types: 1,
        methods: 1,
        edges: 0,
        snapshotBytes: 10,
        snapshot: { state: "DURABLE" as const, durableGeneration: 1, durableManifestFingerprint: "m" },
        pendingForeground: 0,
        pendingBackground: 0,
        coverage: [],
        resourceCoverage: []
      };
    }
  };
  const manager = new RepoRuntimeManager(fakeResolver(), {
    idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 1000
  }, resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndexClient as never }),
    fakeCoordination(), new NoopCrossProcessLeaseStore());
  const done = manager.prewarmRepo({ repoRoot: "/repo-a" });
  for (let attempt = 0; attempt < 200 && !events.includes("wait"); attempt += 1) {
    await delay(5);
  }
  assert.deepEqual(events, ["wait"]);
  release();
  await done;
  assert.deepEqual(events, ["wait", "ready"]);
  assert.equal(sessions.get("/repo-a")?.ensureStartedCalls, 0);
});

test("isJavaIndexPrewarmReady requires durable snapshot or complete coverage without background work", () => {
  const base = {
    state: "READY" as const,
    indexedGeneration: 1,
    files: 2,
    types: 1,
    methods: 1,
    edges: 0,
    snapshotBytes: 1,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [{
      root: "src",
      generation: 1,
      state: "COMPLETE" as const,
      discoveredFiles: 2,
      indexedFiles: 2,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }],
    resourceCoverage: []
  };
  assert.equal(isJavaIndexPrewarmReady({ ...base, snapshotVerificationPending: true }), false);
  assert.equal(isJavaIndexPrewarmReady({ ...base, pendingBackground: 1 }), false);
  assert.equal(isJavaIndexPrewarmReady({
    ...base,
    files: 0,
    coverage: [],
    snapshot: { state: "EMPTY" }
  }), false);
  assert.equal(isJavaIndexPrewarmReady({
    ...base,
    snapshot: { state: "DURABLE", durableGeneration: 1, durableManifestFingerprint: "m" }
  }), true);
  assert.equal(isJavaIndexPrewarmReady(base), true);
});

test("prewarmRepo skips repos that are not LSP-enabled", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(false), {
    idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), fakeCoordination(), new NoopCrossProcessLeaseStore());
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  assert.equal(manager.activeRepos().length, 0);
  assert.equal(sessions.has("/repo-a"), false);
});

test("RepoRuntimeManager binds the coordinator GenerationClock onto the session", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = managerWith({}, sessions);
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {});
  assert.equal(sessions.get("/repo-a")?.boundClock instanceof GenerationClock, true);
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
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    resolved => ({ generation: clock, coordinator, layout: fakeLayoutSource(resolved.repoRoot) }),
    new NoopCrossProcessLeaseStore()
  );

  await manager.contextFor({ repoRoot: "/repo-a" });

  assert.equal(javaIndex.coordinatorStartsAtOpen, 1, "the watcher must be started before sibling seed validation begins");
  assert.ok(coordinator.flushes >= 1, "OPEN must flush any batches buffered while a sibling seed was being validated");
  assert.ok(javaIndex.calls.includes("refresh:2:1:0"), "the flushed batch must refresh its changed Java path before the runtime is exposed");
  assert.ok(javaIndex.calls.includes("reconcile:2"), "a generation change during seed validation receives a target reconcile");
  assert.ok(javaIndex.boundedCalls.includes("reconcile:2"), "coordinator reconcile uses the manager hard-cap budget");

  await manager.shutdownAll();
});

test("RepoRuntimeManager routes a RESOURCE_CHANGE batch to refreshResources, separately from a JAVA_CHANGE batch's refresh", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinator = new FakeCoordinator();
  const javaIndex = new RecordingJavaIndex(() => coordinator.starts);
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    resolved => ({ generation: new GenerationClock(), coordinator, layout: fakeLayoutSource(resolved.repoRoot) }),
    new NoopCrossProcessLeaseStore()
  );

  await manager.contextFor({ repoRoot: "/repo-a" });

  await coordinator.emit({
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [{ kind: "RESOURCE_CHANGE", absolutePath: "/repo-a/src/main/resources/mapper/OrderMapper.xml" }],
    storm: false,
    affectedRoots: []
  });

  assert.ok(javaIndex.calls.includes("refreshResources:2:1"), "a RESOURCE_CHANGE-only batch must reach refreshResources");
  assert.ok(javaIndex.boundedCalls.includes("refreshResources:2:1"), "coordinator RPCs must have a manager hard-cap budget");
  assert.ok(!javaIndex.calls.some(call => call.startsWith("refresh:")), "a RESOURCE_CHANGE-only batch must not also call refresh");

  await coordinator.emit({
    generation: 3,
    observedAt: new Date().toISOString(),
    changes: [
      { kind: "JAVA_CHANGE", absolutePath: "/repo-a/src/main/java/demo/Changed.java" },
      { kind: "RESOURCE_CHANGE", absolutePath: "/repo-a/src/main/resources/mapper/OrderMapper.xml" }
    ],
    storm: false,
    affectedRoots: []
  });

  assert.ok(javaIndex.calls.includes("refresh:3:1:0"), "a mixed batch must still refresh its Java path");
  assert.ok(javaIndex.calls.includes("refreshResources:3:1"), "a mixed batch must still refresh its resource path");
  assert.ok(javaIndex.boundedCalls.includes("refresh:3:1:0"));
  assert.ok(javaIndex.boundedCalls.includes("refreshResources:3:1"));

  await manager.shutdownAll();
});

test("RepoRuntimeManager still applies JavaIndex work when session batch handling fails", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinator = new FakeCoordinator();
  const javaIndex = new RecordingJavaIndex(() => coordinator.starts);
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    resolved => ({ generation: new GenerationClock(), coordinator, layout: fakeLayoutSource(resolved.repoRoot) }),
    new NoopCrossProcessLeaseStore()
  );
  await manager.contextFor({ repoRoot: "/repo-a" });
  sessions.get("/repo-a")!.repoChangeError = new Error("session batch failed");

  await assert.rejects(
    () => coordinator.emit({
      generation: 2,
      observedAt: new Date().toISOString(),
      changes: [{ kind: "JAVA_CHANGE", absolutePath: "/repo-a/src/main/java/demo/Changed.java" }],
      storm: false,
      affectedRoots: []
    }),
    /session batch failed/
  );

  assert.ok(javaIndex.calls.includes("refresh:2:1:0"), "a session failure must not prevent JavaIndex refresh");
  assert.ok(javaIndex.boundedCalls.includes("refresh:2:1:0"));
  await manager.shutdownAll();
});

test("RepoRuntimeManager replays batches buffered during OPEN with a per-batch hard-cap budget", async () => {
  const sessions = new Map<string, FakeSession>();
  const coordinator = new FakeCoordinator();
  const openGate = deferred<{
    indexedGeneration: number;
    coverage: Array<{ state: "COMPLETE"; generation: number; failedFiles: number; recoveredFiles: number }>;
  }>();
  let openStarted = false;
  const javaIndex = new RecordingJavaIndex(() => coordinator.starts);
  javaIndex.openGate = openGate;
  javaIndex.onOpen = () => { openStarted = true; };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    resolved => ({ generation: new GenerationClock(), coordinator, layout: fakeLayoutSource(resolved.repoRoot) }),
    new NoopCrossProcessLeaseStore()
  );

  const creating = manager.contextFor({ repoRoot: "/repo-a" });
  await waitFor(() => openStarted);
  await coordinator.emit({
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [{ kind: "RESOURCE_CHANGE", absolutePath: "/repo-a/src/main/resources/app.yml" }],
    storm: false,
    affectedRoots: []
  });
  assert.ok(!javaIndex.calls.includes("refreshResources:2:1"), "the batch stays buffered until OPEN completes");

  openGate.resolve({ indexedGeneration: 1, coverage: [] });
  await creating;
  assert.ok(javaIndex.calls.includes("refreshResources:2:1"));
  assert.ok(javaIndex.boundedCalls.includes("refreshResources:2:1"), "buffer replay uses the manager hard cap too");
  await manager.shutdownAll();
});

test("RepoRuntimeManager fails fast when all active runtimes are in use", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    }, {
      mayStartLsp: true,
      requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 30 }
    }),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.lsp-slot/.test(error.message)
  );

  held.resolve();
  await first;
});

test("RepoRuntimeManager uses the request deadline, not the manager timeout, while waiting for a saturated LSP slot", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 160
  }, resolved => fakeContext(resolved, sessions),
    fakeCoordination(), new NoopCrossProcessLeaseStore());
  const held = deferred<void>();
  const entered = deferred<void>();

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
    entered.resolve();
    await held.promise;
  }, { mayStartLsp: true });
  await entered.promise;

  const startedAt = Date.now();
  await assert.rejects(
    () => manager.withContext(
      { repoRoot: "/repo-b" },
      async () => undefined,
      {
        mayStartLsp: true,
        requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 }
      }
    ),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.lsp-slot/.test(error.message)
  );
  assert.ok(Date.now() - startedAt < 100, "the slot wait must consume the request's 20ms deadline, not the 160ms manager timeout");

  held.resolve();
  await first;
});

test("RepoRuntimeManager bounds shared runtime creation separately from the caller budget", async () => {
  const sessions = new Map<string, FakeSession>();
  let openBudget: DeadlineBudget | undefined;
  let handlerBudget: DeadlineBudget | undefined;
  const javaIndex = {
    localStatus() {
      return { files: 0 };
    },
    async open(
      generation: number,
      _options?: unknown,
      controls?: { budget?: DeadlineBudget }
    ) {
      openBudget = controls?.budget;
      return { indexedGeneration: generation, coverage: [] };
    }
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );

  await manager.withContext(
    { repoRoot: "/repo-a" },
    async (_context, request) => { handlerBudget = request.budget; },
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 500 } }
  );

  assert.ok(openBudget instanceof DeadlineBudget, "runtime creation must receive a bounded operation budget before JavaIndex OPEN");
  assert.ok(handlerBudget instanceof DeadlineBudget, "the handler must receive its caller-specific absolute budget");
  assert.notEqual(openBudget, handlerBudget, "shared creation must not be cancelled by the first caller's shorter budget");
  assert.ok(openBudget!.remainingMs() > handlerBudget!.remainingMs(), "the shared operation uses the manager hard cap");
});

test("RepoRuntimeManager does not run a handler after its budget expires during the JavaIndex status probe", async () => {
  const sessions = new Map<string, FakeSession>();
  const javaIndex = {
    localStatus() {
      return { files: 1 };
    },
    async open() {
      return completeJavaIndexStatus(1);
    },
    async status(controls?: { budget?: DeadlineBudget }): Promise<JavaIndexStatus> {
      return controls!.budget!.race(
        "test.java-index-status",
        new Promise<JavaIndexStatus>(() => undefined)
      );
    }
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      ...fakeContext(resolved, sessions),
      javaIndexClient: javaIndex as never,
      javaIndex: { routerStatus: async () => ({}) } as never
    }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );
  let handlerRan = false;

  await assert.rejects(
    () => manager.withContext(
      { repoRoot: "/repo-a" },
      async () => { handlerRan = true; },
      { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 } }
    ),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(handlerRan, false);
});

test("STARTING sessions count against the active repo limit", async () => {
  const sessions = new Map<string, FakeSession>();
  const gateA = deferred<void>();
  const enteredB = deferred<void>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    () => manager.withContext({ repoRoot: "/repo-b" }, async () => { bRan = true; }, {
      mayStartLsp: true,
      requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 30 }
    }),
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
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    idleTtlMs: 100000, pressureIntervalMs: 0,
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
    { maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
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

test("the first runtime creator honors its deadline without cancelling shared creation", async () => {
  const leaseGate = deferred<LeaseHandle>();
  let acquireCalls = 0;
  class BlockingRuntimeLeaseStore extends NoopCrossProcessLeaseStore {
    override async acquireRuntime(): Promise<LeaseHandle> {
      acquireCalls += 1;
      return leaseGate.promise;
    }
  }
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    fakeCoordination(),
    new BlockingRuntimeLeaseStore()
  );

  const short = manager.withContext(
    { repoRoot: "/repo-a" },
    async () => "short",
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 } }
  );
  await delay(5);
  const long = manager.withContext(
    { repoRoot: "/repo-a" },
    async () => "long",
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 500 } }
  );
  let leaseReleased = false;
  const releaseTimer = setTimeout(() => {
    leaseReleased = true;
    leaseGate.resolve(fakeLeaseHandle());
  }, 80);

  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.create/.test(error.message)
      && leaseReleased === false
  );
  assert.equal(await long, "long", "the shared creation continues for a caller with budget remaining");
  clearTimeout(releaseTimer);
  assert.equal(acquireCalls, 1, "both callers share the same runtime creation");

  await manager.shutdownAll();
});

test("a runtime creation hard-cap retires a stuck lease singleflight so a later request can recover", async () => {
  let acquireCalls = 0;
  class OneStuckRuntimeLeaseStore extends NoopCrossProcessLeaseStore {
    override async acquireRuntime(): Promise<LeaseHandle> {
      acquireCalls += 1;
      if (acquireCalls === 1) return new Promise<LeaseHandle>(() => undefined);
      return fakeLeaseHandle();
    }
  }
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 30 },
    resolved => fakeContext(resolved, sessions),
    fakeCoordination(),
    new OneStuckRuntimeLeaseStore()
  );

  await assert.rejects(
    () => manager.withContext(
      { repoRoot: "/repo-a" },
      async () => undefined,
      { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 } }
    ),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED"
  );
  await delay(30);

  const recovered = await manager.withContext(
    { repoRoot: "/repo-a" },
    async () => "recovered",
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 200 } }
  );
  assert.equal(recovered, "recovered");
  assert.equal(acquireCalls, 2, "the expired shared creation is removed before the retry");

  await manager.shutdownAll();
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
    async acquireBuild() { throw new Error("not used by this test"); },
    async activeRuntimeCount() { return 0; },
    async status() {
      return {
        opened: false, configuredJdtSlots: 0, configuredSweepSlots: 0,
        requestedJdtSlots: 0, requestedSweepSlots: 0, capacityConflict: false,
        runtimeLeases: 0, jdtWorktreeLeases: 0, claimedJdtSlots: 0, claimedSweepSlots: 0,
        claimedBuildSlots: 0,
        staleLeaseReclaims: 0
      };
    }
  };
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
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
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
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
  const javaIndexClientStub = {
    localStatus() {
      return { files: 0 };
    },
    async open(generation: number) {
      return { indexedGeneration: generation, coverage: [{ state: "COMPLETE", generation, failedFiles: 0, recoveredFiles: 0 }] };
    },
    async reconcile(): Promise<void> {
      reconcileCalls += 1;
      await reconcileGate;
    }
  };

  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      javaIndexClient: javaIndexClientStub as never,
      router: { clearRgCache() {}, async flushSemanticEdgeStore() {} } as never,
      javaIndex: { routerStatus: async () => ({}) } as never
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

test("a reconcile singleflight joiner honors its own deadline without cancelling the shared reconcile", async () => {
  const clock = new GenerationClock();
  clock.markDirty("test-forced-dirty");
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");
  const reconcileGate = deferred<void>();
  let reconcileCalls = 0;
  const javaIndexClientStub = {
    localStatus() {
      return { files: 0 };
    },
    async open(generation: number) {
      return { indexedGeneration: generation, coverage: [{ state: "COMPLETE", generation, failedFiles: 0, recoveredFiles: 0 }] };
    },
    async reconcile(): Promise<void> {
      reconcileCalls += 1;
      await reconcileGate.promise;
    },
    async close() {}
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      javaIndexClient: javaIndexClientStub as never,
      router: { clearRgCache() {}, onRepoChanged() {}, async flushSemanticEdgeStore() {} } as never,
      javaIndex: { routerStatus: async () => ({}) } as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  const long = manager.withContext(
    { repoRoot: "/repo-a" },
    async () => "long",
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 500 } }
  );
  await waitFor(() => reconcileCalls === 1);
  const short = manager.withContext(
    { repoRoot: "/repo-a" },
    async () => "short",
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 } }
  );
  const releaseTimer = setTimeout(() => reconcileGate.resolve(), 80);

  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.reconcile/.test(error.message)
  );
  assert.equal(await long, "long", "the original reconcile caller still completes");
  clearTimeout(releaseTimer);
  assert.equal(reconcileCalls, 1, "the deadline race does not duplicate or cancel reconciliation");
  assert.equal(clock.snapshot().dirty, false);

  await manager.shutdownAll();
});

test("reconcileIfDirty leaves dirty set when reconcile fails, without failing the request", async () => {
  const clock = new GenerationClock();
  clock.markDirty("test-forced-dirty");
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");
  const javaIndexClientStub = {
    localStatus() {
      return { files: 0 };
    },
    async open(generation: number) {
      return { indexedGeneration: generation, coverage: [{ state: "COMPLETE", generation, failedFiles: 0, recoveredFiles: 0 }] };
    },
    async reconcile(): Promise<void> {
      throw new Error("reconcile boom");
    }
  };

  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      javaIndexClient: javaIndexClientStub as never,
      router: { clearRgCache() {}, async flushSemanticEdgeStore() {} } as never,
      javaIndex: { routerStatus: async () => ({}) } as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  let handlerRan = false;
  await manager.withContext({ repoRoot: "/repo-a" }, async () => { handlerRan = true; }, {});

  assert.equal(handlerRan, true, "a reconcile failure does not fail the request");
  assert.equal(clock.snapshot().dirty, true, "dirty remains set so the next request retries reconcile");
});

test("V2 runtime reconciles only JavaIndex and records its OPEN source on the request", async () => {
  const clock = new GenerationClock();
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");
  let reconcileCalls = 0;
  let routerStatusBudget: DeadlineBudget | undefined;
  const javaIndexClient = {
    localStatus() {
      return { files: 3 };
    },
    async open(generation: number) {
      return { indexedGeneration: generation, coverage: [] };
    },
    async reconcile() {
      reconcileCalls += 1;
    },
    async close() {}
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      javaIndexClient: javaIndexClient as never,
      javaIndex: {
        async withRequestOptions<T>(options: { budget?: DeadlineBudget }, action: () => Promise<T>): Promise<T> {
          routerStatusBudget = options.budget;
          return action();
        },
        async routerStatus() {
          return { openSource: "sibling-seed" };
        }
      } as never,
      router: { clearRgCache() {}, onRepoChanged() {}, async flushSemanticEdgeStore() {} } as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  const context = await manager.contextFor({ repoRoot: "/repo-a" });
  reconcileCalls = 0;
  clock.markDirty("test-v2-dirty");
  let openSource: string | undefined;
  let handlerBudget: DeadlineBudget | undefined;
  await manager.withContext({ repoRoot: "/repo-a" }, async (_context, request) => {
    openSource = request.indexOpenSource;
    handlerBudget = request.budget;
  });

  assert.equal(context.javaIndexClient, javaIndexClient as never, "runtime must retain its JavaIndex worker client");
  assert.equal(reconcileCalls, 1, "dirty V2 request must reconcile JavaIndex exactly once");
  assert.equal(openSource, "sibling-seed");
  assert.equal(routerStatusBudget, handlerBudget, "routerStatus must inherit the caller's immutable request budget");
});

test("a compatibility RouterIndex without withRequestOptions cannot outlive the caller deadline", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      ...fakeContext(resolved, sessions),
      javaIndex: {
        routerStatus: async () => new Promise<never>(() => undefined)
      } as never
    }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );
  let handlerRan = false;

  await assert.rejects(
    () => Promise.race([
      manager.withContext(
        { repoRoot: "/repo-a" },
        async () => { handlerRan = true; },
        { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 20 } }
      ),
      delay(150).then(() => { throw new Error("test guard: routerStatus escaped the request deadline"); })
    ]),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /runtime\.router-status/.test(error.message)
  );
  assert.equal(handlerRan, false);
  await manager.shutdownAll();
});

test("a bounded routerStatus failure degrades only indexOpenSource while budget remains", async () => {
  const sessions = new Map<string, FakeSession>();
  let receivedBudget: DeadlineBudget | undefined;
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      ...fakeContext(resolved, sessions),
      javaIndex: {
        async withRequestOptions<T>(options: { budget?: DeadlineBudget }, action: () => Promise<T>): Promise<T> {
          receivedBudget = options.budget;
          return action();
        },
        async routerStatus() {
          throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "bounded router status timed out");
        }
      } as never
    }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );
  let openSource: string | undefined = "unexpected";

  await manager.withContext(
    { repoRoot: "/repo-a" },
    async (_context, request) => { openSource = request.indexOpenSource; },
    { requestOptions: { mode: "balanced", semanticPolicy: "auto", deadlineMs: 500 } }
  );

  assert.ok(receivedBudget instanceof DeadlineBudget);
  assert.equal(openSource, undefined);
  await manager.shutdownAll();
});

test("RepoRuntimeManager permits negative lookup only for a settled, same-generation, fully complete index under a normal watcher", async () => {
  const complete = completeJavaIndexStatus(1);
  assert.equal(await negativeLookupAllowedFor(complete), true);

  const cases: Array<{ name: string; status?: JavaIndexStatus; watcher?: Partial<Pick<FakeCoordinator, "degraded" | "pending" | "ready">> }> = [
    {
      name: "a watcher degradation",
      watcher: { degraded: true }
    },
    {
      name: "undrained watcher work",
      watcher: { pending: 1 }
    },
    {
      name: "a mismatched index generation",
      status: { ...complete, indexedGeneration: 0 }
    },
    {
      name: "incomplete source coverage",
      status: { ...complete, coverage: [{ ...complete.coverage[0]!, state: "BUILDING" }] }
    },
    {
      name: "a failed or recovered source file",
      status: { ...complete, coverage: [{ ...complete.coverage[0]!, failedFiles: 1, recoveredFiles: 1 }] }
    },
    {
      name: "incomplete resource coverage",
      status: { ...complete, resourceCoverage: [{ ...complete.resourceCoverage[0]!, state: "DEGRADED" }] }
    },
    {
      name: "a failed resource file",
      status: { ...complete, resourceCoverage: [{ ...complete.resourceCoverage[0]!, failedFiles: 1 }] }
    },
    {
      name: "foreground index work",
      status: { ...complete, pendingForeground: 1 }
    },
    {
      name: "background index work",
      status: { ...complete, pendingBackground: 1 }
    },
    {
      name: "snapshot verification",
      status: { ...complete, snapshotVerificationPending: true }
    }
  ];

  for (const scenario of cases) {
    assert.equal(
      await negativeLookupAllowedFor(scenario.status ?? complete, scenario.watcher),
      false,
      `negative lookup must remain disabled for ${scenario.name}`
    );
  }
});

test("own snapshot verification stays worker-owned after OPEN instead of triggering a duplicate full reconcile", async () => {
  const clock = new GenerationClock();
  const coordinator = new FakeCoordinator();
  const layout = probeLayout("/repo-a");
  let reconcileCalls = 0;
  const javaIndexClient = {
    localStatus() {
      return { files: 0 };
    },
    async open(generation: number) {
      return {
        indexedGeneration: generation,
        coverage: [],
        snapshotVerificationPending: true
      };
    },
    async reconcile() {
      reconcileCalls += 1;
    },
    async close() {}
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      repoRoot: resolved.repoRoot,
      rootSource: resolved.rootSource,
      repoHash: resolved.repoHash,
      aliases: resolved.aliases,
      layoutProfile: resolved.layoutProfile,
      lsp: resolved.lsp,
      session: new FakeSession() as never,
      javaIndexClient: javaIndexClient as never,
      javaIndex: { routerStatus: async () => ({ openSource: "own-snapshot" }) } as never,
      router: { clearRgCache() {}, onRepoChanged() {}, async flushSemanticEdgeStore() {} } as never
    }),
    () => ({ generation: clock, coordinator, layout: { current: () => layout, refresh: () => ({ changed: false, layout }) } }),
    new NoopCrossProcessLeaseStore()
  );

  await manager.contextFor({ repoRoot: "/repo-a" });

  assert.equal(reconcileCalls, 0, "the worker verifies/queues the snapshot itself; manager must not race it with a full sweep");
});

test("hibernate TTL unloads the index without tearing down JDT", async () => {
  const sessions = new Map<string, FakeSession>();
  const javaIndex = new RecordingJavaIndex(() => 0);
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, hibernateTtlMs: 25, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );
  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });
  await delay(80);
  assert.ok(javaIndex.calls.includes("hibernate"));
  assert.equal(sessions.get("/repo-a")?.stops, 0, "T_hibernate must not call session.stop");
  await manager.shutdownAll();
});

test("freemem pressure hibernates the LRU idle runtime", async () => {
  const sessions = new Map<string, FakeSession>();
  const javaIndex = new RecordingJavaIndex(() => 0);
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    {
      idleTtlMs: 100000,
      hibernateTtlMs: 100000,
      pressureIntervalMs: 15,
      freememPressureBytes: 1,
      freemem: () => 0,
      requestTimeoutMs: 5000
    },
    resolved => ({ ...fakeContext(resolved, sessions), javaIndexClient: javaIndex as never }),
    fakeCoordination(),
    new NoopCrossProcessLeaseStore()
  );
  await manager.withContext({ repoRoot: "/repo-a" }, async () => "ok");
  await delay(80);
  assert.ok(javaIndex.calls.includes("hibernate"), "os.freemem below threshold must hibernate LRU idle");
  await manager.shutdownAll();
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
  ensureStartedCalls = 0;
  startGate?: Deferred<void>;
  repoChangeError?: Error;
  boundClock?: GenerationClock;
  readonly repoChangeBatches: RepoChangeBatch[] = [];

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
    this.ensureStartedCalls += 1;
    this.transition("STARTING");
    if (this.startGate) await this.startGate.promise;
    this.transition("READY");
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.transition("STOPPED");
  }

  bindGenerationClock(clock?: GenerationClock): void {
    this.boundClock = clock;
  }

  async applyRepoChangeBatch(batch: RepoChangeBatch): Promise<void> {
    this.repoChangeBatches.push(batch);
    if (this.repoChangeError) throw this.repoChangeError;
  }
}

function fakeResolver(enabled = true): { resolve(selector: { repoRoot?: string }): Promise<ResolvedRepo> } {
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
          enabled,
          matchedBy: enabled ? "direct-root" : "unregistered",
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
  ready = true;
  degraded = false;
  pending = 0;
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
    return { ready: this.ready, degraded: this.degraded, pending: this.pending };
  }
}

class RecordingJavaIndex {
  readonly calls: string[] = [];
  readonly boundedCalls: string[] = [];
  coordinatorStartsAtOpen: number | undefined;
  openGate?: Deferred<{
    indexedGeneration: number;
    coverage: Array<{ state: "COMPLETE"; generation: number; failedFiles: number; recoveredFiles: number }>;
  }>;
  onOpen?: () => void;

  constructor(private readonly coordinatorStarts: () => number) {}

  async open(generation: number): Promise<{
    indexedGeneration: number;
    coverage: Array<{ state: "COMPLETE" | "DEGRADED"; generation: number; failedFiles: number; recoveredFiles: number }>;
  }> {
    this.coordinatorStartsAtOpen = this.coordinatorStarts();
    this.calls.push(`open:${generation}`);
    this.onOpen?.();
    if (this.openGate) return this.openGate.promise;
    return { indexedGeneration: generation, coverage: [] };
  }

  async reconcile(generation: number, controls?: { budget?: DeadlineBudget }): Promise<void> {
    const call = `reconcile:${generation}`;
    this.calls.push(call);
    if (controls?.budget) this.boundedCalls.push(call);
  }
  async refresh(generation: number, changed: string[], deleted: string[], controls?: { budget?: DeadlineBudget }): Promise<void> {
    const call = `refresh:${generation}:${changed.length}:${deleted.length}`;
    this.calls.push(call);
    if (controls?.budget) this.boundedCalls.push(call);
  }
  async refreshResources(generation: number, paths: string[], controls?: { budget?: DeadlineBudget }): Promise<void> {
    const call = `refreshResources:${generation}:${paths.length}`;
    this.calls.push(call);
    if (controls?.budget) this.boundedCalls.push(call);
  }
  async close(): Promise<void> { this.calls.push("close"); }
  async hibernate(): Promise<void> { this.calls.push("hibernate"); }
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

function fakeLeaseHandle(): LeaseHandle {
  return {
    kind: "RUNTIME",
    path: "/tmp/fake-runtime-lease",
    owner: {
      ownerToken: "test-runtime-owner",
      pid: process.pid,
      repoRoot: "/repo-a",
      repoHash: "repoa",
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString()
    },
    async heartbeat() {},
    async release() {}
  };
}

function managerWith(
  options: Partial<{
    maxActiveRepos: number;
    idleTtlMs: number;
    hibernateTtlMs: number;
    requestTimeoutMs: number;
    maxRetainedStoppedRepos: number;
    pressureIntervalMs: number;
    freememPressureBytes: number;
    freemem: () => number;
  }>,
  sessions: Map<string, FakeSession>,
  gates: Record<string, Deferred<void>> = {},
  coordinators?: Map<string, FakeCoordinator>
): RepoRuntimeManager {
  return new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000, ...options },
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
    router: {
      clearRgCache() {},
      onRepoChanged() {},
      async flushSemanticEdgeStore() {}
    } as never,
    javaIndex: {
      routerStatus: async () => ({ entries: 0 })
    } as never
  };
}

function completeJavaIndexStatus(generation: number): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: generation,
    files: 1,
    types: 1,
    methods: 1,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [{
      root: "src/main/java",
      generation,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }],
    resourceCoverage: [{
      root: "src/main/resources",
      generation,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0
    }]
  };
}

async function negativeLookupAllowedFor(
  status: JavaIndexStatus,
  watcher: Partial<Pick<FakeCoordinator, "degraded" | "pending" | "ready">> = {}
): Promise<boolean> {
  const sessions = new Map<string, FakeSession>();
  const coordinator = new FakeCoordinator();
  Object.assign(coordinator, watcher);
  const javaIndexClient = {
    localStatus() {
      return { files: status.files };
    },
    async open() {
      return status;
    },
    async status() {
      return status;
    },
    async close() {}
  };
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => ({
      ...fakeContext(resolved, sessions),
      javaIndexClient: javaIndexClient as never,
      javaIndex: { routerStatus: async () => ({}) } as never
    }),
    () => ({ generation: new GenerationClock(), coordinator, layout: fakeLayoutSource("/repo-a") }),
    new NoopCrossProcessLeaseStore()
  );
  let allowed = false;
  await manager.withContext({ repoRoot: "/repo-a" }, async (_context, request) => {
    allowed = request.negativeLookupAllowed;
  });
  return allowed;
}
