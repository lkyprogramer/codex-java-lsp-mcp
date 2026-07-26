import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore
} from "../cross-process-lease.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { WorktreeIdentity } from "../worktree-identity.js";
import { JavaIndexClient } from "./java-index-client.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function tempCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), "java-index-worker-cache-"));
}

function writeJavaFile(repoRoot: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function identityFor(repoRoot: string, repoHash: string): WorktreeIdentity {
  return { repoRoot, repoHash, isLinkedWorktree: false };
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

  const client = new JavaIndexClient(repoRoot, tempCacheDir());
  await client.open(1);

  const afterReconcile = await client.reconcile(1);
  assert.ok(afterReconcile.pendingBackground >= 0, "reconcile() returns promptly, not waiting for the sweep");

  await waitFor(async () => (await client.status()).pendingBackground === 0, 5000);

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
