import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RepoRuntimeManager, type ManagedToolContext } from "./repo-runtime-manager.js";
import type { ResolvedRepo } from "./repo-resolver.js";
import type { RepoOwnershipLease, RepoOwnershipProvider } from "./repo-ownership-lease.js";

test("RepoRuntimeManager evicts the oldest idle started runtime before starting another", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 100
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  await manager.withContext({ repoRoot: "/repo-b" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  assert.equal(sessions.get("/repo-a")?.stops, 1);
  assert.equal(sessions.get("/repo-b")?.stops, 0);
});

test("RepoRuntimeManager fails fast when all active runtimes are in use", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 30
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const firstEntered = new Promise<void>(resolve => {
    entered = resolve;
  });

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
    entered();
    await held;
  }, { mayStartLsp: true });
  await firstEntered;

  await assert.rejects(
    () => manager.withContext({ repoRoot: "/repo-b" }, async context => {
      (context.session as unknown as FakeSession).started = true;
    }, { mayStartLsp: true }),
    /active limit is 1/
  );

  release();
  await first;
});

test("RepoRuntimeManager counts STARTING reservations before asynchronous JDT startup", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
  let secondEntered = false;

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    firstEntered();
    await firstGate;
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });
  await firstEnteredPromise;
  const second = manager.withContext({ repoRoot: "/repo-b" }, async context => {
    secondEntered = true;
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  await delay(25);
  assert.equal(secondEntered, false, "a second root must not enter while the only slot is STARTING");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
  assert.equal(sessions.get("/repo-a")?.stops, 1, "the first READY runtime must be stopped before reusing its slot");
});

test("RepoRuntimeManager releases a failed STARTING reservation and wakes a waiter", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  let releaseFailure!: () => void;
  let firstEntered!: () => void;
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
  const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
  let secondEntered = false;

  const firstFailure = assert.rejects(
    manager.withContext({ repoRoot: "/repo-a" }, async () => {
      firstEntered();
      await failureGate;
      throw new Error("simulated JDT startup failure");
    }, { mayStartLsp: true }),
    /simulated JDT startup failure/
  );
  await firstEnteredPromise;
  const second = manager.withContext({ repoRoot: "/repo-b" }, async context => {
    secondEntered = true;
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  await delay(25);
  assert.equal(secondEntered, false);
  releaseFailure();
  await Promise.all([firstFailure, second]);
  assert.equal(secondEntered, true, "the failed reservation must wake the waiting root before its deadline");
});

test("RepoRuntimeManager reserves a victim only after its control gate closes the reacquire window", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);

  await manager.withQuery({ repoRoot: "/repo-b" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  const runtimeEntries = (manager as unknown as {
    runtimes: Map<string, { gate: { withControl: RuntimeGateControl } }>;
  }).runtimes;
  const victimGate = runtimeEntries.get("/repo-b")!.gate;
  const originalWithControl = victimGate.withControl.bind(victimGate);
  const controlRequested = deferred();
  const allowControlAdmission = deferred();
  victimGate.withControl = async <T>(operation: () => Promise<T>, deadlineMs: number): Promise<T> => {
    controlRequested.resolve();
    await allowControlAdmission.promise;
    return originalWithControl(operation, deadlineMs);
  };

  const nextRoot = manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });
  await controlRequested.promise;

  let victimQueryEntered = false;
  const victimQuery = manager.withQuery({ repoRoot: "/repo-b" }, async () => {
    victimQueryEntered = true;
  }, { mayStartLsp: true });
  await delay(20);
  assert.equal(victimQueryEntered, true,
    "a query admitted before victim control must still observe READY instead of a public STOPPING reservation");
  await victimQuery;

  allowControlAdmission.resolve();
  await nextRoot;
  assert.equal(sessions.get("/repo-b")?.stops, 1);
});

test("RepoRuntimeManager control waits for earlier queries, blocks later queries, and never waits for itself", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 2,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  const queryGate = deferred();
  const controlGate = deferred();
  const events: string[] = [];

  const earlierQuery = manager.withQuery({ repoRoot: "/repo-a" }, async () => {
    events.push("query-enter");
    await queryGate.promise;
    events.push("query-exit");
  });
  const control = manager.withControl({ repoRoot: "/repo-a" }, async () => {
    events.push("control-enter");
    const status = manager.activeRepos().find(repo => repo.repoRoot === "/repo-a");
    assert.equal(status?.refCount, 0, "control must not increment the drained query count");
    assert.equal(status?.controlActive, true);
    await controlGate.promise;
    events.push("control-exit");
  });
  const laterQuery = manager.withQuery({ repoRoot: "/repo-a" }, async () => {
    events.push("query-later");
  });

  await delay(20);
  assert.deepEqual(events, ["query-enter"]);
  queryGate.resolve();
  await earlierQuery;
  await delay(20);
  assert.deepEqual(events, ["query-enter", "query-exit", "control-enter"]);
  controlGate.resolve();
  await Promise.all([control, laterQuery]);
  assert.deepEqual(events, ["query-enter", "query-exit", "control-enter", "control-exit", "query-later"]);
});

test("RepoRuntimeManager reconciles READY capacity after a targeted control stops JDT", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);

  await manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });
  assert.equal(manager.activeRepos()[0]?.slotState, "READY");

  await manager.withControl({ repoRoot: "/repo-a" }, async context => {
    await (context.session as unknown as FakeSession).stop();
  });
  assert.equal(manager.activeRepos()[0]?.slotState, "NONE");
});

test("RepoRuntimeManager idle stop cannot interrupt a query that reacquired the entry", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 30,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  await manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  await delay(10);
  const queryGate = deferred();
  const query = manager.withQuery({ repoRoot: "/repo-a" }, async () => queryGate.promise);
  await delay(50);
  assert.equal(sessions.get("/repo-a")?.stops, 0, "reacquiring the query gate must cancel the prior idle timer");

  queryGate.resolve();
  await query;
  await delay(50);
  assert.equal(sessions.get("/repo-a")?.stops, 1, "idle stop may run only after the reacquired query exits");
});

test("RepoRuntimeManager holds ownership across JDT shutdown and releases it on application close", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {}, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);

  await manager.contextFor({ repoRoot: "/repo-a" });
  await manager.contextFor({ repoRoot: "/repo-a" });
  assert.equal(ownership.acquires, 1);

  await manager.shutdownAll();
  assert.equal(ownership.releases, 0, "public JDT shutdown must retain repository ownership");
  await manager.shutdownAll({ releaseOwnership: true });
  assert.equal(ownership.releases, 1);
});

test("RepoRuntimeManager releases ownership when runtime construction fails", async () => {
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {}, () => {
    throw new Error("runtime failed");
  }, ownership, noCacheTouch);

  await assert.rejects(() => manager.contextFor({ repoRoot: "/repo-a" }), /runtime failed/);
  assert.equal(ownership.acquires, 1);
  assert.equal(ownership.releases, 1);
});

test("RepoRuntimeManager waits for every shutdown and retains ownership for failed stops", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {}, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  await manager.contextFor({ repoRoot: "/repo-b" });
  sessions.get("/repo-a")!.failStop = true;

  await assert.rejects(
    () => manager.shutdownAll({ releaseOwnership: true }),
    /Failed to stop 1 repository runtime/
  );
  assert.equal(sessions.get("/repo-a")?.stops, 1);
  assert.equal(sessions.get("/repo-b")?.stops, 1);
  assert.equal(ownership.releases, 1, "only the safely stopped runtime may release ownership");
});

test("RepoRuntimeManager shutdown keeps NONE entries outside the active slot count", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  await manager.contextFor({ repoRoot: "/repo-b" });
  await manager.contextFor({ repoRoot: "/repo-c" });
  for (const session of sessions.values()) {
    session.onStop = () => {
      assert.equal(manager.activeRepos().filter(repo => repo.slotState !== "NONE").length, 0);
    };
  }

  await manager.shutdownAll();
  assert.deepEqual(manager.activeRepos().map(repo => repo.slotState), ["NONE", "NONE", "NONE"]);
});

test("RepoRuntimeManager evicts the least recently used inactive entry and recreates its context", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 1
  }, resolved => fakeContext(resolved, sessions, artifacts), ownership, noCacheTouch);

  await manager.contextFor({ repoRoot: "/repo-a" });
  await delay(2);
  await manager.contextFor({ repoRoot: "/repo-b" });
  await manager.evictInactiveEntries();

  assert.deepEqual(manager.activeRepos().map(repo => repo.repoRoot), ["/repo-b"]);
  assert.equal(artifacts.get("/repo-a")?.[0].session.stops, 1);
  assert.equal(artifacts.get("/repo-a")?.[0].router.disposes, 1);
  assert.equal(artifacts.get("/repo-a")?.[0].sourceIndex.disposes, 1);
  assert.equal(ownership.releases, 1);

  await manager.contextFor({ repoRoot: "/repo-a" });
  assert.equal(artifacts.get("/repo-a")?.length, 2, "the next access must create a fresh context/watcher owner");
  assert.equal(ownership.acquires, 3);
});

test("RepoRuntimeManager never evicts an entry while its query is active", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 1,
    maxRuntimeEntries: 1
  }, resolved => fakeContext(resolved, sessions, artifacts), undefined, noCacheTouch);
  const held = deferred();
  const entered = deferred();
  const active = manager.withQuery({ repoRoot: "/repo-a" }, async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  await manager.contextFor({ repoRoot: "/repo-b" });

  await manager.evictInactiveEntries(Date.now() + 1000);
  assert.ok(manager.activeRepos().some(repo => repo.repoRoot === "/repo-a"));
  assert.equal(artifacts.get("/repo-a")?.[0].sourceIndex.disposes, 0);

  held.resolve();
  await active;
});

test("RepoRuntimeManager detached background work retains the entry until completion", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 1,
    maxRuntimeEntries: 1
  }, resolved => fakeContext(resolved, sessions, artifacts), undefined, noCacheTouch);
  const releaseBackground = deferred();
  const backgroundEntered = deferred();
  const backgroundFinished = deferred();

  await manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    assert.equal(context.runBackgroundTask?.(async () => {
      backgroundEntered.resolve();
      await releaseBackground.promise;
      backgroundFinished.resolve();
    }), true);
  });
  await backgroundEntered.promise;
  await manager.contextFor({ repoRoot: "/repo-b" });
  await manager.evictInactiveEntries(Date.now() + 1000);

  assert.ok(manager.activeRepos().some(repo => repo.repoRoot === "/repo-a"));
  assert.equal(artifacts.get("/repo-a")?.[0].sourceIndex.disposes, 0);
  releaseBackground.resolve();
  await backgroundFinished.promise;
});

test("RepoRuntimeManager retries a persistent eviction failure with backoff", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10,
    entryEvictionRetryBaseMs: 50
  }, resolved => fakeContext(resolved, sessions), undefined, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  sessions.get("/repo-a")!.failStop = true;

  await assert.rejects(() => manager.evictInactiveEntries(Date.now() + 200000), /stop failed/);
  const entry = (manager as unknown as { runtimes: Map<string, { nextEvictionAttemptAt: number }> })
    .runtimes.get("/repo-a")!;
  assert.ok(entry.nextEvictionAttemptAt >= Date.now() + 30);
  assert.equal(await manager.evictInactiveEntries(), 0);
  assert.equal(sessions.get("/repo-a")?.stops, 1, "backoff must prevent a zero-delay retry loop");
});

test("RepoRuntimeManager automatically retries eviction after backoff expires", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 1,
    maxRuntimeEntries: 10,
    entryEvictionRetryBaseMs: 20
  }, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  sessions.get("/repo-a")!.failStop = true;
  await assert.rejects(() => manager.evictInactiveEntries(Date.now() + 1000), /stop failed/);
  sessions.get("/repo-a")!.failStop = false;

  await delay(80);
  assert.equal(sessions.get("/repo-a")?.stops, 2);
  assert.equal(ownership.releases, 1);
  assert.equal(manager.activeRepos().length, 0);
});

test("RepoRuntimeManager keeps the entry fail-closed when ownership release fails", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  ownership.failRelease = true;
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10,
    entryEvictionRetryBaseMs: 50
  }, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });

  await assert.rejects(() => manager.evictInactiveEntries(Date.now() + 200000), /release failed/);
  assert.equal(manager.activeRepos()[0]?.entryState, "EVICTING");
  assert.equal(ownership.releases, 0);
  let handlerEntered = false;
  await assert.rejects(
    () => manager.withQuery({ repoRoot: "/repo-a" }, async () => { handlerEntered = true; }),
    /eviction did not complete safely/
  );
  assert.equal(handlerEntered, false);
  await assert.rejects(
    () => manager.shutdownAll({ releaseOwnership: true, terminal: true }),
    /Failed to stop 1 repository runtime/
  );
  assert.equal(manager.activeRepos()[0]?.entryState, "EVICTING",
    "terminal close must retain the entry and ownership identity when release is uncertain");
});

test("RepoRuntimeManager makes a query queued behind EVICTING retry on a fresh entry", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions, artifacts), new FakeOwnership(), noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  const stopEntered = deferred();
  const releaseStop = deferred();
  artifacts.get("/repo-a")![0].session.stopEntered = stopEntered;
  artifacts.get("/repo-a")![0].session.stopGate = releaseStop;

  const eviction = manager.evictInactiveEntries(Date.now() + 200000);
  await stopEntered.promise;
  let usedSession: FakeSession | undefined;
  const query = manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    usedSession = context.session as unknown as FakeSession;
  });
  releaseStop.resolve();
  await Promise.all([eviction, query]);

  assert.equal(artifacts.get("/repo-a")?.length, 2);
  assert.equal(usedSession, artifacts.get("/repo-a")?.[1].session);
});

test("RepoRuntimeManager terminal shutdown waits for an in-flight sweep before returning", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions, artifacts), ownership, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  const stopEntered = deferred();
  const releaseStop = deferred();
  artifacts.get("/repo-a")![0].session.stopEntered = stopEntered;
  artifacts.get("/repo-a")![0].session.stopGate = releaseStop;

  const sweep = manager.evictInactiveEntries(Date.now() + 200000);
  await stopEntered.promise;
  let shutdownReturned = false;
  const shutdown = manager.shutdownAll({ releaseOwnership: true, terminal: true }).then(() => {
    shutdownReturned = true;
  });
  await delay(10);
  assert.equal(shutdownReturned, false);
  releaseStop.resolve();
  await Promise.all([sweep, shutdown]);
  assert.equal(ownership.releases, 1);
  assert.equal(manager.activeRepos().length, 0);
});

test("RepoRuntimeManager drain-timeout terminal shutdown retains ownership from an in-flight sweep", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions, artifacts), ownership, noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  const stopEntered = deferred();
  const releaseStop = deferred();
  artifacts.get("/repo-a")![0].session.stopEntered = stopEntered;
  artifacts.get("/repo-a")![0].session.stopGate = releaseStop;

  const sweep = manager.evictInactiveEntries(Date.now() + 200000);
  await stopEntered.promise;
  const shutdown = manager.shutdownAll({ releaseOwnership: false, terminal: true });
  releaseStop.resolve();
  await Promise.all([sweep, shutdown]);

  assert.equal(ownership.releases, 0);
  assert.equal(manager.activeRepos()[0]?.entryState, "EVICTING");
});

test("RepoRuntimeManager blocks a new sweep once terminal shutdown has started", async () => {
  const sessions = new Map<string, FakeSession>();
  const artifacts = new Map<string, FakeRuntimeArtifacts[]>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions, artifacts), new FakeOwnership(), noCacheTouch);
  await manager.contextFor({ repoRoot: "/repo-a" });
  const stopEntered = deferred();
  const releaseStop = deferred();
  artifacts.get("/repo-a")![0].session.stopEntered = stopEntered;
  artifacts.get("/repo-a")![0].session.stopGate = releaseStop;

  const shutdown = manager.shutdownAll({ releaseOwnership: true, terminal: true });
  await stopEntered.promise;
  const sweep = manager.evictInactiveEntries(Date.now() + 200000);
  releaseStop.resolve();
  await shutdown;
  assert.equal(await sweep, 0);
  assert.equal(manager.activeRepos().length, 0);
});

test("RepoRuntimeManager automatically evicts an inactive entry after its TTL", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 1000,
    runtimeEntryTtlMs: 20,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);

  await manager.contextFor({ repoRoot: "/repo-a" });
  await delay(60);
  assert.equal(manager.activeRepos().length, 0);
  assert.equal(ownership.releases, 1);
});

test("RepoRuntimeManager forced shutdown bypasses a stuck query, kills owned JDT, and retains ownership", async () => {
  const sessions = new Map<string, FakeSession>();
  const ownership = new FakeOwnership();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 100000,
    runtimeEntryTtlMs: 100000,
    maxRuntimeEntries: 10
  }, resolved => fakeContext(resolved, sessions), ownership, noCacheTouch);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });

  const query = manager.withQuery({ repoRoot: "/repo-a" }, async context => {
    const session = context.session as unknown as FakeSession;
    session.started = true;
    entered();
    await held;
  });
  await enteredPromise;

  await manager.forceTerminateOwnedJdtls(50);
  assert.equal(sessions.get("/repo-a")?.forceStops, 1);
  assert.equal(sessions.get("/repo-a")?.started, false);
  assert.equal(ownership.releases, 0, "forced shutdown must retain ownership until Node exits");

  release();
  await query;
});

class FakeSession {
  started = false;
  stops = 0;
  forceStops = 0;
  failStop = false;
  onStop?: () => void;
  stopEntered?: ReturnType<typeof deferred>;
  stopGate?: ReturnType<typeof deferred>;

  status(): { started: boolean } {
    return { started: this.started };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.onStop?.();
    this.stopEntered?.resolve();
    await this.stopGate?.promise;
    if (this.failStop) {
      throw new Error("stop failed");
    }
    this.started = false;
  }

  async forceStop(): Promise<void> {
    this.forceStops += 1;
    this.started = false;
  }
}

type RuntimeGateControl = <T>(operation: () => Promise<T>, deadlineMs: number) => Promise<T>;

class FakeSourceIndex {
  disposes = 0;

  isBusy(): boolean {
    return false;
  }

  dispose(): void {
    this.disposes += 1;
  }
}

class FakeRouter {
  clears = 0;
  disposes = 0;

  clearRgCache(): void {
    this.clears += 1;
  }

  dispose(): void {
    this.disposes += 1;
    this.clearRgCache();
  }
}

type FakeRuntimeArtifacts = {
  session: FakeSession;
  sourceIndex: FakeSourceIndex;
  router: FakeRouter;
};

function noCacheTouch(): void {}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeResolver(): { resolve(selector: { repoRoot?: string }): Promise<ResolvedRepo> } {
  return {
    async resolve(selector) {
      const repoRoot = selector.repoRoot || "/repo";
      return {
        repoRoot,
        repoHash: repoRoot.replace(/\W/g, ""),
        rootSource: "explicit",
        aliases: [],
        layoutProfile: "generic-java",
        lsp: {
          enabled: true,
          matchedBy: "direct-root",
          configuredRoot: repoRoot,
          effectiveRepoRoot: repoRoot
        }
      };
    }
  };
}

function fakeContext(
  resolved: ResolvedRepo,
  sessions: Map<string, FakeSession>,
  artifacts?: Map<string, FakeRuntimeArtifacts[]>
): ManagedToolContext {
  const session = new FakeSession();
  const sourceIndex = new FakeSourceIndex();
  const router = new FakeRouter();
  sessions.set(resolved.repoRoot, session);
  const repoArtifacts = artifacts?.get(resolved.repoRoot) || [];
  repoArtifacts.push({ session, sourceIndex, router });
  artifacts?.set(resolved.repoRoot, repoArtifacts);
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    session: session as never,
    sourceIndex: sourceIndex as never,
    router: router as never
  };
}

class FakeOwnership implements RepoOwnershipProvider {
  acquires = 0;
  releases = 0;
  failRelease = false;

  acquire(repoRoot: string): RepoOwnershipLease {
    this.acquires += 1;
    let released = false;
    return {
      lockPath: `/locks/${repoRoot}`,
      metadata: {
        schemaVersion: 1,
        repoRoot,
        ownerToken: "test",
        pid: process.pid,
        processStartIdentity: "test",
        transport: "stdio",
        buildSha: "test",
        acquiredAt: new Date(0).toISOString()
      },
      release: () => {
        if (this.failRelease) {
          throw new Error("release failed");
        }
        if (!released) {
          released = true;
          this.releases += 1;
        }
      }
    };
  }
}
