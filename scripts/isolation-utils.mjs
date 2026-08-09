// input: A readable local Git repository, destination, and exact commit.
// output: Detached clones, private dependency identities, and commands bound to private validation state.
// pos: Shared validation isolation primitive for code, Java repositories, and formal matrices.
import { createHash } from "node:crypto";
import { cp, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const ISOLATED_STATE_FLAGS = new Set([
  "--index-cache-dir",
  "--cache-dir",
  "--output",
  "--output-dir",
  "--artifact-root",
  "--workspace-dir",
  "--data-dir",
  "--log-dir",
  "--state-dir"
]);
const CANDIDATE_ROOT_FLAGS = new Set(["--repo-root", "--candidate-root"]);
const NESTED_ISOLATION_BROKERS = new Set(["scripts/run-isolated-jdt-benchmark.mjs"]);
const HOST_NODE_RUNTIME_SELECTORS = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_HISTORY",
  "NODE_V8_COVERAGE",
  "NODE_COMPILE_CACHE",
  "NODE_REDIRECT_WARNINGS"
];
const NODE_CODE_LOADING_OPTIONS = new Set([
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--snapshot-blob",
  "--build-snapshot-config"
]);

export function detachedLocalCloneCommands(source, target, revision) {
  return [
    { command: "git", args: ["clone", "--shared", "--no-checkout", source, target] },
    { command: "git", args: ["-C", target, "checkout", "--detach", revision] }
  ];
}

export async function createDetachedLocalClone(source, target, revision, run) {
  for (const step of detachedLocalCloneCommands(source, target, revision)) {
    await run(step.command, step.args);
  }
}

export async function copyIsolatedNodeModules(sourceRoot, isolationRoot) {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(isolationRoot, "node_modules");
  await cp(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false
  });
  return target;
}

export async function dependencyTreeInventory(root) {
  const resolvedRoot = path.resolve(root);
  const digest = createHash("sha256");
  const totals = { fileCount: 0, directoryCount: 0, symlinkCount: 0, totalBytes: 0 };

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join(path.posix.sep), entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        totals.directoryCount += 1;
        digest.update(`D\0${relativePath}\n`);
        await visit(absolutePath, path.join(relativeDirectory, entry.name));
      } else if (entry.isFile()) {
        const bytes = await readFile(absolutePath);
        totals.fileCount += 1;
        totals.totalBytes += bytes.byteLength;
        digest.update(`F\0${relativePath}\0${bytes.byteLength}\0${sha256(bytes)}\n`);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
        if (!isWithin(resolvedRoot, resolvedTarget)) {
          throw new Error(`isolated dependency symlink escapes node_modules: ${relativePath}`);
        }
        totals.symlinkCount += 1;
        digest.update(`L\0${relativePath}\0${target}\n`);
      } else {
        throw new Error(`unsupported isolated dependency entry: ${relativePath}`);
      }
    }
  }

  await visit(resolvedRoot);
  return {
    schemaVersion: 1,
    algorithm: "sha256-path-type-size-content-v1",
    ...totals,
    sha256: digest.digest("hex")
  };
}

export function sameDependencyInventory(left, right) {
  return left?.schemaVersion === right?.schemaVersion
    && left?.algorithm === right?.algorithm
    && left?.fileCount === right?.fileCount
    && left?.directoryCount === right?.directoryCount
    && left?.symlinkCount === right?.symlinkCount
    && left?.totalBytes === right?.totalBytes
    && left?.sha256 === right?.sha256;
}

export function scrubHostNodeRuntimeState(environment) {
  const isolated = { ...environment };
  for (const name of HOST_NODE_RUNTIME_SELECTORS) delete isolated[name];
  return isolated;
}

export function validateCandidateNodeCommand(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("isolated validation requires a command");
  if (values[0] !== "node" && values[0] !== process.execPath) {
    throw new Error("isolated validation commands must use the current Node executable");
  }
  for (const value of values.slice(1)) {
    const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (
      value === "-" ||
      value === "-e" || value.startsWith("-e") ||
      value === "--eval" || value.startsWith("--eval=") ||
      value === "-p" || value.startsWith("-p") ||
      value === "--print" || value.startsWith("--print=")
    ) {
      throw new Error("isolated validation forbids inline Node evaluation");
    }
    if (NODE_CODE_LOADING_OPTIONS.has(option) || (value.startsWith("-r") && !value.startsWith("--"))) {
      throw new Error(`isolated validation forbids Node code-loading option: ${option}`);
    }
  }
  for (const value of values.slice(1)) {
    if (!/\.(?:[cm]?js|ts)$/.test(value)) continue;
    if (path.isAbsolute(value) || path.normalize(value).startsWith(`..${path.sep}`)) {
      throw new Error("isolated validation script paths must be candidate-relative");
    }
  }
  return values;
}

export function bindCandidateNodeCommand(values, { candidateRoot, stateRoot }) {
  validateCandidateNodeCommand(values);
  const script = values.slice(1).find(value => /\.(?:[cm]?js|ts)$/.test(value));
  if (script && NESTED_ISOLATION_BROKERS.has(path.normalize(script))) return [...values];

  const command = [...values];
  for (let index = 0; index < command.length; index += 1) {
    const value = command[index];
    if ([...ISOLATED_STATE_FLAGS, ...CANDIDATE_ROOT_FLAGS].some(flag => value.startsWith(`${flag}=`))) {
      throw new Error("isolated validation path flags must use a separate placeholder-bound value");
    }
    if (!ISOLATED_STATE_FLAGS.has(value) && !CANDIDATE_ROOT_FLAGS.has(value)) continue;
    const rawPath = command[index + 1];
    if (typeof rawPath !== "string") throw new Error(`${value} requires a path`);
    if (ISOLATED_STATE_FLAGS.has(value)) {
      if (!(rawPath.includes("{state}") || rawPath.includes("{candidate}"))) {
        throw new Error(`${value} must use a {state} or {candidate} placeholder`);
      }
    } else if (rawPath !== "." && !rawPath.includes("{candidate}")) {
      throw new Error(`${value} must use . or a {candidate} placeholder`);
    }
    const bound = rawPath === "."
      ? candidateRoot
      : rawPath.replaceAll("{candidate}", candidateRoot).replaceAll("{state}", stateRoot);
    const allowedRoot = ISOLATED_STATE_FLAGS.has(value) && rawPath.includes("{state}") ? stateRoot : candidateRoot;
    if (!isWithin(allowedRoot, path.resolve(bound))) {
      throw new Error(`${value} escapes isolated validation state`);
    }
    command[index + 1] = bound;
    index += 1;
  }
  return command;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
