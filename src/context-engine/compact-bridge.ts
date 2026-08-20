// input: Planned §11.3 contract.
// output: CompactImpact with contexts[] = selected spans only. Discovery extras stay off the wire.
// pos: JIN N4 T3 adapter. Production java_impact does not import this.
import { withConvergedCostV6 } from "../agent-router/output-v6.js";
import type { CompactImpact } from "../agent-router/output-compact.js";
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
  const contexts = contract.contexts
    .filter(item => item.spans.length > 0)
    .map(item => ({
      path: item.path,
      role: JIN_COMPACT_ROLE[item.role] ?? "REL",
      proof: item.proof.slice(0, 3),
      spans: item.spans.map(span => ({
        s: span.start,
        e: span.end,
        b: span.text ? Buffer.byteLength(span.text, "utf8") : Math.max(1, (span.end - span.start + 1) * 48)
      }))
    }));
  const payload: CompactImpact = {
    version: 1,
    target: { file: contract.anchor.path, symbol: contract.anchor.symbol },
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
