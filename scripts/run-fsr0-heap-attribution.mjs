#!/usr/bin/env node
// Isolated FSR0 three-state STATUS + optional heap snapshot. Not a fourth :38456 daemon.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDoc = path.join(ROOT, "docs/phase-fs/fsr0-heap-attribution.json");
const scratch = process.env.FSR0_SCRATCH || path.join(ROOT, "docs/phase-fs");

const { SqlJavaIndexClient } = await import(pathToFileURL(path.join(ROOT, "dist/java-index/sql/sql-client.js")).href);

function writeJavaFile(repoRoot, relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timeout ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

function splitOf(status) {
  const hs = status.heapSplit ?? {};
  return {
    heapUsedMb: hs.heapUsedMb,
    files: status.files,
    factsHydrated: status.factsHydrated,
    hydrateBaselineHeapMb: status.hydrateBaselineHeapMb,
    pendingIdleRecycle: status.pendingIdleRecycle ?? false,
    donorStoreBytes: hs.donorStoreBytes,
    overlayBytes: hs.overlayBytes,
    graphBytes: hs.graphBytes,
    parseTreeCacheBytes: hs.parseTreeCacheBytes,
    columnarBytes: hs.columnarBytes,
    stringTableBytes: hs.stringTableBytes,
    rangePoolMemoBytes: hs.rangePoolMemoBytes,
    bundleObjectBytes: hs.bundleObjectBytes,
    registryBytes: hs.registryBytes,
    knowledgeBuilderBytes: hs.knowledgeBuilderBytes,
    entitySearchBytes: hs.entitySearchBytes,
    otherBytes: hs.otherBytes,
    accountedShare: hs.heapUsedMb
      ? 1 - (hs.otherBytes ?? 0) / (hs.heapUsedMb * 1024 * 1024)
      : null
  };
}

async function fixtureThreeState() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "fsr0-fixture-"));
  writeJavaFile(repoRoot, "src/main/java/demo/A.java", "package demo;\nclass A { void run() {} }\n");
  writeJavaFile(repoRoot, "src/main/java/demo/B.java", "package demo;\nclass B extends A { void run() { super.run(); } }\n");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "fsr0-cache-"));
  const client = new SqlJavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 15000);
  const afterInProcess = splitOf(await client.status());
  await client.flush();
  await client.close();

  const hydrated = new SqlJavaIndexClient(repoRoot, cacheDir);
  await hydrated.open(1);
  try {
    await hydrated.queryRepositoryFactMarkers([], []);
  } catch {
    // hydrate kick; ignore deadline
  }
  await waitFor(async () => (await hydrated.status()).factsHydrated === true, 15000);
  const afterHydrate = splitOf(await hydrated.status());
  for (let i = 0; i < 50; i += 1) {
    writeJavaFile(repoRoot, "src/main/java/demo/A.java", `package demo;\nclass A { void run() { int x=${i}; } }\n`);
    await hydrated.refresh(i + 2, [path.join(repoRoot, "src/main/java/demo/A.java")], []);
  }
  const afterEdit = splitOf(await hydrated.status());
  await hydrated.close();
  return { afterHydrate, afterInProcess, afterEdit };
}

function orderFromSplit(split) {
  const rows = [
    ["bundleObjectBytes", split.bundleObjectBytes ?? 0],
    ["rangePoolMemoBytes", split.rangePoolMemoBytes ?? 0],
    ["registryBytes", split.registryBytes ?? 0],
    ["knowledgeBuilderBytes", split.knowledgeBuilderBytes ?? 0],
    ["entitySearchBytes", split.entitySearchBytes ?? 0],
    ["stringTableBytes", split.stringTableBytes ?? 0],
    ["columnarBytes", split.columnarBytes ?? 0],
    ["graphBytes", split.graphBytes ?? 0],
    ["otherBytes", split.otherBytes ?? 0]
  ].sort((a, b) => b[1] - a[1]);
  return rows.map(([name, bytes]) => ({ name, bytes }));
}

const fixture = await fixtureThreeState();
const suspects = ["bundleObjectBytes", "rangePoolMemoBytes", "registryBytes", "knowledgeBuilderBytes"];
const order = orderFromSplit(fixture.afterInProcess);
const other = fixture.afterInProcess.otherBytes ?? 0;
const suspectSum = suspects.reduce((sum, key) => sum + (fixture.afterInProcess[key] ?? 0), 0);
const preferredSurfaceTooLarge = other > 0 && suspectSum < other * 0.2;

const payload = {
  generatedAt: new Date().toISOString(),
  notes: {
    compactRebuildsRangePool: true,
    buildTypeRegistryViewRetained: false,
    knowledgeBuilderRetainsOnlyGraphStore: true,
    heapSnapshots: "STATUS-walked live structures; v8.writeHeapSnapshot optional via STATUS heapSnapshotPath"
  },
  fixture: fixture,
  fsr2Order: order,
  fsr2Decision: preferredSurfaceTooLarge
    ? "fallback-event-recycle"
    : "preferred-thin-bundle-then-memo-then-registry",
  productionScale: {
    attempted: false,
    reason: "filled after optional cache hydrate"
  }
};

writeFileSync(outDoc, `${JSON.stringify(payload, null, 2)}\n`);
if (scratch) {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(scratch, "fsr0-heap-attribution.json"), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(path.join(scratch, "fsr0-heap-split.json"), `${JSON.stringify(fixture, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ outDoc, fsr2Decision: payload.fsr2Decision, afterHydrate: fixture.afterHydrate.heapUsedMb, afterInProcess: fixture.afterInProcess.heapUsedMb, afterEdit: fixture.afterEdit.heapUsedMb }, null, 2)}\n`);
