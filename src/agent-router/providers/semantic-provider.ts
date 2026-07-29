// input: Anchors, the persisted semantic EdgeStore, and (phase two) the live JDT gateway.
// output: ProviderOutcome carrying EXACT_SEMANTIC/JDT_EXACT/PERSISTED_JDT EvidenceSignal[].
// pos: Task 24 Step 7 - wraps semantic.ts/collectPersistedSemanticCandidates unchanged behind the evidence contract.
//
// Split into two entry points, not one collect(): the legacy pipeline queries
// the persisted edge store *before* static/lexical discovery (so
// type-reference's reinforcement can see it) but only spends live JDT budget
// *after* nonLspReadPlanPaths has already picked a protected read-plan from
// cheaper evidence. Both stages still emit the same provider id/version so
// downstream evidence is attributed to one logical "semantic" source.
import type { CandidateFile } from "../../agent-types.js";
import type { EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import { collectPersistedSemanticCandidates } from "../candidate-collectors.js";
import { collectSemanticSeed, semanticVerify } from "../semantic.js";
import { timed } from "../runtime.js";
import { isTouchedCandidate, nextSignalId } from "./shared.js";

export const SEMANTIC_PROVIDER_ID = "semantic";
export const SEMANTIC_PROVIDER_VERSION = "1";

/**
 * Task 25 item 5: weight extracted from candidate-collectors.ts's
 * persistedEdgeScoreBonus(edge.kind), the fixed bonus collectPersistedSemanticCandidates
 * adds on top of scoreBase() for a persisted edge. Unlike scoreBase() itself
 * (routing-policy/profile/module/task dependent - not reused as a signal
 * weight per item 5), this bonus was already a context-independent constant,
 * so it carries over unchanged as the signal's weight.
 */
function persistedEdgeWeightBonus(rawKind: string): number {
  if (rawKind === "implementation") {
    return 90;
  }
  if (rawKind === "typeHierarchy") {
    return 70;
  }
  return 10;
}

/**
 * Task 25 item 5: weight extracted from semantic.ts:226's
 * `scoreBase(...) + (reason === "implementation" ? 120 : reason === "typeHierarchy" ? 110 : 80)`.
 * Same rationale as persistedEdgeWeightBonus above - only the fixed bonus
 * term is context-independent, so only it becomes the signal's weight.
 */
function liveSemanticWeightBonus(rawReason: string): number {
  if (rawReason === "implementation") {
    return 120;
  }
  if (rawReason === "typeHierarchy") {
    return 110;
  }
  return 80;
}

export async function collectPersistedSemanticEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const candidates = new Map<string, CandidateFile>();
  await timed(input.phaseMs, "persistedSemantic", async () => collectPersistedSemanticCandidates({
    candidates,
    anchors: input.anchors,
    options: input.options,
    repoRoot: input.repoRoot,
    routingPolicy: input.routingPolicy,
    edgeStore: input.edgeStore,
    metrics: input.metrics.persistedSemantic
  }));
  const touched = [...candidates.values()].filter(isTouchedCandidate);
  const anchorId = input.anchors[0]?.id ?? "A1";
  const evidence: EvidenceSignal[] = touched.map(candidate => {
    const rawKind = (candidate.verifiedBy?.[0] ?? "persisted").replace(/^persisted-/, "");
    return {
      signalId: nextSignalId(SEMANTIC_PROVIDER_ID),
      candidateFile: candidate.absolutePath,
      anchorId,
      kind: rawKind.toUpperCase(),
      family: "EXACT_SEMANTIC" as const,
      provenance: "PERSISTED_JDT" as const,
      confidence: 0.9,
      completeness: "COMPLETE" as const,
      weight: persistedEdgeWeightBonus(rawKind),
      sourceFile: candidate.absolutePath,
      positions: candidate.positions,
      providerId: SEMANTIC_PROVIDER_ID,
      providerVersion: SEMANTIC_PROVIDER_VERSION,
      generation: input.generation,
      detail: candidate.verifiedBy?.[0]
    };
  });
  return {
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    evidence,
    candidates: touched,
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}

export async function collectLiveSemanticEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const candidates = new Map<string, CandidateFile>();
  await collectSemanticSeed({
    candidates,
    anchors: input.anchors,
    options: input.options,
    semantic: input.metrics.semantic,
    phaseMs: input.phaseMs,
    repoRoot: input.repoRoot,
    session: input.session,
    routingPolicy: input.routingPolicy,
    budget: input.budget
  });
  await semanticVerify({
    candidates,
    anchors: input.anchors,
    options: input.options,
    semantic: input.metrics.semantic,
    phaseMs: input.phaseMs,
    repoRoot: input.repoRoot,
    session: input.session,
    routingPolicy: input.routingPolicy,
    edgeStore: input.edgeStore,
    budget: input.budget
  });
  const touched = [...candidates.values()].filter(isTouchedCandidate);
  const anchorId = input.anchors[0]?.id ?? "A1";
  const evidence: EvidenceSignal[] = touched.map(candidate => {
    const rawReason = candidate.reasons[0] ?? "reference";
    return {
      signalId: nextSignalId(SEMANTIC_PROVIDER_ID),
      candidateFile: candidate.absolutePath,
      anchorId,
      kind: rawReason.toUpperCase(),
      family: "EXACT_SEMANTIC" as const,
      provenance: "JDT_EXACT" as const,
      confidence: 0.95,
      completeness: input.metrics.semantic.timeout ? "PARTIAL" as const : "COMPLETE" as const,
      weight: liveSemanticWeightBonus(rawReason),
      sourceFile: candidate.absolutePath,
      positions: candidate.positions,
      providerId: SEMANTIC_PROVIDER_ID,
      providerVersion: SEMANTIC_PROVIDER_VERSION,
      generation: input.generation,
      detail: candidate.reasons[0]
    };
  });
  return {
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    evidence,
    candidates: touched,
    completion: input.metrics.semantic.timeout ? "PARTIAL_TIMEOUT" : "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}
