#!/usr/bin/env node
// input: Three frozen golden Java repos.
// output: N1 index-time budget JSON (cold build, incremental, RSS, digest).
// pos: JIN N1-04. Isolated. Does not start JDT or touch host LSP caches.
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";

const PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const COLD_MS_GATE = 60_000;
const INCREMENTAL_MS_GATE = 500;
const RSS_BYTES_GATE = 512 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    project: options.get("--project"),
    repo: options.get("--repo"),
    cacheRoot: options.get("--cache-root"),
    timeoutMs: Number(options.get("--timeout-ms") || 180_000),
    output: options.get("--output"),
    repositories: {
      lishuedu: options.get("--lishuedu"),
      cipherlink: options.get("--cipherlink"),
      "exam-parent-v3": options.get("--exam-parent-v3")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function waitForComplete(index, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await index.routerStatus(true);
    const pending = (status.javaIndex?.pendingBackground ?? 0) + (status.javaIndex?.pendingForeground ?? 0);
    if (status.coverage === "complete" && pending === 0) return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("JavaIndex did not reach complete coverage before timeout");
}

async function typicalJavaFile(repoRoot) {
  const { readdir, stat } = await import("node:fs/promises");
  const candidates = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "build" && entry.name !== "node_modules") {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        const info = await stat(full);
        if (info.size > 512 && info.size < 64 * 1024) candidates.push(full);
        if (candidates.length >= 32) return;
      }
    }
  }
  await walk(repoRoot);
  return candidates[Math.floor(candidates.length / 2)] ?? candidates[0];
}

function collectHeap() {
  const gcFn = globalThis.gc;
  if (typeof gcFn === "function") gcFn();
  return process.memoryUsage();
}

async function benchProject(project, repoRoot, timeoutMs, cacheRoot) {
  const cacheDir = path.join(cacheRoot, project);
  await mkdir(cacheDir, { recursive: true });
  const rssBefore = collectHeap();
  const client = new SqlJavaIndexClient(repoRoot, cacheDir);
  const index = new RouterJavaIndex(repoRoot, client);
  try {
    const coldStarted = performance.now();
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, timeoutMs);
    const first = await index.queryGraphDigest();
    const coldMs = performance.now() - coldStarted;
    const rssAfter = collectHeap();
    const workerRssBytes = first.rssBytes ?? rssAfter.rss;
    const workerHeapBytes = first.heapUsedBytes ?? rssAfter.heapUsed;
    const second = await index.queryGraphDigest();
    const target = await typicalJavaFile(repoRoot);
    let incrementalMs = 0;
    let incrementalDigest = first.digest;
    if (target) {
      const incStarted = performance.now();
      await index.ensureFresh([target], 2);
      const after = await index.queryGraphDigest();
      incrementalMs = performance.now() - incStarted;
      incrementalDigest = after.digest;
    }
    return {
      project,
      coldMs,
      incrementalMs,
      rssDeltaBytes: Math.max(0, workerRssBytes - rssBefore.rss),
      heapUsedBytes: workerHeapBytes,
      clientHeapUsedBytes: rssAfter.heapUsed,
      digest: first.digest,
      digestRepeat: second.digest,
      digestAfterIncremental: incrementalDigest,
      digestDeterministic: first.digest === second.digest,
      nodes: first.nodes,
      edges: first.edges,
      gates: {
        cold: coldMs <= COLD_MS_GATE,
        incremental: incrementalMs <= INCREMENTAL_MS_GATE,
        rss: (workerRssBytes - rssBefore.rss) <= RSS_BYTES_GATE,
        digest: first.digest === second.digest
      }
    };
  } finally {
    await index.close();
  }
}

function spawnProject(project, repoRoot, timeoutMs, cacheRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        SCRIPT_PATH,
        "--project",
        project,
        "--repo",
        repoRoot,
        "--timeout-ms",
        String(timeoutMs),
        "--cache-root",
        cacheRoot
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`project ${project} exited ${code}: ${line || error}`));
      }
    });
  });
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-jin-index-benchmark.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-jin-index-benchmark must run through isolated validation");
  }
  if (cli.project) {
    const result = await benchProject(
      cli.project,
      path.resolve(required(cli.repo, "--repo")),
      cli.timeoutMs,
      required(cli.cacheRoot, "--cache-root")
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const output = required(cli.output, "--output");
  const cacheRoot = path.join(os.tmpdir(), "jin-n1-index-cache");
  await mkdir(cacheRoot, { recursive: true });
  const projects = [];
  for (const project of PROJECTS) {
    console.error(`jin-index-benchmark: ${project}`);
    projects.push(await spawnProject(
      project,
      path.resolve(required(cli.repositories[project], `--${project}`)),
      cli.timeoutMs,
      cacheRoot
    ));
  }
  const passed = projects.every(item => item.gates.cold && item.gates.incremental && item.gates.rss && item.gates.digest);
  const payload = {
    schemaVersion: "jin-index-benchmark/v1",
    dated: new Date().toISOString().slice(0, 10),
    gates: { coldMs: COLD_MS_GATE, incrementalMs: INCREMENTAL_MS_GATE, rssBytes: RSS_BYTES_GATE },
    passed,
    projects
  };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(output),
    passed,
    projects: projects.map(item => ({
      project: item.project,
      coldMs: Math.round(item.coldMs),
      incrementalMs: Math.round(item.incrementalMs),
      rssDeltaMiB: Math.round(item.rssDeltaBytes / 1024 / 1024),
      heapUsedMiB: Math.round((item.heapUsedBytes ?? 0) / 1024 / 1024),
      nodes: item.nodes,
      edges: item.edges,
      digestDeterministic: item.digestDeterministic,
      gates: item.gates
    }))
  }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
