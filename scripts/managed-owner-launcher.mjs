// Fixed owner bundle shared by installation and explicit release rollback.
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute, isMain, runCli, sha256, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { NATIVE_PROTOCOL, SIGNING_IDENTIFIER } from "./build-macos-native.mjs";

const files = ["package.json", "dist/native/ilv2-mac", "dist/native/manifest.json",
  ...["owner-lock-guard", "owner-lock", "clonefile", "native-protocol", "native-exec"].map(name => `dist/mac-platform/${name}.js`)];

async function verifySignature(binary, signing) {
  await execute("/usr/bin/codesign", ["--verify", "--strict", binary]);
  const details = (await execute("/usr/bin/codesign", ["-dv", binary])).stderr;
  const requirement = (await execute("/usr/bin/codesign", ["-d", "-r-", binary])).stdout.match(/designated => (.*)/)?.[1];
  for (const [field, value] of [["Identifier", signing.identifier], ["TeamIdentifier", signing.teamIdentifier]]) {
    if (new RegExp(`^${field}=(.*)$`, "m").exec(details)?.[1] !== value) throw new Error("launcher signing identity mismatch");
  }
  if (requirement !== signing.designatedRequirement) throw new Error("launcher designated requirement mismatch");
}

export async function verifyOwnerBundle(directory, { runtime, signatureVerifier = verifySignature, capabilityVerifier } = {}) {
  runtime ??= await verifyRuntime();
  if (await realpath(directory) !== path.resolve(directory)) throw new Error("launcher bundle must use a real canonical path");
  for (const relative of ["", "dist", "dist/native", "dist/mac-platform", ...files, "bundle-artifacts.json"]) {
    const stat = await lstat(path.join(directory, relative));
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error(`unsafe launcher bundle permissions: ${relative}`);
  }
  const inventory = JSON.parse(await readFile(path.join(directory, "bundle-artifacts.json"), "utf8"));
  if (inventory.schema !== "ilv2-owner-bundle/v1" || JSON.stringify(Object.keys(inventory.files).sort()) !== JSON.stringify([...files].sort())) throw new Error("launcher bundle inventory mismatch");
  const actualFiles = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) actualFiles.push(name);
      else throw new Error("launcher bundle contains non-regular entries");
    }
  }
  await visit("");
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify([...files, "bundle-artifacts.json"].sort())) throw new Error("launcher bundle file set mismatch");
  for (const relative of files) if (sha256(await readFile(path.join(directory, relative))) !== inventory.files[relative]) throw new Error(`launcher bundle digest mismatch: ${relative}`);
  if (JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).type !== "module") throw new Error("launcher guard requires ESM");
  const binary = path.join(directory, "dist/native/ilv2-mac");
  if (!((await lstat(binary)).mode & 0o111)) throw new Error("launcher must be executable");
  const manifest = JSON.parse(await readFile(path.join(directory, "dist/native/manifest.json"), "utf8"));
  if (manifest.schema !== "ilv2-mac-native-build/v1" || manifest.protocol !== NATIVE_PROTOCOL || manifest.arch !== runtime.arch || manifest.binary !== "ilv2-mac" || manifest.binarySha256 !== sha256(await readFile(binary))) throw new Error("launcher binary/manifest mismatch");
  for (const field of ["execPath", "nodeSha256", "runtimeManifestSha256"]) if (manifest.runtime?.[field] !== runtime[field]) throw new Error(`launcher runtime mismatch: ${field}`);
  if (JSON.stringify(Object.entries(manifest.runtime.versions).sort()) !== JSON.stringify(Object.entries(runtime.versions).sort())) throw new Error("launcher runtime versions mismatch");
  const signing = manifest.signing;
  if (signing?.mode !== "identity" || signing.identifier !== SIGNING_IDENTIFIER || !signing.teamIdentifier || signing.teamIdentifier === "not set" || !signing.designatedRequirement || /\bcdhash\b/.test(signing.designatedRequirement)) throw new Error("launcher requires stable signing identity");
  await signatureVerifier(binary, signing);
  const capability = capabilityVerifier ? await capabilityVerifier(binary) : JSON.parse((await execute(binary, ["capability", path.dirname(binary)])).stdout);
  if (capability.protocol !== NATIVE_PROTOCOL || capability.arch !== runtime.arch) throw new Error("launcher capability mismatch");
  return manifest;
}

export async function prepareOwnerBundle(release, destination, options) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    await mkdir(path.join(destination, "dist/native"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(destination, "dist/mac-platform"), { recursive: true, mode: 0o700 });
    for (const relative of files.filter(file => file !== "package.json")) {
      const source = path.join(release, relative);
      if (!(await lstat(source)).isFile()) throw new Error(`launcher source is not a regular file: ${relative}`);
      await cp(source, path.join(destination, relative));
      await chmod(path.join(destination, relative), relative.endsWith("ilv2-mac") ? 0o755 : 0o600);
    }
    await writeFile(path.join(destination, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    const inventory = { schema: "ilv2-owner-bundle/v1", files: {} };
    for (const relative of files) inventory.files[relative] = sha256(await readFile(path.join(destination, relative)));
    await writeFile(path.join(destination, "bundle-artifacts.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    return await verifyOwnerBundle(destination, options);
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

export async function replaceOwnerBundle(prepared, destination, options) {
  await verifyOwnerBundle(prepared, options);
  const displaced = `${destination}.displaced.${process.pid}`;
  let present = false;
  try { await lstat(destination); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (present) await rename(destination, displaced);
  try { await rename(prepared, destination); }
  catch (error) { if (present) await rename(displaced, destination); throw error; }
  if (present) await rm(displaced, { recursive: true });
}

if (isMain(import.meta.url)) runCli(async () => {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (rest.length || !first || !["prepare", "verify", "replace"].includes(command) || (command !== "verify" && !second)) throw new Error("usage: managed-owner-launcher.mjs prepare <release> <bundle> | verify <bundle> [previous-bundle] | replace <prepared> <fixed>");
  if (command === "prepare") await prepareOwnerBundle(first, second);
  else if (command === "replace") await replaceOwnerBundle(first, second);
  else {
    const candidate = await verifyOwnerBundle(first);
    if (second) {
      const previous = await verifyOwnerBundle(second);
      if (candidate.signing.teamIdentifier !== previous.signing.teamIdentifier || candidate.signing.designatedRequirement !== previous.signing.designatedRequirement) throw new Error("launcher stable identity changed during upgrade");
    }
  }
});
