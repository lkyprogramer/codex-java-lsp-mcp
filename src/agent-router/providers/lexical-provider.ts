// input: Anchors, options, and layout context driving the existing profile-specific rg plans.
// output: ProviderOutcome carrying LEXICAL_RG EvidenceSignal[] plus the legacy RgExecutionResult diagnostics.
// pos: Task 24 Step 6 - wraps rg-plan.ts/rg-execution.ts unchanged behind the evidence contract.
import type { EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import { executeRgPlan, type RgExecutionResult } from "../rg-execution.js";
import { buildRgPlan } from "../rg-plan.js";
import { timed } from "../runtime.js";
import { nextSignalId } from "./shared.js";

export const LEXICAL_PROVIDER_ID = "lexical";
export const LEXICAL_PROVIDER_VERSION = "1";

export type LexicalProviderOutcome = ProviderOutcome & {
  rgExecution: RgExecutionResult;
};

/**
 * rg matches carry no per-line relevance score from ripgrep itself; the
 * legacy pipeline has always scored every match as "medium" confidence
 * regardless of profile (rg-plan.ts). Task 25's family ranker is where
 * per-match confidence differentiation belongs - this generic provider keeps
 * no lishuedu-style business-name tuning.
 */
function lexicalConfidence(): number {
  return 0.6;
}

export async function collectLexicalEvidence(input: ProviderInput): Promise<LexicalProviderOutcome> {
  const startedAt = Date.now();
  const rgPlan = input.anchors.flatMap(anchor => buildRgPlan({
    repoRoot: input.repoRoot,
    anchor,
    options: input.options,
    layoutContext: input.layoutContext
  }));
  const rgExecution = await timed(input.phaseMs, "rg", async () => executeRgPlan({
    plan: rgPlan,
    options: input.options,
    anchors: input.anchors,
    concurrency: input.concurrency,
    loadSummary: input.loadRgSummary
  }));
  const anchorId = input.anchors[0]?.id ?? "A1";
  const completeness = rgExecution.completion === "COMPLETE" ? "COMPLETE" : "PARTIAL";
  const confidence = lexicalConfidence();
  const evidence: EvidenceSignal[] = rgExecution.files.map(candidate => ({
    signalId: nextSignalId(LEXICAL_PROVIDER_ID),
    candidateFile: candidate.absolutePath,
    anchorId,
    kind: "NAME_MATCH",
    family: "LEXICAL",
    provenance: "LEXICAL_RG",
    confidence,
    completeness,
    weight: candidate.score,
    sourceFile: candidate.absolutePath,
    positions: candidate.positions,
    providerId: LEXICAL_PROVIDER_ID,
    providerVersion: LEXICAL_PROVIDER_VERSION,
    generation: input.generation,
    detail: candidate.reasons.join(",")
  }));

  return {
    providerId: LEXICAL_PROVIDER_ID,
    providerVersion: LEXICAL_PROVIDER_VERSION,
    evidence,
    candidates: rgExecution.files,
    completion: rgExecution.completion,
    elapsedMs: Date.now() - startedAt,
    rgExecution
  };
}
