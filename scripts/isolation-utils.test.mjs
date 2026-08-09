import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bindCandidateNodeCommand,
  copyIsolatedNodeModules,
  dependencyTreeInventory,
  detachedLocalCloneCommands,
  sameDependencyInventory,
  scrubHostNodeRuntimeState,
  validateCandidateNodeCommand
} from "./isolation-utils.mjs";

test("detached local clone never uses source worktree metadata", () => {
  const commands = detachedLocalCloneCommands("/source", "/isolated/repo", "a".repeat(40));
  assert.deepEqual(commands, [
    { command: "git", args: ["clone", "--shared", "--no-checkout", "/source", "/isolated/repo"] },
    { command: "git", args: ["-C", "/isolated/repo", "checkout", "--detach", "a".repeat(40)] }
  ]);
  assert.equal(JSON.stringify(commands).includes("worktree"), false);
});

test("isolated validation accepts candidate-relative Node scripts and rejects shell or active absolute scripts", () => {
  assert.deepEqual(validateCandidateNodeCommand(["node", "--test", "scripts/example.test.mjs"]), [
    "node",
    "--test",
    "scripts/example.test.mjs"
  ]);
  assert.throws(() => validateCandidateNodeCommand(["sh", "-c", "true"]), /current Node executable/);
  assert.throws(() => validateCandidateNodeCommand(["node", "/active/checkout/dist/server.js"]), /candidate-relative/);
  assert.throws(() => validateCandidateNodeCommand(["node", "-e", "process.exit(0)"]), /inline Node evaluation/);
  assert.throws(() => validateCandidateNodeCommand(["node", "--eval=process.exit(0)"]), /inline Node evaluation/);
  assert.throws(() => validateCandidateNodeCommand(["node", "-p1+1"]), /inline Node evaluation/);
  assert.throws(() => validateCandidateNodeCommand(["node", "--require=/active/mutator.cjs", "dist/server.js"]), /code-loading option/);
  assert.throws(() => validateCandidateNodeCommand(["node", "-r/active/mutator.cjs", "dist/server.js"]), /code-loading option/);
  assert.throws(() => validateCandidateNodeCommand(["node", "--import", "file:///active/mutator.mjs", "dist/server.js"]), /code-loading option/);
  assert.throws(() => validateCandidateNodeCommand(["node", "--experimental-loader=/active/loader.mjs", "dist/server.js"]), /code-loading option/);
  assert.throws(() => validateCandidateNodeCommand(["node", "--env-file=/active/runtime.env", "dist/server.js"]), /code-loading option/);
});

test("host Node runtime selectors never reach isolated child processes", () => {
  const clean = scrubHostNodeRuntimeState({
    TASK_MARKER: "yes",
    NODE_OPTIONS: "--require=/active/mutator.cjs",
    NODE_PATH: "/active/node_modules",
    NODE_REPL_HISTORY: "/active/repl-history",
    NODE_V8_COVERAGE: "/active/coverage",
    NODE_COMPILE_CACHE: "/active/compile-cache",
    NODE_REDIRECT_WARNINGS: "/active/warnings.log"
  });
  assert.deepEqual(clean, { TASK_MARKER: "yes" });
});

test("shell bootstrap clears Node loaders before the isolation broker starts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolated-node-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "loader-ran");
  const output = path.join(root, "environment.json");
  const loader = path.join(root, "loader.cjs");
  const target = path.join(root, "target.mjs");
  const bootstrap = fileURLToPath(new URL("./run-isolated-node.sh", import.meta.url));
  await writeFile(loader, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded")\n`);
  await writeFile(target, [
    "import { writeFile } from \"node:fs/promises\";",
    "const names = [\"NODE_OPTIONS\", \"NODE_PATH\", \"NODE_REPL_HISTORY\", \"NODE_V8_COVERAGE\", \"NODE_COMPILE_CACHE\", \"NODE_REDIRECT_WARNINGS\"];",
    "await writeFile(process.argv[2], JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))));"
  ].join("\n"));

  const result = await run("sh", [bootstrap, target, output], {
    ...process.env,
    NODE_OPTIONS: `--require=${loader}`,
    NODE_PATH: "/active/node_modules",
    NODE_REPL_HISTORY: "/active/repl-history",
    NODE_V8_COVERAGE: "/active/coverage",
    NODE_COMPILE_CACHE: "/active/compile-cache",
    NODE_REDIRECT_WARNINGS: "/active/warnings.log"
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {});
  await assert.rejects(readFile(marker), error => error?.code === "ENOENT");
});

test("isolated dependency copy never links validation writes back to source node_modules", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolation-utils-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const isolated = path.join(root, "isolated");
  await mkdir(path.join(source, "node_modules", "fixture"), { recursive: true });
  await mkdir(isolated, { recursive: true });
  await writeFile(path.join(source, "node_modules", "fixture", "index.js"), "source\n");
  await symlink("fixture/index.js", path.join(source, "node_modules", "entry.js"));

  const copied = await copyIsolatedNodeModules(source, isolated);
  assert.equal(await readlink(path.join(copied, "entry.js")), "fixture/index.js");
  assert.deepEqual(
    await dependencyTreeInventory(copied),
    await dependencyTreeInventory(path.join(source, "node_modules"))
  );
  await writeFile(path.join(copied, "fixture", "index.js"), "isolated\n");

  assert.equal(await readFile(path.join(source, "node_modules", "fixture", "index.js"), "utf8"), "source\n");
  assert.equal(await readFile(path.join(copied, "fixture", "index.js"), "utf8"), "isolated\n");
});

test("dependency inventory binds file bytes and internal symlink targets deterministically", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolation-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "pkg"), { recursive: true });
  await writeFile(path.join(root, "pkg", "index.js"), "one\n");
  await symlink("pkg/index.js", path.join(root, "entry.js"));

  const first = await dependencyTreeInventory(root);
  const second = await dependencyTreeInventory(root);
  assert.deepEqual(second, first);
  assert.equal(sameDependencyInventory(first, second), true);
  assert.deepEqual(
    { files: first.fileCount, directories: first.directoryCount, symlinks: first.symlinkCount, bytes: first.totalBytes },
    { files: 1, directories: 1, symlinks: 1, bytes: 4 }
  );

  await writeFile(path.join(root, "pkg", "index.js"), "two\n");
  const changed = await dependencyTreeInventory(root);
  assert.notEqual(changed.sha256, first.sha256);
  assert.equal(sameDependencyInventory(first, changed), false);
});

test("dependency inventory rejects a symlink back to non-isolated state", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolation-inventory-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(path.join(os.tmpdir(), "active-node-modules"), path.join(root, "escape"));
  await assert.rejects(() => dependencyTreeInventory(root), /symlink escapes/);
});

test("candidate commands bind writable and repository paths to private placeholders", () => {
  const candidateRoot = "/private/candidate";
  const stateRoot = "/private/state";
  assert.deepEqual(
    bindCandidateNodeCommand([
      "node",
      "dist/benchmark.js",
      "--repo-root", ".",
      "--index-cache-dir", "{state}/index",
      "--output", "{candidate}/result.json"
    ], { candidateRoot, stateRoot }),
    [
      "node",
      "dist/benchmark.js",
      "--repo-root", candidateRoot,
      "--index-cache-dir", "/private/state/index",
      "--output", "/private/candidate/result.json"
    ]
  );
  assert.throws(
    () => bindCandidateNodeCommand(["node", "dist/benchmark.js", "--index-cache-dir", "/active/cache"], { candidateRoot, stateRoot }),
    /placeholder/
  );
  assert.throws(
    () => bindCandidateNodeCommand(["node", "dist/benchmark.js", "--repo-root", "/active/repo"], { candidateRoot, stateRoot }),
    /candidate/
  );
});

test("nested JDT isolation broker retains its own repo and state placeholders", () => {
  const command = [
    "node",
    "scripts/run-isolated-jdt-benchmark.mjs",
    "--repo-root", "/source/repo",
    "--",
    "node", "dist/benchmark.js", "--repo-root", "{repo}", "--output", "{state}/result.json"
  ];
  assert.deepEqual(bindCandidateNodeCommand(command, {
    candidateRoot: "/private/candidate",
    stateRoot: "/private/state"
  }), command);
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}
