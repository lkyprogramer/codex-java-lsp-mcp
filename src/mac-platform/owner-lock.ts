import { execFileSync, type StdioOptions } from "node:child_process";
import { fstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";

const nativeBinary = fileURLToPath(new URL("../native/ilv2-mac", import.meta.url));

export function ownerCacheRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.ILV2_OWNER_CACHE_ROOT;
  if (root === undefined) return undefined;
  if (!root.startsWith("/") || realpathSync(root) !== root) throw new Error("canonical owner cache root required");
  return root;
}

/** Check the existing OFD, not a newly acquired substitute. */
export function assertOwnerLock(env: NodeJS.ProcessEnv = process.env): void {
  const root = ownerCacheRoot(env);
  // No owner launcher (tests, dev, the legacy LaunchAgent until MAC-17): no lock to check, and no GC cycle runs.
  if (!root) return;
  if (!fstatSync(4).isFile()) throw new Error("owner fd4 missing");
  const response = JSON.parse(execFileSync(nativeBinary, ["verify-owner-lock", root], {
    encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe", "ignore", 4]
  }));
  if (response.protocol !== MAC_NATIVE_PROTOCOL || response.kind !== "owner-lock") throw new Error("owner lock validation failed");
}

/** Preserve IPC3; duplicate fd4 into the child without reopening the inode. */
export function ownerChildStdio(stdio: StdioOptions, env: NodeJS.ProcessEnv = process.env): StdioOptions {
  const current = ownerCacheRoot();
  const childRoot = ownerCacheRoot(env);
  if (current && childRoot !== current) throw new Error("child must preserve the owner binding");
  if (!childRoot) return stdio;
  assertOwnerLock(env);
  if (!Array.isArray(stdio) || stdio.length > 4) throw new Error("owner child requires explicit stdio mapping");
  return [...stdio, ...Array(4 - stdio.length).fill("ignore"), 4];
}

export async function ownerLaunchArguments(cacheRoot: string, entry: string, args: string[] = []): Promise<{ binary: string; args: string[] }> {
  const { readMacNativeIdentity } = await import("./clonefile.js");
  await readMacNativeIdentity();
  if (realpathSync(cacheRoot) !== cacheRoot || !entry.startsWith("/")) throw new Error("absolute owner paths required");
  return { binary: nativeBinary, args: ["owner", cacheRoot, entry, ...args] };
}
