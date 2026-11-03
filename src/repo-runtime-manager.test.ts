import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { changeBatchFor, RepoRuntimeManager, type IndexOwnerSource, type ManagedToolContext } from "./repo-runtime-manager.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import type { JavaIndexStatus } from "./java-index/index-types.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import { isJavaIndexPrewarmReady } from "./java-index/java-index-client-api.js";
import { repoCacheRoot } from "./repo-layout.js";
import { deferred, delay, type Deferred } from "./test-support/fake-jdtls.test.js";
import type { JdtlsLifecycleState } from "./jdtls-session.js";
import type { ResolvedRepo } from "./repo-resolver.js";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  NoopCrossProcessLeaseStore,
  type CrossProcessLeaseStore,
  type LeaseHandle
} from "./cross-process-lease.js";
import type { PublishEvent } from "./java-index/snapshot/index-owner.js";
import { GradleDomain, type GradleCleanupIO } from "./mac-platform/gradle-domain.js";

test("RepoRuntimeManager evicts the oldest idle started runtime before starting another", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 100
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  assert.equal(manager.activeRepos().length, 1);
  assert.equal(manager.activeRepos()[0]?.started, false);
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
  const manager = new RepoRuntimeManager(fakeResolver(false), { index: false,
    idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  assert.equal(manager.activeRepos().length, 0);
  assert.equal(sessions.has("/repo-a"), false);
});

test("RepoRuntimeManager binds its GenerationClock onto the session", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = managerWith({}, sessions);
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {});
  assert.equal(sessions.get("/repo-a")?.boundClock instanceof GenerationClock, true);
});

test("RepoRuntimeManager fails fast when all active runtimes are in use", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 30
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());
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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 160
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());
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

test("STARTING sessions count against the active repo limit", async () => {
  const sessions = new Map<string, FakeSession>();
  const gateA = deferred<void>();
  const enteredB = deferred<void>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions, { "/repo-a": gateA }),
    undefined, new NoopCrossProcessLeaseStore());

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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 40
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

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
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

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
  assert.equal(sessions.get("/repo-a")!.reaps >= 1, true, "breaking the session still reaps a surviving child");
});

test("BROKEN keeps its machine slot until an abandoned child is reaped", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 1, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  const broken = deferred<void>();
  const releaseHandler = deferred<void>();
  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    const session = context.session as unknown as FakeSession;
    await session.ensureStarted();
    session.liveChild = true;
    session.reapGate = deferred<void>();
    session.transition("BROKEN");
    broken.resolve();
    await releaseHandler.promise;
  }, { mayStartLsp: true });
  await broken.promise;
  let ran = false;
  const second = manager.withContext({ repoRoot: "/repo-b" }, async () => { ran = true; }, { mayStartLsp: true });
  releaseHandler.resolve();
  await first;
  await delay(20);
  assert.equal(ran, false, "a surviving child still consumes the machine slot");
  const session = sessions.get("/repo-a")!;
  session.liveChild = false;
  session.reapGate!.resolve();
  await second;
  await manager.shutdownAll();
});

test("activeRepos exposes lifecycle state and reservation", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false,
    maxActiveRepos: 2,
    idleTtlMs: 100000, pressureIntervalMs: 0,
    requestTimeoutMs: 5000
  }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).ensureStarted();
  }, { mayStartLsp: true });

  const [entry] = manager.activeRepos();
  assert.equal(entry.repoRoot, "/repo-a");
  assert.equal(entry.lifecycleState, "READY");
  assert.equal(entry.lspReservation, "READY");
  assert.equal(entry.started, true);
});

test("two concurrent contextFor calls share one runtime", async () => {
  const sessions = new Map<string, FakeSession>();
  let contextCalls = 0;
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { index: false, maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => { contextCalls += 1; return fakeContext(resolved, sessions); },
    undefined,
    new NoopCrossProcessLeaseStore()
  );

  const [a, b] = await Promise.all([
    manager.contextFor({ repoRoot: "/repo-a" }),
    manager.contextFor({ repoRoot: "/repo-a" })
  ]);

  assert.equal(a, b, "both callers receive the same context");
  assert.equal(contextCalls, 1, "the runtime is created once");
});

test("request-path cache stamps (sync meta I/O) run once per interval, not per request", async t => {
  const base = mkdtempSync(path.join(tmpdir(), "runtime-touch-"));
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-touch-repo-")));
  const previousBase = process.env.JAVA_LSP_CACHE_BASE;
  process.env.JAVA_LSP_CACHE_BASE = base;
  t.after(() => {
    if (previousBase === undefined) delete process.env.JAVA_LSP_CACHE_BASE; else process.env.JAVA_LSP_CACHE_BASE = previousBase;
    rmSync(base, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(
    fakeResolver(),
    { index: false, maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    undefined,
    new NoopCrossProcessLeaseStore()
  );
  const meta = path.join(repoCacheRoot(repoRoot), "repo-meta.json");
  await manager.contextFor({ repoRoot });
  assert.equal(typeof JSON.parse(readFileSync(meta, "utf8")).lastRequestAt, "string", "the first request stamps the cache");
  rmSync(meta);
  for (let index = 0; index < 5; index += 1) await manager.contextFor({ repoRoot });
  assert.equal(existsSync(meta), false, "later requests within the interval do not rewrite the stamp");
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
    { index: false, maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    undefined,
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
    { index: false, maxActiveRepos: 2, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 30 },
    resolved => fakeContext(resolved, sessions),
    undefined,
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

/** A Gradle cleanup that never starts (or never ends) fails the test instead of hanging it. */
async function cleanupSettled(domain: GradleDomain, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (domain.status().semanticState === "RECOVERING") {
    if (Date.now() > deadline) throw new Error(`Gradle cleanup still RECOVERING after ${timeoutMs} ms`);
    await delay(5);
  }
}

test("under a Gradle domain, start runs its cleanup before any semantic admission and a normal stop closes JDT before stopping Gradle", async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-gradle-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const order: string[] = [];
  const firstStatus = deferred<void>();
  let commands = 0;
  const io: GradleCleanupIO = { alive: () => false, async execute(_dist, args) {
    order.push(`gradle${args[0]}`);
    if (++commands === 1) await firstStatus.promise;
    return "No Gradle daemons are running.\n";
  } };
  const domain = new GradleDomain(home, [{ version: "9.3.1", launcher: "/private/gradle/bin/gradle", launcherSha256: "a".repeat(64), javaHome: "/private/jdk" }], io);
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false, gradleDomain: domain, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  await manager.initialize();
  assert.deepEqual(manager.semanticStatus(), { staticAdmission: "CLOSED", semanticState: "RECOVERING" });
  assert.throws(() => domain.assertSemanticAdmission(), /semanticState=RECOVERING/);
  firstStatus.resolve();
  await cleanupSettled(domain);
  assert.equal(manager.semanticStatus()?.semanticState, "READY");
  assert.deepEqual(order.splice(0), ["gradle--status", "gradle--stop", "gradle--status"]);

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    const session = context.session as unknown as FakeSession;
    await session.ensureStarted();
    const stop = session.stop.bind(session);
    session.stop = async () => {
      // Semantic admission is already closed while the session is still closing.
      order.push(`session-stop:${domain.status().semanticState}`);
      await delay(20);
      await stop();
      order.push("session-stopped");
    };
  }, { mayStartLsp: true });
  await manager.shutdownAll({ terminal: true });
  assert.deepEqual(order, ["session-stop:RECOVERING", "session-stopped", "gradle--status", "gradle--stop", "gradle--status"]);
});

test("terminal shutdown reports the original Gradle stop error after stopping the index owner", { timeout: 5000 }, async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-gradle-stop-error-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = new Error("injected terminal Gradle stop error");
  const owner = new FakeOwner();
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  let closing = false;
  const domain = new GradleDomain(home, [{ version: "9.3.1", launcher: "/private/gradle/bin/gradle",
    launcherSha256: "a".repeat(64), javaHome: "/private/jdk" }], {
    alive: () => false,
    async execute(_dist, args) {
      if (closing && args[0] === "--stop") throw original;
      return "No Gradle daemons are running.\n";
    }
  });
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: owner.source(), gradleDomain: domain,
    idleTtlMs: 100000, pressureIntervalMs: 0 }, resolved => fakeContext(resolved, sessions),
    undefined, new NoopCrossProcessLeaseStore());
  await manager.initialize();
  await cleanupSettled(domain);
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  closing = true;
  await assert.rejects(manager.shutdownAll({ terminal: true }), error => error === original);
  assert.equal(owner.stops, 1);
  assert.equal(sessions.get("/repo-a")?.stops, 1);
});

test("a blocked Gradle cleanup is retried only on semantic demand and not sooner than the retry floor", async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-gradle-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let statusCalls = 0;
  const io: GradleCleanupIO = { alive: () => false, async execute(_dist, args) {
    if (args[0] === "--status") statusCalls += 1;
    if (args[0] === "--stop") throw new Error("injected stop failure");
    return "No Gradle daemons are running.\n";
  } };
  const domain = new GradleDomain(home, [{ version: "9.3.1", launcher: "/private/gradle/bin/gradle", launcherSha256: "a".repeat(64), javaHome: "/private/jdk" }], io);
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), { index: false, gradleDomain: domain, semanticRetryMs: 300, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  await manager.initialize();
  await cleanupSettled(domain);
  assert.deepEqual(manager.semanticStatus(), { staticAdmission: "CLOSED", semanticState: "RECOVERY_BLOCKED", failure: "injected stop failure" });
  await delay(5);
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {}, {});
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {}, { mayStartLsp: true });
  await delay(20);
  assert.equal(statusCalls, 1, "neither a static request nor a semantic one inside the floor retries");
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
  await delay(300);
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {}, {});
  assert.equal(statusCalls, 1, "a static request never retries");
  await manager.withContext({ repoRoot: "/repo-a" }, async () => {}, { mayStartLsp: true });
  await cleanupSettled(domain);
  assert.equal(statusCalls, 2, "the first semantic request after the floor retried once");
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
    { index: false, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    undefined,
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
    { index: false, idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000 },
    resolved => fakeContext(resolved, sessions),
    undefined,
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

type FakeWorkspace = { workspaceId: string; canonicalRoot: string; viewState: () => "STALE" };

class FakeOwner {
  opens = 0;
  workspaceCalls = 0;
  stops = 0;
  readonly retired: string[] = [];
  readonly workspaces = new Map<string, FakeWorkspace>();
  readonly bindings = new Map<string, unknown>();
  private readonly listeners = new Set<(event: PublishEvent) => void>();
  readonly store = { binding: (workspaceId: string) => this.bindings.get(workspaceId) };

  source(): IndexOwnerSource {
    return async () => { this.opens += 1; return this as never; };
  }
  onPublished(listener: (event: PublishEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async workspace(canonicalRoot: string): Promise<FakeWorkspace> {
    this.workspaceCalls += 1;
    let workspace = this.workspaces.get(canonicalRoot);
    if (!workspace) {
      workspace = { workspaceId: `ws${canonicalRoot.replace(/\W/g, "")}`, canonicalRoot, viewState: () => "STALE" as const };
      this.workspaces.set(canonicalRoot, workspace);
    }
    return workspace;
  }
  peek(canonicalRoot: string): FakeWorkspace | undefined { return this.workspaces.get(canonicalRoot); }
  acquireBound(): undefined { return undefined; }
  async retire(canonicalRoot: string): Promise<void> {
    this.retired.push(canonicalRoot);
    this.workspaces.delete(canonicalRoot);
  }
  async stop(): Promise<void> { this.stops += 1; }
  publish(event: PublishEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function publishEvent(canonicalRoot: string, overrides: Partial<PublishEvent> = {}): PublishEvent {
  return {
    workspaceId: `ws${canonicalRoot.replace(/\W/g, "")}`,
    canonicalRoot,
    snapshotId: "snap-2",
    previousSnapshotId: "snap-1",
    indexedGeneration: 7,
    changed: [],
    deleted: [],
    buildKeyChanged: false,
    ...overrides
  };
}

test("status without start on an unknown repo opens no owner, creates no runtime and starts nothing", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  const state = await manager.statusOnly({ repoRoot: "/repo-a" }, async value => value);
  assert.equal(state.labels.state, "NOT_READY");
  assert.equal(state.context, undefined);
  assert.equal(manager.hasRuntime("/repo-a"), false, "status-only never creates a runtime entry");
  assert.equal(sessions.size, 0, "no JDT session object exists");
  assert.equal(owner.opens, 0, "the index owner is not opened by status-only");
  assert.equal(owner.workspaceCalls, 0, "no workspace tracker or build is started");
  await manager.shutdownAll();
});

test("status without start on a known repo reads memory only and never starts its workspace", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  owner.bindings.set("wsrepob", { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot: "/repo-b" });
  assert.equal(owner.opens, 1);
  owner.workspaces.delete("/repo-b");
  const before = owner.workspaceCalls;
  const state = await manager.statusOnly({ repoRoot: "/repo-b" }, async value => value);
  assert.equal(state.labels.state, "NOT_READY", "a repo whose workspace is not running is NOT_READY");
  assert.ok(state.context, "the existing runtime is reported");
  assert.equal(owner.workspaceCalls, before, "status-only did not start the workspace");
  assert.equal(sessions.get("/repo-b")?.ensureStartedCalls, 0);
  await manager.shutdownAll();
});

test("status without start on a running repo stamps no cache: no meta I/O and no git spawn", async t => {
  const base = mkdtempSync(path.join(tmpdir(), "runtime-status-"));
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-status-repo-")));
  const previousBase = process.env.JAVA_LSP_CACHE_BASE;
  process.env.JAVA_LSP_CACHE_BASE = base;
  t.after(() => {
    if (previousBase === undefined) delete process.env.JAVA_LSP_CACHE_BASE; else process.env.JAVA_LSP_CACHE_BASE = previousBase;
    rmSync(base, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  owner.bindings.set(`ws${repoRoot.replace(/\W/g, "")}`, { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot });
  const meta = path.join(repoCacheRoot(repoRoot), "repo-meta.json");
  assert.equal(existsSync(meta), true, "the prewarm request stamped the cache");
  rmSync(meta);
  // Past the stamp interval: a request would stamp again, status must not.
  t.mock.timers.tick(61_000);
  const state = await manager.statusOnly({ repoRoot }, async value => value);
  assert.equal(state.labels.state, "STALE", "status read the running workspace's labels");
  assert.equal(existsSync(meta), false, "status-only wrote no cache meta (and ran no git for it)");
  await manager.contextFor({ repoRoot });
  assert.equal(existsSync(meta), true, "a request after the interval stamps, so the clock did move");
  await manager.shutdownAll();
});

test("prewarmRepo waits for the repo's own verified binding and does not start JDT", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  let returned = false;
  const done = manager.prewarmRepo({ repoRoot: "/repo-a" }).then(() => { returned = true; });
  await waitFor(() => owner.workspaceCalls === 1);
  await delay(300);
  assert.equal(returned, false, "no binding yet: prewarm is still waiting");
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  await done;
  assert.equal(sessions.get("/repo-a")?.ensureStartedCalls, 0);
  await manager.shutdownAll();
});

test("freemem pressure does not retire a pin while its prewarm is waiting", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({ pressureIntervalMs: 15, freememPressureBytes: 1, freemem: () => 0 }, sessions, {}, owner.source());
  const done = manager.prewarmRepo({ repoRoot: "/repo-a" });
  await waitFor(() => owner.workspaceCalls === 1);
  await delay(80);
  assert.equal(manager.retainedRepoRoots().has("/repo-a"), true, "an in-flight prewarm is not a pressure victim");
  assert.deepEqual(owner.retired, []);
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  await done;
  await manager.shutdownAll();
});

test("a publish reaches the JDT session as one change batch at a newer generation", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  const session = sessions.get("/repo-a")!;
  const before = session.boundClock!.snapshot().value;
  owner.publish(publishEvent("/repo-a", { changed: ["src/main/java/demo/A.java", "src/main/resources/M.xml"], deleted: ["src/main/java/demo/B.java"] }));
  await waitFor(() => session.repoChangeBatches.length === 1);
  const batch = session.repoChangeBatches[0]!;
  assert.ok(batch.generation > before && batch.generation >= 7, "the batch carries the publish's generation or later");
  assert.deepEqual(batch.changes.map(change => [change.kind, change.absolutePath, change.event]), [
    ["JAVA_CHANGE", "/repo-a/src/main/java/demo/A.java", "change"],
    ["RESOURCE_CHANGE", "/repo-a/src/main/resources/M.xml", "change"],
    ["JAVA_DELETE", "/repo-a/src/main/java/demo/B.java", "delete"]
  ]);
  const router = (await manager.contextFor({ repoRoot: "/repo-a" })).router as unknown as { invalidated: number[] };
  assert.deepEqual(router.invalidated, [batch.generation], "the NOT_READY router drops results older than the publish");
  owner.publish(publishEvent("/repo-other"));
  await delay(20);
  assert.equal(session.repoChangeBatches.length, 1, "another workspace's publish is not this session's batch");
  await manager.shutdownAll();
});

test("a failing JDT batch does not escape the publish listener", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  const session = sessions.get("/repo-a")!;
  session.repoChangeError = new Error("jdt rejected batch");
  owner.publish(publishEvent("/repo-a", { changed: ["src/main/java/demo/A.java"] }));
  owner.publish(publishEvent("/repo-a", { indexedGeneration: 8, changed: ["src/main/java/demo/A.java"] }));
  await waitFor(() => session.repoChangeBatches.length === 2);
  assert.ok(session.repoChangeBatches[1]!.generation > session.repoChangeBatches[0]!.generation, "generations stay monotonic");
  await manager.shutdownAll();
});

test("changeBatchFor maps build files and a build-key change to BUILD_CHANGE and a large publish to one storm", () => {
  const pom = changeBatchFor(publishEvent("/r", { changed: ["module/pom.xml"] }), 3);
  assert.deepEqual(pom.changes.map(change => change.kind), ["BUILD_CHANGE"]);
  const keyOnly = changeBatchFor(publishEvent("/r", { changed: ["src/main/java/A.java"], buildKeyChanged: true }), 4);
  assert.equal(keyOnly.changes.filter(change => change.kind === "BUILD_CHANGE").length > 0, true, "a build-key change always reaches JDT as BUILD_CHANGE");
  const many = Array.from({ length: 500 }, (_, index) => `src/main/java/p/C${index}.java`);
  const storm = changeBatchFor(publishEvent("/r", { changed: many }), 5);
  assert.equal(storm.storm, true, "a 500-file publish is delivered as one storm batch");
  assert.equal(storm.changes.length, 500);
  assert.ok(storm.affectedRoots.length > 0 && storm.affectedRoots.length <= 16, "affectedRoots is bounded and non-empty");
  assert.equal(changeBatchFor(publishEvent("/r", { changed: ["src/main/java/A.java"] }), 6).storm, false);
});

test("shutdown retires the repo's workspace in the owner and shutdownAll stops the owner last", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = managerWith({}, sessions, {}, owner.source());
  owner.bindings.set("wsrepoa", { snapshotId: "snap-1" });
  owner.bindings.set("wsrepob", { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot: "/repo-a" });
  await manager.prewarmRepo({ repoRoot: "/repo-b" });
  await manager.shutdown("/repo-a");
  assert.deepEqual(owner.retired, ["/repo-a"]);
  assert.equal(owner.stops, 0);
  await manager.shutdownAll();
  assert.equal(owner.stops, 1);
  assert.equal(sessions.get("/repo-b")?.stops, 1, "sessions stop before the owner");
});

test("idle TTL retires an unprotected runtime and its workspace but keeps a protected pin", async () => {
  const sessions = new Map<string, FakeSession>();
  const owner = new FakeOwner();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    idleTtlMs: 40, pressureIntervalMs: 0, requestTimeoutMs: 1000, index: owner.source(),
    isProtectedRepo: repoRoot => repoRoot === "/repo-pin"
  }, resolved => fakeContext(resolved, sessions), undefined, new NoopCrossProcessLeaseStore());
  owner.bindings.set("wsrepowt", { snapshotId: "snap-1" });
  owner.bindings.set("wsrepopin", { snapshotId: "snap-1" });
  await manager.prewarmRepo({ repoRoot: "/repo-wt" });
  await manager.prewarmRepo({ repoRoot: "/repo-pin" });
  await delay(150);
  assert.equal(manager.retainedRepoRoots().has("/repo-wt"), false);
  assert.deepEqual(owner.retired, ["/repo-wt"]);
  assert.equal(manager.retainedRepoRoots().has("/repo-pin"), true, "a pin keeps its index runtime after idle");
  await manager.shutdownAll();
});

test("an owner that fails to open leaves requests NOT_READY instead of failing them", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = managerWith({}, sessions, {}, async () => { throw new Error("owner lock missing"); });
  const request = await manager.withContext({ repoRoot: "/repo-a" }, async (_context, value) => value);
  assert.equal(request.freshnessMode, "WATCHER_NOT_READY");
  assert.equal(request.negativeLookupAllowed, false);
  assert.equal(request.cacheReadAllowed, false);
  const status = await manager.indexStatus();
  assert.ok(status && "unavailable" in status && /owner lock missing/.test(status.unavailable));
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
  reaps = 0;
  liveChild = false;
  reapGate?: Deferred<void>;
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

  hasLiveChildren(): boolean { return this.liveChild; }

  async reapAbandonedChildren(): Promise<void> {
    this.reaps += 1;
    if (this.reapGate) await this.reapGate.promise;
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
    requestTimeoutMs: number;
    maxRetainedStoppedRepos: number;
    pressureIntervalMs: number;
    freememPressureBytes: number;
    freemem: () => number;
  }>,
  sessions: Map<string, FakeSession>,
  gates: Record<string, Deferred<void>> = {},
  index: IndexOwnerSource = false
): RepoRuntimeManager {
  return new RepoRuntimeManager(
    fakeResolver(),
    { idleTtlMs: 100000, pressureIntervalMs: 0, requestTimeoutMs: 5000, index, ...options },
    resolved => fakeContext(resolved, sessions, gates),
    undefined,
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
  const invalidated: number[] = [];
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    worktree: resolved.worktree,
    session: session as never,
    router: {
      invalidated,
      clearRgCache() {},
      onRepoChanged() {},
      invalidateGeneration(generation: number) { invalidated.push(generation); },
      async flushSemanticEdgeStore() {},
      dispose() {}
    } as never,
    javaIndex: {} as never
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
