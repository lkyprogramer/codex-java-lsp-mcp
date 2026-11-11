import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";
import { executeMacNativeProcess } from "./native-exec.js";

export { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";
const execute = executeMacNativeProcess;
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

/**
 * A verified identity per native directory, keyed by the stat of every file the check read. The full
 * check reads the Node executable (~100 MB) and the helper and starts a capability process; every
 * delta's clone used to pay it. A replaced or rewritten file changes ino/size/mtime/ctime (ctime is
 * not settable by a writer), so a hit proves the bytes the full check hashed are still the ones there.
 */
const verifiedIdentities = new Map<string, { key: string; identity: MacNativeIdentity }>();

async function identityStatKey(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Partial<MacNativeIdentity>;
    if (typeof manifest.binary !== "string") return undefined;
    const files = [path.join(directory, "manifest.json"), path.join(directory, manifest.binary), process.execPath];
    const stats = await Promise.all(files.map(file => stat(file, { bigint: true })));
    return stats.map((info, index) => `${files[index]}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).join("|");
  } catch { return undefined; }
}

export async function readMacNativeIdentity(directory = nativeDirectory): Promise<MacNativeIdentity> {
  const key = await identityStatKey(directory);
  const cached = verifiedIdentities.get(directory);
  if (key !== undefined && cached?.key === key) return cached.identity;
  const identity = await verifyMacNativeIdentity(directory);
  // Cached only when the files did not move during the check: a write racing it is checked again next time.
  if (key !== undefined && await identityStatKey(directory) === key) verifiedIdentities.set(directory, { key, identity });
  else verifiedIdentities.delete(directory);
  return identity;
}

async function verifyMacNativeIdentity(directory: string): Promise<MacNativeIdentity> {
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

const WARM_CHUNK = 8 << 20, WARM_LANES = 4;
/**
 * Reads a file once, in order, so its pages are cached before random access. A clone shares the
 * base's blocks but not its page cache: a delta builder on a cold 572 MB clone spent 1.0-1.7 s of a
 * 2.2-5.1 s job waiting on page reads that one ordered pass (about 90 ms) makes warm.
 */
export async function warmFile(file: string): Promise<number> {
  const started = performance.now();
  // A full build creates its database: nothing to warm.
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!handle) return 0;
  try {
    const size = (await handle.stat()).size;
    let next = 0;
    await Promise.all(Array.from({ length: WARM_LANES }, async () => {
      const buffer = Buffer.allocUnsafe(WARM_CHUNK);
      while (next < size) { const at = next; next += WARM_CHUNK; await handle.read(buffer, 0, WARM_CHUNK, at); }
    }));
  } finally { await handle.close(); }
  return performance.now() - started;
}
