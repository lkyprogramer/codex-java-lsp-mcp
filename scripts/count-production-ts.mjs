#!/usr/bin/env node
// input: A Git worktree and, optionally, an immutable revision.
// output: A reproducible manifest of production TypeScript paths, bytes, LOC, and SHA-256 values.
// pos: V3.2 source-size authority; counts src/**/*.ts and excludes only *.test.ts.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function countProductionTs({ root = scriptRoot, revision } = {}) {
  const resolvedRoot = path.resolve(root);
  const identity = await sourceIdentity(resolvedRoot, revision);
  const paths = revision
    ? await revisionPaths(resolvedRoot, identity.commit)
    : await worktreePaths(resolvedRoot);
  const files = [];
  for (const relativePath of paths) {
    const bytes = revision
      ? await gitBytes(resolvedRoot, identity.commit, relativePath)
      : await readFile(path.join(resolvedRoot, relativePath));
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      loc: countLines(bytes),
      sha256: sha256(bytes)
    });
  }
  const inventoryPayload = {
    scope: {
      include: "src/**/*.ts",
      exclude: ["src/**/*.test.ts", "dist/**", "generated output"]
    },
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalLoc: files.reduce((sum, file) => sum + file.loc, 0),
    files
  };
  return {
    schemaVersion: 1,
    source: identity,
    ...inventoryPayload,
    inventorySha256: sha256(stableJson(inventoryPayload))
  };
}

export function verifyProductionTsManifest(expected, actual) {
  if (!expected || expected.schemaVersion !== 1) {
    throw new Error("production TypeScript manifest must use schemaVersion 1");
  }
  const expectedStable = stableJson(expected);
  const actualStable = stableJson(actual);
  if (expectedStable !== actualStable) {
    throw new Error("production TypeScript manifest does not match the source-locked tree");
  }
  return true;
}

export function countLines(bytes) {
  if (bytes.byteLength === 0) return 0;
  const text = bytes.toString("utf8");
  const newlineCount = (text.match(/\n/g) || []).length;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

async function sourceIdentity(root, revision) {
  const commit = (await git(root, ["rev-parse", `${revision || "HEAD"}^{commit}`])).trim();
  const commitTree = (await git(root, ["rev-parse", `${commit}^{tree}`])).trim();
  if (revision) {
    return { kind: "git-revision", revision, commit, commitTree, executableTree: commitTree };
  }
  const executableTree = (await git(root, ["write-tree"])).trim();
  return { kind: "worktree", commit, commitTree, executableTree };
}

async function revisionPaths(root, commit) {
  const output = await git(root, ["ls-tree", "-r", "--name-only", commit, "--", "src"]);
  return filterProductionPaths(output.split(/\r?\n/));
}

async function worktreePaths(root) {
  const output = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"]);
  return filterProductionPaths(output.split(/\r?\n/))
    .filter(relativePath => existsSync(path.join(root, relativePath)));
}

function filterProductionPaths(paths) {
  return paths
    .filter(Boolean)
    .filter(relativePath => relativePath.startsWith("src/") && relativePath.endsWith(".ts"))
    .filter(relativePath => !relativePath.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right));
}

async function gitBytes(root, commit, relativePath) {
  const { stdout } = await execFileBuffer("git", ["-C", root, "show", `${commit}:${relativePath}`]);
  return stdout;
}

async function git(root, args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function execFileBuffer(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr?.toString("utf8");
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseCli(args) {
  const cli = { root: scriptRoot };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") cli.root = args[++index];
    else if (arg === "--revision") cli.revision = args[++index];
    else if (arg === "--output") cli.output = args[++index];
    else if (arg === "--verify") cli.verify = args[++index];
    else if (arg === "--help" || arg === "-h") cli.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return cli;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("Usage: node scripts/count-production-ts.mjs [--root PATH] [--revision REV] [--output FILE] [--verify FILE]");
    return;
  }
  const manifest = await countProductionTs(cli);
  if (cli.verify) {
    verifyProductionTsManifest(JSON.parse(await readFile(path.resolve(cli.verify), "utf8")), manifest);
  }
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (cli.output) await writeFile(path.resolve(cli.output), contents);
  else process.stdout.write(contents);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
