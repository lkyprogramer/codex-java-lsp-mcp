import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  filterGeneratedCodeDiagnostics,
  forceTerminateJdtlsChild,
  JdtlsSession,
  resolveJdtlsRuntimePaths,
  terminateJdtlsChild,
  validateJdtlsTransportEnvironment,
  type JdtlsChild
} from "./jdtls-session.js";
import type { GeneratedCodeStatus } from "./generated-code.js";
import type { LspDiagnostic } from "./jdtls-session.js";
import { repoCacheBase, repoCacheRoot } from "./repo-layout.js";
import { canonicalPath, repoHash } from "./path-utils.js";
import { SourceIndex } from "./source-index.js";
import { EdgeStore } from "./edge-store.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";
import { RepoOwnershipManager } from "./repo-ownership-lease.js";
import { JavaFileWatcher } from "./file-watcher.js";

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

test("JDT child termination waits for a graceful close", async () => {
  const child = new FakeJdtlsChild("sigterm");

  await terminateJdtlsChild(child as unknown as JdtlsChild, 5);

  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("JDT child termination escalates when SIGTERM does not close the process", async () => {
  const child = new FakeJdtlsChild("sigkill");

  await terminateJdtlsChild(child as unknown as JdtlsChild, 5);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("forced JDT child termination sends SIGKILL without waiting for graceful shutdown", async () => {
  const child = new FakeJdtlsChild("sigkill");

  await forceTerminateJdtlsChild(child as unknown as JdtlsChild, 5);

  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});

test("JDT initialize failure kills its child, clears ownership state, and never reports a poisoned READY session", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-init-failure-"));
  const cache = path.join(root, "cache");
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const transitions: string[] = [];
  const spawnedPids: number[] = [];
  const session = new JdtlsSession(root, [], {
    transportMode: "stdio",
    env: { ...process.env, JDTLS_BIN: "/test/fake-jdtls", JAVA_LSP_CACHE_BASE: cache },
    initializeTimeoutMs: 250,
    ownershipLifecycle: {
      markJdtlsStarting: () => { transitions.push("starting"); },
      markJdtlsRunning: (pid, identity) => { transitions.push(`running:${pid}:${identity}`); },
      clearJdtlsState: () => { transitions.push("cleared"); }
    },
    spawnJdtls: () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (child.pid) spawnedPids.push(child.pid);
      return child;
    }
  });

  await assert.rejects(() => session.ensureStarted(), /Timed out waiting for initialize/);
  assert.equal(session.status().started, false);
  assert.equal(session.status().pid, undefined);
  const firstPid = spawnedPids[0];
  assert.ok(firstPid, "startup must create a child before initialize times out");
  assert.throws(() => process.kill(firstPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  assert.deepEqual(transitions.map(value => value.split(":")[0]), ["starting", "running", "cleared"]);

  await assert.rejects(() => session.ensureStarted(), /Timed out waiting for initialize/);
  assert.equal(spawnedPids.length, 2, "a subsequent call must spawn a clean replacement rather than reuse a failed connection");
  assert.notEqual(spawnedPids[0], spawnedPids[1]);
  assert.throws(() => process.kill(spawnedPids[1]!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  assert.deepEqual(transitions.map(value => value.split(":")[0]), [
    "starting", "running", "cleared", "starting", "running", "cleared"
  ]);
});

test("linked worktrees receive distinct cache, JDT data, log, and snapshot roots", async t => {
  const fixture = await linkedWorktreeFixture(t);
  const env = {
    HOME: path.join(fixture.base, "home"),
    JAVA_LSP_CACHE_BASE: "~/java-cache"
  } as NodeJS.ProcessEnv;
  const mainPaths = resolveJdtlsRuntimePaths(fixture.main, "streamable_http", env);
  const worktreePaths = resolveJdtlsRuntimePaths(fixture.worktree, "streamable_http", env);

  assert.notEqual(repoHash(fixture.main), repoHash(fixture.worktree));
  assert.notEqual(mainPaths.cacheRoot, worktreePaths.cacheRoot);
  assert.notEqual(mainPaths.dataDir, worktreePaths.dataDir);
  assert.notEqual(mainPaths.logDir, worktreePaths.logDir);
  assert.notEqual(
    repoCacheRoot(fixture.main, repoCacheBase(env)),
    repoCacheRoot(fixture.worktree, repoCacheBase(env))
  );
  assert.ok(mainPaths.dataDir.startsWith(path.join(env.HOME!, "java-cache")));
});

test("canonical aliases reuse one cache identity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-cache-alias-"));
  const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
  t.after(async () => {
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  await symlink(root, alias);
  const cacheBase = path.join(root, "cache-base");

  assert.equal(repoCacheRoot(root, cacheBase), repoCacheRoot(alias, cacheBase));
});

test("daemon path policy rejects singleton directories and extra -data overrides", () => {
  assert.throws(
    () => validateJdtlsTransportEnvironment("streamable_http", { JDTLS_DATA_DIR: "/tmp/shared" }),
    /rejects JDTLS_DATA_DIR\/JDTLS_LOG_DIR/
  );
  assert.throws(
    () => validateJdtlsTransportEnvironment("streamable_http", { JDTLS_LOG_DIR: "/tmp/shared" }),
    /rejects JDTLS_DATA_DIR\/JDTLS_LOG_DIR/
  );
  for (const extraArgs of ["-data /tmp/shared", "-data=/tmp/shared", "--jvm-arg=-data=/tmp/shared"]) {
    assert.throws(
      () => validateJdtlsTransportEnvironment("stdio", { JDTLS_EXTRA_ARGS: extraArgs }),
      /must not override -data/
    );
  }
  for (const [name, value] of [
    ["JAVA_LSP_CACHE_BASE", "relative-cache"],
    ["JAVA_LSP_OWNERSHIP_BASE", "relative-ownership"],
    ["JDTLS_DATA_DIR", "relative-data"],
    ["JDTLS_LOG_DIR", "relative-logs"]
  ] as const) {
    assert.throws(
      () => validateJdtlsTransportEnvironment("stdio", { [name]: value }),
      /must be an absolute path or start with ~\//
    );
  }
});

test("stdio legacy data and log settings are bases with a canonical repo hash suffix", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-stdio-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const paths = resolveJdtlsRuntimePaths(root, "stdio", {
    HOME: home,
    JDTLS_DATA_DIR: "~/legacy-data",
    JDTLS_LOG_DIR: "~/legacy-logs"
  });
  const hash = repoHash(root);

  assert.equal(paths.dataDir, path.join(home, "legacy-data", hash));
  assert.equal(paths.logDir, path.join(home, "legacy-logs", hash));
});

test("linked-worktree disk consumers, leases, and watchers share one canonical isolation scheme", async t => {
  const fixture = await linkedWorktreeFixture(t);
  const cacheBase = path.join(fixture.base, "cache");
  const ownershipBase = path.join(fixture.base, "ownership");
  const previousCacheBase = process.env.JAVA_LSP_CACHE_BASE;
  const previousOwnershipBase = process.env.JAVA_LSP_OWNERSHIP_BASE;
  process.env.JAVA_LSP_CACHE_BASE = cacheBase;
  process.env.JAVA_LSP_OWNERSHIP_BASE = ownershipBase;
  t.after(() => {
    restoreEnv("JAVA_LSP_CACHE_BASE", previousCacheBase);
    restoreEnv("JAVA_LSP_OWNERSHIP_BASE", previousOwnershipBase);
  });

  const mainJava = await addJavaFixture(fixture.main, "MainSample");
  const worktreeJava = await addJavaFixture(fixture.worktree, "WorktreeSample");
  new SourceIndex(fixture.main).factsFor(mainJava);
  new SourceIndex(fixture.worktree).factsFor(worktreeJava);
  new EdgeStore(fixture.main).recordEdges(mainJava, [{ to: mainJava, kind: "reference", line: 2, column: 1 }]);
  new EdgeStore(fixture.worktree).recordEdges(worktreeJava, [{ to: worktreeJava, kind: "reference", line: 2, column: 1 }]);
  touchRepoCache(fixture.main);
  touchRepoCache(fixture.worktree);

  const ownership = new RepoOwnershipManager({ transport: "stdio", buildSha: "integration-test" });
  const mainLease = ownership.acquire(fixture.main);
  const worktreeLease = ownership.acquire(fixture.worktree);
  t.after(() => {
    mainLease.release();
    worktreeLease.release();
  });

  const mainWatcher = watcherFor(fixture.main);
  const worktreeWatcher = watcherFor(fixture.worktree);
  await Promise.all([mainWatcher.start(), worktreeWatcher.start()]);
  t.after(() => {
    mainWatcher.close();
    worktreeWatcher.close();
  });

  const mainCache = repoCacheRoot(fixture.main);
  const worktreeCache = repoCacheRoot(fixture.worktree);
  assert.notEqual(mainCache, worktreeCache);
  for (const cache of [mainCache, worktreeCache]) {
    assert.equal(existsSync(path.join(cache, "source-index.files.jsonl")), true);
    assert.equal(existsSync(path.join(cache, "semantic-edges.jsonl")), true);
    assert.equal(existsSync(path.join(cache, "repo-meta.json")), true);
  }
  assert.notEqual(mainLease.lockPath, worktreeLease.lockPath);
  assert.equal(existsSync(mainLease.lockPath), true);
  assert.equal(existsSync(worktreeLease.lockPath), true);
  assert.ok(mainWatcher.status().watchedRoots.every(root => root.startsWith(fixture.main)));
  assert.ok(worktreeWatcher.status().watchedRoots.every(root => root.startsWith(fixture.worktree)));
  assert.equal(
    JSON.parse(readFileSync(path.join(mainCache, "repo-meta.json"), "utf8")).repoRoot,
    canonicalPath(fixture.main)
  );

  const alias = path.join(fixture.base, "main-alias");
  await symlink(fixture.main, alias);
  assert.equal(repoCacheRoot(alias), mainCache);
  assert.equal(ownership.lockPath(alias), mainLease.lockPath);
});

class FakeJdtlsChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly closeOn: "sigterm" | "sigkill") {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    const closes = (signal === "SIGTERM" && this.closeOn === "sigterm")
      || (signal === "SIGKILL" && this.closeOn === "sigkill");
    if (closes) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

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

async function linkedWorktreeFixture(t: TestContext): Promise<{ base: string; main: string; worktree: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "java-lsp-linked-worktrees-"));
  const main = path.join(base, "main");
  const worktree = path.join(base, "feature");
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(main, { recursive: true });
  execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: main });
  await writeFile(path.join(main, "pom.xml"), "<project></project>\n");
  execFileSync("git", ["add", "pom.xml"], { cwd: main });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: main, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "-b", "feature", worktree], { cwd: main, stdio: "ignore" });
  return { base, main, worktree };
}

async function addJavaFixture(repoRoot: string, typeName: string): Promise<string> {
  const file = path.join(repoRoot, "src", "main", "java", "demo", `${typeName}.java`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `package demo;\npublic class ${typeName} { public void run() {} }\n`);
  return file;
}

function watcherFor(repoRoot: string): JavaFileWatcher {
  return new JavaFileWatcher(repoRoot, {
    notifyChanges() {},
    syncOpenDocument() {}
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
