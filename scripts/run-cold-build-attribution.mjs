#!/usr/bin/env node
// input: A golden Java repo. output: cold-build phase timings (parse/resolve/v4 encode/graph).
// pos: M6-4 attribution. Isolated. Does not change production query/selection.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runColdIndexBuild } from "../dist/java-index/cold-build.js";

if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
  throw new Error("run-cold-build-attribution must run through isolated validation");
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    repo: options.get("--repo"),
    output: options.get("--output"),
    cacheDir: options.get("--cache-dir")
  };
}

const cli = parseArgs(process.argv.slice(2));
if (!cli.repo || !cli.output) throw new Error("--repo and --output are required");
const cacheDir = cli.cacheDir ?? path.join(os.tmpdir(), "m6-4-cold-cache");
await mkdir(cacheDir, { recursive: true });
const result = await runColdIndexBuild(path.resolve(cli.repo), cacheDir, 1);
await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
await writeFile(cli.output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
