import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePsTable,
  processTree,
  summarizeResourceSamples
} from "./sample-java-runtime-resources.mjs";

test("process sampler parses ps rows and retains only descendants of the spawned root", () => {
  const rows = parsePsTable([
    "  10 1 1024 0:01.50 node server.js",
    "  11 10 2048 0:00.25 /usr/bin/java org.eclipse.equinox.launcher",
    "  12 11 512 0:00.10 helper",
    "  99 1 4096 0:10.00 unrelated-lsp"
  ].join("\n"));
  assert.deepEqual(processTree(rows, 10).map(row => row.pid), [10, 11, 12]);
  assert.equal(rows[0].rssBytes, 1024 * 1024);
  assert.equal(rows[0].cpuTimeMs, 1500);
});

test("resource summary reports peak RSS, CPU delta, fd peak and post-warmup retention slope", () => {
  const samples = [
    { tMs: 0, processes: [{ pid: 10, ppid: 1, role: "node-root", command: "node", rssBytes: 100, cpuTimeMs: 10, fdCount: 4 }] },
    { tMs: 1000, processes: [{ pid: 10, ppid: 1, role: "node-root", command: "node", rssBytes: 200, cpuTimeMs: 30, fdCount: 6 }] },
    { tMs: 2000, processes: [{ pid: 10, ppid: 1, role: "target-root", command: "node", rssBytes: 300, cpuTimeMs: 50, fdCount: 5 }] },
    { tMs: 3000, processes: [{ pid: 10, ppid: 1, role: "target-root", command: "node", rssBytes: 400, cpuTimeMs: 70, fdCount: 5 }] }
  ];
  const summary = summarizeResourceSamples(samples, 1000, "present");
  assert.equal(summary.peakProcessTreeRssBytes, 400);
  assert.equal(summary.sampledRetentionSlopeBytesPerMinute, 6000);
  assert.equal(summary.processes[0].peakFdCount, 6);
  assert.equal(summary.processes[0].cpuTimeDeltaMs, 60);
  assert.equal(summary.workerThreadAccounting.javaIndexWorker, "INCLUDED_IN_NODE_PROCESS");
});

test("resource sampler writes PARTIAL for an externally sampled child and refuses to overwrite evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-sampler-test-"));
  const output = path.join(root, "resources.json");
  const script = new URL("./sample-java-runtime-resources.mjs", import.meta.url);
  try {
    const first = await run(process.execPath, [
      script.pathname,
      "--output", output,
      "--interval-ms", "10",
      "--warmup-ms", "0",
      "--java-index", "absent",
      "--",
      process.execPath,
      "scripts/resource-target-fixture.mjs",
      "delay"
    ], { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "1" });
    assert.equal(first.code, 0, first.stderr);
    const before = await readFile(output, "utf8");
    const payload = JSON.parse(before);
    assert.equal(payload.status, "PARTIAL");
    assert.equal(payload.observations.processTree.status, "MEASURED");
    assert.equal(payload.summary.workerThreadAccounting.javaIndexWorker, "NOT_PRESENT");

    const second = await run(process.execPath, [
      script.pathname,
      "--output", output,
      "--",
      process.execPath,
      "scripts/resource-target-fixture.mjs",
      "delay"
    ], { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "1" });
    assert.notEqual(second.code, 0);
    assert.equal(await readFile(output, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}
