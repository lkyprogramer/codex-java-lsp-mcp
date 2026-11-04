// input: Internal V6 impact payload after ranking/read-plan (selection unchanged).
// output: Compact wire contract: one contexts[] list, no files[]+readPlan[] dual expression.
// pos: JIN N0.5 serializer. Ranking/selection stay in format.ts / read-plan.ts.
import type { Completion } from "../runtime/completion.js";
import type { ImpactCostV6, ImpactFileV6, ImpactFreshnessV6, ImpactResult, ImpactResultV6, ReadPlanItemV6 } from "../agent-types.js";
import { roleOf } from "./output-v6.js";
import { withConvergedCostV6 } from "./output-v6.js";

export const COMPACT_IMPACT_VERSION = 1 as const;
const SUPPLEMENTAL_CONTEXT_LIMIT = 3;

const ROLE_CODE: Record<string, string> = {
  target: "TGT",
  collaborator: "COL",
  implementation: "IMP",
  reference: "REF",
  config: "CFG",
  framework: "FW",
  related: "REL"
};

export type CompactSpan = {
  s: number;
  e: number;
  b: number;
};

export type CompactContext = {
  path: string;
  role: string;
  proof: string[];
  spans: CompactSpan[];
};

export type CompactImpact = {
  version: typeof COMPACT_IMPACT_VERSION;
  target: { file: string; symbol: string };
  contexts: CompactContext[];
  /** Ranked candidates omitted from the explicit compact view. */
  omittedContexts?: number;
  unresolved: string[];
  cost: ImpactCostV6;
  /** Slim cold-nolsp proof; not files[]/readPlan[] dual expression. */
  freshness: Pick<ImpactFreshnessV6, "coverage" | "requestGeneration" | "indexedGeneration" | "changedDuringRequest">;
  semantic: { used: boolean; completion: Completion };
  metrics?: {
    routingVersion: number;
    elapsedMs: number;
    generatedSemantics?: unknown;
  };
};

export function isCompactImpact(value: unknown): value is CompactImpact {
  return Boolean(value && typeof value === "object" && (value as CompactImpact).version === COMPACT_IMPACT_VERSION
    && Array.isArray((value as CompactImpact).contexts));
}

export function asImpactResult(result: ImpactResult | CompactImpact): ImpactResult {
  if (isCompactImpact(result)) {
    throw new Error("expected diagnostic ImpactResult, got compact wire");
  }
  return result;
}

export function toCompactImpact(payload: ImpactResultV6, verbosity: "standard" | "compact" = "standard"): CompactImpact {
  const byId = new Map(payload.files.map(file => [file.id, file]));
  const selected = new Map<string, CompactSpan[]>();
  for (const item of payload.readPlan) {
    const file = byId.get(item.fileId);
    const path = file?.path;
    if (!path) continue;
    const spans = selected.get(path) ?? [];
    for (const range of item.ranges) {
      spans.push({ s: range.startLine, e: range.endLine, b: range.estimatedBytes });
    }
    selected.set(path, spans);
  }
  const contexts: CompactContext[] = payload.files.map(file => ({
    path: file.path,
    role: compactRole(file),
    proof: compactProof(file),
    spans: selected.get(file.path) ?? []
  }));
  const slim = verbosity === "compact";
  const visibleContexts = slim ? selectCompactContexts(contexts, payload.files) : contexts;
  const compact: CompactImpact = {
    version: COMPACT_IMPACT_VERSION,
    target: { file: payload.target.file, symbol: payload.target.symbol },
    contexts: visibleContexts,
    ...(slim ? { omittedContexts: contexts.length - visibleContexts.length } : {}),
    unresolved: slim ? payload.evidenceGaps : compactUnresolved(payload.evidenceGaps),
    cost: payload.cost,
    freshness: {
      coverage: payload.freshness.coverage,
      requestGeneration: payload.freshness.requestGeneration,
      indexedGeneration: payload.freshness.indexedGeneration,
      changedDuringRequest: payload.freshness.changedDuringRequest
    },
    semantic: {
      used: payload.semantic.used,
      completion: payload.semantic.completion
    }
  };
  if (payload.metrics && (!slim || payload.metrics.generatedSemantics === "INCOMPLETE")) {
    compact.metrics = {
      routingVersion: Number(payload.metrics.routingVersion ?? 6),
      elapsedMs: Number(payload.metrics.elapsedMs ?? 0),
      ...(payload.metrics.generatedSemantics === undefined
        ? {}
        : { generatedSemantics: payload.metrics.generatedSemantics })
    };
  }
  return withConvergedCostV6(compact, payload.cost.readBytes, payload.cost.suppressedRawBytes);
}

function selectCompactContexts(contexts: CompactContext[], files: ImpactFileV6[]): CompactContext[] {
  // Framework evidence can set the display role of an explicit anchor to FW.
  const anchorPaths = new Set(files
    .filter(file => file.reasons?.some(reason => reason === "target" || reason === "anchor"))
    .map(file => file.path));
  const required = (context: CompactContext) => context.spans.length > 0 || anchorPaths.has(context.path);
  // Reserve one slot for configuration/framework evidence outside the read plan.
  const supplemental = contexts.filter(context => !required(context));
  const wiring = supplemental.find(context => context.role === "CFG" || context.role === "FW");
  const selected = supplemental.filter(context => context !== wiring).slice(0, SUPPLEMENTAL_CONTEXT_LIMIT - (wiring ? 1 : 0));
  if (wiring) selected.push(wiring);
  return contexts.filter(context => required(context) || selected.includes(context));
}

export function compactRole(file: Pick<ImpactFileV6, "role" | "reasons">): string {
  const role = file.role || roleOf(file.reasons ?? []);
  return ROLE_CODE[role] ?? "REL";
}

export function compactProof(file: Pick<ImpactFileV6, "reasons">): string[] {
  const kinds = (file.reasons ?? []).filter(kind => kind !== "target" && kind !== "anchor");
  return [...new Set(kinds)].slice(0, 3);
}

function compactUnresolved(gaps: string[]): string[] {
  const lombok = gaps.filter(gap => gap.includes("Lombok"));
  const rest = gaps.filter(gap => !gap.includes("Lombok"));
  return [...lombok, ...rest].slice(0, 3);
}

export function viewImpactFiles(result: ImpactResult | CompactImpact): string[] {
  if (isCompactImpact(result)) return result.contexts.map(context => context.path);
  return result.files.map(file => String(file.path));
}

export function viewReadPlanBytes(result: ImpactResult | CompactImpact): number {
  if (isCompactImpact(result)) {
    return result.contexts.reduce((sum, context) => sum + context.spans.reduce((inner, span) => inner + span.b, 0), 0);
  }
  return result.readPlan.reduce((sum, item) => sum + item.estimatedBytes, 0);
}

export function viewReadPlanRangeCount(result: ImpactResult | CompactImpact): number {
  if (isCompactImpact(result)) {
    return result.contexts.reduce((sum, context) => sum + context.spans.length, 0);
  }
  return result.readPlan.reduce((sum, item) => sum + item.ranges.length, 0);
}

export function viewDistinctReadFiles(result: ImpactResult | CompactImpact): string[] {
  if (isCompactImpact(result)) {
    return result.contexts.filter(context => context.spans.length > 0).map(context => context.path);
  }
  const files = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  return [...new Set(result.readPlan.map(item => files.get(item.fileId)).filter((file): file is string => Boolean(file)))];
}

export function viewSelectedRangesByFile(result: ImpactResult | CompactImpact): Map<string, Array<{ startLine: number; endLine: number }>> {
  const byFile = new Map<string, Array<{ startLine: number; endLine: number }>>();
  if (isCompactImpact(result)) {
    for (const context of result.contexts) {
      if (context.spans.length === 0) continue;
      byFile.set(context.path, context.spans.map(span => ({ startLine: span.s, endLine: span.e })));
    }
    return byFile;
  }
  const pathById = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  for (const item of result.readPlan as ReadPlanItemV6[]) {
    const file = pathById.get(item.fileId);
    if (!file) continue;
    const ranges = byFile.get(file) ?? [];
    ranges.push(...item.ranges.map(range => ({ startLine: range.startLine, endLine: range.endLine })));
    byFile.set(file, ranges);
  }
  return byFile;
}
