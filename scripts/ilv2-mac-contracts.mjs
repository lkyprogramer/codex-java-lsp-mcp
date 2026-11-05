// Shared boundary checks for the Mac lifecycle acceptance runners.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "ilv2-mac-run/v1";
// User-approved absolute timing-window admission limit (2026-10-21).
export const TIMING_LOAD1_LIMIT = 20;
export function timingWindowIdle(start, end, limit = TIMING_LOAD1_LIMIT) {
  return [start?.load1, end?.load1].every(value => Number.isFinite(value) && value >= 0 && value < limit);
}
// ILV2-MAC/5: outside every TCC-protected folder. The pre-MAC/5 root under
// ~/Documents/evidence-archive stays a read-only historical archive.
export const MAC_WORK_ROOT = path.join(os.userInfo().homedir, "Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac");
// A launchd job that loads or reads files below these folders waits for a TCC
// decision before main (G02B runs 20261014T035836Z/061337Z). Managed roots must avoid them.
const TCC_PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents", "Library/CloudStorage"];
// Removable and network volumes are TCC services of their own.
const TCC_PROTECTED_ROOTS = ["/Volumes"];
export const execute = promisify(execFile);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const readJson = async file => JSON.parse(await readFile(file, "utf8"));
export const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function isMain(meta) { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(meta); }
export function cliOptions(args, names) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    requireValue(names.includes(name) && !Object.hasOwn(options, name.slice(2)) && args[index + 1] !== undefined, `invalid option: ${name}`);
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}
export async function verifyRuntime(file = process.env.ILV2_RUNTIME_MANIFEST) {
  requireValue(file && path.isAbsolute(file), "absolute runtime manifest required");
  const bytes = await readFile(file);
  const manifest = JSON.parse(bytes);
  const actual = {
    execPath: process.execPath, nodeRealpath: await realpath(process.execPath),
    nodeSha256: sha256(await readFile(process.execPath)), arch: process.arch,
    versions: { ...process.versions }
  };
  requireValue(manifest.schema === "ilv2-mac-runtime/v1", "unsupported runtime manifest");
  for (const field of ["execPath", "nodeRealpath", "nodeSha256", "arch"]) {
    requireValue(manifest[field] === actual[field], `runtime drift: ${field}`);
  }
  requireValue(JSON.stringify(Object.entries(manifest.versions).sort()) === JSON.stringify(Object.entries(actual.versions).sort()), "runtime drift: versions");
  requireValue(process.platform === "darwin", "Mac runtime required");
  requireValue(manifest.os === (await execute("/usr/bin/sw_vers", [])).stdout, "runtime drift: macOS build");
  return { ...actual, runtimeManifestSha256: sha256(bytes) };
}

export function contains(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Return the TCC-protected user folder that contains target, or null. APFS is case-insensitive here. */
export function tccProtectedFolder(target, home = os.userInfo().homedir) {
  const folded = path.resolve(target).toLowerCase();
  return [...TCC_PROTECTED_FOLDERS.map(name => path.join(home, name)), ...TCC_PROTECTED_ROOTS].find(root => contains(root.toLowerCase(), folded)) ?? null;
}
export function requireUnprotectedRoot(target, label) {
  const folder = tccProtectedFolder(target);
  requireValue(!folder, `BLOCKED_ENV_TCC_PATH: ${label} ${target} is inside TCC-protected ${folder}`);
}
export async function resolvedPath(target) {
  try { return await realpath(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    requireValue(parent !== target, "unresolvable path");
    return path.join(await resolvedPath(parent), path.basename(target));
  }
}
export async function managedPath(root, target) {
  requireValue(path.isAbsolute(root) && path.isAbsolute(target), "managed paths must be absolute");
  const actualRoot = await resolvedPath(root);
  const actualTarget = await resolvedPath(target);
  requireValue(contains(actualRoot, actualTarget) && actualRoot !== actualTarget, "path outside managed root");
  const productionHome = os.userInfo().homedir;
  for (const forbidden of [path.join(productionHome, "Library/Caches/codex-java-lsp"), path.join(productionHome, "Library/Application Support/codex-java-lsp-mcp")]) {
    requireValue(!contains(await resolvedPath(forbidden), actualTarget), "production path rejected");
  }
  return actualTarget;
}
export async function newOutput(root, target) {
  const actual = await managedPath(root, target);
  await mkdir(actual, { recursive: false });
  return actual;
}

export async function createRegisteredBrokerRoot(prefix) {
  const runRoot = process.env.ILV2_RUN_ROOT;
  if (runRoot) {
    requireValue((await readFile(path.join(runRoot, "run-root.txt"), "utf8")).trim() === path.resolve(runRoot), "run root must be preregistered");
    requireValue(contains(await realpath(runRoot), await realpath(os.tmpdir())), "broker TMPDIR must belong to preregistered run root");
    requireUnprotectedRoot(await realpath(runRoot), "run root");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  // The preregistered parent covers a SIGKILL before this child is announced.
  console.error(JSON.stringify({ event: "broker-root-created", root, parentRunRoot: runRoot ?? null, pid: process.pid }));
  await writeJson(path.join(root, "broker-root.json"), { root, parentRunRoot: runRoot ?? null, pid: process.pid });
  return root;
}

export function relevantInput(relative) {
  return /\.(?:java|xml)$/.test(relative) || /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|libs\.versions\.toml|gradle-wrapper\.(?:properties|jar)|gradlew(?:\.bat)?)$/.test(relative);
}
export async function verifyFrozenInput(record, { signal } = {}) {
  const bytes = await readFile(record.manifest);
  requireValue(sha256(bytes) === record.manifestSha256, "input manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  requireValue(manifest.schema === "ilv2-mac-input/v1" && record.repoRoot === manifest.repoRoot && record.head === manifest.head, "input identity mismatch");
  const git = args => execute("git", ["--no-optional-locks", "-C", record.repoRoot, ...args], { maxBuffer: 32 * 1024 * 1024, signal });
  const head = (await git(["rev-parse", "HEAD^{commit}"])).stdout.trim();
  requireValue(head === record.head, "frozen HEAD mismatch");
  requireValue((await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout === "", "frozen worktree changed");
  try { await git(["fsck", "--full"]); } catch { throw new Error("frozen objects failed fsck"); }
  const paths = [];
  const requiredPaths = new Set(manifest.files.map(row => row.path));
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (relative === "" && entry.name === ".git") continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (relevantInput(name) || requiredPaths.has(name)) paths.push(name);
    }
  }
  await walk(record.repoRoot);
  paths.sort();
  requireValue(JSON.stringify(paths) === JSON.stringify(manifest.files.map(row => row.path).sort()), "frozen input path census mismatch");
  requireValue(new Set(paths).size === manifest.files.length, "duplicate frozen input paths");
  for (const row of manifest.files) {
    signal?.throwIfAborted();
    const file = path.resolve(record.repoRoot, row.path);
    requireValue(contains(record.repoRoot, file) && contains(await realpath(record.repoRoot), await realpath(file)) && !(await lstat(file)).isSymbolicLink(), "invalid frozen input path");
    const actual = await readFile(file);
    requireValue(actual.length === row.size && sha256(actual) === row.sha256, "frozen input bytes changed");
  }
  return { head, inputFiles: paths.length, manifestSha256: record.manifestSha256 };
}
export function runCli(operation) {
  const controller = new AbortController();
  let exitCode;
  const interrupt = () => { exitCode = 130; controller.abort(); };
  const terminate = () => { exitCode = 143; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  operation({ signal: controller.signal }).catch(error => { console.error(error.message); process.exitCode = 2; }).finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    if (exitCode) process.exitCode = exitCode;
  });
}
