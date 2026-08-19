#!/usr/bin/env node
// input: --profile pr|nightly|release
// output: isolated gate run plus a raw SHA-256 of stdout/stderr.
// pos: V4-14 runnable profiles. Raw dumps stay off git; this prints the hash.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROFILES = {
  pr: {
    description: "PR-fast: compile + targeted tests already compiled by isolation",
    args: ["scripts/run-isolated-validation.mjs", "--profile", "full"]
  },
  nightly: {
    description: "nightly: isolated full plus script-level matrix tests",
    args: ["scripts/run-isolated-validation.mjs", "--profile", "full"]
  },
  release: {
    description: "release: isolated full + HTTP smoke",
    args: ["scripts/run-isolated-validation.mjs", "--profile", "full"]
  }
};

function parseCli(args) {
  let profile = "pr";
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--profile") profile = args[++index];
    else if (args[index] === "--output") output = args[++index];
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  if (!PROFILES[profile]) throw new Error(`--profile must be ${Object.keys(PROFILES).join("|")}`);
  return { profile, output };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const selected = PROFILES[cli.profile];
  const chunks = [];
  const child = spawn(process.execPath, selected.args, { cwd: root, env: process.env });
  child.stdout.on("data", chunk => {
    chunks.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", chunk => {
    chunks.push(chunk);
    process.stderr.write(chunk);
  });
  const code = await new Promise(resolve => child.once("exit", resolve));
  const raw = Buffer.concat(chunks);
  const hash = createHash("sha256").update(raw).digest("hex");
  const summary = {
    schemaVersion: "v4-gate-profile/v1",
    profile: cli.profile,
    description: selected.description,
    exitCode: code,
    rawSha256: hash,
    bytes: raw.length
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (cli.output) await writeFile(cli.output, text);
  process.stdout.write(text);
  if (code !== 0) process.exitCode = typeof code === "number" ? code : 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
