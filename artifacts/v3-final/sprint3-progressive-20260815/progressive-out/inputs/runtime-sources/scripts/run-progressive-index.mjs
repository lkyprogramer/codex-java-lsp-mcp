#!/usr/bin/env node
// input: One detached Java repository, a frozen project scenario and private state paths.
// output: One source-locked progressive JavaIndex attempt JSON.
// pos: Isolated CLI boundary for V3.2-16; the active checkout/cache is never a valid target.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export function parseProgressiveCli(args) {
  const result = { generation: 1, pollMs: 50, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--repo-root") result.repoRoot = args[++index];
    else if (arg === "--project-id") result.projectId = args[++index];
    else if (arg === "--scenario-lock") result.scenarioLock = args[++index];
    else if (arg === "--index-cache-dir") result.indexCacheDir = args[++index];
    else if (arg === "--output") result.output = args[++index];
    else if (arg === "--generation") result.generation = positiveInteger(args[++index], arg);
    else if (arg === "--poll-ms") result.pollMs = positiveInteger(args[++index], arg);
    else if (arg === "--timeout-ms") result.timeoutMs = positiveInteger(args[++index], arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const required of ["repoRoot", "projectId", "scenarioLock", "indexCacheDir", "output"]) {
    if (!result[required]) throw new Error(`--${required.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)} is required`);
  }
  return result;
}

export function assertProgressivePaths(repoRoot, cacheDir, output) {
  const repo = path.resolve(repoRoot);
  const cache = path.resolve(cacheDir);
  const artifact = path.resolve(output);
  if (inside(repo, cache) || inside(repo, artifact)) {
    throw new Error("progressive cache/output must stay outside the detached Java repository");
  }
  if (cache === artifact || inside(cache, artifact) || inside(artifact, cache)) {
    throw new Error("progressive cache and output must be disjoint");
  }
}

export async function assertProgressiveCanonicalPaths(repoRoot, cacheDir, output) {
  assertProgressivePaths(repoRoot, cacheDir, output);
  const [repo, cache, artifact] = await Promise.all([
    realpath(repoRoot),
    canonicalProspectivePath(cacheDir),
    canonicalProspectivePath(output)
  ]);
  if (inside(repo, cache) || inside(repo, artifact)) {
    throw new Error("progressive cache/output resolves inside the detached Java repository");
  }
  if (cache === artifact || inside(cache, artifact) || inside(artifact, cache)) {
    throw new Error("progressive cache and output resolve to overlapping paths");
  }
}

export function selectProgressiveScenario(document, projectId) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.scenarios)) {
    throw new Error("progressive scenario lock must use schemaVersion 1");
  }
  const matches = document.scenarios.filter(item => item?.projectId === projectId);
  if (matches.length !== 1) throw new Error(`expected exactly one progressive scenario for ${projectId}`);
  const scenario = matches[0];
  if (!/^[a-f0-9]{40}$/.test(scenario.repoCommit ?? "")) throw new Error("scenario repoCommit must be an exact commit");
  if (!scenario.anchor?.file || !Number.isInteger(scenario.anchor.line) || !Number.isInteger(scenario.anchor.column)) {
    throw new Error("scenario anchor is incomplete");
  }
  if (!Array.isArray(scenario.requiredTypeDefinitions) || scenario.requiredTypeDefinitions.length === 0) {
    throw new Error("scenario requires at least one locked direct type definition");
  }
  return scenario;
}

async function main() {
  const cli = parseProgressiveCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("progressive benchmark must run inside isolated validation");
  }
  if (process.env.JDTLS_BIN !== "/usr/bin/false") {
    throw new Error("progressive JavaIndex benchmark requires JDTLS_BIN=/usr/bin/false");
  }
  const repoRoot = path.resolve(cli.repoRoot);
  const cacheDir = path.resolve(cli.indexCacheDir);
  const output = path.resolve(cli.output);
  const scenarioFile = path.resolve(cli.scenarioLock);
  await assertProgressiveCanonicalPaths(repoRoot, cacheDir, output);
  if (existsSync(output)) throw new Error("progressive output must not already exist");
  if (existsSync(cacheDir) && (await readdir(cacheDir)).length > 0) {
    throw new Error("progressive index cache must be empty");
  }
  await Promise.all([mkdir(cacheDir, { recursive: true }), mkdir(path.dirname(output), { recursive: true })]);
  const [scenarioBytes, repoCommit, repoTree, repoStatus, runtimeBuildBytes] = await Promise.all([
    readFile(scenarioFile),
    capture("git", ["-C", repoRoot, "rev-parse", "HEAD^{commit}"]),
    capture("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"]),
    capture("git", ["-C", repoRoot, "status", "--porcelain=v1"]),
    readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "build-stamp.json"))
  ]);
  const scenarioDocument = JSON.parse(scenarioBytes.toString("utf8"));
  const scenario = selectProgressiveScenario(scenarioDocument, cli.projectId);
  if (repoStatus.trim()) throw new Error("progressive Java repository must be clean");
  if (repoCommit.trim() !== scenario.repoCommit) throw new Error("progressive repository commit does not match scenario lock");
  if (!existsSync(path.join(repoRoot, scenario.anchor.file))) throw new Error("progressive anchor file is missing");
  const { runProgressiveIndex } = await import("../dist/benchmark/progressive-index.js");
  const attempt = await runProgressiveIndex({
    repoRoot,
    indexCacheDir: cacheDir,
    scenario,
    generation: cli.generation,
    pollMs: cli.pollMs,
    timeoutMs: cli.timeoutMs
  });
  const repoStatusAfter = await capture("git", ["-C", repoRoot, "status", "--porcelain=v1"]);
  if (repoStatusAfter !== repoStatus) throw new Error("progressive Java repository changed during the attempt");
  const artifact = {
    schemaVersion: 1,
    sourceLock: {
      runtimeBuild: JSON.parse(runtimeBuildBytes.toString("utf8")),
      repoCommit: repoCommit.trim(),
      repoTree: repoTree.trim(),
      repoStatusSha256: sha256(Buffer.from(repoStatus)),
      scenarioFileSha256: sha256(scenarioBytes),
      scenarioId: scenario.anchorScenarioId
    },
    protocol: {
      cache: "EMPTY_PRIVATE_PER_ATTEMPT",
      generation: cli.generation,
      pollMs: cli.pollMs,
      timeoutMs: cli.timeoutMs,
      jdtlsDisabled: process.env.JDTLS_BIN === "/usr/bin/false"
    },
    attempt
  };
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, projectId: cli.projectId, stages: attempt.stages }));
  const reached = Object.values(attempt.stages).every(stage => stage.state === "REACHED")
    && attempt.negativeLookup.beforeComplete.state === "UNRESOLVED"
    && attempt.negativeLookup.beforeComplete.coverage !== "COMPLETE"
    && attempt.negativeLookup.beforeComplete.authoritative === false
    && attempt.negativeLookup.afterComplete.state === "UNRESOLVED"
    && attempt.negativeLookup.afterComplete.coverage === "COMPLETE"
    && attempt.negativeLookup.afterComplete.authoritative === true;
  if (!reached) process.exitCode = 1;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalProspectivePath(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve progressive path: ${value}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(await realpath(cursor), ...suffix);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

function printUsage() {
  console.log("Usage: node scripts/run-progressive-index.mjs --repo-root DIR --project-id ID --scenario-lock FILE --index-cache-dir DIR --output FILE [--generation 1] [--poll-ms 50] [--timeout-ms 180000]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
