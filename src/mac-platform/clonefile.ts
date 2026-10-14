import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const MAC_NATIVE_PROTOCOL = "ilv2-mac-native/v1";
const execute = promisify(execFile);
const nativeDirectory = fileURLToPath(new URL("../native/", import.meta.url));
export type MacNativeIdentity = {
  schema: "ilv2-mac-native-build/v1";
  protocol: string;
  arch: string;
  deploymentTarget: string;
  sourceDigest: string;
  binary: string;
  binarySha256: string;
  runtime: { execPath: string; nodeSha256: string; versions: Record<string, string>; runtimeManifestSha256: string };
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function readMacNativeIdentity(directory = nativeDirectory): Promise<MacNativeIdentity> {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as MacNativeIdentity;
  if (manifest.schema !== "ilv2-mac-native-build/v1" || manifest.protocol !== MAC_NATIVE_PROTOCOL || manifest.arch !== process.arch || manifest.binary !== "ilv2-mac") throw new Error("native identity mismatch");
  if (manifest.runtime.execPath !== process.execPath || manifest.runtime.nodeSha256 !== sha256(await readFile(process.execPath)) ||
      JSON.stringify(Object.entries(manifest.runtime.versions).sort()) !== JSON.stringify(Object.entries(process.versions).sort())) throw new Error("native runtime mismatch");
  if (sha256(await readFile(path.join(directory, manifest.binary))) !== manifest.binarySha256) throw new Error("native binary digest mismatch");
  const capability = JSON.parse((await execute(path.join(directory, manifest.binary), ["capability", directory], { timeout: 5000, maxBuffer: 64 * 1024 })).stdout);
  if (capability.protocol !== MAC_NATIVE_PROTOCOL || capability.arch !== process.arch) throw new Error("native architecture/protocol mismatch");
  return manifest;
}

export async function callMacNative(args: string[], directory = nativeDirectory): Promise<Record<string, unknown>> {
  const identity = await readMacNativeIdentity(directory);
  let stdout: string;
  try { stdout = (await execute(path.join(directory, identity.binary), args, { maxBuffer: 64 * 1024, timeout: 5000 })).stdout; }
  catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (output) {
      try { const failure = JSON.parse(output); if (failure.protocol === MAC_NATIVE_PROTOCOL && failure.kind === "error") throw new Error(`native ${failure.code} (errno ${failure.errno})`); }
      catch (parsedError) { if (parsedError instanceof Error && parsedError.message.startsWith("native ")) throw parsedError; }
    }
    throw new Error("native execution failed", { cause: error });
  }
  let result: Record<string, unknown>;
  try { result = JSON.parse(stdout); } catch { throw new Error("invalid native protocol response"); }
  if (result.protocol !== MAC_NATIVE_PROTOCOL) throw new Error("native protocol mismatch");
  return result;
}

export async function cloneSealedDatabase(source: string, target: string, cacheRoot: string): Promise<void> {
  const root = await realpath(cacheRoot);
  const actualSource = await realpath(source);
  const targetParent = await realpath(path.dirname(target));
  const inside = (file: string) => { const relative = path.relative(root, file); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (!path.isAbsolute(source) || !path.isAbsolute(target) || !inside(actualSource) || !(targetParent === root || inside(targetParent)) || (await lstat(source)).isSymbolicLink()) throw new Error("clone paths must belong to the cache root");
  const result = await callMacNative(["clone", actualSource, path.join(targetParent, path.basename(target))]);
  if (result.kind !== "cloned") throw new Error("native clone acknowledgement missing");
}
