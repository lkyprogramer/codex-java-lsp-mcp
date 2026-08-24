#!/usr/bin/env node
// input: Optional --apply, cache/projects overrides, built dist/.
// output: JSON janitor report; dry-run by default. Same rules as the daemon janitor.
// pos: Offline harvest of production JAVA_LSP_CACHE_BASE; never rm -rf the cache root.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseHarvestArgs(argv) {
  let dryRun = true;
  let cacheBase;
  let projectsJson;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--apply") {
      dryRun = false;
    } else if (value === "--cache-base") {
      cacheBase = requiredValue(argv, ++index, value);
    } else if (value === "--projects-json") {
      projectsJson = requiredValue(argv, ++index, value);
    } else if (value === "--help" || value === "-h") {
      return { help: true, dryRun: true };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return { dryRun, cacheBase, projectsJson, help: false };
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export async function loadPinRoots(projectsJson, distRoot = path.join(projectRoot, "dist")) {
  const { AliasRegistry } = await import(pathToFileURL(path.join(distRoot, "alias-registry.js")).href);
  const registry = new AliasRegistry(projectsJson);
  await registry.reloadIfChanged();
  return new Set(
    registry.aliases()
      .filter(alias => alias.lspEnabled)
      .map(alias => alias.root)
  );
}

export async function harvestJavaLspCache(options = {}) {
  const distRoot = options.distRoot ?? path.join(projectRoot, "dist");
  const { cleanupStaleWorktreeCaches } = await import(
    pathToFileURL(path.join(distRoot, "worktree-cache-cleanup.js")).href
  );
  const protectedRepoRoots = options.protectedRepoRoots
    ?? await loadPinRoots(options.projectsJson, distRoot);
  return cleanupStaleWorktreeCaches({
    cacheBase: options.cacheBase,
    dryRun: options.dryRun !== false,
    protectedRepoRoots
  });
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/harvest-java-lsp-cache.mjs [--dry-run|--apply] [--cache-base <dir>] [--projects-json <file>]

Default is --dry-run. --apply deletes dead-path / expired non-pin / overflow dirs
using the same janitor rules as the running daemon. Pin roots from projects.json
are never removed. Do not rm -rf the cache base.
`);
}

async function main(argv) {
  const args = parseHarvestArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  const result = await harvestJavaLspCache({
    dryRun: args.dryRun,
    cacheBase: args.cacheBase,
    projectsJson: args.projectsJson
  });
  const cacheBase = args.cacheBase
    ?? process.env.JAVA_LSP_CACHE_BASE
    ?? path.join(homedir(), "Library/Caches/codex-java-lsp");
  const report = {
    dryRun: args.dryRun,
    cacheBase,
    scanned: result.scanned,
    removed: result.removed,
    skipped: result.skipped,
    failures: result.failures,
    reclaimedFiles: result.reclaimedFiles ?? 0
  };
  if ((result.removedDirs?.length ?? 0) > 40) {
    const listPath = path.join(tmpdir(), `codex-java-lsp-harvest-${Date.now()}.txt`);
    writeFileSync(listPath, `${result.removedDirs.join("\n")}\n`);
    report.removedDirList = listPath;
    report.removedDirSample = result.removedDirs.slice(0, 8);
  } else {
    report.removedDirs = result.removedDirs;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error("[codex-java-lsp] cache harvest failed", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
