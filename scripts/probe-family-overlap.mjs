#!/usr/bin/env node
// input: Two (or more) java-index-snapshot.json.gz paths, or a cache-base + familyHash.
// output: JSON { familyOverlapRatio, sources, workerHeapMb?, workerFootprintMb? }.
// pos: FS0 ledger probe. Decodes shipped v4 files segments; never invents overlap.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function familyOverlapRatio(hashesA, hashesB) {
  let compared = 0;
  let matched = 0;
  for (const [relativePath, hash] of hashesA) {
    const other = hashesB.get(relativePath);
    if (other === undefined) continue;
    compared += 1;
    if (other === hash) matched += 1;
  }
  return compared === 0 ? 0 : matched / compared;
}

export function parseProbeArgs(argv) {
  const snapshots = [];
  let cacheBase;
  let familyHash;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--snapshot") {
      snapshots.push(requiredValue(argv, ++index, value));
    } else if (value === "--cache-base") {
      cacheBase = requiredValue(argv, ++index, value);
    } else if (value === "--family-hash") {
      familyHash = requiredValue(argv, ++index, value);
    } else if (value === "--output") {
      output = requiredValue(argv, ++index, value);
    } else if (value === "--help" || value === "-h") {
      return { help: true, snapshots: [], cacheBase, familyHash, output };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return { help: false, snapshots, cacheBase, familyHash, output };
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export async function contentHashesFromSnapshot(snapshotPath, decodeView) {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(snapshotPath);
  const view = decodeView(bytes, snapshotPath);
  if ("error" in view) throw new Error(`${snapshotPath}: ${view.error}`);
  const hashes = new Map();
  for (const file of view.files) hashes.set(file.relativePath, file.contentHash);
  return hashes;
}

export function discoverFamilySnapshots(cacheBase, familyHash) {
  if (!existsSync(cacheBase)) return [];
  const found = [];
  for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cacheRoot = path.join(cacheBase, entry.name);
    const metaPath = path.join(cacheRoot, "repo-meta.json");
    const snapshotPath = path.join(cacheRoot, "java-index-snapshot.json.gz");
    if (!existsSync(metaPath) || !existsSync(snapshotPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (familyHash && meta.familyHash !== familyHash) continue;
    found.push({
      repoHash: meta.repoHash,
      repoRoot: meta.repoRoot,
      familyHash: meta.familyHash,
      snapshotPath
    });
  }
  return found;
}

export function sampleWorkerResources(pids) {
  const footprints = [];
  for (const pid of pids) {
    const result = spawnSync("footprint", ["-p", String(pid)], { encoding: "utf8" });
    const match = /phys_footprint:\s+([\d.]+)\s+([KMG]?B)/i.exec(result.stdout);
    if (!match) continue;
    footprints.push({ pid, footprintMb: toMb(Number(match[1]), match[2]) });
  }
  if (footprints.length === 0) return { workerFootprintMb: undefined, workerHeapMb: undefined, workers: [] };
  const workerFootprintMb = Math.round(footprints.reduce((sum, row) => sum + row.footprintMb, 0) / footprints.length);
  return { workerFootprintMb, workerHeapMb: workerFootprintMb, workers: footprints };
}

function toMb(value, unit) {
  const upper = unit.toUpperCase();
  if (upper.startsWith("G")) return value * 1024;
  if (upper.startsWith("K")) return value / 1024;
  return value;
}

export function liveIndexWorkerPids() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const pids = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.includes("java-index-worker.js")) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function loadDecoder() {
  const url = pathToFileURL(path.join(projectRoot, "dist/java-index/snapshot-v4.js")).href;
  const mod = await import(url);
  return mod.decodeSnapshotV4View;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseProbeArgs(argv);
  if (args.help) {
    console.log("Usage: probe-family-overlap.mjs --snapshot A --snapshot B [--output ledger.json]");
    return 0;
  }
  const decodeView = await loadDecoder();
  let sources = args.snapshots.map(snapshotPath => ({ snapshotPath }));
  if (sources.length < 2 && args.cacheBase) {
    sources = discoverFamilySnapshots(args.cacheBase, args.familyHash);
  }
  if (sources.length < 2) {
    throw new Error("need at least two sibling snapshots (--snapshot twice, or --cache-base with a family)");
  }
  const hashMaps = [];
  for (const source of sources) {
    hashMaps.push(await contentHashesFromSnapshot(source.snapshotPath, decodeView));
  }
  const ratios = [];
  for (let i = 0; i < hashMaps.length; i += 1) {
    for (let j = i + 1; j < hashMaps.length; j += 1) {
      ratios.push(familyOverlapRatio(hashMaps[i], hashMaps[j]));
    }
  }
  const familyOverlapRatioValue = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const sampled = sampleWorkerResources(liveIndexWorkerPids());
  const ledger = {
    sampledAt: new Date().toISOString(),
    familyOverlapRatio: Number(familyOverlapRatioValue.toFixed(6)),
    pairCount: ratios.length,
    sources: sources.map((source, index) => ({
      ...source,
      files: hashMaps[index].size
    })),
    workerFootprintMb: sampled.workerFootprintMb ?? null,
    workerHeapMb: sampled.workerHeapMb ?? null,
    workers: sampled.workers
  };
  const json = `${JSON.stringify(ledger, null, 2)}\n`;
  if (args.output) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.output, json);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
