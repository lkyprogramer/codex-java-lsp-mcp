#!/usr/bin/env node
// input: --repo-root --cache-dir --generation [--phase parse|resolve]. Isolated child only.
// output: v4 snapshot files plus one JSON line {ok, files, rssPeakBytes, heapUsedBytes}.
// pos: M3 P3. Spawned by the JavaIndex worker; must not open a worker of its own.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runColdIndexBuild, type ColdBuildPhase, type ColdBuildResult } from "./cold-build.js";

const SELF = fileURLToPath(import.meta.url);

function parseArgs(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]!);
  }
  const repoRoot = options.get("--repo-root");
  const cacheDir = options.get("--cache-dir");
  if (!repoRoot || !cacheDir) throw new Error("--repo-root and --cache-dir are required");
  const phase = (options.get("--phase") ?? "all") as ColdBuildPhase;
  if (phase !== "parse" && phase !== "resolve" && phase !== "all") {
    throw new Error(`invalid --phase ${phase}`);
  }
  return { repoRoot, cacheDir, generation: Number(options.get("--generation") || 1), phase };
}

function spawnPhase(
  repoRoot: string,
  cacheDir: string,
  generation: number,
  phase: Exclude<ColdBuildPhase, "all">
): Promise<ColdBuildResult | undefined> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      "--max-old-space-size=1536",
      "--expose-gc",
      SELF,
      "--repo-root",
      repoRoot,
      "--cache-dir",
      cacheDir,
      "--generation",
      String(generation),
      "--phase",
      phase
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
      stdout += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", code => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as ColdBuildResult);
      } catch {
        resolve(undefined);
      }
    });
  });
}

function combinePhaseResults(parseResult: ColdBuildResult, resolveResult: ColdBuildResult): ColdBuildResult {
  return {
    ok: true,
    files: resolveResult.files,
    discovered: parseResult.discovered,
    parseFailed: parseResult.parseFailed,
    ...(parseResult.lastParseError ? { lastParseError: parseResult.lastParseError } : {}),
    snapshotBytes: resolveResult.snapshotBytes,
    rssPeakBytes: Math.max(parseResult.rssPeakBytes, resolveResult.rssPeakBytes),
    heapUsedBytes: resolveResult.heapUsedBytes,
    phasesMs: {
      discover: parseResult.phasesMs.discover,
      parse: parseResult.phasesMs.parse,
      resolve: resolveResult.phasesMs.resolve,
      snapshotPrepare: parseResult.phasesMs.snapshotPrepare + resolveResult.phasesMs.snapshotPrepare,
      snapshotEncode: parseResult.phasesMs.snapshotEncode + resolveResult.phasesMs.snapshotEncode,
      graphEncode: resolveResult.phasesMs.graphEncode,
      total: parseResult.phasesMs.total + resolveResult.phasesMs.total
    }
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.phase === "parse" || cli.phase === "resolve") {
    const result = await runColdIndexBuild(cli.repoRoot, cli.cacheDir, cli.generation, cli.phase);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const parseResult = await spawnPhase(cli.repoRoot, cli.cacheDir, cli.generation, "parse");
  if (!parseResult?.ok) {
    process.exitCode = 1;
    return;
  }
  const resolveResult = await spawnPhase(cli.repoRoot, cli.cacheDir, cli.generation, "resolve");
  if (!resolveResult?.ok) {
    process.exitCode = 1;
    return;
  }
  const combined = combinePhaseResults(parseResult, resolveResult);
  await writeFile(path.join(cli.cacheDir, "cold-build-metrics.json"), `${JSON.stringify({
    rssPeakBytes: combined.rssPeakBytes,
    heapUsedBytes: combined.heapUsedBytes,
    files: combined.files,
    phasesMs: combined.phasesMs
  })}\n`);
  process.stdout.write(`${JSON.stringify(combined)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
