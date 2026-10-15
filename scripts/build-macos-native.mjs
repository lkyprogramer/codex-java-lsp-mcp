#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, isMain, runCli, sha256, verifyRuntime } from "./ilv2-mac-contracts.mjs";

export const NATIVE_PROTOCOL = "ilv2-mac-native/v1";
export const DEPLOYMENT_TARGET = "14.0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Native build inputs; their digest is the manifest's sourceDigest. */
export async function nativeSourceFiles(repoRoot = root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(c|h)$/.test(entry.name)) files.push({ path: path.relative(repoRoot, file), sha256: sha256(await readFile(file)) });
      else throw new Error("unsupported native source entry");
    }
  }
  await visit(path.join(repoRoot, "native/macos"));
  files.push({ path: "scripts/build-macos-native.mjs", sha256: sha256(await readFile(path.join(repoRoot, "scripts/build-macos-native.mjs"))) });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export const SIGNING_IDENTIFIER = "com.lky.codex-java-lsp-mcp.ilv2-mac";

/**
 * Sign the launcher. TCC binds a Documents grant to the responsible code's
 * designated requirement: ad-hoc (cdhash) changes on every rebuild, while a
 * certificate-based one survives rebuilds. Unset identity keeps ad-hoc.
 */
export async function signLauncher(binary, { identity = process.env.ILV2_CODESIGN_IDENTITY, keychain = process.env.ILV2_CODESIGN_KEYCHAIN } = {}) {
  const codesign = "/usr/bin/codesign";
  if (identity) {
    await execute(codesign, ["--force", "--sign", identity, "--identifier", SIGNING_IDENTIFIER, "--timestamp=none",
      ...(keychain ? ["--keychain", keychain] : []), binary]);
    await execute(codesign, ["--verify", "--strict", binary]);
  }
  const details = (await execute(codesign, ["-dv", binary])).stderr;
  const field = name => new RegExp(`^${name}=(.*)$`, "m").exec(details)?.[1] ?? null;
  const requirement = (await execute(codesign, ["-d", "-r-", binary])).stdout.match(/designated => (.*)/)?.[1] ?? null;
  const signing = { mode: identity ? "identity" : "adhoc", identifier: field("Identifier"), teamIdentifier: field("TeamIdentifier"), designatedRequirement: requirement };
  if (identity && (signing.identifier !== SIGNING_IDENTIFIER || !signing.teamIdentifier || signing.teamIdentifier === "not set" || /^cdhash /.test(requirement ?? "")))
    throw new Error(`launcher signature is not a stable identity: ${JSON.stringify(signing)}`);
  return signing;
}

export async function buildMacNative(repoRoot = root) {
  const runtime = await verifyRuntime();
  const runtimeManifest = JSON.parse(await readFile(process.env.ILV2_RUNTIME_MANIFEST, "utf8"));
  const compiler = "/usr/bin/clang";
  const toolchain = (await execute(compiler, ["--version"])).stdout;
  if (runtimeManifest.clang !== toolchain) throw new Error("native toolchain drift");
  const sdk = (await execute("/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim();
  const files = await nativeSourceFiles(repoRoot);
  const output = path.join(repoRoot, "dist/native");
  // No old helper or identity may survive an unsuccessful build.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const binary = path.join(output, "ilv2-mac");
  const args = ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", runtime.arch === "arm64" ? "arm64" : "x86_64", "-isysroot", sdk,
    `-mmacosx-version-min=${DEPLOYMENT_TARGET}`, `-DILV2_NATIVE_PROTOCOL=\"${NATIVE_PROTOCOL}\"`,
    `-DILV2_NODE_BIN=${JSON.stringify(runtime.execPath)}`,
    path.join(repoRoot, "native/macos/ilv2-mac.c"), "-fblocks", "-pthread", "-framework", "CoreServices", "-framework", "CoreFoundation", "-o", binary];
  try {
    await execute(compiler, args);
    const signing = await signLauncher(binary);
    const capability = JSON.parse((await execute(binary, ["capability", output])).stdout);
    if (capability.protocol !== NATIVE_PROTOCOL || capability.arch !== runtime.arch) throw new Error("native architecture/protocol mismatch");
    const manifest = { schema: "ilv2-mac-native-build/v1", protocol: NATIVE_PROTOCOL, arch: runtime.arch, deploymentTarget: DEPLOYMENT_TARGET,
      sourceFiles: files, sourceDigest: sha256(JSON.stringify(files)), binary: "ilv2-mac", binarySha256: sha256(await readFile(binary)),
      compiler, compilerSha256: sha256(await readFile(compiler)), toolchain, sdk, compilerArgs: args, signing, runtime };
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (isMain(import.meta.url)) runCli(async () => {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--build")) throw new Error("expected optional --build");
  await verifyRuntime();
  if (process.argv[2] === "--build") {
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    await execute(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.json")], { cwd: root });
  }
  const manifest = await buildMacNative();
  if (process.argv[2] === "--build") await execute(process.execPath, [path.join(root, "scripts/write-build-stamp.mjs")], { cwd: root });
  console.log(JSON.stringify({ nativeBuild: "PASS", sourceDigest: manifest.sourceDigest, binarySha256: manifest.binarySha256, signing: manifest.signing.mode, runtimeManifestSha256: manifest.runtime.runtimeManifestSha256 }));
});
