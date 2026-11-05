// input: one workspace's verified snapshot and watermark.
// output: mac1/workspaces/<workspaceId>/binding.json, the single correctness commit point (contract §2.7).
// pos: MAC-07. All correctness fields are written in one atomic rename; statistics live elsewhere.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assertId, writeFileAtomic, type FaultHook, type Mac1Layout } from "./seal.js";

export const BINDING_FORMAT = "ilv2-binding/mac1";
export const BINDING_FILE = "binding.json";

/** Identity of the root directory itself: replacing the root at the same path changes it. */
export type RootIdentity = { canonicalRoot: string; dev: number; ino: number; volume: string };

export type WorkspaceBinding = {
  formatVersion: typeof BINDING_FORMAT;
  workspaceId: string;
  root: RootIdentity;
  workspaceGeneration: number;
  bindingVersion: number;
  snapshotId: string;
  contentManifestId: string;
  buildKey: string;
  trackerEpoch: string;
  coveredThroughSeq: number;
};

const KEYS = ["bindingVersion", "buildKey", "contentManifestId", "coveredThroughSeq", "formatVersion", "root", "snapshotId", "trackerEpoch", "workspaceGeneration", "workspaceId"];
const HEX64 = /^[0-9a-f]{64}$/;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

export function sameRoot(a: RootIdentity, b: RootIdentity): boolean {
  return a.canonicalRoot === b.canonicalRoot && a.dev === b.dev && a.ino === b.ino && a.volume === b.volume;
}

/** Strict reader: no other format, no missing or extra field. */
export function parseBinding(value: unknown, workspaceId: string): WorkspaceBinding {
  const fail = (why: string): never => { throw new Error(`invalid binding for ${workspaceId}: ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not an object");
  const b = value as Record<string, unknown>;
  if (b.formatVersion !== BINDING_FORMAT) fail(`formatVersion ${String(b.formatVersion)}`);
  if (JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(KEYS)) fail("unexpected fields");
  if (b.workspaceId !== workspaceId) fail(`workspaceId ${String(b.workspaceId)}`);
  const root = b.root as Record<string, unknown> | undefined;
  if (!root || typeof root.canonicalRoot !== "string" || !root.canonicalRoot.startsWith("/") || !count(root.dev) || !count(root.ino)
    || typeof root.volume !== "string" || JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(["canonicalRoot", "dev", "ino", "volume"])) fail("root");
  for (const key of ["workspaceGeneration", "coveredThroughSeq"]) if (!count(b[key])) fail(key);
  if (!Number.isSafeInteger(b.bindingVersion) || (b.bindingVersion as number) < 1) fail("bindingVersion");
  if (typeof b.snapshotId !== "string") fail("snapshotId");
  assertId("snapshotId", b.snapshotId as string);
  for (const key of ["contentManifestId", "buildKey"]) if (typeof b[key] !== "string" || !HEX64.test(b[key] as string)) fail(key);
  if (typeof b.trackerEpoch !== "string" || !b.trackerEpoch) fail("trackerEpoch");
  return value as WorkspaceBinding;
}

export function workspaceDir(layout: Mac1Layout, workspaceId: string): string {
  assertId("workspaceId", workspaceId);
  return path.join(layout.workspaces, workspaceId);
}

export async function readBinding(layout: Mac1Layout, workspaceId: string): Promise<WorkspaceBinding | undefined> {
  let text: string;
  try { text = await readFile(path.join(workspaceDir(layout, workspaceId), BINDING_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseBinding(JSON.parse(text), workspaceId);
}

/** tmp write + sync, atomic rename, then sync the workspace directory. */
export async function writeBinding(layout: Mac1Layout, binding: WorkspaceBinding, faultAt?: FaultHook): Promise<void> {
  parseBinding(JSON.parse(JSON.stringify(binding)), binding.workspaceId);
  const file = path.join(workspaceDir(layout, binding.workspaceId), BINDING_FILE);
  await writeFileAtomic(file, `${JSON.stringify(binding, null, 2)}\n`, 0o644, faultAt ? {
    afterTmp: () => faultAt("binding-tmp-written"), afterRename: () => faultAt("binding-renamed") } : undefined);
  await faultAt?.("workspace-synced");
}

/** Recovery: a tmp binding is never a commit; remove it. */
export async function removeStaleBindingTmp(layout: Mac1Layout, workspaceId: string): Promise<string[]> {
  const directory = workspaceDir(layout, workspaceId);
  const removed: string[] = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(`${BINDING_FILE}.tmp-`)) continue;
    await rm(path.join(directory, name), { force: true });
    removed.push(name);
  }
  return removed;
}
