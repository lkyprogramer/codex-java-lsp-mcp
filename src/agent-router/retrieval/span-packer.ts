// input: Selected ReadUnit ranges plus a mode packing profile.
// output: Packed multi-span plan. Overlap merges; distant primaries stay separate.
// pos: V5R Phase 6. Default off keeps first-plan identity. No golden +1 expansion.
import type { ImpactMode, ReadRange } from "../../agent-types.js";
import type { ReadUnit, RetrievalBudget, RetrievalStopReason } from "./retrieval-types.js";
import { reconstructEstimatedTokens } from "./cost-model.js";

export const JAVA_LSP_SPAN_PACKING = "JAVA_LSP_SPAN_PACKING";
export type SpanPackingMode = "off" | "shadow" | "on";

export type SpanKind = "primary" | "context" | "fallback";

export type SpanPackingProfile = {
  adjacentGapLines: number;
  maxSpansPerFile: number;
  extremeMethodMaxBytes: number;
};

export type PackedSpan = ReadRange & { kind: SpanKind };

export type FilePackingReport = {
  path: string;
  beforeSpans: number;
  afterSpans: number;
  beforeSourceBytes: number;
  afterSourceBytes: number;
  wireBytesProxy: number;
  stopReason: RetrievalStopReason | "PACKED" | "SPAN_CAP" | "EXTREME_METHOD_BOUNDED";
  keptPrimary: boolean;
};

export type SpanPackingReport = {
  mode: SpanPackingMode;
  profile: SpanPackingProfile;
  files: FilePackingReport[];
  sourceBytesBefore: number;
  sourceBytesAfter: number;
  wireBytesProxy: number;
  estimatedTokensAfter: number;
  stopReason: RetrievalStopReason | "PACKED" | "SPAN_CAP" | "EXTREME_METHOD_BOUNDED";
};

export function spanPackingMode(env: NodeJS.ProcessEnv = process.env): SpanPackingMode {
  const raw = env[JAVA_LSP_SPAN_PACKING];
  if (raw === "1" || raw === "on") return "on";
  if (raw === "shadow") return "shadow";
  return "off";
}

export function spanPackingProfile(mode: ImpactMode): SpanPackingProfile {
  if (mode === "minimal") {
    return { adjacentGapLines: 0, maxSpansPerFile: 4, extremeMethodMaxBytes: 4 * 1024 };
  }
  if (mode === "recall") {
    return { adjacentGapLines: 0, maxSpansPerFile: 8, extremeMethodMaxBytes: 16 * 1024 };
  }
  return { adjacentGapLines: 0, maxSpansPerFile: 8, extremeMethodMaxBytes: 8 * 1024 };
}

export function spanKind(reason: string | undefined): SpanKind {
  if (reason?.includes("method range") || reason?.includes("XML statement")) return "primary";
  if (reason?.includes("type header") || reason?.includes("XML resultMap")) return "context";
  return "fallback";
}

export function packReadUnit(
  unit: ReadUnit,
  profile: SpanPackingProfile,
  budget: Pick<RetrievalBudget, "maxReadBytes">
): { unit: ReadUnit; report: FilePackingReport } {
  const beforeSourceBytes = unit.mergedRanges.reduce((sum, range) => sum + range.estimatedBytes, 0);
  let stop: FilePackingReport["stopReason"] = "PACKED";
  const tagged: PackedSpan[] = unit.mergedRanges.map(range => ({ ...range, kind: spanKind(range.reason) }));
  const bounded = tagged.map(range => {
    if (!unit.extremeMethod || range.kind === "context") return range;
    const clipped = boundExtremeMethod(range, profile.extremeMethodMaxBytes);
    if (clipped.endLine !== range.endLine || clipped.estimatedBytes !== range.estimatedBytes) {
      stop = "EXTREME_METHOD_BOUNDED";
    }
    return clipped;
  });
  const merged = mergePackableSpans(bounded, profile.adjacentGapLines);
  const capped = capSpans(merged, profile.maxSpansPerFile);
  if (capped.length < merged.length && stop === "PACKED") stop = "SPAN_CAP";
  const budgeted = fitSourceBudget(capped, budget.maxReadBytes);
  if (budgeted.length < capped.length && stop === "PACKED") stop = "READ_BUDGET_EXHAUSTED";
  const afterSourceBytes = budgeted.reduce((sum, range) => sum + range.estimatedBytes, 0);
  const packedRanges = budgeted.map(({ kind: _kind, ...range }) => range);
  const primaryKept = budgeted.some(range => range.kind === "primary")
    || (tagged.every(range => range.kind !== "primary") && budgeted.length > 0);
  const closedPrimary = budgeted.filter(range => range.kind === "primary").map(({ kind: _kind, ...range }) => range);
  const closedContext = budgeted.filter(range => range.kind !== "primary").map(({ kind: _kind, ...range }) => range);
  return {
    unit: {
      ...unit,
      primaryRanges: closedPrimary.length > 0 ? closedPrimary : packedRanges,
      contextRanges: closedContext,
      mergedRanges: packedRanges,
      estimatedBytes: afterSourceBytes
    },
    report: {
      path: unit.relativePath,
      beforeSpans: unit.mergedRanges.length,
      afterSpans: packedRanges.length,
      beforeSourceBytes,
      afterSourceBytes,
      wireBytesProxy: Buffer.byteLength(JSON.stringify(packedRanges), "utf8"),
      stopReason: stop,
      keptPrimary: primaryKept
    }
  };
}

export function packSelectedUnits(
  units: readonly ReadUnit[],
  profile: SpanPackingProfile,
  budget: RetrievalBudget
): { units: ReadUnit[]; report: SpanPackingReport } {
  const files = units.map(unit => packReadUnit(unit, profile, budget));
  const sourceBytesBefore = files.reduce((sum, file) => sum + file.report.beforeSourceBytes, 0);
  const sourceBytesAfter = files.reduce((sum, file) => sum + file.report.afterSourceBytes, 0);
  const wireBytesProxy = files.reduce((sum, file) => sum + file.report.wireBytesProxy, 0);
  const stopReason = files.some(file => file.report.stopReason === "EXTREME_METHOD_BOUNDED")
    ? "EXTREME_METHOD_BOUNDED"
    : files.some(file => file.report.stopReason === "READ_BUDGET_EXHAUSTED")
      ? "READ_BUDGET_EXHAUSTED"
      : files.some(file => file.report.stopReason === "SPAN_CAP")
        ? "SPAN_CAP"
        : "PACKED";
  return {
    units: files.map(file => file.unit),
    report: {
      mode: "on",
      profile,
      files: files.map(file => file.report),
      sourceBytesBefore,
      sourceBytesAfter,
      wireBytesProxy,
      estimatedTokensAfter: reconstructEstimatedTokens(wireBytesProxy, sourceBytesAfter),
      stopReason
    }
  };
}

export function mergePackableSpans(ranges: readonly PackedSpan[], adjacentGapLines: number): PackedSpan[] {
  const ordered = [...ranges].sort((left, right) =>
    left.startLine - right.startLine
    || left.endLine - right.endLine
    || left.kind.localeCompare(right.kind));
  const packed: PackedSpan[] = [];
  for (const range of ordered) {
    const last = packed[packed.length - 1];
    if (last && canMerge(last, range, adjacentGapLines)) {
      packed[packed.length - 1] = mergeSpan(last, range);
    } else {
      packed.push({ ...range });
    }
  }
  return packed;
}

function canMerge(left: PackedSpan, right: PackedSpan, adjacentGapLines: number): boolean {
  if (left.kind === "primary" && right.kind === "primary") return false;
  return right.startLine <= left.endLine + 1 + Math.max(0, adjacentGapLines);
}

function mergeSpan(left: PackedSpan, right: PackedSpan): PackedSpan {
  const startLine = Math.min(left.startLine, right.startLine);
  const endLine = Math.max(left.endLine, right.endLine);
  const kind: SpanKind = left.kind === "primary" || right.kind === "primary" ? "primary" : left.kind;
  const reason = kind === "primary"
    ? (left.kind === "primary" ? left.reason : right.reason)
    : left.reason;
  return {
    startLine,
    endLine,
    reason,
    estimatedBytes: unionBytes(left, right, startLine, endLine),
    kind
  };
}

function unionBytes(left: PackedSpan, right: PackedSpan, _startLine: number, _endLine: number): number {
  const leftLines = Math.max(1, left.endLine - left.startLine + 1);
  const rightLines = Math.max(1, right.endLine - right.startLine + 1);
  const overlapLines = Math.max(0, Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine) + 1);
  const overlapBytes = overlapLines * Math.min(left.estimatedBytes / leftLines, right.estimatedBytes / rightLines);
  const union = left.estimatedBytes + right.estimatedBytes - overlapBytes;
  return Math.max(left.estimatedBytes, right.estimatedBytes, Math.ceil(union));
}

function boundExtremeMethod(range: PackedSpan, maxBytes: number): PackedSpan {
  if (range.estimatedBytes <= maxBytes) return range;
  const lines = Math.max(1, range.endLine - range.startLine + 1);
  const bytesPerLine = range.estimatedBytes / lines;
  const keepLines = Math.max(1, Math.floor(maxBytes / Math.max(1, bytesPerLine)));
  return {
    ...range,
    endLine: range.startLine + keepLines - 1,
    estimatedBytes: Math.min(range.estimatedBytes, maxBytes)
  };
}

function capSpans(ranges: readonly PackedSpan[], maxSpansPerFile: number): PackedSpan[] {
  if (ranges.length <= maxSpansPerFile) return [...ranges];
  const primary = ranges.filter(range => range.kind === "primary");
  if (primary.length >= maxSpansPerFile) return primary.slice(0, maxSpansPerFile);
  const context = ranges.filter(range => range.kind !== "primary");
  const keepContext = maxSpansPerFile - primary.length;
  return [...primary, ...context.slice(0, keepContext)].sort((left, right) => left.startLine - right.startLine);
}

function fitSourceBudget(ranges: readonly PackedSpan[], maxReadBytes: number): PackedSpan[] {
  const total = ranges.reduce((sum, range) => sum + range.estimatedBytes, 0);
  if (total <= maxReadBytes) return [...ranges];
  const primary = ranges.filter(range => range.kind === "primary");
  const context = ranges.filter(range => range.kind !== "primary");
  const kept = [...primary];
  let used = kept.reduce((sum, range) => sum + range.estimatedBytes, 0);
  for (const range of context) {
    if (used + range.estimatedBytes > maxReadBytes) continue;
    kept.push(range);
    used += range.estimatedBytes;
  }
  if (kept.length === 0 && ranges[0]) return [ranges[0]];
  return kept.sort((left, right) => left.startLine - right.startLine);
}
