#!/usr/bin/env node
// input: compiled dist/ tests plus FSY_TAP_DIR (absolute, host-writable).
// output: fsy1/2/3 TAP files, fsy2-heap-growth.jsonl from a measured worker STATUS.
// pos: FSY verification helper; must run inside run-isolated-validation.mjs --profile targeted.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";

const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tapDir = process.env.FSY_TAP_DIR;
if (!tapDir) {
  throw new Error("FSY_TAP_DIR is required");
}

function runTests(tapFile, files) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
      cwd: candidateRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("exit", code => {
      writeFileSync(tapFile, Buffer.concat(chunks));
      code === 0 ? resolve() : reject(new Error(`${tapFile} failed with ${code}`));
    });
  });
}

await runTests(path.join(tapDir, "fsy1-unit.tap"), ["dist/repo-runtime-manager.test.js"]);
await runTests(path.join(tapDir, "fsy2-unit.tap"), [
  "dist/java-index/bounded-json.test.js",
  "dist/java-index/worker-protocol.test.js",
  "dist/java-index/java-index-worker.test.js",
  "dist/java-index/shared-facts-pool.test.js",
  "dist/java-index/snapshot-v4.test.js"
]);
await runTests(path.join(tapDir, "fsy3-unit.tap"), [
  "dist/worktree-cache-cleanup.test.js",
  "dist/telemetry/impact-telemetry.test.js"
]);

const repo = path.join(candidateRoot, "fixtures", "java-index-v2");
const cache = mkdtempSync(path.join(tmpdir(), "fsy2-heap-"));
const client = new SqlJavaIndexClient(repo, path.join(cache, "index.sqlite"));
await client.open(1);
await client.reconcile(1);
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const pending = await client.status();
  if ((pending.pendingBackground ?? 0) === 0) break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
const status = await client.status();
const sample = {
  sampledAt: new Date().toISOString(),
  source: "fixtures/java-index-v2 OPEN+reconcile STATUS (measured)",
  heapUsedBytes: status.heapUsedBytes,
  files: status.files,
  heapSplit: status.heapSplit
};
writeFileSync(path.join(tapDir, "fsy2-heap-growth.jsonl"), `${JSON.stringify(sample)}\n`);
console.log(`FSY2_HEAP_SAMPLE ${JSON.stringify(sample)}`);
await client.close();
