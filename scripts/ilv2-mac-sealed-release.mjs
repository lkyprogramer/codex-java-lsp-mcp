#!/usr/bin/env node
// Bind installation to the exact tree accepted by the validation broker.
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute, isMain, managedPath, readJson, requireUnprotectedRoot, requireValue, runCli, sha256, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { dependencyTreeInventory, sameDependencyInventory } from "./isolation-utils.mjs";
import { NATIVE_PROTOCOL, SIGNING_IDENTIFIER } from "./build-macos-native.mjs";
import { verifySignature } from "./managed-owner-launcher.mjs";
import { formalTarget, requireFormalPath } from "./ilv2-mac-formal-target.mjs";

export async function releaseInventory(candidate) {
  return {
    files: await dependencyTreeInventory(candidate, { includeMode: true, excludeRoot: [".git", "node_modules"] }),
    dependencies: await dependencyTreeInventory(path.join(candidate, "node_modules"), { includeMode: true })
  };
}

export function assertReleaseInventory(expected, actual) {
  requireValue(sameDependencyInventory(expected.files, actual.files), "sealed release file tree mismatch");
  requireValue(sameDependencyInventory(expected.dependencies, actual.dependencies), "sealed release dependency tree mismatch");
}

export async function writeReleaseSeal(directory, { candidate, inventory, profile, identity }) {
  const seal = {
    schema: "ilv2-mac-sealed-release/v1", profile, candidate, inventory,
    gitSha: identity.build.gitSha,
    nativeSha256: identity.native.binarySha256,
    runtimeManifestSha256: identity.runtime.runtimeManifestSha256,
    validationSha256: sha256(await readFile(path.join(directory, "result.json")))
  };
  const file = path.join(directory, "sealed-release.json");
  const bytes = JSON.stringify(seal, null, 2) + "\n";
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return { path: file, sha256: sha256(bytes) };
}

async function loadAcceptedRelease(file, digest, formal) {
  const root = process.env.ILV2_RUN_ROOT;
  requireValue((formal ? !process.env.JAVA_LSP_ISOLATED_VALIDATION : process.env.JAVA_LSP_ISOLATED_VALIDATION === "1")
    && root && path.isAbsolute(root)
    && (await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "registered release acceptance required");
  requireUnprotectedRoot(root, "sealed release");
  requireValue(await managedPath(root, file) === file, "seal must be a canonical file under the run root");
  const bytes = await readFile(file);
  requireValue(/^[0-9a-f]{64}$/.test(digest) && sha256(bytes) === digest, "sealed release acceptance digest mismatch");
  const seal = JSON.parse(bytes);
  requireValue(seal.schema === "ilv2-mac-sealed-release/v1" && ["targeted", "full"].includes(seal.profile)
    && /^[a-f0-9]{12}$/.test(seal.gitSha), "invalid sealed release acceptance");
  requireValue(await managedPath(root, seal.candidate) === seal.candidate, "candidate must belong to the registered run");
  await managedPath(root, path.join(seal.candidate, "node_modules"));
  const validation = await readFile(path.join(path.dirname(file), "result.json"));
  requireValue(sha256(validation) === seal.validationSha256, "sealed release validation record mismatch");
  const record = JSON.parse(validation);
  requireValue(record.schema === "ilv2-validation-result/v1" && record.status === "SELECTED_COMMANDS_PASSED"
    && record.candidateRoot === seal.candidate && record.identity.build.gitSha === seal.gitSha
    && record.identity.native.binarySha256 === seal.nativeSha256
    && record.identity.runtime.runtimeManifestSha256 === seal.runtimeManifestSha256, "validation and sealed release identity differ");
  return { root, seal, native: record.identity.native };
}

async function requireInstalledPath(root, candidate, seal, formal) {
  if (formal) {
    const name = path.basename(candidate);
    requireValue(new RegExp(`^${seal.gitSha}-\\d{8}T\\d{6}Z$`).test(name), "formal release name must identify the sealed build");
    await requireFormalPath(path.join(formalTarget().runtime, "releases", name), candidate);
  } else {
    requireValue(await managedPath(root, candidate) === candidate, "installed release must belong to the registered run");
  }
}

export async function verifySealedRelease(file, digest, installed, formal = false) {
  const { root, seal, native } = await loadAcceptedRelease(file, digest, formal);
  const candidate = installed ?? seal.candidate;
  if (installed) {
    await requireInstalledPath(root, candidate, seal, formal);
    requireValue((await lstat(path.join(candidate, "node_modules"))).isDirectory(), "installed release dependencies must be local to the release");
  }
  const runtime = await verifyRuntime();
  requireValue(runtime.runtimeManifestSha256 === seal.runtimeManifestSha256
    && native.runtime?.runtimeManifestSha256 === seal.runtimeManifestSha256
    && native.arch === runtime.arch && native.protocol === NATIVE_PROTOCOL, "sealed release runtime mismatch");
  assertReleaseInventory(seal.inventory, await releaseInventory(candidate));
  const binary = path.join(candidate, "dist/native/ilv2-mac");
  const stamp = await readJson(path.join(candidate, "dist/build-stamp.json"));
  requireValue((await lstat(binary)).isFile() && sha256(await readFile(binary)) === seal.nativeSha256
    && stamp.gitSha === seal.gitSha && stamp.native?.binarySha256 === seal.nativeSha256, "sealed release build stamp or binary mismatch");
  const signing = native.signing;
  requireValue(signing?.mode === "identity" && signing.identifier === SIGNING_IDENTIFIER
    && signing.teamIdentifier && signing.teamIdentifier !== "not set"
    && signing.designatedRequirement && !/\bcdhash\b/.test(signing.designatedRequirement), "sealed release requires a stable signature");
  await verifySignature(binary, signing);
  return seal;
}

async function materialize(file, digest, destination, formal) {
  const { root, seal } = await loadAcceptedRelease(file, digest, formal);
  await requireInstalledPath(root, destination, seal, formal);
  await mkdir(destination);
  await execute("/usr/bin/rsync", ["-a", "--exclude=/.git", "--exclude=/node_modules", seal.candidate + "/", destination + "/"]);
  await mkdir(path.join(destination, "node_modules"));
  await execute("/usr/bin/rsync", ["-a", path.join(seal.candidate, "node_modules") + "/", path.join(destination, "node_modules") + "/"]);
  return verifySealedRelease(file, digest, destination, formal);
}

if (isMain(import.meta.url)) runCli(async () => {
  const [option, file, digest, destination, ...rest] = process.argv.slice(2);
  const formal = ["--verify-formal", "--materialize-formal"].includes(option);
  const command = formal ? option.slice(0, -"-formal".length) : option;
  requireValue(file && digest && !rest.length && (command === "--verify" && !destination
    || (command === "--materialize" || command === "--verify-installed") && destination), "invalid sealed release command");
  const seal = command === "--materialize" ? await materialize(file, digest, destination, formal)
    : await verifySealedRelease(file, digest, destination, formal);
  console.log(seal.gitSha);
});
