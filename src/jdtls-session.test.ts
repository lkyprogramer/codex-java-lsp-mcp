import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JdtlsSession, filterGeneratedCodeDiagnostics } from "./jdtls-session.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import {
  deferred,
  delay,
  fakeTransportFactory,
  sequenceTransportFactory,
  type FakeJdtlsTransportFactory
} from "./test-support/fake-jdtls.js";
import type { GeneratedCodeStatus } from "./generated-code.js";
import type { LspDiagnostic } from "./jdtls-session.js";
import type {
  CompositeJdtLease,
  CrossProcessLeaseStore,
  CrossProcessLeaseStatus,
  JdtLeaseAcquireResult,
  LeaseHandle,
  LeaseOwner
} from "./cross-process-lease.js";

const lombokStatus: GeneratedCodeStatus = {
  lombok: {
    detected: true,
    agentEnabled: true,
    status: "enabled"
  },
  annotationProcessing: {
    detectedProcessors: ["lombok"],
    enabled: true,
    source: "auto"
  },
  generatedCodeSemantics: "ok"
};

test("filters only Lombok generated log unresolved diagnostics", () => {
  const source = [
    "package demo;",
    "",
    "import lombok.extern.slf4j.Slf4j;",
    "",
    "@Slf4j",
    "class Demo {",
    "  void run(User user) {",
    "    log.info(\"{}\", user.missing());",
    "  }",
    "}"
  ].join("\n");
  const diagnostics: LspDiagnostic[] = [
    diagnosticAt(8, 5, 8, "log cannot be resolved to a variable"),
    diagnosticAt(8, 20, 24, "The method missing() is undefined for the type User")
  ];

  const filtered = filterGeneratedCodeDiagnostics({ generatedCode: lombokStatus, source, diagnostics });

  assert.deepEqual(filtered.map(diagnostic => diagnostic.message), ["The method missing() is undefined for the type User"]);
});

function diagnosticAt(line: number, start: number, end: number, message: string): LspDiagnostic {
  return {
    range: {
      start: { line: line - 1, character: start - 1 },
      end: { line: line - 1, character: end - 1 }
    },
    severity: 1,
    code: "compiler.err.cant.resolve",
    source: "Java",
    message
  };
}

// --- lifecycle ------------------------------------------------------------

type Harness = {
  session: JdtlsSession;
  factory: FakeJdtlsTransportFactory;
  advance(ms: number): void;
};

function harness(
  factory: FakeJdtlsTransportFactory,
  options: { readyStabilityMs?: number; leaseStore?: CrossProcessLeaseStore } = {}
): Harness {
  const scratch = mkdtempSync(path.join(tmpdir(), "jdtls-session-"));
  const repoRoot = path.join(scratch, "repo");
  const javaHome = path.join(scratch, "jdk-21");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(javaHome, { recursive: true });

  const previous = {
    bin: process.env.JDTLS_BIN,
    dataDir: process.env.JDTLS_DATA_DIR,
    logDir: process.env.JDTLS_LOG_DIR,
    javaHome: process.env.JAVA_LSP_PROJECT_JAVA_HOME,
    stability: process.env.JDTLS_READY_STABILITY_MS,
    watch: process.env.JAVA_LSP_FILE_WATCH
  };
  process.env.JDTLS_BIN = path.join(scratch, "fake-jdtls");
  process.env.JDTLS_DATA_DIR = path.join(scratch, "workspace");
  process.env.JDTLS_LOG_DIR = path.join(scratch, "logs");
  process.env.JAVA_LSP_PROJECT_JAVA_HOME = javaHome;
  process.env.JAVA_LSP_FILE_WATCH = "0";
  if (options.readyStabilityMs !== undefined) {
    process.env.JDTLS_READY_STABILITY_MS = String(options.readyStabilityMs);
  }

  let now = 1_000_000;
  const session = new JdtlsSession(repoRoot, [], factory, () => now, options.leaseStore);

  for (const [key, value] of Object.entries({
    JDTLS_BIN: previous.bin,
    JDTLS_DATA_DIR: previous.dataDir,
    JDTLS_LOG_DIR: previous.logDir,
    JAVA_LSP_PROJECT_JAVA_HOME: previous.javaHome,
    JDTLS_READY_STABILITY_MS: previous.stability,
    JAVA_LSP_FILE_WATCH: previous.watch
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return { session, factory, advance: ms => { now += ms; } };
}

async function waitForSpawn(factory: FakeJdtlsTransportFactory, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && factory.spawnCalls < count; attempt += 1) {
    await delay(5);
  }
  assert.equal(factory.spawnCalls >= count, true, `expected at least ${count} spawn(s), saw ${factory.spawnCalls}`);
}

/** A single-slot lease store test double: acquireJdt either always succeeds
 * (recording whatever pid is given) or always rejects with a fixed result. */
class FakeLeaseStore implements CrossProcessLeaseStore {
  acquireCalls = 0;
  released: string[] = [];
  recordedPids: number[] = [];
  recordSucceeds = true;
  rejection?: Exclude<JdtLeaseAcquireResult, { kind: "ACQUIRED" }>;

  async open(): Promise<void> {}

  async acquireRuntime(): Promise<LeaseHandle> {
    throw new Error("not used by these tests");
  }

  async tryAcquireJdt(): Promise<JdtLeaseAcquireResult> {
    return this.acquireJdt();
  }

  async acquireJdt(): Promise<JdtLeaseAcquireResult> {
    this.acquireCalls += 1;
    if (this.rejection) return this.rejection;
    const worktree = this.handle("JDT_WORKTREE");
    const slot = this.handle("JDT_SLOT");
    const lease: CompositeJdtLease = {
      worktree,
      slot,
      heartbeat: async () => {},
      release: async () => {
        await worktree.release();
        await slot.release();
      },
      recordJdtlsPid: async (pid: number) => {
        this.recordedPids.push(pid);
        return this.recordSucceeds;
      }
    };
    return { kind: "ACQUIRED", lease };
  }

  async acquireSweep(): Promise<LeaseHandle> {
    throw new Error("not used by these tests");
  }

  async activeRuntimeCount(): Promise<number> {
    return 0;
  }

  async status(): Promise<CrossProcessLeaseStatus> {
    throw new Error("not used by these tests");
  }

  private handle(kind: LeaseHandle["kind"]): LeaseHandle {
    const owner: LeaseOwner = { ownerToken: kind, pid: 1, repoRoot: "", repoHash: "", acquiredAt: "", heartbeatAt: "" };
    return {
      kind,
      path: kind,
      owner,
      heartbeat: async () => {},
      release: async () => { this.released.push(kind); }
    };
  }
}

test("a lease metadata-update failure after spawn kills the child and never reaches READY", async () => {
  const factory = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  const leaseStore = new FakeLeaseStore();
  leaseStore.recordSucceeds = false;
  const { session } = harness(factory, { leaseStore });

  await assert.rejects(
    () => session.ensureStarted(DeadlineBudget.fromTimeout(5000)),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "LEASE_CONFIG_ERROR"
  );
  assert.equal(session.status().state, "BROKEN");
  assert.equal(session.status().started, false);
  assert.equal(factory.children[0].killCalls > 0, true, "the spawned child was terminated");
  assert.deepEqual(leaseStore.released.sort(), ["JDT_SLOT", "JDT_WORKTREE"], "both lease directories are released");
  assert.equal(session.status().restartBackoff.consecutiveFailures, 0, "a lease failure never pollutes JDT restart backoff");
  await session.stop();
});

test("a rejected lease acquisition fails fast without spawning and does not gate future retries", async () => {
  const factory = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  const leaseStore = new FakeLeaseStore();
  leaseStore.rejection = { kind: "BUSY_SAME_WORKTREE" };
  const { session } = harness(factory, { leaseStore });

  await assert.rejects(
    () => session.ensureStarted(DeadlineBudget.fromTimeout(5000)),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_BUSY_OTHER_SESSION"
  );
  assert.equal(factory.spawnCalls, 0, "no child is spawned when the lease is rejected");
  assert.equal(session.status().restartBackoff.consecutiveFailures, 0);

  // The next attempt is not blocked by backoff: another lease attempt is made.
  leaseStore.rejection = undefined;
  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  assert.equal(session.status().state, "READY");
  assert.equal(leaseStore.acquireCalls, 2);
  await session.stop();
});

test("a successful start records the spawned jdtls pid on the lease", async () => {
  const factory = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  const leaseStore = new FakeLeaseStore();
  const { session } = harness(factory, { leaseStore });

  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  assert.equal(session.status().state, "READY");
  assert.deepEqual(leaseStore.recordedPids, [factory.children[0].pid]);
  await session.stop();
  assert.deepEqual(leaseStore.released.sort(), ["JDT_SLOT", "JDT_WORKTREE"], "stop() releases the lease");
});

test("concurrent ensureStarted shares one transactional start", async () => {
  const initialize = deferred<unknown>();
  const { session, factory } = harness(fakeTransportFactory({ initialize }));
  const budget = DeadlineBudget.fromTimeout(5000);

  const first = session.ensureStarted(budget);
  const second = session.ensureStarted(budget);

  assert.equal(session.status().state, "STARTING");
  assert.equal(session.status().started, false);
  await waitForSpawn(factory, 1);
  assert.equal(factory.spawnCalls, 1);
  assert.equal(session.status().state, "STARTING");
  assert.equal(session.status().started, false);

  initialize.resolve({ capabilities: {} });
  await Promise.all([first, second]);

  assert.equal(session.status().state, "READY");
  assert.equal(session.status().started, true);
  assert.equal(factory.spawnCalls, 1);
  await session.stop();
});

test("a short caller deadline does not cancel a shared JDT startup", async () => {
  const initialize = deferred<unknown>();
  const { session, factory } = harness(fakeTransportFactory({ initialize }));

  const short = session.ensureStarted(DeadlineBudget.fromTimeout(10));
  const long = session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(session.status().state, "STARTING");
  await waitForSpawn(factory, 1);
  assert.equal(factory.children[0].killCalls, 0);

  initialize.resolve({ capabilities: {} });
  await long;
  assert.equal(session.status().state, "READY");
  assert.equal(factory.spawnCalls, 1);
  await session.stop();
});

test("failed initialize disposes the attempt and permits a clean retry", async () => {
  const factory = sequenceTransportFactory([
    { initializeError: new Error("boom") },
    { initializeResult: { capabilities: {} } }
  ]);
  const { session } = harness(factory);

  await assert.rejects(() => session.ensureStarted(DeadlineBudget.fromTimeout(5000)), /boom/);
  assert.equal(session.status().state, "BROKEN");
  assert.equal(session.status().started, false);
  assert.equal(factory.children[0].killCalls > 0, true);
  assert.equal(factory.connections[0].disposed, true);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 1);

  // A retryable failure gates the next start until the backoff window elapses.
  await assert.rejects(
    () => session.ensureStarted(DeadlineBudget.fromTimeout(5000)),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_BACKOFF"
  );
  assert.equal(factory.spawnCalls, 1);

  await session.restart(false);
  assert.equal(session.status().state, "READY");
  assert.equal(factory.spawnCalls, 2);
  await session.stop();
});

test("a missing jdtls binary blocks restarts until an explicit reset", async () => {
  const factory = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  const { session } = harness(factory);
  const previous = process.env.JDTLS_BIN;
  delete process.env.JDTLS_BIN;
  try {
    const bare = new JdtlsSession(path.join(tmpdir(), "no-such-repo"), [], factory);
    // Only assert the classification when jdtls is genuinely absent from PATH.
    if (bare.status().jdtlsBin === "") {
      await assert.rejects(
        () => bare.ensureStarted(DeadlineBudget.fromTimeout(1000)),
        (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_CONFIG_ERROR"
      );
      assert.equal(bare.status().restartBackoff.blockedUntilExplicitReset, true);
      await assert.rejects(
        () => bare.ensureStarted(DeadlineBudget.fromTimeout(1000)),
        (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_CONFIG_ERROR"
      );
    }
  } finally {
    if (previous === undefined) delete process.env.JDTLS_BIN;
    else process.env.JDTLS_BIN = previous;
  }
  await session.stop();
});

test("requests inside an active retry window share exactly one delayed restart", async () => {
  const factory = sequenceTransportFactory([
    { initializeError: new Error("first boom") },
    { initializeResult: { capabilities: {} } }
  ]);
  const { session, advance } = harness(factory);

  await assert.rejects(() => session.ensureStarted(DeadlineBudget.fromTimeout(5000)), /first boom/);
  assert.equal(factory.spawnCalls, 1);

  const blocked = await Promise.allSettled([
    session.ensureStarted(DeadlineBudget.fromTimeout(5000)),
    session.ensureStarted(DeadlineBudget.fromTimeout(5000))
  ]);
  assert.deepEqual(blocked.map(item => item.status), ["rejected", "rejected"]);
  assert.equal(factory.spawnCalls, 1, "no new child while the retry window is open");

  advance(500);
  const retried = await Promise.allSettled([
    session.ensureStarted(DeadlineBudget.fromTimeout(5000)),
    session.ensureStarted(DeadlineBudget.fromTimeout(5000))
  ]);
  assert.deepEqual(retried.map(item => item.status), ["fulfilled", "fulfilled"]);
  assert.equal(factory.spawnCalls, 2, "the two callers share one retry");
  assert.equal(session.status().state, "READY");
  await session.stop();
});

test("stop during STARTING cancels waiters without recording a restart failure", async () => {
  const initialize = deferred<unknown>();
  const { session, factory } = harness(fakeTransportFactory({ initialize }));

  const waiter = session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  await waitForSpawn(factory, 1);
  assert.equal(session.status().state, "STARTING");

  const stopped = session.stop();
  await assert.rejects(
    () => waiter,
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "CANCELLED"
  );
  await stopped;

  assert.equal(session.status().state, "STOPPED");
  assert.equal(session.status().started, false);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 0);
  assert.equal(session.status().restartBackoff.blockedUntilExplicitReset, false);
  assert.equal(factory.children[0].killCalls > 0, true);
  assert.equal(factory.connections[0].disposed, true);
});

test("a READY child that exits marks the session BROKEN and restartable", async () => {
  const factory = sequenceTransportFactory([
    { initializeResult: { capabilities: {} } },
    { initializeResult: { capabilities: {} } }
  ]);
  const { session, advance } = harness(factory);

  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  assert.equal(session.status().state, "READY");
  assert.equal(typeof session.status().pid, "number");

  factory.children[0].exit(1, null);
  assert.equal(session.status().state, "BROKEN");
  assert.equal(session.status().started, false);
  assert.equal(session.status().pid, undefined);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 1);

  advance(500);
  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  assert.equal(session.status().state, "READY");
  assert.equal(factory.spawnCalls, 2);
  await session.stop();
});

test("status reports STARTING pid separately and never as started", async () => {
  const initialize = deferred<unknown>();
  const { session, factory } = harness(fakeTransportFactory({ initialize }));

  const pending = session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  await waitForSpawn(factory, 1);

  const starting = session.status();
  assert.equal(starting.state, "STARTING");
  assert.equal(starting.started, false);
  assert.equal(starting.pid, undefined);
  assert.equal(starting.startingPid, factory.children[0].pid);

  initialize.resolve({ capabilities: {} });
  await pending;

  const ready = session.status();
  assert.equal(ready.started, true);
  assert.equal(ready.pid, factory.children[0].pid);
  assert.equal(ready.startingPid, undefined);
  await session.stop();
});

test("the ready stability window clears earlier restart failures", async () => {
  const factory = sequenceTransportFactory([
    { initializeError: new Error("flaky") },
    { initializeResult: { capabilities: {} } }
  ]);
  const { session, advance } = harness(factory, { readyStabilityMs: 20 });

  await assert.rejects(() => session.ensureStarted(DeadlineBudget.fromTimeout(5000)), /flaky/);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 1);

  advance(500);
  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  assert.equal(session.status().state, "READY");
  // Entering READY alone must not clear the failure count.
  assert.equal(session.status().restartBackoff.consecutiveFailures, 1);

  await delay(60);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 0);
  await session.stop();
});

test("lifecycle listeners observe every transition and can unsubscribe", async () => {
  const initialize = deferred<unknown>();
  const { session, factory } = harness(fakeTransportFactory({ initialize }));
  const seen: string[] = [];
  const unsubscribe = session.onLifecycleChange(state => { seen.push(state); });

  const pending = session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  await waitForSpawn(factory, 1);
  initialize.resolve({ capabilities: {} });
  await pending;
  assert.deepEqual(seen, ["STARTING", "READY"]);

  unsubscribe();
  await session.stop();
  assert.deepEqual(seen, ["STARTING", "READY"]);
});
