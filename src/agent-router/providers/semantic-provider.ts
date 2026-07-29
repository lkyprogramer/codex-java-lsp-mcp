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
  const evidence: EvidenceSignal[] = touched.map(candidate => ({
    signalId: nextSignalId(SEMANTIC_PROVIDER_ID),
    candidateFile: candidate.absolutePath,
    anchorId,
    kind: (candidate.verifiedBy?.[0] ?? "persisted").replace(/^persisted-/, "").toUpperCase(),
    family: "EXACT_SEMANTIC",
    provenance: "PERSISTED_JDT",
    confidence: 0.9,
    completeness: "COMPLETE",
    weight: candidate.score,
    sourceFile: candidate.absolutePath,
    positions: candidate.positions,
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    generation: input.generation,
    detail: candidate.verifiedBy?.[0]
  }));
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
  const evidence: EvidenceSignal[] = touched.map(candidate => ({
    signalId: nextSignalId(SEMANTIC_PROVIDER_ID),
    candidateFile: candidate.absolutePath,
    anchorId,
    kind: (candidate.reasons[0] ?? "reference").toUpperCase(),
    family: "EXACT_SEMANTIC",
    provenance: "JDT_EXACT",
    confidence: 0.95,
    completeness: input.metrics.semantic.timeout ? "PARTIAL" : "COMPLETE",
    weight: candidate.score,
    sourceFile: candidate.absolutePath,
    positions: candidate.positions,
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    generation: input.generation,
    detail: candidate.reasons[0]
  }));
  return {
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    evidence,
    candidates: touched,
    completion: input.metrics.semantic.timeout ? "PARTIAL_TIMEOUT" : "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}
