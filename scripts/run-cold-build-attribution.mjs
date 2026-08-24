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
    cacheDir: options.get("--cache-dir"),
    lishuedu: options.get("--lishuedu"),
    cipherlink: options.get("--cipherlink"),
    "exam-parent-v3": options.get("--exam-parent-v3")
  };
}

const cli = parseArgs(process.argv.slice(2));
const three = {
  lishuedu: cli.lishuedu,
  cipherlink: cli.cipherlink,
  "exam-parent-v3": cli["exam-parent-v3"]
};
const threeComplete = Object.values(three).every(Boolean);
if (!cli.output || (!cli.repo && !threeComplete)) {
  throw new Error("--output and either --repo or the three golden roots are required");
}

async function measure(repo, cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  return runColdIndexBuild(path.resolve(repo), cacheDir, 1);
}

if (threeComplete) {
  const base = cli.cacheDir ?? path.join(os.tmpdir(), "o2-cold-cache");
  const projects = {};
  for (const [name, repo] of Object.entries(three)) {
    process.stderr.write(`cold-attribution: ${name}\n`);
    projects[name] = await measure(repo, path.join(base, name));
  }
  const payload = {
    schemaVersion: "o2-cold/v1",
    dated: new Date().toISOString().slice(0, 10),
    gateMs: 60_000,
    projects
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: path.resolve(cli.output),
    totalsMs: Object.fromEntries(Object.entries(projects).map(([name, row]) => [name, row.phasesMs?.total])),
    lishueduPass: (projects.lishuedu?.phasesMs?.total ?? Infinity) <= 60_000
  })}\n`);
} else {
  const cacheDir = cli.cacheDir ?? path.join(os.tmpdir(), "m6-4-cold-cache");
  const result = await measure(cli.repo, cacheDir);
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
