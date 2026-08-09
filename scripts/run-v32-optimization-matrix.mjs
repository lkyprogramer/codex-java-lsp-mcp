#!/usr/bin/env node
// input: An immutable old revision, a candidate worktree, and the three formal Java repositories.
// output: The existing source-locked cold matrix plus a V3.2 provenance/LOC/environment manifest.
// pos: Sprint-level V3.2 matrix entrypoint; delegates semantic gates to the V4 cold runner.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { countProductionTs } from "./count-production-ts.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V32_OPTIMIZATION_MANIFEST_VERSION = 1;

export function createOptimizationManifest({
  baselineProductionTs,
  candidateProductionTs,
  coldManifest,
  coldSummary,
  environment,
  artifacts,
  taskLedger = []
}) {
  if (coldSummary?.passed !== true) throw new Error("cold matrix must pass before a V3.2 manifest can be published");
  const oldRuntime = coldManifest?.runtimes?.old;
  const newRuntime = coldManifest?.runtimes?.new;
  if (!oldRuntime || !newRuntime) throw new Error("cold manifest is missing old/new runtime identities");
  if (baselineProductionTs.source.commit !== oldRuntime.commit
    || baselineProductionTs.source.commitTree !== oldRuntime.commitTree) {
    throw new Error("production TypeScript baseline does not match the cold old runtime");
  }
  if (candidateProductionTs.source.commit !== newRuntime.commit) {
    throw new Error("production TypeScript candidate does not match the cold candidate base commit");
  }
  const manifest = {
    schemaVersion: V32_OPTIMIZATION_MANIFEST_VERSION,
    status: "PASS",
    comparison: {
      policy: "previous-immutable-sprint-to-source-locked-candidate",
      coldManifestVersion: coldManifest.version,
      baselineCommit: oldRuntime.commit,
      baselineTree: oldRuntime.executableTree,
      candidateBaseCommit: newRuntime.commit,
      candidateCommitTree: newRuntime.commitTree,
      candidateExecutableTree: newRuntime.executableTree,
      candidatePatchSha256: coldManifest.candidatePatch?.sha256,
      runtimeInputs: coldManifest.candidatePatch?.untrackedInputs ?? []
    },
    repositories: coldManifest.repositories,
    scenarios: coldManifest.scenarios,
    environment,
    productionTs: {
      old: baselineProductionTs,
      new: candidateProductionTs,
      limits: {
        sprintMaximumLoc: Math.floor(baselineProductionTs.totalLoc * 1.05),
        finalTargetLoc: baselineProductionTs.totalLoc
      },
      delta: {
        files: candidateProductionTs.fileCount - baselineProductionTs.fileCount,
        bytes: candidateProductionTs.totalBytes - baselineProductionTs.totalBytes,
        loc: candidateProductionTs.totalLoc - baselineProductionTs.totalLoc
      }
    },
    taskLedger,
    coldGate: {
      passed: true,
      inputSha256: coldSummary.inputSha256,
      projects: coldSummary.projects,
      configuration: coldSummary.configuration
    },
    artifacts
  };
  return { ...manifest, manifestPayloadSha256: sha256(stableJson(manifest)) };
}

export function validateOptimizationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== V32_OPTIMIZATION_MANIFEST_VERSION || manifest.status !== "PASS") {
    throw new Error("invalid V3.2 optimization manifest header");
  }
  const { manifestPayloadSha256, ...payload } = manifest;
  if (manifestPayloadSha256 !== sha256(stableJson(payload))) {
    throw new Error("V3.2 optimization manifest payload hash mismatch");
  }
  for (const side of ["old", "new"]) validateProductionInventory(manifest.productionTs?.[side], side);
  const expectedDelta = {
    files: manifest.productionTs.new.fileCount - manifest.productionTs.old.fileCount,
    bytes: manifest.productionTs.new.totalBytes - manifest.productionTs.old.totalBytes,
    loc: manifest.productionTs.new.totalLoc - manifest.productionTs.old.totalLoc
  };
  if (stableJson(expectedDelta) !== stableJson(manifest.productionTs.delta)) {
    throw new Error("production TypeScript delta is inconsistent");
  }
  if (manifest.productionTs.new.totalLoc > manifest.productionTs.limits.sprintMaximumLoc) {
    throw new Error("production TypeScript LOC exceeds the V3.2 +5% sprint ceiling");
  }
  if (!Array.isArray(manifest.taskLedger)) throw new Error("V3.2 task LOC ledger is missing");
  for (const entry of manifest.taskLedger) {
    if (!entry || typeof entry.task !== "string" || !Number.isFinite(entry.productionLocAdded)) {
      throw new Error("V3.2 task LOC ledger contains an invalid entry");
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("V3.2 optimization manifest has no artifact inventory");
  }
  return true;
}

export async function verifyOptimizationManifest({ manifestFile, candidateRoot = scriptRoot }) {
  const manifest = JSON.parse(await readFile(path.resolve(manifestFile), "utf8"));
  validateOptimizationManifest(manifest);
  const baseline = await countProductionTs({ root: candidateRoot, revision: manifest.comparison.baselineCommit });
  assertSameInventory(manifest.productionTs.old, baseline, "old production TypeScript");
  const candidate = await countProductionTs({ root: candidateRoot });
  assertSameInventory(manifest.productionTs.new, candidate, "new production TypeScript");
  const environment = await environmentIdentity(candidateRoot);
  if (stableJson(manifest.environment) !== stableJson(environment)) {
    throw new Error("runtime environment drift");
  }
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(artifact.file);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`artifact drift: ${artifact.file}`);
    }
  }
  return manifest;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (cli.verify) {
    const manifest = await verifyOptimizationManifest({ manifestFile: cli.verify, candidateRoot: cli.candidateRoot });
    console.log(JSON.stringify({ status: "PASS", manifestPayloadSha256: manifest.manifestPayloadSha256 }));
    return;
  }

  const outputDir = path.resolve(cli.outputDir);
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  await mkdir(outputDir, { recursive: true });
  const coldDir = path.join(outputDir, "cold");
  await runColdMatrix({ ...cli, outputDir: coldDir });
  const manifest = await buildManifestFromCold({
    candidateRoot: cli.candidateRoot,
    baseline: cli.baseline,
    coldDir,
    taskLedger: cli.taskLedgerFile ? JSON.parse(await readFile(path.resolve(cli.taskLedgerFile), "utf8")) : []
  });
  const manifestFile = path.join(outputDir, "optimization-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyOptimizationManifest({ manifestFile, candidateRoot: cli.candidateRoot });
  console.log(JSON.stringify({ status: "PASS", manifestFile, manifestPayloadSha256: manifest.manifestPayloadSha256 }));
}

export async function buildManifestFromCold({ candidateRoot, baseline, coldDir, taskLedger = [] }) {
  const coldManifestFile = path.resolve(coldDir, "run-manifest.json");
  const coldSummaryFile = path.resolve(coldDir, "matrix-summary.json");
  const coldManifest = JSON.parse(await readFile(coldManifestFile, "utf8"));
  const coldSummary = JSON.parse(await readFile(coldSummaryFile, "utf8"));
  const baselineProductionTs = await countProductionTs({ root: candidateRoot, revision: baseline });
  const candidateProductionTs = await countProductionTs({ root: candidateRoot });
  const environment = await environmentIdentity(candidateRoot);
  const artifacts = await artifactInventory(coldManifestFile, coldSummaryFile, coldSummary);
  return createOptimizationManifest({
    baselineProductionTs,
    candidateProductionTs,
    coldManifest,
    coldSummary,
    environment,
    artifacts,
    taskLedger
  });
}

async function environmentIdentity(root) {
  const packageJsonBytes = await readFile(path.join(root, "package.json"));
  const packageLockBytes = await readFile(path.join(root, "package-lock.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  const packageVersion = name => packageLock.packages?.[`node_modules/${name}`]?.version
    ?? packageJson.dependencies?.[name]
    ?? packageJson.devDependencies?.[name]
    ?? "UNMEASURED";
  return {
    node: { version: process.version, execPath: process.execPath },
    platform: process.platform,
    arch: process.arch,
    jdt: { state: "DISABLED_FOR_COLD", binary: "/usr/bin/false", version: "UNMEASURED" },
    treeSitter: {
      runtime: packageVersion("tree-sitter"),
      javaGrammar: packageVersion("tree-sitter-java")
    },
    typescript: packageVersion("typescript"),
    packageJsonSha256: sha256(packageJsonBytes),
    packageLockSha256: sha256(packageLockBytes)
  };
}

async function artifactInventory(coldManifestFile, coldSummaryFile, coldSummary) {
  const files = new Set([coldManifestFile, coldSummaryFile]);
  for (const cell of coldSummary.cells ?? []) {
    files.add(path.resolve(cell.file));
    files.add(path.resolve(`${cell.file}.stderr`));
  }
  const result = [];
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const bytes = await readFile(file);
    result.push({ file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return result;
}

function validateProductionInventory(value, label) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error(`${label} production TypeScript inventory is invalid`);
  }
  const fileCount = value.files.length;
  const totalBytes = value.files.reduce((sum, file) => sum + file.bytes, 0);
  const totalLoc = value.files.reduce((sum, file) => sum + file.loc, 0);
  if (value.fileCount !== fileCount || value.totalBytes !== totalBytes || value.totalLoc !== totalLoc) {
    throw new Error(`${label} production TypeScript totals are inconsistent`);
  }
  const inventoryPayload = {
    scope: value.scope,
    fileCount,
    totalBytes,
    totalLoc,
    files: value.files
  };
  if (value.inventorySha256 !== sha256(stableJson(inventoryPayload))) {
    throw new Error(`${label} production TypeScript inventory hash mismatch`);
  }
}

function assertSameInventory(expected, actual, label) {
  validateProductionInventory(expected, label);
  validateProductionInventory(actual, label);
  if (expected.inventorySha256 !== actual.inventorySha256) throw new Error(`${label} source inventory drift`);
}

function runColdMatrix(cli) {
  const args = [
    path.join(scriptRoot, "scripts", "run-three-repo-cold-matrix.mjs"),
    "--candidate-root", path.resolve(cli.candidateRoot),
    "--baseline", cli.baseline,
    "--lishuedu", cli.repositories.lishuedu,
    "--cipherlink", cli.repositories.cipherlink,
    "--exam-parent-v3", cli.repositories["exam-parent-v3"],
    "--runs", "5",
    "--p95-limit", String(cli.p95Limit),
    "--output-dir", cli.outputDir
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: cli.candidateRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`cold matrix exited with ${code}`)));
  });
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  if (flags.has("--help")) return { help: true };
  const candidateRoot = path.resolve(options.get("--candidate-root") || scriptRoot);
  if (options.has("--verify")) {
    return { candidateRoot, verify: options.get("--verify") };
  }
  return {
    candidateRoot,
    baseline: required(options.get("--baseline"), "--baseline"),
    outputDir: required(options.get("--output-dir"), "--output-dir"),
    p95Limit: numeric(options.get("--p95-limit"), 1.25, "--p95-limit"),
    taskLedgerFile: options.get("--task-ledger"),
    verify: options.get("--verify"),
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function numeric(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be numeric`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function printUsage() {
  console.log("Usage: node scripts/run-v32-optimization-matrix.mjs --baseline SHA --output-dir DIR --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--candidate-root DIR] [--task-ledger FILE]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
