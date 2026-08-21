#!/usr/bin/env node
// input: --repo-root --cache-dir --generation. Isolated child only.
// output: v4 snapshot files plus one JSON line {ok, files, rssPeakBytes, heapUsedBytes}.
// pos: M3 P3. Spawned by the JavaIndex worker; must not open a worker of its own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runColdIndexBuild } from "./cold-build.js";

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
  return { repoRoot, cacheDir, generation: Number(options.get("--generation") || 1) };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const result = await runColdIndexBuild(cli.repoRoot, cli.cacheDir, cli.generation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
