import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JdtlsSession,
  createJdtlsSemanticBackend,
  filterGeneratedCodeDiagnostics,
  lifecycleGateFromRestartBackoffStatus
} from "./jdtls-session.js";
import type { SemanticCacheKey } from "./semantic-gateway.js";
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
  repoRoot: string;
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

  return { session, factory, repoRoot, advance: ms => { now += ms; } };
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

test("invalidateForRepoChanges clears the whole cache on a storm instead of only the affected files", async () => {
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: { "textDocument/documentSymbol": [] }
  });
  const { session, repoRoot } = harness(factory);
  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));

  const fileA = path.join(repoRoot, "A.java");
  const fileB = path.join(repoRoot, "B.java");
  writeFileSync(fileA, "class A {}\n");
  writeFileSync(fileB, "class B {}\n");
  await session.documentSymbols(fileA);
  await session.documentSymbols(fileB);
  assert.equal(session.cacheStatus().entries, 2);

  // Non-storm: only the entry depending on the changed file is invalidated.
  session.invalidateForRepoChanges({ changes: [{ kind: "JAVA_CHANGE", absolutePath: fileA }] });
  assert.equal(session.cacheStatus().entries, 1, "only file A's entry was invalidated");

  await session.documentSymbols(fileA);
  assert.equal(session.cacheStatus().entries, 2);

  // Storm: everything is cleared, since filtering per path is strictly more
  // work than one clear once this many files changed at once.
  session.invalidateForRepoChanges({ changes: [{ kind: "JAVA_CHANGE", absolutePath: fileA }], storm: true });
  assert.equal(session.cacheStatus().entries, 0, "a storm clears the whole cache regardless of which paths it lists");

  await session.stop();
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

// --- createJdtlsSemanticBackend (Task 33 Step 7) ---------------------------

function baseKeyFor(repoRoot: string, overrides: Partial<SemanticCacheKey> = {}): SemanticCacheKey {
  return {
    repoHash: "repo",
    generation: 1,
    operation: "references",
    file: path.join(repoRoot, "A.java"),
    fileFingerprint: "irrelevant",
    line: 3,
    column: 7,
    optionsKey: "",
    ...overrides
  };
}

test("createJdtlsSemanticBackend routes each operation to its matching raw JDT request", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: {
      "textDocument/hover": { contents: "docs" },
      "textDocument/definition": [location],
      "textDocument/implementation": [location],
      "textDocument/documentSymbol": [{ name: "A", kind: 5, range: location.range }]
    },
    handlers: {
      "textDocument/references": (params: unknown) => {
        const context = (params as { context?: { includeDeclaration?: boolean } }).context;
        return context?.includeDeclaration ? [location, location] : [location];
      }
    }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const backend = createJdtlsSemanticBackend(session);

  const hover = await backend.execute(baseKeyFor(repoRoot, { operation: "hover" }), 5000, new AbortController().signal);
  assert.equal(hover.completion, "COMPLETE");
  assert.deepEqual(hover.value, { contents: "docs" });

  const definition = await backend.execute(baseKeyFor(repoRoot, { operation: "definition" }), 5000, new AbortController().signal);
  assert.equal(definition.completion, "COMPLETE");
  assert.deepEqual((definition.value as unknown[]).length, 1);

  const implementation = await backend.execute(baseKeyFor(repoRoot, { operation: "implementation" }), 5000, new AbortController().signal);
  assert.equal(implementation.completion, "COMPLETE");
  assert.deepEqual((implementation.value as unknown[]).length, 1);

  const documentSymbol = await backend.execute(baseKeyFor(repoRoot, { operation: "documentSymbol", line: undefined, column: undefined }), 5000, new AbortController().signal);
  assert.equal(documentSymbol.completion, "COMPLETE");
  assert.equal((documentSymbol.value as ReadonlyArray<{ name: string }>)[0]?.name, "A");

  const referencesWithoutDeclaration = await backend.execute(baseKeyFor(repoRoot, { optionsKey: "includeDeclaration=false" }), 5000, new AbortController().signal);
  assert.equal((referencesWithoutDeclaration.value as unknown[]).length, 1);

  const referencesWithDeclaration = await backend.execute(baseKeyFor(repoRoot, { optionsKey: "includeDeclaration=true" }), 5000, new AbortController().signal);
  assert.equal((referencesWithDeclaration.value as unknown[]).length, 2);

  await session.stop();
});

test("createJdtlsSemanticBackend forwards hierarchy completion and honours direction/depth/limit from optionsKey", async () => {
  const item = { name: "Base", uri: "file:///repo/Base.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [item],
      "typeHierarchy/subtypes": () => [],
      "typeHierarchy/supertypes": () => []
    }
  });
  const { session, repoRoot, factory: harnessFactory } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const backend = createJdtlsSemanticBackend(session);

  const result = await backend.execute(
    baseKeyFor(repoRoot, { operation: "typeHierarchy", optionsKey: "direction=subtypes&depth=2&limit=10" }),
    5000,
    new AbortController().signal
  );

  assert.equal(result.completion, "COMPLETE");
  assert.equal(harnessFactory.connections[0].count("typeHierarchy/subtypes"), 1);
  assert.equal(harnessFactory.connections[0].count("typeHierarchy/supertypes"), 0);

  await session.stop();
});

test("createJdtlsSemanticBackend rejects a position-requiring operation missing line/column", async () => {
  const factory = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  const { session, repoRoot } = harness(factory);
  const backend = createJdtlsSemanticBackend(session);

  await assert.rejects(
    () => backend.execute(baseKeyFor(repoRoot, { operation: "hover", line: undefined, column: undefined }), 5000, new AbortController().signal),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );

  await session.stop();
});

test("lifecycleGateFromRestartBackoffStatus maps backoff, config-block and allowed states", () => {
  assert.deepEqual(
    lifecycleGateFromRestartBackoffStatus({ consecutiveFailures: 0, blockedUntilExplicitReset: false }),
    { allowed: true }
  );
  assert.deepEqual(
    lifecycleGateFromRestartBackoffStatus({ consecutiveFailures: 2, retryAfterMs: 1200, blockedUntilExplicitReset: false }),
    { allowed: false, code: "JDT_BACKOFF", message: "JDT restart is backing off for 1200ms" }
  );
  assert.deepEqual(
    lifecycleGateFromRestartBackoffStatus({ consecutiveFailures: 1, blockedUntilExplicitReset: true, lastErrorCode: "JDT_CONFIG_ERROR" }),
    { allowed: false, code: "JDT_CONFIG_ERROR", message: "JDT start is blocked until configuration changes or java_runtime(action=restart)" }
  );
});

// --- references() cutover onto SemanticGateway (Task 33 Step 7) -----------

test("references() returns the same shape as before, backed by the gateway", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: { "textDocument/references": [location, location] }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  const result = await session.references(path.join(repoRoot, "A.java"), 3, 7, false);

  assert.equal(result.items.length, 2);
  assert.equal(result.totalReferences, 2);
  assert.equal(result.truncated, false);
  await session.stop();
});

test("references() shares one backend request across identical concurrent calls and caches the result", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: { "textDocument/references": [location] }
  });
  const { session, repoRoot, factory: harnessFactory } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const file = path.join(repoRoot, "A.java");

  const [first, second] = await Promise.all([
    session.references(file, 3, 7, false),
    session.references(file, 3, 7, false)
  ]);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(harnessFactory.connections[0].count("textDocument/references"), 1, "concurrent identical requests join one backend call");

  await session.references(file, 3, 7, false);
  assert.equal(harnessFactory.connections[0].count("textDocument/references"), 1, "a subsequent call is served from the complete-only cache");

  await session.stop();
});

test("references() with includeDeclaration true/false are independent cache entries", async () => {
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    handlers: {
      "textDocument/references": (params: unknown) => {
        const context = (params as { context?: { includeDeclaration?: boolean } }).context;
        return context?.includeDeclaration ? [] : [];
      }
    }
  });
  const { session, repoRoot, factory: harnessFactory } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const file = path.join(repoRoot, "A.java");

  await session.references(file, 3, 7, false);
  await session.references(file, 3, 7, true);
  assert.equal(harnessFactory.connections[0].count("textDocument/references"), 2);

  await session.stop();
});

test("references() throws a classified error instead of silently returning partial data", async () => {
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    errors: { "textDocument/references": new Error("Internal error in JDT") }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  await assert.rejects(
    () => session.references(path.join(repoRoot, "A.java"), 3, 7, false),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_SERVER_ERROR"
  );

  await session.stop();
});

test("a storm/BUILD_CHANGE invalidation forces a fresh references() request even for an unchanged file", async () => {
  let calls = 0;
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    handlers: {
      "textDocument/references": () => { calls += 1; return []; }
    }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const file = path.join(repoRoot, "A.java");

  await session.references(file, 3, 7, false);
  assert.equal(calls, 1);
  await session.references(file, 3, 7, false);
  assert.equal(calls, 1, "second call is a cache hit");

  session.invalidateForRepoChanges({ changes: [{ kind: "BUILD_CHANGE", absolutePath: file }] });

  await session.references(file, 3, 7, false);
  assert.equal(calls, 2, "the build-change generation bump invalidates the gateway cache even though the file itself is unchanged");

  await session.stop();
});

test("references() during an active restart backoff fails fast without a backend request", async () => {
  const factory = sequenceTransportFactory([
    { initializeError: new Error("boom") },
    { initializeResult: { capabilities: {} }, responses: { "textDocument/references": [] } }
  ]);
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  await assert.rejects(() => session.ensureStarted(DeadlineBudget.fromTimeout(5000)), /boom/);
  assert.equal(session.status().restartBackoff.consecutiveFailures, 1);

  await assert.rejects(
    () => session.references(path.join(repoRoot, "A.java"), 3, 7, false),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "JDT_BACKOFF"
  );
  assert.equal(factory.spawnCalls, 1, "the gateway's lifecycle gate skipped a second start attempt");

  await session.stop();
});

// --- symbolContext()/semanticLocations() cutover onto SemanticGateway -----

test("symbolContext() returns hover/definitions/implementations from independently gateway-cached operations", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: {
      "textDocument/hover": { contents: "docs" },
      "textDocument/definition": [location],
      "textDocument/implementation": [location, location]
    }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  const result = await session.symbolContext(path.join(repoRoot, "A.java"), 3, 7);

  assert.deepEqual(result.hover, { contents: "docs" });
  assert.equal(result.definitions.length, 1);
  assert.equal(result.implementations.length, 2);
  await session.stop();
});

test("symbolContext() never throws: a per-field JDT failure degrades that field to absent, not a rejected call", async () => {
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: { "textDocument/definition": [] },
    errors: {
      "textDocument/hover": new Error("hover exploded"),
      "textDocument/implementation": new Error("implementation exploded")
    }
  });
  const { session, repoRoot } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  const result = await session.symbolContext(path.join(repoRoot, "A.java"), 3, 7);

  assert.equal(result.hover, undefined);
  assert.deepEqual(result.definitions, []);
  assert.deepEqual(result.implementations, []);
  await session.stop();
});

test("semanticLocations() skips implementation entirely when includeImplementations is false, and shares the definition cache entry with symbolContext()", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  let implementationCalls = 0;
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    handlers: {
      "textDocument/definition": () => [location],
      "textDocument/implementation": () => { implementationCalls += 1; return [location]; }
    },
    responses: { "textDocument/hover": { contents: "docs" } }
  });
  const { session, repoRoot, factory: harnessFactory } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");
  const file = path.join(repoRoot, "A.java");

  const locations = await session.semanticLocations(file, 3, 7, 5000, false);
  assert.equal(locations.definitions.length, 1);
  assert.deepEqual(locations.implementations, []);
  assert.equal(implementationCalls, 0, "implementation is never requested when includeImplementations is false");

  await session.symbolContext(file, 3, 7);
  assert.equal(harnessFactory.connections[0].count("textDocument/definition"), 1, "symbolContext's definition request is served from semanticLocations' cache entry - same position, same operation");

  await session.stop();
});

test("symbolContext()'s 3 concurrent raw requests for a not-yet-open file open the document exactly once", async () => {
  const location = { uri: "file:///repo/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const factory = fakeTransportFactory({
    initializeResult: { capabilities: {} },
    responses: {
      "textDocument/hover": { contents: "docs" },
      "textDocument/definition": [location],
      "textDocument/implementation": [location]
    }
  });
  const { session, repoRoot, factory: harnessFactory } = harness(factory);
  writeFileSync(path.join(repoRoot, "A.java"), "class A {}\n");

  await session.symbolContext(path.join(repoRoot, "A.java"), 3, 7);

  const connection = harnessFactory.connections[0];
  assert.equal(
    connection.notifications.filter(method => method === "textDocument/didOpen").length,
    1,
    "3 concurrent hover/definition/implementation requests for the same never-before-opened file must join one didOpen, not send it 3 times"
  );

  await session.stop();
});
