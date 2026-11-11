import { execFileSync, type StdioOptions } from "node:child_process";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";

const nativeBinary = fileURLToPath(new URL("../native/ilv2-mac", import.meta.url));

export function ownerCacheRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.ILV2_OWNER_CACHE_ROOT;
  if (root === undefined) return undefined;
  if (!root.startsWith("/") || realpathSync(root) !== root) throw new Error("canonical owner cache root required");
  return root;
}

/** The lock file fd4 referred to at the last native verification (validate_owner_lock in native/macos/owner-lock.h). */
let nativelyVerified: { root: string; dev: bigint; ino: bigint } | undefined;

/**
 * Check the existing OFD, not a newly acquired substitute: a native probe that the lock is held by
 * fd4's open file description. Synchronous (it blocks the event loop for one exec), so it guards
 * commit points only: every binding write, deletion and verdict (SnapshotStore assertOwner).
 */
export function assertOwnerLock(env: NodeJS.ProcessEnv = process.env): void {
  const root = ownerCacheRoot(env);
  // No owner launcher (tests, dev, the legacy LaunchAgent until MAC-17): no lock to check, and no GC cycle runs.
  if (!root) return;
  // A failed (or throwing) native check is the strongest evidence the lock is gone: no fast path survives it.
  nativelyVerified = undefined;
  const held = fstatSync(4, { bigint: true });
  if (!held.isFile()) throw new Error("owner fd4 missing");
  const response = JSON.parse(execFileSync(nativeBinary, ["verify-owner-lock", root], {
    encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe", "ignore", 4]
  }));
  if (response.protocol !== MAC_NATIVE_PROTOCOL || response.kind !== "owner-lock") throw new Error("owner lock validation failed");
  nativelyVerified = { root, dev: held.dev, ino: held.ino };
}

/**
 * For points that commit nothing (handing fd4 to a child): fd4 still refers to the lock file a native
 * verification proved locked, and that file is still the one at the lock path. A flock on an open
 * file description is held until every descriptor of it closes, so while fd4 is that same inode, still
 * linked once under the lock path, the lock is the verified one, given this invariant: no holder of
 * that open file description (the owner or any child it handed fd4 to) ever calls flock(LOCK_UN), and
 * nothing in the owner closes fd 4 and reopens the lock file onto it. Neither is visible to stat. Any
 * mismatch falls back to the native verification. Commit points keep calling assertOwnerLock.
 */
export function assertOwnerLockHeld(env: NodeJS.ProcessEnv = process.env): void {
  const root = ownerCacheRoot(env);
  if (!root) return;
  const verified = nativelyVerified;
  if (verified && verified.root === root) {
    const held = fstatSync(4, { bigint: true });
    if (held.isFile() && held.nlink === 1n && held.dev === verified.dev && held.ino === verified.ino) {
      let named;
      try { named = lstatSync(path.join(root, ".owner.lock"), { bigint: true }); } catch { named = undefined; }
      if (named?.isFile() && named.dev === held.dev && named.ino === held.ino) return;
    }
  }
  assertOwnerLock(env);
}

/** Preserve IPC3; duplicate fd4 into the child without reopening the inode. */
export function ownerChildStdio(stdio: StdioOptions, env: NodeJS.ProcessEnv = process.env): StdioOptions {
  const current = ownerCacheRoot();
  const childRoot = ownerCacheRoot(env);
  if (current && childRoot !== current) throw new Error("child must preserve the owner binding");
  if (!childRoot) return stdio;
  assertOwnerLockHeld(env);
  if (!Array.isArray(stdio) || stdio.length > 4) throw new Error("owner child requires explicit stdio mapping");
  return [...stdio, ...Array(4 - stdio.length).fill("ignore"), 4];
}

export async function ownerLaunchArguments(cacheRoot: string, entry: string, args: string[] = []): Promise<{ binary: string; args: string[] }> {
  const { readMacNativeIdentity } = await import("./clonefile.js");
  await readMacNativeIdentity();
  if (realpathSync(cacheRoot) !== cacheRoot || !entry.startsWith("/")) throw new Error("absolute owner paths required");
  return { binary: nativeBinary, args: ["owner", cacheRoot, entry, ...args] };
}
