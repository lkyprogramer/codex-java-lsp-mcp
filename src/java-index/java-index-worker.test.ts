import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore
} from "../cross-process-lease.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { WorktreeIdentity } from "../worktree-identity.js";
import { probeLayout } from "../layout-probe.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";
import { JavaIndexClient } from "./java-index-client.js";
import type { JavaIndexSnapshotStatus } from "./index-types.js";
import { computeCurrentManifestFingerprint, computeCurrentSnapshotManifestFingerprint } from "./manifest.js";
import { loadSnapshot, writeSnapshotAtomic } from "./snapshot.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import { JAVA_INDEX_CLOSE_GRACE_MS } from "./worker-protocol.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function tempCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), "java-index-worker-cache-"));
}

const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";

function writeJavaFile(repoRoot: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function identityFor(repoRoot: string, repoHash: string): WorktreeIdentity {
  return { repoRoot, repoHash, isLinkedWorktree: false };
}

function controlledSnapshotWorker(
  barrier: Int32Array,
  hook: "snapshot-sync" | "build-read",
  snapshotWriteToBlock = 1,
  lifecycle?: { unrefs: number; terminations: number }
): Worker {
  const worker = new Worker(`
    const fs = require("node:fs");
    const { syncBuiltinESMExports } = require("node:module");
    const { workerData } = require("node:worker_threads");
    (async () => {
      const control = new Int32Array(workerData.barrier);
      if (workerData.hook === "snapshot-sync") {
        const originalOpen = fs.promises.open;
        let snapshotWrites = 0;
        fs.promises.open = async function (input, ...args) {
          const handle = await originalOpen.call(this, input, ...args);
          if (String(input).includes("java-index-snapshot.json.gz.tmp-")) {
            snapshotWrites += 1;
            if (snapshotWrites === workerData.snapshotWriteToBlock) {
              const originalSync = handle.sync.bind(handle);
              handle.sync = async () => {
                await originalSync();
                Atomics.store(control, 0, 1);
                Atomics.notify(control, 0);
                while (Atomics.load(control, 1) === 0) {
                  await Atomics.waitAsync(control, 1, 0).value;
                }
              };
            }
          }
          return handle;
        };
      } else {
        const originalReadFile = fs.promises.readFile;
        fs.promises.readFile = async function (input, ...args) {
          if (
            String(input).endsWith("/pom.xml")
            && Atomics.compareExchange(control, 2, 1, 2) === 1
          ) {
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            while (Atomics.load(control, 1) === 0) {
              await Atomics.waitAsync(control, 1, 0).value;
            }
          }
          return originalReadFile.call(this, input, ...args);
        };
      }
      syncBuiltinESMExports();
      await import(workerData.workerModuleUrl);
    })().catch(error => setImmediate(() => { throw error; }));
  `, {
    eval: true,
    workerData: {
      barrier: barrier.buffer,
      hook,
      snapshotWriteToBlock,
      workerModuleUrl: new URL("./java-index-worker.js", import.meta.url).href
    }
  });
  if (lifecycle) {
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      lifecycle.terminations += 1;
      return terminate();
    };
    const unref = worker.unref.bind(worker);
    worker.unref = () => {
      lifecycle.unrefs += 1;
      return unref();
    };
  }
  return worker;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("reconcile() runs a background full sweep that discovers and indexes every file under source roots", async () => {
  const repoRoot = tempRepo("java-index-worker-sweep-");
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  writeJavaFile(repoRoot, "src/main/java/demo/Impl.java", "package demo;\n\nclass Impl implements Gateway {}\n");
  writeJavaFile(repoRoot, "src/test/java/demo/ImplTest.java", "package demo;\n\nclass ImplTest {}\n");

  const cacheDir = tempCacheDir();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);

  const afterReconcile = await client.reconcile(1);
  assert.ok(afterReconcile.pendingBackground >= 0, "reconcile() returns promptly, not waiting for the sweep");

  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);
  assert.ok(
    existsSync(path.join(cacheDir, SNAPSHOT_FILE_NAME)),
    "a quiescent full sweep must include its durable snapshot flush"
  );

  const status = await client.status();
  assert.equal(status.files, 3);
  assert.ok(status.coverage.length > 0, "expected discovered source roots to be tracked");
  assert.ok(
    status.coverage.every(entry => entry.state === "COMPLETE"),
    `expected every source root COMPLETE, got ${JSON.stringify(status.coverage)}`
  );

  const implBundle = (await client.queryFiles([path.join(repoRoot, "src/main/java/demo/Impl.java")]))[0]!;
  const gatewayBundle = (await client.queryFiles([path.join(repoRoot, "src/main/java/demo/Gateway.java")]))[0]!;
  const gateway = gatewayBundle.types.find(t => t.simpleName === "Gateway")!;
  assert.ok(
    implBundle.edges.some(e => e.kind === "IMPLEMENTS" && e.toId === gateway.typeId),
    "a background-swept file must resolve its cross-file edges just like a foreground refresh does"
  );

  await client.close();
});

test("a failed snapshot publication is observable after coverage becomes complete", async () => {
  const repoRoot = tempRepo("java-index-worker-snapshot-failure-");
  writeJavaFile(repoRoot, "src/main/java/demo/Solo.java", "package demo; class Solo {}\n");
  const cacheParent = tempRepo("java-index-worker-snapshot-failure-cache-");
  const cacheDir = path.join(cacheParent, "not-a-directory");
  writeFileSync(cacheDir, "blocks snapshot mkdir\n");
  const client = new JavaIndexClient(repoRoot, cacheDir);
  try {
    await client.open(1);
    await client.reconcile(1);
    await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);
    const status = await client.status();
    assert.ok(status.coverage.every(entry => entry.state === "COMPLETE"));
    assert.deepEqual(status.snapshot, { state: "FAILED", failure: "WRITE_FAILED" });
    assert.equal(status.snapshotBytes, 0);
  } finally {
    await client.close();
  }
});

test("stale maintenance commands never regress the worker generation", async () => {
  const repoRoot = tempRepo("java-index-worker-generation-high-water-");
  const relativeFile = "src/main/java/demo/A.java";
  const absoluteFile = path.join(repoRoot, relativeFile);
  writeJavaFile(repoRoot, relativeFile, "package demo; class A {}\n");
  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.refresh(2, [absoluteFile], []);

  assert.equal((await client.refresh(1, [absoluteFile], [])).indexedGeneration, 2);
  assert.equal((await client.refreshResources(1, [path.join(repoRoot, "pom.xml")])).indexedGeneration, 2);
  assert.equal((await client.reconcile(1)).indexedGeneration, 2);
  assert.equal((await client.status()).indexedGeneration, 2);
  assert.equal((await client.queryFiles([absoluteFile]))[0]?.file.generation, 2);

  await client.close();
});

test("pendingBackground stays nonzero while the final sweep chunk is still finishing", async () => {
  const repoRoot = tempRepo("java-index-worker-final-chunk-quiescence-");
  writeJavaFile(repoRoot, "src/main/java/demo/Solo.java", "package demo;\n\nclass Solo {}\n");
  const cacheDir = tempCacheDir();
  const leaseRoot = tempRepo("java-index-worker-final-chunk-lease-");
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const client = new JavaIndexClient(repoRoot, cacheDir, () => new Worker(`
    const { workerData } = require("node:worker_threads");
    (async () => {
      const control = new Int32Array(workerData.barrier);
      const leaseModule = await import(workerData.leaseModuleUrl);
      const originalAcquireSweep = leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep;
      leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep = async function (...args) {
        const handle = await originalAcquireSweep.apply(this, args);
        const originalHeartbeat = handle.heartbeat;
        handle.heartbeat = async () => {
          Atomics.store(control, 0, 1);
          Atomics.notify(control, 0);
          while (Atomics.load(control, 1) === 0) {
            await Atomics.waitAsync(control, 1, 0).value;
          }
          await originalHeartbeat.call(handle);
        };
        return handle;
      };
      await import(workerData.workerModuleUrl);
    })().catch(error => setImmediate(() => { throw error; }));
  `, {
    eval: true,
    workerData: {
      barrier: barrier.buffer,
      leaseModuleUrl: new URL("../cross-process-lease.js", import.meta.url).href,
      workerModuleUrl: new URL("./java-index-worker.js", import.meta.url).href
    }
  }));

  try {
    await client.open(1, { leaseRoot, worktree: identityFor(repoRoot, "final-chunk-quiescence") });
    await client.reconcile(1);
    while (Atomics.load(barrier, 0) === 0) {
      const wait = (Atomics as typeof Atomics & {
        waitAsync(array: Int32Array, index: number, value: number, timeout?: number): {
          async: boolean;
          value: string | Promise<string>;
        };
      }).waitAsync(barrier, 0, 0, 5000);
      const result = wait.async ? await wait.value : wait.value;
      assert.notEqual(result, "timed-out", "the controlled final-chunk heartbeat barrier must be reached");
    }

    const duringFinalHeartbeat = await client.status();
    assert.ok(
      duringFinalHeartbeat.pendingBackground > 0,
      `the final chunk must remain pending through heartbeat and terminal cleanup, got ${JSON.stringify(duringFinalHeartbeat)}`
    );
    assert.ok(
      duringFinalHeartbeat.coverage.every(entry => entry.state === "BUILDING"),
      `coverage must still be BUILDING at the heartbeat barrier, got ${JSON.stringify(duringFinalHeartbeat.coverage)}`
    );
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("a clean full sweep re-links an early source file after its later declaration is indexed", async () => {
  const repoRoot = tempRepo("java-index-worker-final-relink-");
  const consumer = "src/main/java/demo/AConsumer.java";
  writeJavaFile(repoRoot, consumer, [
    "package demo;",
    "class AConsumer { ZProvider provider; }",
    ""
  ].join("\n"));
  // The alphabetical discovery order deliberately indexes AConsumer before
  // ZProvider.  A complete sweep must not leave that timing accident as an
  // unresolved type reference once all declarations are present.
  writeJavaFile(repoRoot, "src/main/java/demo/ZProvider.java", "package demo;\nclass ZProvider {}\n");

  const cacheDir = tempCacheDir();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

  const bundle = (await client.queryFiles([path.join(repoRoot, consumer)]))[0]!;
  const providerField = bundle.fields.find(field => field.name === "provider")!;
  assert.deepEqual(providerField.type.resolution, {
    state: "RESOLVED_REPO",
    typeId: "type:demo.ZProvider",
    strategy: "SAME_PACKAGE"
  });
  assert.ok(
    bundle.edges.some(edge => edge.kind === "FIELD_TYPE" && edge.toId === "type:demo.ZProvider"),
    "the final re-link must also publish the resolved FIELD_TYPE edge"
  );
  await client.close();
});

test("a clean multi-module sweep resolves an import into a source root indexed later", async () => {
  const repoRoot = tempRepo("java-index-worker-cross-module-relink-");
  const consumer = "modules/account/src/main/java/account/AccountConsumer.java";
  writeJavaFile(repoRoot, consumer, [
    "package account;",
    "import common.ErrorCode;",
    "class AccountConsumer { ErrorCode errorCode; }",
    ""
  ].join("\n"));
  // Force the imported declaration into a later 50-file background chunk;
  // a same-chunk fixture would accidentally get a free re-link at the end of
  // the first chunk and would not exercise the cross-chunk completion path.
  for (let index = 0; index < 60; index += 1) {
    writeJavaFile(
      repoRoot,
      `modules/account/src/main/java/account/Filler${index}.java`,
      `package account; class Filler${index} {}\n`
    );
  }
  writeJavaFile(
    repoRoot,
    "modules/common/src/main/java/common/ErrorCode.java",
    "package common;\npublic interface ErrorCode {}\n"
  );

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

  const bundle = (await client.queryFiles([path.join(repoRoot, consumer)]))[0]!;
  const errorCodeField = bundle.fields.find(field => field.name === "errorCode")!;
  assert.deepEqual(errorCodeField.type.resolution, {
    state: "RESOLVED_REPO",
    typeId: "type:common.ErrorCode",
    strategy: "EXPLICIT_IMPORT"
  });
  await client.close();
});

test("a background sweep spanning multiple 50-file chunks resolves every file's own facts and cross-file edges", async () => {
  const repoRoot = tempRepo("java-index-worker-chunked-sweep-");
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  for (let i = 0; i < 60; i += 1) {
    writeJavaFile(
      repoRoot,
      `src/main/java/demo/Impl${i}.java`,
      `package demo;\n\nclass Impl${i} implements Gateway {}\n`
    );
  }

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 15000);

  const status = await client.status();
  assert.equal(status.files, 61);

  const gatewayBundle = (await client.queryFiles([path.join(repoRoot, "src/main/java/demo/Gateway.java")]))[0]!;
  const gateway = gatewayBundle.types.find(t => t.simpleName === "Gateway")!;
  const implFiles = Array.from({ length: 60 }, (_, i) => path.join(repoRoot, `src/main/java/demo/Impl${i}.java`));
  const implBundles = await client.queryFiles(implFiles);
  assert.equal(implBundles.length, 60);
  for (const bundle of implBundles) {
    assert.equal(bundle.types.length, 1, `${bundle.file.relativePath} must have its type indexed`);
    assert.ok(
      bundle.edges.some(e => e.kind === "IMPLEMENTS" && e.toId === gateway.typeId),
      `${bundle.file.relativePath} must carry a resolved IMPLEMENTS edge, never facts without edges`
    );
  }

  await client.close();
});

test("an ordinary watcher refresh in a test root does not preempt remaining main-root sweep work", async () => {
  const repoRoot = tempRepo("java-index-worker-watcher-root-priority-");
  const primaryRoot = "modules/a-main/src/main/java";
  const watcherTestRoot = "modules/z-watcher/src/test/java";
  for (let index = 0; index < 55; index += 1) {
    writeJavaFile(repoRoot, `${primaryRoot}/demo/Filler${String(index).padStart(2, "0")}.java`, `package demo; class Filler${index} {}\n`);
  }
  const anchor = `${watcherTestRoot}/demo/Anchor.java`;
  writeJavaFile(repoRoot, anchor, "package demo; class Anchor {}\n");
  for (let index = 1; index < 50; index += 1) {
    writeJavaFile(repoRoot, `${watcherTestRoot}/demo/Watcher${String(index).padStart(2, "0")}.java`, `package demo; class Watcher${index} {}\n`);
  }

  const leaseRoot = tempRepo("java-index-worker-watcher-root-priority-lease-");
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const client = new JavaIndexClient(repoRoot, tempCacheDir(), () => new Worker(`
    const { workerData } = require("node:worker_threads");
    (async () => {
      const control = new Int32Array(workerData.barrier);
      const leaseModule = await import(workerData.leaseModuleUrl);
      const originalAcquireSweep = leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep;
      leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep = async function (...args) {
        const handle = await originalAcquireSweep.apply(this, args);
        const originalHeartbeat = handle.heartbeat;
        handle.heartbeat = async () => {
          const heartbeat = Atomics.add(control, 0, 1) + 1;
          Atomics.notify(control, 0);
          while (Atomics.load(control, 1) < heartbeat) {
            await Atomics.waitAsync(control, 1, Atomics.load(control, 1)).value;
          }
          await originalHeartbeat.call(handle);
        };
        return handle;
      };
      await import(workerData.workerModuleUrl);
    })().catch(error => setImmediate(() => { throw error; }));
  `, {
    eval: true,
    workerData: {
      barrier: barrier.buffer,
      leaseModuleUrl: new URL("../cross-process-lease.js", import.meta.url).href,
      workerModuleUrl: new URL("./java-index-worker.js", import.meta.url).href
    }
  }));

  try {
    await client.open(1, { leaseRoot, worktree: identityFor(repoRoot, "watcher-root-priority") });
    await client.reconcile(1);
    await waitFor(() => Atomics.load(barrier, 0) >= 1, 5000);

    await client.refresh(2, [path.join(repoRoot, anchor)], []);
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await waitFor(() => Atomics.load(barrier, 0) >= 2, 5000);

    const duringSecondChunk = await client.status();
    const watcherCoverage = duringSecondChunk.coverage.find(entry => entry.root === watcherTestRoot)!;
    const primaryCoverage = duringSecondChunk.coverage.find(entry => entry.root === primaryRoot)!;
    assert.equal(primaryCoverage.indexedFiles, 55, "a watcher refresh must not let a test root jump the five remaining main-root files");
    assert.equal(watcherCoverage.indexedFiles, 46, "the watcher refresh itself plus only the remaining chunk capacity may be indexed from the test root");

    Atomics.store(barrier, 1, 2147483647);
    Atomics.notify(barrier, 1);
    await waitFor(async () => (await client.status()).pendingBackground === 0, 10000);
    const completed = await client.status();
    assert.ok(completed.coverage.every(entry => entry.state === "COMPLETE"));
  } finally {
    Atomics.store(barrier, 1, 2147483647);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("only the first active-anchor refresh receives the sweep priority epoch", async () => {
  const repoRoot = tempRepo("java-index-worker-single-active-root-");
  const primaryRoot = "modules/a-main/src/main/java";
  const firstAnchorRoot = "modules/y-first/src/main/java";
  const secondAnchorRoot = "modules/z-second/src/main/java";
  for (let index = 0; index < 55; index += 1) {
    writeJavaFile(repoRoot, `${primaryRoot}/demo/Filler${String(index).padStart(2, "0")}.java`, `package demo; class Filler${index} {}\n`);
  }
  const firstAnchor = `${firstAnchorRoot}/demo/FirstAnchor.java`;
  const secondAnchor = `${secondAnchorRoot}/demo/SecondAnchor.java`;
  writeJavaFile(repoRoot, firstAnchor, "package demo; class FirstAnchor {}\n");
  writeJavaFile(repoRoot, secondAnchor, "package demo; class SecondAnchor {}\n");
  for (let index = 1; index < 50; index += 1) {
    writeJavaFile(repoRoot, `${firstAnchorRoot}/demo/First${String(index).padStart(2, "0")}.java`, `package demo; class First${index} {}\n`);
    writeJavaFile(repoRoot, `${secondAnchorRoot}/demo/Second${String(index).padStart(2, "0")}.java`, `package demo; class Second${index} {}\n`);
  }

  const leaseRoot = tempRepo("java-index-worker-single-active-root-lease-");
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const client = new JavaIndexClient(repoRoot, tempCacheDir(), () => new Worker(`
    const { workerData } = require("node:worker_threads");
    (async () => {
      const control = new Int32Array(workerData.barrier);
      const leaseModule = await import(workerData.leaseModuleUrl);
      const originalAcquireSweep = leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep;
      leaseModule.FileCrossProcessLeaseStore.prototype.acquireSweep = async function (...args) {
        const handle = await originalAcquireSweep.apply(this, args);
        const originalHeartbeat = handle.heartbeat;
        handle.heartbeat = async () => {
          const heartbeat = Atomics.add(control, 0, 1) + 1;
          Atomics.notify(control, 0);
          while (Atomics.load(control, 1) < heartbeat) {
            await Atomics.waitAsync(control, 1, Atomics.load(control, 1)).value;
          }
          await originalHeartbeat.call(handle);
        };
        return handle;
      };
      await import(workerData.workerModuleUrl);
    })().catch(error => setImmediate(() => { throw error; }));
  `, {
    eval: true,
    workerData: {
      barrier: barrier.buffer,
      leaseModuleUrl: new URL("../cross-process-lease.js", import.meta.url).href,
      workerModuleUrl: new URL("./java-index-worker.js", import.meta.url).href
    }
  }));

  try {
    await client.open(1, { leaseRoot, worktree: identityFor(repoRoot, "single-active-root") });
    await client.reconcile(1);
    await waitFor(() => Atomics.load(barrier, 0) >= 1, 5000);

    await client.refresh(2, [path.join(repoRoot, firstAnchor)], [], {}, "ACTIVE_ANCHOR");
    await client.refresh(2, [path.join(repoRoot, secondAnchor)], [], {}, "ACTIVE_ANCHOR");
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await waitFor(() => Atomics.load(barrier, 0) >= 2, 5000);

    const duringFirstPriorityChunk = await client.status();
    const firstCoverage = duringFirstPriorityChunk.coverage.find(entry => entry.root === firstAnchorRoot)!;
    const secondCoverage = duringFirstPriorityChunk.coverage.find(entry => entry.root === secondAnchorRoot)!;
    const primaryCoverage = duringFirstPriorityChunk.coverage.find(entry => entry.root === primaryRoot)!;
    assert.equal(firstCoverage.indexedFiles, 51, "the first ACTIVE_ANCHOR root owns the one priority epoch");
    assert.equal(secondCoverage.indexedFiles, 1, "the second ACTIVE_ANCHOR refresh itself is indexed but cannot create another priority root");
    assert.equal(primaryCoverage.indexedFiles, 50);

    Atomics.store(barrier, 1, 2);
    Atomics.notify(barrier, 1);
    await waitFor(() => Atomics.load(barrier, 0) >= 3, 5000);

    const duringFollowingChunk = await client.status();
    assert.equal(
      duringFollowingChunk.coverage.find(entry => entry.root === primaryRoot)!.indexedFiles,
      55,
      "after the single priority epoch, remaining main-root files retain their stable order ahead of the second anchor root"
    );
    assert.equal(
      duringFollowingChunk.coverage.find(entry => entry.root === secondAnchorRoot)!.indexedFiles,
      46
    );

    Atomics.store(barrier, 1, 2147483647);
    Atomics.notify(barrier, 1);
    await waitFor(async () => (await client.status()).pendingBackground === 0, 10000);
  } finally {
    Atomics.store(barrier, 1, 2147483647);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("an untouched root stays COMPLETE at the new generation after a healthy incremental refresh elsewhere", async () => {
  const repoRoot = tempRepo("java-index-worker-untouched-root-");
  const mainFile = "src/main/java/demo/Main.java";
  writeJavaFile(repoRoot, mainFile, "package demo;\n\nclass Main {}\n");
  writeJavaFile(repoRoot, "src/test/java/demo/MainTest.java", "package demo;\n\nclass MainTest {}\n");

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => {
    const status = await client.status();
    return status.coverage.length > 0 && status.coverage.every(entry => entry.state === "COMPLETE");
  }, 5000);

  await client.refresh(2, [path.join(repoRoot, mainFile)], []);

  const status = await client.status();
  const testRoot = status.coverage.find(entry => entry.root === "src/test/java")!;
  assert.equal(
    testRoot.state,
    "COMPLETE",
    "the untouched test root must stay COMPLETE, not fall back to BUILDING/DEGRADED"
  );
  assert.equal(testRoot.generation, 2, "the untouched root's generation must advance with the repo-wide generation");

  const typeLookup = await client.queryType("demo.NoSuchType");
  assert.deepEqual(typeLookup, { state: "UNRESOLVED", coverage: "COMPLETE" });

  await client.close();
});

test("a refresh landing while the initial sweep is still in flight bumps the sweep's target generation instead of leaving it stale", async () => {
  const repoRoot = tempRepo("java-index-worker-refresh-during-sweep-");
  const mainFile = "src/main/java/demo/Main.java";
  writeJavaFile(repoRoot, mainFile, "package demo;\n\nclass Main {}\n");
  // Enough files that the initial sweep spans multiple chunks/yields, giving
  // a real (not purely theoretical) window for the refresh below to land
  // before the sweep's own generation would otherwise catch up.
  for (let i = 0; i < 80; i += 1) {
    writeJavaFile(repoRoot, `src/main/java/demo/Filler${i}.java`, `package demo;\n\nclass Filler${i} {}\n`);
  }

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  await client.refresh(2, [path.join(repoRoot, mainFile)], []);

  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

  const status = await client.status();
  assert.ok(
    status.coverage.every(entry => entry.generation === 2),
    `expected every root's coverage to land on generation 2, got ${JSON.stringify(status.coverage)}`
  );
  assert.ok(status.coverage.every(entry => entry.state === "COMPLETE"));

  const typeLookup = await client.queryType("demo.NoSuchType");
  assert.deepEqual(
    typeLookup,
    { state: "UNRESOLVED", coverage: "COMPLETE" },
    "a refresh mid-sweep must not permanently strand coverage at the sweep's original (now stale) generation"
  );

  await client.close();
});

test("CLOSE waits for an in-flight background sweep instead of racing worker.terminate() against it", async () => {
  const repoRoot = tempRepo("java-index-worker-close-race-");
  for (let i = 0; i < 80; i += 1) {
    writeJavaFile(repoRoot, `src/main/java/demo/Type${i}.java`, `package demo;\n\nclass Type${i} {}\n`);
  }

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  // Close immediately, without waiting for the sweep to finish: this used to
  // race worker.terminate() against an in-flight tree-sitter parse and abort
  // the whole process with an uncaught native exception.
  await client.close();
  assert.equal(client.localStatus().state, "CLOSED");
});

test("CLOSE returns at its grace without interrupting an active atomic writer, then terminates after ACK", async () => {
  const repoRoot = tempRepo("java-index-worker-close-snapshot-write-");
  writeJavaFile(repoRoot, "src/main/java/demo/Solo.java", "package demo; class Solo {}\n");
  const cacheDir = tempCacheDir();
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const lifecycle = { unrefs: 0, terminations: 0 };
  const client = new JavaIndexClient(
    repoRoot,
    cacheDir,
    () => controlledSnapshotWorker(barrier, "snapshot-sync", 1, lifecycle)
  );
  try {
    await client.open(1);
    await client.refresh(1, [path.join(repoRoot, "src/main/java/demo/Solo.java")], []);
    await waitFor(() => Atomics.load(barrier, 0) === 1, 5000);

    let settled = false;
    const closing = client.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, JAVA_INDEX_CLOSE_GRACE_MS + 100));
    assert.equal(settled, true, "the caller-visible close must stay bounded even while the writer is blocked");
    assert.equal(lifecycle.unrefs, 1);
    assert.equal(lifecycle.terminations, 0, "the grace branch must not terminate a worker before CLOSE ACK");
    assert.equal(existsSync(path.join(cacheDir, SNAPSHOT_FILE_NAME)), false);

    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await closing;
    await waitFor(
      () => lifecycle.terminations === 1 && existsSync(path.join(cacheDir, SNAPSHOT_FILE_NAME)),
      2000
    );
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("a stale writer failure leaves a newer dirty revision pending with the last durable identity, then retries", async () => {
  const repoRoot = tempRepo("java-index-worker-snapshot-revision-retry-");
  const relativeFile = "src/main/java/demo/Solo.java";
  const absoluteFile = path.join(repoRoot, relativeFile);
  writeJavaFile(repoRoot, relativeFile, "package demo; class Solo { int value = 1; }\n");
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const client = new JavaIndexClient(
    repoRoot,
    tempCacheDir(),
    () => controlledSnapshotWorker(barrier, "snapshot-sync", 2)
  );
  try {
    await client.open(1);
    await client.reconcile(1);
    await waitFor(async () => {
      const status = await client.status();
      return status.pendingBackground === 0 && status.snapshot?.state === "DURABLE";
    }, 5000);
    const firstDurable = (await client.status()).snapshot;
    assert.equal(firstDurable?.state, "DURABLE");

    await client.reconcile(2);
    await waitFor(() => Atomics.load(barrier, 0) === 1, 5000);
    writeJavaFile(repoRoot, relativeFile, "package demo; class Solo { int value = 2; }\n");
    await client.refresh(3, [absoluteFile], []);
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);

    await waitFor(async () => {
      const status = await client.status();
      const snapshot = status.snapshot;
      return status.pendingBackground === 0
        && snapshot?.state === "PENDING"
        && snapshot.durableGeneration === firstDurable.durableGeneration
        && snapshot.durableManifestFingerprint === firstDurable.durableManifestFingerprint;
    }, 800);
    await waitFor(async () => {
      const snapshot = (await client.status()).snapshot;
      return snapshot?.state === "DURABLE" && snapshot.durableGeneration === 3;
    }, 5000);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("snapshot generation, data, and coverage are captured from one revision", async () => {
  const repoRoot = tempRepo("java-index-worker-snapshot-coherent-revision-");
  const cacheDir = tempCacheDir();
  const relativeFile = "src/main/java/demo/Solo.java";
  const absoluteFile = path.join(repoRoot, relativeFile);
  writeJavaFile(repoRoot, relativeFile, "package demo; class Solo { int value = 1; }\n");
  writeFileSync(path.join(repoRoot, "pom.xml"), "<project/>\n");
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const client = new JavaIndexClient(
    repoRoot,
    cacheDir,
    () => controlledSnapshotWorker(barrier, "build-read")
  );
  try {
    await client.open(1);
    await client.reconcile(1);
    await waitFor(async () => {
      const status = await client.status();
      return status.pendingBackground === 0 && status.snapshot?.state === "DURABLE";
    }, 5000);

    Atomics.store(barrier, 2, 1);
    await client.reconcile(2);
    await waitFor(() => Atomics.load(barrier, 0) === 1, 5000);
    writeJavaFile(repoRoot, relativeFile, "package demo; class Solo { int value = 2; }\n");
    await client.refresh(3, [absoluteFile], []);
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    const published = await (async () => {
      let observed: Extract<JavaIndexSnapshotStatus, { state: "PENDING" | "DURABLE" }> | undefined;
      await waitFor(async () => {
        const status = await client.status();
        if (
          status.pendingBackground === 0
          && (status.snapshot?.state === "PENDING" || status.snapshot?.state === "DURABLE")
        ) {
          observed = status.snapshot;
        }
        return observed !== undefined;
      }, 800);
      return observed!;
    })();
    assert.equal(published.durableGeneration, 3, "the publication identity must use the same revision as its serialized data");

    const snapshot = await loadSnapshot(path.join(cacheDir, SNAPSHOT_FILE_NAME), {
      extractorVersion: computeExtractorVersion(),
      stableIdVersion: STABLE_ID_VERSION,
      canonicalRepoRoot: repoRoot,
      buildFingerprint: await computeBuildFingerprint(repoRoot, probeLayout(repoRoot))
    });
    assert.ok(snapshot);
    const capturedGenerations = [
      ...snapshot.files.map(file => file.generation),
      ...snapshot.coverage.map(entry => entry.generation)
    ];
    assert.equal(snapshot.indexedGeneration, Math.max(...capturedGenerations));
    assert.equal(snapshot.indexedGeneration, 3);

    await waitFor(async () => {
      const status = await client.status();
      return status.snapshot?.state === "DURABLE" && status.snapshot.durableGeneration === 3;
    }, 5000);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await client.close().catch(() => undefined);
  }
});

test("a background sweep waits for the machine sweep lease without blocking foreground queries", async () => {
  const repoRoot = tempRepo("java-index-worker-lease-");
  writeJavaFile(repoRoot, "src/main/java/demo/Solo.java", "package demo;\n\nclass Solo {}\n");
  const leaseRoot = tempRepo("java-index-worker-lease-root-");
  const identity = identityFor(repoRoot, "repo-under-test");

  // Pre-claim the sole sweep slot directly, simulating another process's
  // in-progress sweep holding the machine-wide resource.
  const rivalStore = new FileCrossProcessLeaseStore(leaseRoot, defaultLeaseClockDeps());
  await rivalStore.open({ jdtSlots: 0, sweepSlots: 1 });
  const rivalLease = await rivalStore.acquireSweep(identity, DeadlineBudget.fromTimeout(1000));

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1, { leaseRoot, worktree: identity });

  await client.reconcile(1);

  const start = Date.now();
  await client.queryFiles([]);
  assert.ok(Date.now() - start < 1000, "a foreground query must not wait on the sweep lease");

  await new Promise(resolve => setTimeout(resolve, 200));
  const midStatus = await client.status();
  assert.ok(
    midStatus.coverage.every(entry => entry.state !== "COMPLETE"),
    "the sweep must still be blocked on the lease while the rival holds it"
  );

  await rivalLease.release();

  await waitFor(async () => {
    const status = await client.status();
    return status.coverage.length > 0 && status.coverage.every(entry => entry.state === "COMPLETE");
  }, 15000);

  await client.close();
});

test("a file's own sourceRoot matches the repo-wide discovery root under a modules/X layout", async () => {
  // layout-probe.ts's discovery keeps the "modules/" prefix for a
  // modules/<name> layout (e.g. "modules/foo/src/main/java"), while
  // classifyPath's module alone would synthesize "foo/src/main/java" if
  // resolveSourceRoot did not defer to the discovered source root list -
  // a mismatch here would silently split coverage tracking and manifest
  // fingerprints across two different root keys for the same directory.
  const repoRoot = tempRepo("java-index-worker-modules-layout-");
  const file = "modules/foo/src/main/java/demo/Widget.java";
  writeJavaFile(repoRoot, file, "package demo;\n\nclass Widget {}\n");

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

  const swept = await client.status();
  assert.deepEqual(swept.coverage.map(entry => entry.root), ["modules/foo/src/main/java"]);
  assert.ok(swept.coverage.every(entry => entry.state === "COMPLETE"));

  const bundle = (await client.queryFiles([path.join(repoRoot, file)]))[0]!;
  assert.equal(
    bundle.file.sourceRoot,
    "modules/foo/src/main/java",
    "a single file's own sourceRoot must match the repo-wide discovery root exactly"
  );

  // A foreground refresh of that same file must key onto the exact same
  // coverage entry, not silently create/target a differently-spelled root.
  await client.refresh(2, [path.join(repoRoot, file)], []);
  const afterRefresh = await client.status();
  assert.deepEqual(afterRefresh.coverage.map(entry => entry.root), ["modules/foo/src/main/java"]);
  assert.ok(afterRefresh.coverage.every(entry => entry.state === "COMPLETE" && entry.generation === 2));

  await client.close();
});

test("a diff too large to apply inline is abandoned in favor of an ordinary leased, chunked reconcile", async () => {
  // Models a partial snapshot recovering from an unclean shutdown, or a large
  // branch switch: the manifest diff vastly exceeds what OPEN should ever
  // parse synchronously and without the sweep lease.
  const repoRoot = tempRepo("java-index-worker-snapshot-large-diff-");
  writeJavaFile(repoRoot, "src/main/java/demo/Seed.java", "package demo;\n\nclass Seed {}\n");
  const cacheDir = tempCacheDir();

  const first = new JavaIndexClient(repoRoot, cacheDir);
  await first.open(1);
  await first.reconcile(1);
  await waitFor(async () => (await first.status()).pendingBackground === 0, 5000);
  await first.close();

  for (let i = 0; i < 210; i += 1) {
    writeJavaFile(repoRoot, `src/main/java/demo/Added${i}.java`, `package demo;\n\nclass Added${i} {}\n`);
  }

  const second = new JavaIndexClient(repoRoot, cacheDir);
  const openStatus = await second.open(1);
  assert.equal(
    openStatus.indexedGeneration,
    1,
    "an oversized diff must not bump the generation - it is abandoned, not applied"
  );
  assert.ok(
    openStatus.coverage.every(entry => entry.state !== "COMPLETE"),
    "an oversized diff must leave roots provisional, not silently promote them"
  );

  // Mirrors what repo-runtime-manager.createEntry does: a not-fully-restored
  // open triggers an ordinary reconcile().
  await second.reconcile(2);
  await waitFor(async () => (await second.status()).pendingBackground === 0, 15000);

  const finalStatus = await second.status();
  assert.equal(finalStatus.files, 211, "the full, governed sweep must still discover every file");
  assert.ok(finalStatus.coverage.every(entry => entry.state === "COMPLETE"));

  await second.close();
});

test("a full sweep's completion persists a snapshot that a fresh client restores without re-parsing", async () => {
  const repoRoot = tempRepo("java-index-worker-snapshot-restore-");
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  writeJavaFile(repoRoot, "src/main/java/demo/Impl.java", "package demo;\n\nclass Impl implements Gateway {}\n");
  const cacheDir = tempCacheDir();

  const first = new JavaIndexClient(repoRoot, cacheDir);
  await first.open(7);
  await first.reconcile(7);
  await waitFor(async () => (await first.status()).pendingBackground === 0, 5000);
  const firstStatus = await first.status();
  assert.ok(firstStatus.coverage.every(entry => entry.state === "COMPLETE"));
  assert.equal(firstStatus.snapshot?.state, "DURABLE");
  await first.close();

  assert.ok(
    existsSync(path.join(cacheDir, SNAPSHOT_FILE_NAME)),
    "a full sweep's completion must persist a snapshot without waiting for CLOSE"
  );

  const second = new JavaIndexClient(repoRoot, cacheDir);
  const openStatus = await second.open(1);
  assert.equal(openStatus.files, 0, "OPEN must not synchronously deserialize the full snapshot payload");
  assert.ok(openStatus.pendingBackground > 0, "OPEN must return before the snapshot manifest verification finishes");
  assert.ok(
    openStatus.coverage.every(entry => entry.state === "BUILDING"),
    `unverified restored facts must not claim COMPLETE coverage, got ${JSON.stringify(openStatus.coverage)}`
  );
  await waitFor(async () => (await second.status()).pendingBackground === 0, 5000);
  const restoredStatus = await second.status();
  assert.equal(restoredStatus.files, 2, "facts must be restored from the snapshot after background hydration");
  assert.equal(
    restoredStatus.indexedGeneration,
    1,
    "a snapshot from a prior process must be adopted into the new coordinator generation"
  );
  assert.ok(
    restoredStatus.coverage.every(entry => entry.state === "COMPLETE" && entry.generation === restoredStatus.indexedGeneration),
    `expected every root restored COMPLETE without a re-parse, got ${JSON.stringify(restoredStatus.coverage)}`
  );
  assert.equal(restoredStatus.snapshot?.state, "PENDING");
  assert.equal(restoredStatus.snapshot.durableGeneration, 7, "the old bytes retain their literal generation identity");
  assert.equal(restoredStatus.snapshot.durableManifestFingerprint, firstStatus.snapshot.durableManifestFingerprint);
  assert.equal(restoredStatus.snapshotBytes, readFileSync(path.join(cacheDir, SNAPSHOT_FILE_NAME)).length);

  const rewrittenStatus = await second.flush();
  assert.equal(rewrittenStatus.snapshot?.state, "DURABLE");
  assert.equal(rewrittenStatus.snapshot.durableGeneration, 1, "FLUSH rewrites the adopted facts in the current generation domain");

  const gatewayBundle = (await second.queryFiles([path.join(repoRoot, "src/main/java/demo/Gateway.java")]))[0]!;
  const implBundle = (await second.queryFiles([path.join(repoRoot, "src/main/java/demo/Impl.java")]))[0]!;
  assert.equal(gatewayBundle.file.generation, 1);
  assert.equal(implBundle.file.generation, 1);
  const gateway = gatewayBundle.types.find(t => t.simpleName === "Gateway")!;
  assert.ok(
    implBundle.edges.some(e => e.kind === "IMPLEMENTS" && e.toId === gateway.typeId),
    "a restored snapshot's facts must include the same resolved edges the original sweep produced"
  );

  await second.refresh(2, [path.join(repoRoot, "src/main/java/demo/Impl.java")], []);
  assert.equal((await second.status()).indexedGeneration, 2, "the first watcher generation after restore must apply normally");

  await second.close();
});

test("a file edited while the index was closed is detected and only that file is re-parsed on reopen", async () => {
  const repoRoot = tempRepo("java-index-worker-snapshot-diff-");
  const editedFile = "src/main/java/demo/Impl.java";
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  writeJavaFile(repoRoot, editedFile, "package demo;\n\nclass Impl implements Gateway {}\n");
  const cacheDir = tempCacheDir();

  const first = new JavaIndexClient(repoRoot, cacheDir);
  await first.open(1);
  await first.reconcile(1);
  await waitFor(async () => (await first.status()).pendingBackground === 0, 5000);
  await first.close();

  // Simulate an edit made while no process had this repo open (e.g. a branch
  // switch), so no REFRESH/RECONCILE ever told a running worker about it.
  writeJavaFile(repoRoot, editedFile, "package demo;\n\nclass Impl implements Gateway { void extra() {} }\n");

  const second = new JavaIndexClient(repoRoot, cacheDir);
  const openStatus = await second.open(1);
  assert.ok(openStatus.pendingBackground > 0, "the reopened snapshot is verified after OPEN responds");
  await waitFor(async () => (await second.status()).pendingBackground === 0, 5000);
  const verifiedStatus = await second.status();
  assert.equal(
    verifiedStatus.indexedGeneration,
    1,
    "offline snapshot repair belongs to the new coordinator's OPEN generation"
  );
  assert.ok(
    verifiedStatus.coverage.every(entry => entry.state === "COMPLETE" && entry.generation === verifiedStatus.indexedGeneration),
    `expected every root to reach COMPLETE at the new generation, got ${JSON.stringify(verifiedStatus.coverage)}`
  );

  const implBundle = (await second.queryFiles([path.join(repoRoot, editedFile)]))[0]!;
  const implType = implBundle.types.find(t => t.simpleName === "Impl")!;
  assert.equal(implType.methodIds.length, 1, "the edited file's new method must be reflected without a full sweep");

  await second.close();
});

test("FLUSH writes the current facts immediately, ahead of the debounce timer", async () => {
  const repoRoot = tempRepo("java-index-worker-flush-");
  const file = "src/main/java/demo/Solo.java";
  writeJavaFile(repoRoot, file, "package demo;\n\nclass Solo {}\n");
  const cacheDir = tempCacheDir();

  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.refresh(2, [path.join(repoRoot, file)], []);
  await client.flush();

  const snapshotPath = path.join(cacheDir, SNAPSHOT_FILE_NAME);
  assert.ok(existsSync(snapshotPath), "FLUSH must write the snapshot without waiting for the debounce timer");
  const bytesAtFlush = readFileSync(snapshotPath).length;
  assert.ok(bytesAtFlush > 0);

  await client.close();
});

test("HIBERNATE unloads facts then a query reheats from the v4 snapshot", async () => {
  const repoRoot = tempRepo("java-index-worker-hibernate-");
  const file = "src/main/java/demo/Solo.java";
  writeJavaFile(repoRoot, file, "package demo;\n\nclass Solo {}\n");
  const cacheDir = tempCacheDir();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.refresh(1, [path.join(repoRoot, file)], []);
  await client.flush();
  const before = (await client.queryFiles([path.join(repoRoot, file)]))[0];
  assert.ok(before);
  assert.equal(before.types.some(type => type.simpleName === "Solo"), true);

  const hibernated = await client.hibernate();
  assert.equal(hibernated.hibernated, true);
  assert.equal(typeof hibernated.heapUsedBytes, "number");

  const after = (await client.queryFiles([path.join(repoRoot, file)]))[0];
  assert.ok(after);
  assert.equal(after.types.some(type => type.simpleName === "Solo"), true);
  assert.equal(after.file.contentHash, before.file.contentHash);
  const woke = await client.status();
  assert.equal(woke.hibernated, undefined);

  await client.close();
});

test("OPEN leaves the knowledge graph unloaded until a graph query", async () => {
  const repoRoot = tempRepo("java-index-worker-lazy-graph-");
  writeJavaFile(repoRoot, "src/main/java/demo/Solo.java", "package demo;\n\nclass Solo { void run() { Solo.x(); } }\n");
  const cacheDir = tempCacheDir();
  const writer = new JavaIndexClient(repoRoot, cacheDir);
  await writer.open(1);
  await writer.reconcile(1);
  await waitFor(async () => (await writer.status()).pendingBackground === 0, 8000);
  await writer.flush();
  await writer.close();

  const reader = new JavaIndexClient(repoRoot, cacheDir);
  await reader.open(1);
  await waitFor(async () => (await reader.status()).pendingBackground === 0, 8000);
  const digest = await reader.queryGraphDigest();
  assert.ok(digest.nodes > 0, "QUERY_GRAPH_DIGEST must unpack the on-disk graph after OPEN");
  const files = await reader.queryFiles([path.join(repoRoot, "src/main/java/demo/Solo.java")]);
  assert.equal(files[0]?.types.some(type => type.simpleName === "Solo"), true);
  await reader.close();
});

test("sibling-seeded reconcile re-parses only target-side diffs while preserving reusable facts", async () => {
  const siblingRepo = tempRepo("java-index-worker-sibling-source-");
  writeJavaFile(siblingRepo, "src/main/java/demo/Same.java", "package demo;\n\nclass Same {}\n");
  writeJavaFile(siblingRepo, "src/main/java/demo/Changed.java", "package demo;\n\nclass Changed {}\n");
  const cacheBase = tempCacheDir();
  const siblingCacheDir = path.join(cacheBase, "sibling");
  const siblingClient = new JavaIndexClient(siblingRepo, siblingCacheDir);
  await siblingClient.open(1);
  await siblingClient.reconcile(1);
  await waitFor(async () => (await siblingClient.status()).pendingBackground === 0, 5000);
  await siblingClient.close();
  writeFileSync(
    path.join(siblingCacheDir, "repo-meta.json"),
    JSON.stringify({ repoRoot: siblingRepo, repoHash: "sibling-repo-hash", familyHash: "shared-family" })
  );

  const targetRepo = tempRepo("java-index-worker-sibling-target-");
  writeJavaFile(targetRepo, "src/main/java/demo/Same.java", "package demo;\n\nclass Same {}\n");
  writeJavaFile(targetRepo, "src/main/java/demo/Changed.java", "package demo;\n\nclass Changed { void targetOnly() {} }\n");
  const identity: WorktreeIdentity = {
    repoRoot: targetRepo,
    repoHash: "target-repo-hash",
    familyHash: "shared-family",
    isLinkedWorktree: true
  };

  const client = new JavaIndexClient(targetRepo, tempCacheDir());
  const openStatus = await client.open(1, { worktree: identity, siblingCacheBase: cacheBase });

  assert.equal(openStatus.worktreeSeed?.completion, "SEEDED_DEGRADED");
  assert.equal(openStatus.worktreeSeed?.reusedFiles, 1);
  assert.equal(openStatus.worktreeSeed?.dirtyFiles, 1);
  assert.equal(openStatus.worktreeSeed?.relinkFiles, 0);
  assert.equal(openStatus.worktreeSeed?.droppedCrossFileEdges, 0);
  assert.equal(openStatus.worktreeSeed?.deltaParsedFiles, 0);
  assert.ok((openStatus.worktreeSeed?.manifestValidationMs ?? 0) >= 0);
  assert.equal(openStatus.files, 1, "the seeded store's facts must be visible immediately, before any sweep runs");
  assert.ok(
    openStatus.coverage.every(entry => entry.state === "DEGRADED"),
    `seeded coverage must never read COMPLETE before the target's own reconcile, got ${JSON.stringify(openStatus.coverage)}`
  );

  const bundle = (await client.queryFiles([path.join(targetRepo, "src/main/java/demo/Same.java")]))[0];
  assert.ok(bundle, "a reused file's facts must already answer a query right after OPEN");
  assert.equal(
    (await client.queryFiles([path.join(targetRepo, "src/main/java/demo/Changed.java")])).length,
    0,
    "a target-side changed file must not be exposed from the sibling snapshot"
  );

  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);
  const reconciled = await client.status();
  assert.equal(reconciled.worktreeSeed?.completion, "RECONCILED_COMPLETE");
  assert.equal(reconciled.worktreeSeed?.deltaParsedFiles, 1);
  const changed = (await client.queryFiles([path.join(targetRepo, "src/main/java/demo/Changed.java")]))[0]!;
  assert.equal(changed.methods.length, 1, "the target-side diff must be parsed during reconcile");

  await client.close();
});

test("two target processes can seed concurrently and leave a manifest-validated target snapshot", async () => {
  const siblingRepo = tempRepo("java-index-concurrent-seed-source-");
  const relativePath = "src/main/java/demo/Same.java";
  writeJavaFile(siblingRepo, relativePath, "package demo;\n\nclass Same {}\n");
  const cacheBase = tempCacheDir();
  const siblingCacheDir = path.join(cacheBase, "sibling");
  const siblingClient = new JavaIndexClient(siblingRepo, siblingCacheDir);
  await siblingClient.open(1);
  await siblingClient.reconcile(1);
  await waitFor(async () => (await siblingClient.status()).pendingBackground === 0, 5000);
  await siblingClient.close();
  writeFileSync(
    path.join(siblingCacheDir, "repo-meta.json"),
    JSON.stringify({ repoRoot: siblingRepo, repoHash: "sibling-concurrent-hash", familyHash: "shared-concurrent-family" })
  );

  const targetRepo = tempRepo("java-index-concurrent-seed-target-");
  writeJavaFile(targetRepo, relativePath, "package demo;\n\nclass Same {}\n");
  const targetCacheDir = path.join(cacheBase, "target");
  const identity: WorktreeIdentity = {
    repoRoot: targetRepo,
    repoHash: "target-concurrent-hash",
    familyHash: "shared-concurrent-family",
    isLinkedWorktree: true
  };
  const first = new JavaIndexClient(targetRepo, targetCacheDir);
  const second = new JavaIndexClient(targetRepo, targetCacheDir);
  const [firstOpen, secondOpen] = await Promise.all([
    first.open(1, { worktree: identity, siblingCacheBase: cacheBase }),
    second.open(1, { worktree: identity, siblingCacheBase: cacheBase })
  ]);
  assert.equal(firstOpen.worktreeSeed?.completion, "SEEDED_DEGRADED");
  assert.equal(secondOpen.worktreeSeed?.completion, "SEEDED_DEGRADED");

  await Promise.all([first.reconcile(1), second.reconcile(1)]);
  await waitFor(async () => (await first.status()).pendingBackground === 0 && (await second.status()).pendingBackground === 0, 10000);
  await Promise.all([first.flush(), second.flush()]);
  await Promise.all([first.close(), second.close()]);

  const layout = probeLayout(targetRepo);
  const snapshot = await loadSnapshot(path.join(targetCacheDir, SNAPSHOT_FILE_NAME), {
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: targetRepo,
    buildFingerprint: await computeBuildFingerprint(targetRepo, layout)
  });
  assert.ok(snapshot, "concurrent atomic writers must leave one readable target snapshot");
  assert.equal(snapshot!.manifestFingerprint, await computeCurrentManifestFingerprint(targetRepo, layout));
});

test("a malformed sibling snapshot fails the seed attempt softly - OPEN still succeeds with an empty store", async () => {
  const siblingRepo = tempRepo("java-index-worker-bad-sibling-source-");
  writeJavaFile(siblingRepo, "src/main/java/demo/Solo.java", "package demo;\n\nclass Solo {}\n");
  const cacheBase = tempCacheDir();
  const siblingCacheDir = path.join(cacheBase, "sibling");
  const siblingClient = new JavaIndexClient(siblingRepo, siblingCacheDir);
  await siblingClient.open(1);
  await siblingClient.reconcile(1);
  await waitFor(async () => (await siblingClient.status()).pendingBackground === 0, 5000);
  await siblingClient.close();

  // Corrupt the otherwise-identity-matching snapshot: duplicate a file entry,
  // which JavaIndexStore.loadSnapshotData() rejects by throwing.
  const snapshotPath = path.join(siblingCacheDir, "java-index-snapshot.json.gz");
  const raw = await loadSnapshot(snapshotPath, {
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: siblingRepo,
    buildFingerprint: (await computeBuildFingerprint(siblingRepo, probeLayout(siblingRepo)))!
  });
  assert.ok(raw);
  raw.files.push({ ...raw.files[0]! });
  await writeSnapshotAtomic(snapshotPath, raw);
  writeFileSync(
    path.join(siblingCacheDir, "repo-meta.json"),
    JSON.stringify({ repoRoot: siblingRepo, repoHash: "sibling-repo-hash", familyHash: "shared-family" })
  );

  const targetRepo = tempRepo("java-index-worker-bad-sibling-target-");
  writeJavaFile(targetRepo, "src/main/java/demo/Target.java", "package demo;\n\nclass Target {}\n");
  const identity: WorktreeIdentity = {
    repoRoot: targetRepo,
    repoHash: "target-repo-hash",
    familyHash: "shared-family",
    isLinkedWorktree: true
  };

  const client = new JavaIndexClient(targetRepo, tempCacheDir());
  const openStatus = await client.open(1, { worktree: identity, siblingCacheBase: cacheBase });

  assert.equal(openStatus.state, "READY", "OPEN must succeed even when the only sibling candidate is malformed");
  assert.equal(openStatus.worktreeSeed?.completion, "FAILED");
  assert.equal(openStatus.files, 0, "a failed seed must fall back to an empty store, never partial/garbage facts");

  await client.close();
});

function writeResourceFile(repoRoot: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

const ORDER_MAPPER_XML = '<mapper namespace="demo.OrderMapper"><select id="findById" resultType="demo.OrderEntity">select 1</select></mapper>';

test("reconcile()'s full sweep discovers and indexes MyBatis mapper resources, but not a well-formed non-mapper XML resource", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-sweep-");
  writeResourceFile(repoRoot, "src/main/resources/mapper/OrderMapper.xml", ORDER_MAPPER_XML);
  writeResourceFile(repoRoot, "src/main/resources/beans.xml", '<beans><bean id="x"/></beans>');

  const cacheDir = tempCacheDir();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

  const facts = await client.queryMyBatisResource("src/main/resources/mapper/OrderMapper.xml");
  assert.equal(facts?.namespace, "demo.OrderMapper");
  assert.deepEqual(facts?.statements.map(s => s.id), ["findById"]);
  assert.equal(facts?.parseState, "COMPLETE");

  assert.equal(await client.queryMyBatisResource("src/main/resources/beans.xml"), undefined);

  const status = await client.status();
  assert.deepEqual(status.resourceCoverage, [{
    root: "src/main/resources",
    generation: 1,
    state: "COMPLETE",
    discoveredFiles: 1,
    indexedFiles: 1,
    failedFiles: 0
  }]);

  await client.flush();
  const snapshot = await loadSnapshot(path.join(cacheDir, SNAPSHOT_FILE_NAME), {
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: repoRoot,
    buildFingerprint: await computeBuildFingerprint(repoRoot, probeLayout(repoRoot))
  });
  assert.deepEqual(snapshot?.resourceCoverage, status.resourceCoverage);
  assert.equal(snapshot?.manifestFingerprint, await computeCurrentSnapshotManifestFingerprint(repoRoot, probeLayout(repoRoot)));

  await client.close();
});

test("reconcile() indexes a mapper even when more than 500 non-mapper XML resources sort before it", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-many-resources-");
  for (let index = 0; index <= 500; index += 1) {
    writeResourceFile(repoRoot, `src/main/resources/a-${String(index).padStart(3, "0")}.xml`, "<beans/>");
  }
  const mapperPath = "src/main/resources/z-mapper/OrderMapper.xml";
  writeResourceFile(repoRoot, mapperPath, ORDER_MAPPER_XML);

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  try {
    await client.open(1);
    await client.reconcile(1);
    await waitFor(async () => (await client.status()).pendingBackground === 0, 15000);

    assert.equal(
      (await client.queryMyBatisResource(mapperPath))?.namespace,
      "demo.OrderMapper",
      "a mapper must never be silently dropped by an XML-count cap"
    );
  } finally {
    await client.close();
  }
});

test("refreshResources upserts a mapper resource written after OPEN, without requiring a full reconcile", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-refresh-add-");
  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);

  writeResourceFile(repoRoot, "src/main/resources/mapper/OrderMapper.xml", ORDER_MAPPER_XML);
  await client.refreshResources(2, [path.join(repoRoot, "src/main/resources/mapper/OrderMapper.xml")]);

  const facts = await client.queryMyBatisResource("src/main/resources/mapper/OrderMapper.xml");
  assert.equal(facts?.namespace, "demo.OrderMapper");
  assert.deepEqual(facts?.statements.map(s => s.id), ["findById"]);

  await client.close();
});

test("refreshResources on a path that was never indexed and does not exist on disk is an idempotent no-op", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-refresh-noop-");
  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);

  const missingPath = path.join(repoRoot, "src/main/resources/mapper/NeverCreated.xml");
  await assert.doesNotReject(() => client.refreshResources(2, [missingPath]));
  assert.equal(await client.queryMyBatisResource("src/main/resources/mapper/NeverCreated.xml"), undefined);
  // Repeating the same no-op refresh must stay a no-op, not accumulate state or throw.
  await assert.doesNotReject(() => client.refreshResources(3, [missingPath]));
  assert.equal(await client.queryMyBatisResource("src/main/resources/mapper/NeverCreated.xml"), undefined);

  await client.close();
});

test("refreshResources re-extracts a changed mapper file and leaves an unchanged one intact", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-refresh-change-");
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  writeResourceFile(repoRoot, relativePath, ORDER_MAPPER_XML);
  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.refreshResources(2, [path.join(repoRoot, relativePath)]);
  assert.deepEqual((await client.queryMyBatisResource(relativePath))?.statements.map(s => s.id), ["findById"]);

  // Same content again - must remain correct, not just "not throw".
  await client.refreshResources(3, [path.join(repoRoot, relativePath)]);
  assert.deepEqual((await client.queryMyBatisResource(relativePath))?.statements.map(s => s.id), ["findById"]);

  const changed = '<mapper namespace="demo.OrderMapper"><select id="findById">x</select><insert id="insert">y</insert></mapper>';
  writeResourceFile(repoRoot, relativePath, changed);
  await client.refreshResources(4, [path.join(repoRoot, relativePath)]);
  assert.deepEqual((await client.queryMyBatisResource(relativePath))?.statements.map(s => s.id).sort(), ["findById", "insert"]);

  await client.close();
});

test("refreshResources removes a resource once its file is deleted, idempotently across repeated events", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-refresh-delete-");
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  const absolutePath = path.join(repoRoot, relativePath);
  writeResourceFile(repoRoot, relativePath, ORDER_MAPPER_XML);
  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);
  await client.refreshResources(2, [absolutePath]);
  assert.ok(await client.queryMyBatisResource(relativePath));

  rmSync(absolutePath);
  await client.refreshResources(3, [absolutePath]);
  assert.equal(await client.queryMyBatisResource(relativePath), undefined);

  // A second delete event for the same already-absent path (a duplicate
  // watcher event, or the unlink racing a later re-create that hasn't
  // landed yet) must stay a clean no-op.
  await assert.doesNotReject(() => client.refreshResources(4, [absolutePath]));
  assert.equal(await client.queryMyBatisResource(relativePath), undefined);

  await client.close();
});

test("an own-snapshot restore re-derives MyBatis resources even when Java facts verify clean and queue no reconcile", async () => {
  const repoRoot = tempRepo("java-index-worker-mybatis-restore-");
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  const relativePath = "src/main/resources/mapper/OrderMapper.xml";
  writeResourceFile(repoRoot, relativePath, ORDER_MAPPER_XML);
  const cacheDir = tempCacheDir();

  const first = new JavaIndexClient(repoRoot, cacheDir);
  await first.open(1);
  await first.reconcile(1);
  await waitFor(async () => (await first.status()).pendingBackground === 0, 5000);
  assert.deepEqual((await first.queryMyBatisResource(relativePath))?.statements.map(s => s.id), ["findById"]);
  const firstStatus = await first.status();
  assert.equal(firstStatus.snapshot?.state, "DURABLE");
  await first.close();

  // Edited while the process was closed - Java facts are untouched, so the
  // restore's Java-side verification takes the fast metadata-match path and
  // queues no reconcile. Only the explicit MyBatis re-derivation call (not
  // gated on Java's own verification outcome) can pick this up.
  const changed = '<mapper namespace="demo.OrderMapper"><select id="findById">x</select><insert id="insert">y</insert></mapper>';
  writeResourceFile(repoRoot, relativePath, changed);

  const second = new JavaIndexClient(repoRoot, cacheDir);
  await second.open(1);
  await waitFor(async () => (await second.status()).pendingBackground === 0, 5000);
  const restoredStatus = await second.status();
  assert.ok(
    restoredStatus.coverage.every(entry => entry.state === "COMPLETE"),
    `expected the unrelated Java restore to still take the clean fast path, got ${JSON.stringify(restoredStatus.coverage)}`
  );
  assert.equal(restoredStatus.snapshot?.state, "PENDING", "changed resource facts must not leave the old manifest DURABLE");
  assert.equal(restoredStatus.snapshot.durableManifestFingerprint, firstStatus.snapshot.durableManifestFingerprint);

  const facts = await second.queryMyBatisResource(relativePath);
  assert.deepEqual(facts?.statements.map(s => s.id).sort(), ["findById", "insert"], "the changed mapper must be re-derived, not served stale from the restored snapshot");

  const flushed = await second.flush();
  assert.equal(flushed.snapshot?.state, "DURABLE");
  assert.equal(flushed.snapshot.durableGeneration, 1);
  assert.notEqual(flushed.snapshot.durableManifestFingerprint, firstStatus.snapshot.durableManifestFingerprint);
  const persisted = await loadSnapshot(path.join(cacheDir, SNAPSHOT_FILE_NAME), {
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: repoRoot,
    buildFingerprint: await computeBuildFingerprint(repoRoot, probeLayout(repoRoot))
  });
  assert.deepEqual(
    persisted?.myBatisResources[0]?.statements.map(statement => statement.id).sort(),
    ["findById", "insert"]
  );

  await second.close();
});
