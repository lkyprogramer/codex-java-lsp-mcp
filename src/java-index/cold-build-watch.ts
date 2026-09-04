// input: child stdout lines, stall clock, on-disk snapshot completeness.
// output: whether to kill, and whether a finished snapshot counts as success.
// pos: FSR1 progress-based cold-build watch. No absolute wall timeout.
export const COLD_BUILD_STALL_MS = 120_000;
export const COLD_BUILD_CHILD_RETRIES = 3;
export const IN_PROCESS_PARSE_FILE_LIMIT = 500;
export const IN_PROCESS_PARSE_RECYCLE_FILES = 200;

export type ColdBuildProgressLine = {
  type: "progress";
  phase: string;
  files: number;
  t?: number;
};

export function parseColdBuildStdoutLine(
  line: string
): { kind: "progress"; phase: string; files: number } | { kind: "result" } | { kind: "ignore" } {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; ok?: unknown; phase?: string; files?: number };
    if (parsed.type === "progress") {
      return { kind: "progress", phase: String(parsed.phase ?? ""), files: Number(parsed.files ?? 0) };
    }
    if (parsed.ok === true || parsed.ok === false) return { kind: "result" };
  } catch {
    return { kind: "ignore" };
  }
  return { kind: "ignore" };
}

export function coldBuildStallExceeded(lastProgressAt: number, now: number, stallMs = COLD_BUILD_STALL_MS): boolean {
  return now - lastProgressAt >= stallMs;
}

export function coldBuildRetryDelayMs(attemptIndex: number): number {
  return 1000 * 2 ** Math.max(0, attemptIndex);
}

/** Kill only on stall. If the snapshot is already complete, treat as success instead of failure. */
export function resolveStalledColdBuild(snapshotComplete: boolean): "success" | "failure" {
  return snapshotComplete ? "success" : "failure";
}

export function resolveClosedColdBuild(exitCode: number | null, snapshotComplete: boolean): "success" | "failure" {
  if (exitCode === 0) return "success";
  return snapshotComplete ? "success" : "failure";
}

export function inProcessParseDecision(
  unindexedCount: number,
  cap = IN_PROCESS_PARSE_FILE_LIMIT,
  recycleAt = IN_PROCESS_PARSE_RECYCLE_FILES
): "skip" | "recycle" | "ok" {
  if (unindexedCount > cap) return "skip";
  if (unindexedCount >= recycleAt) return "recycle";
  return "ok";
}
