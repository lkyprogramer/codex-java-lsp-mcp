import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { JavaIndexClient } from "./java-index-client.js";
import type { JavaIndexStatus } from "./index-types.js";

const FILE_COUNT = 220;
const REFRESH_CYCLES = 500;

function writeJavaFile(repoRoot: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

function heapBytes(status: { heapUsedBytes?: number; heapSplit?: { heapUsedMb?: number } }): number {
  if (typeof status.heapUsedBytes === "number") return status.heapUsedBytes;
  return (status.heapSplit?.heapUsedMb ?? 0) * 1024 * 1024;
}

async function awaitHydrated(client: JavaIndexClient, timeoutMs = 120_000): Promise<JavaIndexStatus> {
  const status = await client.awaitPrewarmReady({
    hydrate: true,
    budget: DeadlineBudget.fromTimeout(timeoutMs)
  });
  assert.equal(status.factsHydrated, true, "OPEN returns before rest hydrate; kick only after files-only snapshot is in");
  assert.equal(status.files, FILE_COUNT);
  return status;
}

test("FSR2: in-process rebuild plus recycle unifies worker heap to hydrate ±15%, and 500 REFRESH stays ±10%", { timeout: 300_000 }, async () => {
  process.env.JAVA_LSP_ISOLATED_VALIDATION = "1";
  delete process.env.JAVA_LSP_COLD_BUILD_CHILD;
  const repoRoot = mkdtempSync(path.join(tmpdir(), "fsr2-unify-repo-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "fsr2-unify-cache-"));
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeJavaFile(
      repoRoot,
      `src/main/java/demo/C${index}.java`,
      `package demo;\nclass C${index} { void run() { int x = ${index}; } }\n`
    );
  }
  const parser = new JavaIndexClient(repoRoot, cacheDir);
  const clients: JavaIndexClient[] = [parser];
  try {
  await parser.open(1);
  await parser.reconcile(1);
  await waitFor(async () => (await parser.status()).pendingBackground === 0, 120_000);
  const afterParse = await parser.status();
  assert.equal(afterParse.files, FILE_COUNT);
  assert.equal(afterParse.pendingIdleRecycle, true, "≥200 in-process files must request idle recycle");
  await parser.flush();
  const inProcessBytes = heapBytes(afterParse);
  await parser.recycle();

  const unified = new JavaIndexClient(repoRoot, cacheDir);
  clients.push(unified);
  await unified.open(1);
  const afterUnify = await awaitHydrated(unified);
  const unifyBytes = heapBytes(afterUnify);

  const hydrated = new JavaIndexClient(repoRoot, cacheDir);
  clients.push(hydrated);
  await hydrated.open(1);
  const afterHydrate = await awaitHydrated(hydrated);
  const hydrateBytes = heapBytes(afterHydrate);
  const originalBaselineMb = afterHydrate.hydrateBaselineHeapMb ?? afterHydrate.heapSplit?.heapUsedMb;
  assert.ok(typeof originalBaselineMb === "number" && originalBaselineMb > 0);
  const unifyDelta = Math.abs(unifyBytes - hydrateBytes) / Math.max(hydrateBytes, 1);
  assert.ok(
    unifyDelta <= 0.15,
    `unify heap ${unifyBytes} vs hydrate ${hydrateBytes} delta ${(unifyDelta * 100).toFixed(1)}% (in-process was ${inProcessBytes})`
  );

  const growPath = path.join(repoRoot, "src/main/java/demo/C0.java");
  const lastGeneration = REFRESH_CYCLES + 1;
  for (let generation = 2; generation <= lastGeneration; generation += 1) {
    writeJavaFile(
      repoRoot,
      "src/main/java/demo/C0.java",
      `package demo;\nclass C0 { void run() { int x = ${generation % 3}; } }\n`
    );
    await hydrated.refresh(generation, [growPath], []);
  }
  const bundles = await hydrated.queryFiles([growPath]);
  assert.ok(
    (bundles[0]?.file.generation ?? 0) >= lastGeneration,
    `500 REFRESH cycles must land on C0 (generation ${bundles[0]?.file.generation} < ${lastGeneration})`
  );
  await hydrated.flush();
  await hydrated.recycle();
  const afterCycles = new JavaIndexClient(repoRoot, cacheDir);
  clients.push(afterCycles);
  await afterCycles.open(lastGeneration + 1);
  const returned = await awaitHydrated(afterCycles);
  const returnedBytes = heapBytes(returned);
  const refreshDelta = Math.abs(returnedBytes - hydrateBytes) / Math.max(hydrateBytes, 1);
  assert.ok(
    refreshDelta <= 0.10,
    `500-cycle then rehydrate heap ${returnedBytes} vs original hydrate ${hydrateBytes} (baselineMb=${originalBaselineMb}) delta ${(refreshDelta * 100).toFixed(1)}%`
  );
  const reheated = await afterCycles.queryFiles([growPath]);
  assert.ok(
    (reheated[0]?.file.generation ?? 0) >= lastGeneration,
    `rehydrate must keep C0 generation ${reheated[0]?.file.generation} >= ${lastGeneration}`
  );
  } finally {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
  }
});
