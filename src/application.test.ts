import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JavaLspApplication } from "./application.js";

test("JavaLspApplication initializes and closes shared resources exactly once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "java-lsp-application-"));
  const configPath = path.join(dir, "projects.json");
  await writeFile(configPath, JSON.stringify({ aliases: [] }));
  let cleanups = 0;
  let shutdowns = 0;
  const shutdownOptions: Array<{ releaseOwnership?: boolean; terminal?: boolean } | undefined> = [];
  const runtimes = {
    async shutdownAll(options?: { releaseOwnership?: boolean; terminal?: boolean }) {
      shutdowns += 1;
      shutdownOptions.push(options);
    }
  };
  const application = new JavaLspApplication({
    projectsConfigPath: configPath,
    runtimes: runtimes as never,
    cleanup: () => {
      cleanups += 1;
      return { scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] };
    }
  });

  await Promise.all([application.initialize(), application.initialize()]);
  assert.equal(cleanups, 1);
  assert.equal(application.state().state, "ready");

  await Promise.all([application.close(), application.close()]);
  assert.equal(shutdowns, 1);
  assert.deepEqual(shutdownOptions, [{ releaseOwnership: true, terminal: true }]);
  assert.equal(application.state().state, "closed");
});

test("JavaLspApplication drain blocks new work and waits only for entered requests", async () => {
  const application = new JavaLspApplication({
    runtimes: { shutdownAll: async () => undefined } as never,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = application.runRequest(async () => held);

  const drain = application.drain(1000);
  await assert.rejects(() => application.runRequest(async () => undefined), /draining/);
  release();
  await Promise.all([request, drain]);
  assert.equal(application.state().activeRequests, 0);
});

test("JavaLspApplication shutdown drains entered requests before releasing ownership", async () => {
  const shutdownOptions: Array<{ releaseOwnership?: boolean; terminal?: boolean }> = [];
  const application = new JavaLspApplication({
    runtimes: {
      async shutdownAll(options: { releaseOwnership?: boolean; terminal?: boolean }) {
        shutdownOptions.push(options);
      }
    } as never,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = application.runRequest(async () => {
    entered();
    await held;
  });
  await enteredPromise;

  const shutdown = application.shutdown(1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(shutdownOptions, [], "runtime shutdown must wait for the entered request");
  release();
  await Promise.all([request, shutdown]);
  assert.deepEqual(shutdownOptions, [{ releaseOwnership: true, terminal: true }]);
});

test("JavaLspApplication retains ownership when bounded drain times out", async () => {
  const shutdownOptions: Array<{ releaseOwnership?: boolean; terminal?: boolean }> = [];
  const application = new JavaLspApplication({
    runtimes: {
      async shutdownAll(options: { releaseOwnership?: boolean; terminal?: boolean }) {
        shutdownOptions.push(options);
      }
    } as never,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  await application.initialize();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = application.runRequest(async () => held);

  await assert.rejects(() => application.shutdown(10), /Timed out draining 1 MCP request/);
  assert.deepEqual(shutdownOptions, [{ releaseOwnership: false, terminal: true }]);
  assert.equal(application.state().state, "closed");
  release();
  await request;
});

test("JavaLspApplication daemon preflight rejects every unsafe path override before cleanup", async t => {
  const variables = ["JDTLS_DATA_DIR", "JDTLS_LOG_DIR", "JDTLS_EXTRA_ARGS"] as const;
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of variables) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  });
  for (const name of variables) delete process.env[name];

  for (const [name, value] of [
    ["JDTLS_DATA_DIR", "/tmp/shared-jdtls-data"],
    ["JDTLS_LOG_DIR", "/tmp/shared-jdtls-logs"],
    ["JDTLS_EXTRA_ARGS", "-data /tmp/shared-jdtls-data"]
  ] as const) {
    process.env[name] = value;
    let cleanupCalled = false;
    const application = new JavaLspApplication({
      transportMode: "streamable_http",
      runtimes: { shutdownAll: async () => undefined } as never,
      cleanup: () => {
        cleanupCalled = true;
        return { scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] };
      }
    });
    await assert.rejects(
      () => application.initialize(),
      name === "JDTLS_EXTRA_ARGS" ? /must not override -data/ : /rejects JDTLS_DATA_DIR\/JDTLS_LOG_DIR/
    );
    assert.equal(cleanupCalled, false);
    delete process.env[name];
  }
});

test("JavaLspApplication runs cache janitor periodically with retained roots and stops it on drain", async () => {
  const retained = new Set(["/repo-retained"]);
  const cleanupRoots: string[][] = [];
  let cleanupCalls = 0;
  const application = new JavaLspApplication({
    runtimes: {
      retainedRepoRoots: () => retained,
      shutdownAll: async () => undefined
    } as never,
    cacheJanitorIntervalMs: 15,
    cleanup: options => {
      cleanupCalls += 1;
      cleanupRoots.push([...(options.protectedRepoRoots || [])]);
      return { scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] };
    }
  });

  await application.initialize();
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.ok(cleanupCalls >= 3, `expected startup plus periodic cleanup, got ${cleanupCalls}`);
  assert.ok(cleanupRoots.every(roots => roots.includes("/repo-retained")));

  await application.drain(100);
  const callsAtDrain = cleanupCalls;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(cleanupCalls, callsAtDrain);
  await application.close();
});

test("JavaLspApplication degrades cache janitor failures without failing startup", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const application = new JavaLspApplication({
      runtimes: { shutdownAll: async () => undefined } as never,
      cacheJanitorIntervalMs: 0,
      cleanup: () => { throw new Error("janitor failure"); }
    });
    const result = await application.initialize();
    assert.deepEqual(result, { scanned: 0, removed: 0, skipped: 0, failures: 1, removedDirs: [] });
    assert.equal(application.state().state, "ready");
    assert.equal(errors.length, 1);
    await application.close();
  } finally {
    console.error = originalError;
  }
});

test("JavaLspApplication bounds janitor intervals to the Node timer range", async () => {
  let cleanupCalls = 0;
  const application = new JavaLspApplication({
    runtimes: { shutdownAll: async () => undefined } as never,
    cacheJanitorIntervalMs: 2_147_483_648,
    cleanup: () => {
      cleanupCalls += 1;
      return { scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] };
    }
  });

  await application.initialize();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(cleanupCalls, 1, "an overflowing interval must not become a 1ms timer");
  await application.close();
});
