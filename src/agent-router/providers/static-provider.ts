// input: Anchors and JavaIndex structural facts (implementers, imports, type references).
// output: ProviderOutcome carrying static-structure EvidenceSignal[] plus legacy CandidateFile fragments.
// pos: Task 24 Step 5 - wraps candidate-collectors.ts/type-reference.ts unchanged behind the evidence contract.
import type { CandidateFile } from "../../agent-types.js";
import type { EvidenceFamily, EvidenceProvenance, EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import {
  collectImportGraphCandidates,
  collectTypeGraphCandidates
} from "../candidate-collectors.js";
import { collectTypeReferenceCandidates } from "../type-reference.js";
import { timed } from "../runtime.js";
import { updateTypeReferenceCacheMetrics } from "../impact-metrics.js";
import { isTouchedCandidate, nextSignalId, seedZeroStubs } from "./shared.js";

export const STATIC_PROVIDER_ID = "static";
export const STATIC_PROVIDER_VERSION = "1";

/** Mirrors the old per-reason score bonuses (candidate-collectors.ts/type-reference.ts). Task 25 replaces this policy object with family saturation. */
const STATIC_SIGNAL_POLICY: Record<string, { kind: string; family: EvidenceFamily; provenance: EvidenceProvenance; confidence: number; weight: number }> = {
  typeGraph: { kind: "IMPLEMENTS", family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.85, weight: 70 },
  "typeGraph:implementation-lookup": { kind: "IMPLEMENTS", family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.9, weight: 70 },
  importGraph: { kind: "IMPORTS", family: "STATIC_STRUCTURE", provenance: "AST_EXACT", confidence: 0.55, weight: 65 },
  "importGraph:reverse": { kind: "IMPORTED_BY", family: "STATIC_STRUCTURE", provenance: "AST_EXACT", confidence: 0.55, weight: 20 },
  typeReference: { kind: "REFERENCE", family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.8, weight: 55 }
};

export async function collectStaticEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const candidates = seedZeroStubs(input.repoRoot, input.existingCandidatePaths);

  await timed(input.phaseMs, "typeGraph", async () => collectTypeGraphCandidates({
    candidates,
    anchors: input.anchors,
    options: input.options,
    javaIndex: input.javaIndex,
    routingPolicy: input.routingPolicy,
    generation: input.generation
  }));
  await timed(input.phaseMs, "importGraph", async () => collectImportGraphCandidates({
    candidates,
    anchors: input.anchors,
    options: input.options,
    javaIndex: input.javaIndex,
    routingPolicy: input.routingPolicy,
    metrics: input.metrics.importGraph,
    generation: input.generation
  }));
  const typeReferenceBefore = await input.javaIndex.routerStatus();
  await timed(input.phaseMs, "typeReference", async () => collectTypeReferenceCandidates({
    candidates,
    anchors: [...input.anchors],
    options: input.options,
    metrics: input.metrics.typeReference,
    javaIndex: input.javaIndex,
    routingPolicy: input.routingPolicy,
    generation: input.generation
  }));
  const typeReferenceAfter = await input.javaIndex.routerStatus();
  updateTypeReferenceCacheMetrics(input.metrics.typeReference, typeReferenceBefore, typeReferenceAfter);

  const touched = [...candidates.values()].filter(isTouchedCandidate);
  const evidence = touched.flatMap(candidate => evidenceForCandidate(input, candidate));

  return {
    providerId: STATIC_PROVIDER_ID,
    providerVersion: STATIC_PROVIDER_VERSION,
    evidence,
    candidates: touched,
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}

function evidenceForCandidate(input: ProviderInput, candidate: CandidateFile): EvidenceSignal[] {
  const anchorId = input.anchors[0]?.id ?? "A1";
  const reasons = candidate.reasons.length > 0 ? candidate.reasons : (candidate.verifiedBy ?? []);
  const seen = new Set<string>();
  const signals: EvidenceSignal[] = [];
  for (const reason of reasons) {
    const policy = STATIC_SIGNAL_POLICY[reason];
    if (!policy || seen.has(reason)) {
      continue;
    }
    seen.add(reason);
    signals.push({
      signalId: nextSignalId(STATIC_PROVIDER_ID),
      candidateFile: candidate.absolutePath,
      anchorId,
      kind: policy.kind,
      family: policy.family,
      provenance: policy.provenance,
      confidence: policy.confidence,
      completeness: "COMPLETE",
      weight: policy.weight,
      sourceFile: candidate.absolutePath,
      positions: candidate.positions,
      providerId: STATIC_PROVIDER_ID,
      providerVersion: STATIC_PROVIDER_VERSION,
      generation: input.generation,
      detail: reason
    });
  }
  return signals;
}
