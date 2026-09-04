// input: soak counters and heap vs hydrate baseline.
// output: FSR4 failures/warnings. Compact log lines are not soak events.
export const FSR4_CLIMB_FACTOR = 1.4;
export const FSR4_CLIMB_HOURS = 6;
export const FSR4_STEP_PCT = 0.3;
export const FSR4_RECYCLE_PER_24H = 2;

export type Fsr4SoakInput = {
  fatal: number;
  ebadf: number;
  inProcessParseEvents: number;
  coldBuildChildEvents: number;
  recycleBudgeted: number;
  watchHours: number;
  heapMb: number;
  hydrateBaselineHeapMb: number;
  hoursAboveClimb: number;
  stepPct?: number;
  stepRecoveredWithin24h?: boolean;
};

export type Fsr4HeapSample = {
  sampledAt: string;
  heapMb: number;
  hydrateBaselineHeapMb?: number;
};

/** Trailing hours heap stayed > 1.4× the worker hydrate baseline. Missing baseline does not fall back to first-sample heap. */
export function fsr4HoursAboveClimb(series: readonly Fsr4HeapSample[]): number {
  const pts = series.filter(
    (point): point is Fsr4HeapSample & { hydrateBaselineHeapMb: number } =>
      typeof point.hydrateBaselineHeapMb === "number" && point.hydrateBaselineHeapMb > 0
  );
  if (pts.length === 0) return 0;
  const last = pts[pts.length - 1]!;
  if (last.heapMb <= last.hydrateBaselineHeapMb * FSR4_CLIMB_FACTOR) return 0;
  let startAt = last.sampledAt;
  for (let index = pts.length - 2; index >= 0; index -= 1) {
    const point = pts[index]!;
    if (point.heapMb > point.hydrateBaselineHeapMb * FSR4_CLIMB_FACTOR) {
      startAt = point.sampledAt;
      continue;
    }
    break;
  }
  return (Date.parse(last.sampledAt) - Date.parse(startAt)) / 3600000;
}

/** Latest >+30% consecutive jump; recovered means current heap ≤ pre-jump × 1.1. */
export function fsr4StepStatus(series: readonly Fsr4HeapSample[]): {
  stepPct?: number;
  stepRecoveredWithin24h?: boolean;
} {
  if (series.length < 2) return {};
  let jumpIndex = -1;
  let stepPct = 0;
  for (let index = 1; index < series.length; index += 1) {
    const prev = series[index - 1]!.heapMb;
    const current = series[index]!.heapMb;
    if (prev > 0 && (current - prev) / prev > FSR4_STEP_PCT) {
      jumpIndex = index;
      stepPct = (current - prev) / prev;
    }
  }
  if (jumpIndex < 0) return {};
  const pre = series[jumpIndex - 1]!.heapMb;
  const jumpAt = series[jumpIndex]!.sampledAt;
  const now = series[series.length - 1]!;
  const recovered = now.heapMb <= pre * 1.1;
  const ageHours = (Date.parse(now.sampledAt) - Date.parse(jumpAt)) / 3600000;
  if (recovered) return { stepPct, stepRecoveredWithin24h: true };
  if (ageHours >= 24) return { stepPct, stepRecoveredWithin24h: false };
  return { stepPct, stepRecoveredWithin24h: undefined };
}

export function fsr4SoakVerdict(input: Fsr4SoakInput): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (input.fatal > 0) failures.push(`FATAL ${input.fatal}`);
  if (input.ebadf > 0) failures.push(`EBADF ${input.ebadf}`);
  if (input.inProcessParseEvents > 0) {
    failures.push(`in-process parse events ${input.inProcessParseEvents} (must be 0)`);
  }
  if (input.watchHours >= 24 && input.recycleBudgeted > FSR4_RECYCLE_PER_24H) {
    failures.push(`recycle ${input.recycleBudgeted} exceeds ${FSR4_RECYCLE_PER_24H}/24h`);
  }
  const climbLine = input.hydrateBaselineHeapMb * FSR4_CLIMB_FACTOR;
  if (input.hydrateBaselineHeapMb > 0 && input.heapMb > climbLine && input.hoursAboveClimb >= FSR4_CLIMB_HOURS) {
    failures.push(`heap ${input.heapMb} > ${FSR4_CLIMB_FACTOR}× hydrate ${input.hydrateBaselineHeapMb} for ${input.hoursAboveClimb.toFixed(1)}h`);
  }
  if (input.stepPct !== undefined && input.stepPct > FSR4_STEP_PCT) {
    if (input.stepRecoveredWithin24h === false) {
      failures.push(`step ${(input.stepPct * 100).toFixed(0)}% did not recover within 24h`);
    } else if (input.stepRecoveredWithin24h !== true) {
      warnings.push(`step ${(input.stepPct * 100).toFixed(0)}% marked; must recover within 24h`);
    }
  }
  if (input.coldBuildChildEvents > 0) {
    warnings.push(`cold-build child events ${input.coldBuildChildEvents}`);
  }
  return { failures, warnings };
}

export function fsr4CountLogLine(line: string): "recycle" | "cold-build" | "in-process-parse" | "compact" | "other" {
  if (line.includes("worker heap recycle")) return "recycle";
  if (line.includes("cold-build child") || line.includes("in-process parse skipped")) return "cold-build";
  if (line.includes("in-process parse files=")) return "in-process-parse";
  if (line.includes("columnar compact")) return "compact";
  return "other";
}
