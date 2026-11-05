#!/usr/bin/env node
// Dependency preparation must preserve macOS metadata and relative npm links.
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { cliOptions, contains, execute, isMain, newOutput, readJson, requireUnprotectedRoot, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { dependencyTreeInventory, sameDependencyInventory } from "./isolation-utils.mjs";

export async function restoreDependencyArchive({ archive, destination, expectedArchiveSha256, expectedDependencies, runRoot = process.env.ILV2_RUN_ROOT }) {
  requireValue(process.platform === "darwin", "macOS native tar required");
  requireValue(runRoot && path.isAbsolute(runRoot), "absolute registered run root required");
  const root = await realpath(runRoot);
  requireValue((await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "run root must be preregistered");
  requireUnprotectedRoot(root, "dependency restore root");
  requireValue(/^[a-f0-9]{64}$/.test(expectedArchiveSha256 ?? ""), "archive SHA-256 required");
  requireValue(sha256(await readFile(archive)) === expectedArchiveSha256, "dependency archive SHA-256 mismatch");
  requireValue(expectedDependencies?.schemaVersion === 1 && typeof expectedDependencies.sha256 === "string", "expected dependency inventory required");
  const output = await newOutput(root, destination);
  // bsdtar consumes AppleDouble entries as metadata; generic extractors can
  // materialize ._*.node as libraries that node-gyp-build selects first.
  await execute("/usr/bin/tar", ["-xzf", path.resolve(archive), "-C", output, "./node_modules"], { timeout: 120000 });
  const dependencies = await dependencyTreeInventory(path.join(output, "node_modules"));
  requireValue(sameDependencyInventory(expectedDependencies, dependencies), "restored dependency inventory mismatch");
  return { schema: "ilv2-mac-dependency-restore/v1", status: "PASS", archiveSha256: expectedArchiveSha256, destination: output, dependencies };
}

// Invoke this CLI in a fresh Node process so require.cache cannot hide a broken
// binding or select a dependency loaded earlier from another repository.
async function checkNativeDependencies(repoRoot) {
  requireValue(path.isAbsolute(repoRoot), "absolute repository root required");
  const dependencies = await realpath(path.join(repoRoot, "node_modules"));
  const require = createRequire(path.join(repoRoot, "package.json"));
  const loaderPath = await realpath(require.resolve("node-gyp-build"));
  requireValue(contains(dependencies, loaderPath), "node-gyp-build resolved outside dependencies");
  const loader = require("node-gyp-build");
  const bindings = [];
  for (const name of ["tree-sitter", "tree-sitter-java"]) {
    const packageRoot = await realpath(path.join(dependencies, name));
    requireValue(contains(dependencies, packageRoot), `${name} resolved outside dependencies`);
    const selected = loader.path(packageRoot);
    requireValue(!path.basename(selected).startsWith("._"), `${name}: AppleDouble selected as native binding`);
    const actual = await realpath(selected);
    requireValue(contains(dependencies, actual), `${name} binding resolved outside dependencies`);
    const bytes = await readFile(actual);
    bindings.push({ package: name, path: path.relative(dependencies, actual), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const Parser = require("tree-sitter");
  const Java = require("tree-sitter-java");
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse("class Evidence {}");
  requireValue(tree.rootNode.type === "program" && !tree.rootNode.hasError, "native Java parser smoke failed");
  return { schema: "ilv2-mac-dependency-load/v1", status: "PASS", node: { execPath: process.execPath, version: process.version, arch: process.arch }, loader: path.relative(dependencies, loaderPath), bindings, parse: { rootType: tree.rootNode.type, hasError: tree.rootNode.hasError } };
}

if (isMain(import.meta.url)) runCli(async () => {
  const [operation, ...args] = process.argv.slice(2);
  let result;
  if (operation === "check") {
    const options = cliOptions(args, ["--repo-root"]);
    result = await checkNativeDependencies(options["repo-root"]);
  } else {
    requireValue(operation === "restore", "expected restore or check");
    const options = cliOptions(args, ["--archive", "--out", "--archive-sha256", "--inventory"]);
    result = await restoreDependencyArchive({ archive: options.archive, destination: options.out, expectedArchiveSha256: options["archive-sha256"], expectedDependencies: await readJson(options.inventory) });
    result.load = await checkNativeDependencies(result.destination);
  }
  console.log(JSON.stringify(result, null, 2));
});
