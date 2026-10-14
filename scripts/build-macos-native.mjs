#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, isMain, runCli, sha256, verifyRuntime } from "./ilv2-mac-contracts.mjs";

export const NATIVE_PROTOCOL = "ilv2-mac-native/v1";
export const DEPLOYMENT_TARGET = "14.0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildMacNative(repoRoot = root) {
  const runtime = await verifyRuntime();
  const runtimeManifest = JSON.parse(await readFile(process.env.ILV2_RUNTIME_MANIFEST, "utf8"));
  const compiler = "/usr/bin/clang";
  const toolchain = (await execute(compiler, ["--version"])).stdout;
  if (runtimeManifest.clang !== toolchain) throw new Error("native toolchain drift");
  const sdk = (await execute("/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim();
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
  files.sort((a, b) => a.path.localeCompare(b.path));
  const output = path.join(repoRoot, "dist/native");
  // No old helper or identity may survive an unsuccessful build.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const binary = path.join(output, "ilv2-mac");
  const args = ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", runtime.arch === "arm64" ? "arm64" : "x86_64", "-isysroot", sdk,
    `-mmacosx-version-min=${DEPLOYMENT_TARGET}`, `-DILV2_NATIVE_PROTOCOL=\"${NATIVE_PROTOCOL}\"`, path.join(repoRoot, "native/macos/ilv2-mac.c"), "-o", binary];
  try {
    await execute(compiler, args);
    const capability = JSON.parse((await execute(binary, ["capability", output])).stdout);
    if (capability.protocol !== NATIVE_PROTOCOL || capability.arch !== runtime.arch) throw new Error("native architecture/protocol mismatch");
    const manifest = { schema: "ilv2-mac-native-build/v1", protocol: NATIVE_PROTOCOL, arch: runtime.arch, deploymentTarget: DEPLOYMENT_TARGET,
      sourceFiles: files, sourceDigest: sha256(JSON.stringify(files)), binary: "ilv2-mac", binarySha256: sha256(await readFile(binary)),
      compiler, compilerSha256: sha256(await readFile(compiler)), toolchain, sdk, compilerArgs: args.map(value => value.replaceAll(repoRoot, "{candidate}")), runtime };
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
  console.log(JSON.stringify({ nativeBuild: "PASS", sourceDigest: manifest.sourceDigest, binarySha256: manifest.binarySha256, runtimeManifestSha256: manifest.runtime.runtimeManifestSha256 }));
});
