import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PUBLICATION_HISTORY_FILE = "snapshot-publications.jsonl";
export const PUBLICATION_HISTORY_LIMIT = 128;

export type FullBuildReason = "no-base" | "input-limit" | "build-key-changed" | "delta-deadline"
  | "verification-failed" | "closure-limit" | "resolution-did-not-settle"
  | "incompatible-base" | "builder-inputs-changed" | "lineage-limit" | "other-escalation";

export function builderFullReason(reason: string): FullBuildReason {
  if (/^delta escalated to full: dependency closure /.test(reason)) return "closure-limit";
  if (/^delta escalated to full: resolution did not settle /.test(reason)) return "resolution-did-not-settle";
  if (/^delta escalated to full: \d+ changed\/deleted inputs /.test(reason)) return "input-limit";
  if (reason === "no compatible published base") return "incompatible-base";
  if (reason === "build/resolver inputs changed") return "builder-inputs-changed";
  return "other-escalation";
}

export type PublicationDetails = {
  indexedGeneration: number;
  plannedMode: "full" | "delta" | "rescan" | "seed-bind";
  actualBuildMode: "full" | "delta" | "none";
  comparisonBaseSnapshotId?: string;
  fullReason?: FullBuildReason;
};

export type SnapshotPublication = PublicationDetails & {
  at: number;
  workspaceId: string;
  bindingVersion: number;
  snapshotId: string;
  cloneBaseSnapshotId?: string;
  bindingResult: "bound" | "bound-after-error";
};

/** Called under the owner's binding queue. This history is diagnostic, not binding state. */
export async function recordSnapshotPublication(directory: string, record: SnapshotPublication): Promise<void> {
  const file = path.join(directory, PUBLICATION_HISTORY_FILE);
  const tmp = `${file}.tmp`;
  try {
    const prior = await readFile(file, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const rows = prior.trimEnd().split("\n").filter(Boolean).slice(1 - PUBLICATION_HISTORY_LIMIT);
    rows.push(JSON.stringify(record));
    await rm(tmp, { force: true });
    await writeFile(tmp, `${rows.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch {
    // A history write cannot turn a committed binding into a failed publish.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
