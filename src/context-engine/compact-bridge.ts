// input: Planned §11.3 contract.
// output: CompactImpact with contexts[] = selected spans only. Discovery extras stay off the wire.
// pos: JIN N4 T3 adapter. Production java_impact does not import this.
import { withConvergedCostV6 } from "../agent-router/output-v6.js";
import type { CompactImpact } from "../agent-router/output-compact.js";
import { parseSpanRanges } from "./context-candidates.js";
import type { ContextContract } from "./context-contract.js";

const JIN_COMPACT_ROLE: Record<string, string> = {
  ANCHOR: "TGT",
  CHANGE_SITE: "TGT",
  CALLEE: "COL",
  CALLER: "COL",
  DATAFLOW: "COL",
  IMPLEMENTATION: "IMP",
  CONTRACT: "REF",
  PERSISTENCE: "CFG",
  FRAMEWORK: "FW",
  TEST: "REL"
};

export function toCompactFromContract(contract: ContextContract, elapsedMs: number): CompactImpact {
  const packed = contract.evidence ?? contract.contexts ?? [];
  const contexts = packed
    .map(item => {
      const spans = (item.ranges ? parseSpanRanges(item.ranges) : item.spans ?? [])
        .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end >= span.start);
      return {
        path: item.path,
        role: JIN_COMPACT_ROLE[item.role] ?? "REL",
        proof: (item.proof ?? []).slice(0, 3),
        spans: spans.map(span => ({
          s: span.start,
          e: span.end,
          b: Math.max(1, (span.end - span.start + 1) * 48)
        }))
      };
    })
    .filter(item => item.spans.length > 0);
  const payload: CompactImpact = {
    version: 1,
    target: {
      file: contract.anchor?.path ?? packed[0]?.path ?? "",
      symbol: contract.anchor?.symbol ?? ""
    },
    contexts,
    unresolved: contract.unresolved.map(item => item.role).slice(0, 3),
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 },
    freshness: {
      coverage: contract.coverage === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      requestGeneration: contract.generation,
      indexedGeneration: contract.generation,
      changedDuringRequest: false
    },
    semantic: { used: false, completion: "COMPLETE" },
    metrics: { routingVersion: 1, elapsedMs }
  };
  const readBytes = contexts.reduce((sum, item) => sum + item.spans.reduce((inner, span) => inner + span.b, 0), 0);
  return withConvergedCostV6(payload, readBytes, 0);
}
