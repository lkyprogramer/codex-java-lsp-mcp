#!/usr/bin/env node
// input: --profile pr|nightly|release
// output: isolated gate run plus a raw SHA-256 of stdout/stderr.
// pos: V5R Phase 0. Profiles must execute different argv, not three identical full wrappers.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Shipped gate-profile table. Tests import this object; do not duplicate it.
 * pr: unit tests only. nightly: isolated full. release: full + HTTP smoke.
 */
export const GATE_PROFILES = {
  pr: {
    description: "PR-fast: isolated compile + dist unit tests (no script suite, no smoke)",
    steps: [
      {
        args: [
          "scripts/run-isolated-validation.mjs",
          "--profile",
          "targeted",
          "--",
          "node",
          "--test",
          "--test-concurrency=1",
          "dist/**/*.test.js"
        ]
      }
    ]
  },
  nightly: {
    description: "nightly: isolated full (unit tests + script tests + stdio smoke)",
    steps: [
      { args: ["scripts/run-isolated-validation.mjs", "--profile", "full"] }
    ]
  },
  release: {
    description: "release: isolated full plus HTTP five-tool smoke",
    steps: [
      { args: ["scripts/run-isolated-validation.mjs", "--profile", "full"] },
      {
        args: [
          "scripts/run-isolated-validation.mjs",
          "--profile",
          "targeted",
          "--env",
          "JAVA_LSP_HTTP_PORT=38491",
          "--",
          "node",
          "scripts/run-v4-http-smoke.mjs"
        ]
      }
    ]
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
  if (!GATE_PROFILES[profile]) throw new Error(`--profile must be ${Object.keys(GATE_PROFILES).join("|")}`);
  return { profile, output };
}

async function runStep(args) {
  const chunks = [];
  const child = spawn(process.execPath, args, { cwd: root, env: process.env });
  child.stdout.on("data", chunk => {
    chunks.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", chunk => {
    chunks.push(chunk);
    process.stderr.write(chunk);
  });
  const code = await new Promise(resolve => child.once("exit", resolve));
  return { code, raw: Buffer.concat(chunks) };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const selected = GATE_PROFILES[cli.profile];
  const chunks = [];
  let code = 0;
  for (const step of selected.steps) {
    const result = await runStep(step.args);
    chunks.push(result.raw);
    if (result.code !== 0) {
      code = typeof result.code === "number" ? result.code : 1;
      break;
    }
  }
  const raw = Buffer.concat(chunks);
  const hash = createHash("sha256").update(raw).digest("hex");
  const summary = {
    schemaVersion: "v5r-gate-profile/v1",
    profile: cli.profile,
    description: selected.description,
    steps: selected.steps.map(step => step.args),
    exitCode: code,
    rawSha256: hash,
    bytes: raw.length
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (cli.output) await writeFile(cli.output, text);
  process.stdout.write(text);
  if (code !== 0) process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
