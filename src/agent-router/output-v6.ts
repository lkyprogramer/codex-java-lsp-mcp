// input: Raw pieces of an impact() result (target, freshness, semantic, ranked files, read plan, cost).
// output: ImpactResultV6 per architecture V3.1 §15.2-15.5 - explicit nested types, no
//         Record<string, unknown> in the core shape.
// pos: Task 31 Slice A. Not wired into production yet: format.ts/impact.ts/server.ts keep
//      emitting the v5 ImpactResult until a later slice replaces them with this contract.
import type { Completion } from "../runtime/completion.js";
import type { SourceRange } from "../runtime/source-range.js";
import type { Confidence, ReadPlanItemV6, SemanticPolicy } from "../agent-types.js";

export type ImpactTargetV6 = {
  file: string;
  symbol: string;
  type?: string;
  method?: string;
  profile: string;
  range: SourceRange;
};

export type ImpactFreshnessV6 = {
  requestGeneration: number;
  indexedGeneration: number;
  coverage: "COMPLETE" | "PARTIAL" | "DEGRADED";
  changedDuringRequest: boolean;
};

export type ImpactSemanticV6 = {
  policy: SemanticPolicy;
  used: boolean;
  completion: Completion;
  readiness?: string;
};

export type ImpactFileV6 = {
  id: string;
  path: string;
  role: string;
  confidence: Confidence;
  evidence: string[];
  locations: Array<{ line: number; column: number }>;
};

export type ImpactCostV6 = {
  resultBytes: number;
  readBytes: number;
  estimatedTokens: number;
  suppressedRawBytes: number;
};

/**
 * Diagnostic-only extensibility (verbosity="diagnostic"). Each section keeps
 * its own producer's shape rather than folding into one undifferentiated
 * bag - the ban on `Record<string, unknown>` applies to the core V6 contract
 * (target/freshness/semantic/files/cost), not to every diagnostic leaf; those
 * producers (semantic.ts, javaIndex status, framework adapters, ...) are not
 * being retyped in this slice.
 */
export type ImpactDiagnosticMetrics = {
  routingVersion: number;
  elapsedMs: number;
  phaseMs?: Record<string, number>;
  semantic?: Record<string, unknown>;
  javaIndex?: Record<string, unknown>;
  readPlan?: Record<string, unknown>;
  framework?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  generatedSemantics?: "OK" | "INCOMPLETE" | "NOT_DETECTED";
};

export type ImpactResultV6 = {
  version: 6;
  target: ImpactTargetV6;
  freshness: ImpactFreshnessV6;
  semantic: ImpactSemanticV6;
  files: ImpactFileV6[];
  readPlan: ReadPlanItemV6[];
  evidenceGaps: string[];
  cost: ImpactCostV6;
  metrics?: ImpactDiagnosticMetrics;
};

const BYTES_PER_TOKEN = 4;

/**
 * cost.resultBytes includes the cost object itself, so recompute until the
 * byte count stabilizes - the same fixed-point approach the v5 path already
 * uses for metrics.outputBytes (tools/impact.ts, format.ts), relocated to
 * this contract's cost shape. Three attempts is the documented bound: a
 * result only needs more than one correction when a byte-count digit itself
 * changes width, which cannot cascade past the first correction here.
 */
export function withConvergedCostV6<T extends { cost: ImpactCostV6 }>(
  payload: T,
  readBytes: number,
  suppressedRawBytes: number
): T {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resultBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const estimatedTokens = Math.ceil((resultBytes + readBytes) / BYTES_PER_TOKEN);
    if (payload.cost.resultBytes === resultBytes && payload.cost.estimatedTokens === estimatedTokens) {
      return payload;
    }
    payload.cost = { resultBytes, readBytes, estimatedTokens, suppressedRawBytes };
  }
  return payload;
}
