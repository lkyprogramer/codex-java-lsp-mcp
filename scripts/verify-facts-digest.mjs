#!/usr/bin/env node
// input: A frozen golden Java repo (or three).
// output: Per-file SHA-256 of canonicalized JavaFileBundle facts.
// pos: M0 identity tool. Isolated. Does not change production query/selection.
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeLayout } from "../dist/layout-probe.js";
import { discoverJavaFiles } from "../dist/java-index/manifest.js";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";
import { digestFileBundle, digestManifest } from "./facts-digest.mjs";

const PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const BATCH = 40;

export function parseFactsDigestCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    timeoutMs: Number(options.get("--timeout-ms") || 600_000),
    output: options.get("--output"),
    project: options.get("--project"),
    repo: options.get("--repo"),
    cacheRoot: options.get("--cache-root"),
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

export async function digestRepo(repoRoot, timeoutMs, cacheRoot) {
  const layout = probeLayout(repoRoot);
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const client = new JavaIndexClient(repoRoot, cacheRoot);
  const index = new RouterJavaIndex(repoRoot, client);
  const files = [];
  try {
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, timeoutMs);
    for (let offset = 0; offset < discovered.length; offset += BATCH) {
      const slice = discovered.slice(offset, offset + BATCH);
      const bundles = await index.queryFiles(slice.map(item => item.absolutePath));
      const byPath = new Map(bundles.map(bundle => [bundle.file.relativePath, bundle]));
      for (const item of slice) {
        const bundle = byPath.get(item.relativePath);
        if (!bundle) continue;
        files.push(digestFileBundle(bundle));
      }
    }
  } finally {
    await index.close();
  }
  return {
    repoRoot,
    discovered: discovered.length,
    digested: files.length,
    ...digestManifest(files)
  };
}

async function main() {
  const cli = parseFactsDigestCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/verify-facts-digest.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("verify-facts-digest must run through isolated validation");
  }
  const output = required(cli.output, "--output");
  const cacheRoot = cli.cacheRoot ? path.resolve(cli.cacheRoot) : path.join(os.tmpdir(), "m0-facts-digest-cache");
  await mkdir(cacheRoot, { recursive: true });
  const projects = [];
  for (const project of PROJECTS) {
    const repo = required(cli.repositories[project], `--${project}`);
    console.error(`facts-digest: ${project}`);
    const result = await digestRepo(path.resolve(repo), cli.timeoutMs, path.join(cacheRoot, project));
    projects.push({ project, ...result });
  }
  const payload = {
    schemaVersion: "m0-facts-digest/v1",
    dated: new Date().toISOString().slice(0, 10),
    projects: projects.map(item => ({
      project: item.project,
      discovered: item.discovered,
      digested: item.digested,
      sha256: item.sha256,
      fileCount: item.fileCount,
      files: item.files
    }))
  };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(output),
    projects: payload.projects.map(item => ({
      project: item.project,
      fileCount: item.fileCount,
      sha256: item.sha256
    }))
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
