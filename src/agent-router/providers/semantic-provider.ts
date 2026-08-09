// input: Anchors, the persisted SemanticEdgeStoreV2, and (phase two) the live JDT gateway.
// output: ProviderOutcome carrying EXACT_SEMANTIC/JDT_EXACT/PERSISTED_JDT EvidenceSignal[].
// pos: Task 24 Step 7 wraps semantic.ts/collectPersistedSemanticCandidates behind the evidence
//      contract; Task 33's read-path cutover moved the persisted read off the legacy
//      file-path-keyed edge-store onto the symbolId-keyed SemanticEdgeStoreV2.
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
import { candidateMetadata, isTouchedCandidate, nextSignalId } from "./shared.js";

export const SEMANTIC_PROVIDER_ID = "semantic";
export const SEMANTIC_PROVIDER_VERSION = "1";

/**
 * The additive implementation's `reference` bonus (10) rode on top of a
 * context-dependent base score. A standalone COMPLETE persisted JDT edge
 * needs an evidence-native fixed weight instead: 80 reaches the exact-
 * semantic high-confidence threshold after its 0.9 confidence factor, while
 * family caps still bound repeated persisted references. Implementation and
 * hierarchy preserve their established fixed strength ordering.
 */
function persistedEdgeWeightBonus(rawKind: string): number {
  if (rawKind === "implementation") {
    return 90;
  }
  if (rawKind === "typeHierarchy") {
    return 70;
  }
  return 80;
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
    javaIndex: input.javaIndex,
    edgeStoreV2: input.edgeStoreV2,
    generation: input.generation,
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
      detail: candidate.verifiedBy?.[0],
      candidateMetadata: candidateMetadata(candidate)
    };
  });
  return {
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    evidence,
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
    budget: input.budget,
    javaIndex: input.javaIndex,
    edgeStoreV2: input.edgeStoreV2,
    buildFingerprint: input.buildFingerprint,
    generation: input.generation
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
      completeness: input.metrics.semantic.timeout
        || (rawReason === "reference" && input.metrics.semantic.referenceTruncatedByLimit)
        ? "PARTIAL" as const
        : "COMPLETE" as const,
      weight: liveSemanticWeightBonus(rawReason),
      sourceFile: candidate.absolutePath,
      positions: candidate.positions,
      providerId: SEMANTIC_PROVIDER_ID,
      providerVersion: SEMANTIC_PROVIDER_VERSION,
      generation: input.generation,
      detail: candidate.reasons[0],
      candidateMetadata: candidateMetadata(candidate)
    };
  });
  return {
    providerId: SEMANTIC_PROVIDER_ID,
    providerVersion: SEMANTIC_PROVIDER_VERSION,
    evidence,
    completion: input.metrics.semantic.timeout
      ? "PARTIAL_TIMEOUT"
      : input.metrics.semantic.referenceTruncatedByLimit
        ? "PARTIAL_LIMIT"
        : "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}
