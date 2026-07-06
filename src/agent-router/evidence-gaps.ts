import type { ImpactOptions, ResolvedAnchor } from "../agent-types.js";

type EvidenceGapState = {
  readonly skipped: boolean;
  readonly timeout: boolean;
};

export function evidenceGaps(anchors: readonly ResolvedAnchor[], options: ImpactOptions, semantic: EvidenceGapState): string[] {
  const gaps = [
    "Run Gradle compile/test before claiming behavior.",
    "Use rg/runtime evidence for Spring wiring, SQL/XML/YAML, logs, Nacos, and DB state."
  ];
  if (semantic.skipped) {
    gaps.push("LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.");
  }
  if (semantic.timeout) {
    gaps.push("LSP semantic enrichment hit the configured timeout and fell back to source-index plus rg evidence.");
  }
  if (anchors.some(anchor => anchor.factSource !== "documentSymbol")) {
    gaps.push("Source facts are regex-derived and not yet JDT LS documentSymbol confirmed.");
  }
  if (anchors.some(anchor => anchor.profile === "repository" || anchor.profile === "port")) {
    gaps.push("Review persistence/config evidence from rgSummary before changing behavior.");
  }
  if (options.testReadMode === "defer") {
    gaps.push("Tests are returned as lower-priority candidates; use testReadMode=priority when verification planning is the main task.");
  }
  return gaps;
}
