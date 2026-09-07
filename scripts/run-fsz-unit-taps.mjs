#!/usr/bin/env node
// input: compiled dist/ tests plus FSZ_TAP_DIR (absolute, host-writable).
// output: fsz1/2/3 TAP files and a measured worker STATUS heapSplit sample.
// pos: FSZ verification helper; must run inside run-isolated-validation.mjs --profile targeted.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";

const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tapDir = process.env.FSZ_TAP_DIR;
if (!tapDir) {
  throw new Error("FSZ_TAP_DIR is required");
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

await runTests(path.join(tapDir, "fsz1-unit.tap"), ["dist/repo-runtime-manager.test.js"]);
await runTests(path.join(tapDir, "fsz2-unit.tap"), [
  "dist/java-index/snapshot-v4.test.js",
  "dist/java-index/worker-protocol.test.js"
]);
await runTests(path.join(tapDir, "fsz3-refresh.tap"), [
  "dist/java-index/index-store.test.js",
  "dist/java-index/columnar/file-columns.test.js",
  "dist/java-index/columnar/method-columns.test.js",
  "dist/java-index/columnar/edge-columns.test.js"
]);

const repo = path.join(candidateRoot, "fixtures", "java-index-v2");
const cache = mkdtempSync(path.join(tmpdir(), "fsz4-heap-"));
const client = new SqlJavaIndexClient(repo, cache);
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
writeFileSync(path.join(tapDir, "fsz4-heap-split.json"), `${JSON.stringify(sample, null, 2)}\n`);
console.log(`FSZ4_HEAP_SAMPLE ${JSON.stringify(sample)}`);
await client.close();
