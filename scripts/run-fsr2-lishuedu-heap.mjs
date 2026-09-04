#!/usr/bin/env node
// Isolated lishuedu hydrate vs recycle-unify. Uses a COPY of the snapshot cache, not the live :38456 dir.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { JavaIndexClient } = await import(pathToFileURL(path.join(ROOT, "dist/java-index/java-index-client.js")).href);

const repoRoot = process.env.LISHUEDU_ROOT || "/Users/luo/Documents/program/lishu/lishuedu";
const liveCache = path.join(homedir(), "Library/Caches/codex-java-lsp/6496e5a49fd9");
const outPath = process.argv[2];
if (!outPath) throw new Error("usage: run-fsr2-lishuedu-heap.mjs <output.txt>");
if (!existsSync(path.join(liveCache, "java-index-snapshot.json.gz"))) {
  writeFileSync(outPath, "skip: lishuedu snapshot missing\n");
  process.exit(0);
}

const cacheDir = path.join(path.dirname(outPath), "fsr2-lishuedu-cache");
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });
cpSync(liveCache, cacheDir, { recursive: true });

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timeout ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 100));
  }
}

function heapBytes(status) {
  if (typeof status.heapUsedBytes === "number") return status.heapUsedBytes;
  return (status.heapSplit?.heapUsedMb ?? 0) * 1024 * 1024;
}

async function hydrate(label) {
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  try {
    await waitFor(async () => {
      const status = await client.status();
      return (status.files ?? 0) > 1000 && (status.heapSplit?.heapUsedMb ?? 0) > 200;
    }, 90_000);
  } catch (error) {
    const status = await client.status().catch(() => ({}));
    throw new Error(`${error instanceof Error ? error.message : String(error)} last=${JSON.stringify({
      files: status.files,
      heap: status.heapSplit?.heapUsedMb,
      facts: status.factsHydrated,
      pending: status.pendingBackground,
      err: status.lastError
    })}`);
  }
  const status = await client.status();
  const row = {
    label,
    files: status.files,
    heapUsedBytes: heapBytes(status),
    heapUsedMb: status.heapSplit?.heapUsedMb,
    hydrateBaselineHeapMb: status.hydrateBaselineHeapMb,
    rangePoolMemoBytes: status.heapSplit?.rangePoolMemoBytes,
    bundleObjectBytes: status.heapSplit?.bundleObjectBytes,
    registryBytes: status.heapSplit?.registryBytes,
    otherBytes: status.heapSplit?.otherBytes
  };
  await client.recycle();
  return { client, row };
}

const first = await hydrate("hydrate");
await first.client.close().catch(() => undefined);
const second = await hydrate("unify-after-recycle");
await second.client.close().catch(() => undefined);
const delta = Math.abs(second.row.heapUsedBytes - first.row.heapUsedBytes) / Math.max(first.row.heapUsedBytes, 1);
const pass = delta <= 0.15;
const text = [
  `lishuedu hydrate vs recycle-unify (cache copy, not live daemon)`,
  `repoRoot=${repoRoot}`,
  `files=${first.row.files}`,
  `hydrateBytes=${first.row.heapUsedBytes} mb=${first.row.heapUsedMb} baseline=${first.row.hydrateBaselineHeapMb}`,
  `unifyBytes=${second.row.heapUsedBytes} mb=${second.row.heapUsedMb} baseline=${second.row.hydrateBaselineHeapMb}`,
  `delta=${(delta * 100).toFixed(1)}% gate=15% pass=${pass}`,
  `hydrateSplit memo=${first.row.rangePoolMemoBytes} bundles=${first.row.bundleObjectBytes} registry=${first.row.registryBytes} other=${first.row.otherBytes}`,
  `unifySplit memo=${second.row.rangePoolMemoBytes} bundles=${second.row.bundleObjectBytes} registry=${second.row.registryBytes} other=${second.row.otherBytes}`
].join("\n") + "\n";
writeFileSync(outPath, text);
process.stdout.write(text);
process.exitCode = pass ? 0 : 1;
