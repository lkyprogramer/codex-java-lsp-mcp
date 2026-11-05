// Measurement contracts. Product instrumentation is added by its owning task.
export type MacWorkloadWindow = "normal" | "fault";
export type MacJobKind = "full" | "delta" | "noop";
export interface MacLeaseCounts {
  owner: number;
  query: number;
  reader: number;
  base: number;
  publication: number;
}
export interface MacCallSample {
  sampleId: string;
  slotId: string;
  workspaceId: string;
  snapshotId?: string;
  sourceHash?: string;
  window: MacWorkloadWindow;
  kind: "attempt" | "slot";
  operation: "status" | "prewarm" | "query" | "cancel";
  startedAt: string;
  startMonoNs: string;
  endMonoNs: string;
  elapsedMs: number;
  deadlineMs: number;
  firstCorrectMs: number | null;
  publishMs: number | null;
  payloadBytes: number;
}
export interface MacJobSample {
  jobId: string;
  ownerIncarnation: string;
  workspaceId: string;
  kind: MacJobKind;
  reason: string;
  queuedMonoNs: string;
  runMonoNs: string | null;
  sealedMonoNs: string | null;
  publishedMonoNs: string | null;
  reapedMonoNs: string | null;
  changedFiles: number;
  affectedFiles: number;
  parsedFiles: number;
  writtenBytes: number;
  physicalBytes: number | null;
  cpuUserUs: number;
  cpuSystemUs: number;
  lastHeartbeatMonoNs: string | null;
  workCounter: number;
  resultReceived: boolean;
  exitCode: number | null;
  leases: MacLeaseCounts;
}
