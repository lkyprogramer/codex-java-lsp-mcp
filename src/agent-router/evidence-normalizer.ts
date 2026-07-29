// input: Raw EvidenceSignal[] from every provider's ProviderOutcome.
// output: One CandidateEvidence per candidate file, deduplicated by canonical identity.
// pos: Task 24 Step 2-4 - the single place duplicate/invalid provider output is caught.
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { Confidence } from "../agent-types.js";
import type { CandidateEvidence, EvidenceCompleteness, EvidenceSignal } from "./evidence.js";

const COMPLETENESS_RANK: Record<EvidenceCompleteness, number> = {
  COMPLETE: 2,
  PARTIAL: 1,
  UNKNOWN: 0
};

const DEFAULT_CONFIDENCE: Confidence = "low";

export function normalizeEvidence(signals: readonly EvidenceSignal[]): Map<string, CandidateEvidence> {
  const bestByIdentity = new Map<string, EvidenceSignal>();
  for (const signal of signals) {
    validateSignal(signal);
    const identity = evidenceIdentity(signal);
    const current = bestByIdentity.get(identity);
    if (!current || isBetter(signal, current)) {
      bestByIdentity.set(identity, signal);
    }
  }

  const byFile = new Map<string, CandidateEvidence>();
  for (const signal of bestByIdentity.values()) {
    const entry = byFile.get(signal.candidateFile);
    if (entry) {
      entry.signals.push(signal);
      continue;
    }
    byFile.set(signal.candidateFile, {
      file: signal.candidateFile,
      signals: [signal],
      familyScores: {},
      finalScore: 0,
      confidence: DEFAULT_CONFIDENCE,
      degradation: []
    });
  }
  return byFile;
}

function evidenceIdentity(signal: EvidenceSignal): string {
  return JSON.stringify({
    candidateFile: signal.candidateFile,
    candidateNodeId: signal.candidateNodeId,
    anchorId: signal.anchorId,
    kind: signal.kind,
    family: signal.family,
    provenance: signal.provenance,
    sourceFile: signal.sourceFile,
    sourceRange: signal.sourceRange,
    providerId: signal.providerId
  });
}

/** True when `candidate` should replace `current` for the same evidence identity. */
function isBetter(candidate: EvidenceSignal, current: EvidenceSignal): boolean {
  if (candidate.confidence !== current.confidence) {
    return candidate.confidence > current.confidence;
  }
  const candidateRank = COMPLETENESS_RANK[candidate.completeness];
  const currentRank = COMPLETENESS_RANK[current.completeness];
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank;
  }
  if (candidate.weight !== current.weight) {
    return candidate.weight > current.weight;
  }
  return candidate.signalId < current.signalId;
}

function validateSignal(signal: EvidenceSignal): void {
  if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
    throw new JavaIntelligenceError(
      "INVALID_INPUT",
      `Evidence ${signal.signalId} has invalid confidence ${String(signal.confidence)}`
    );
  }
  if (!COMPLETENESS_RANK_KEYS.has(signal.completeness)) {
    throw new JavaIntelligenceError(
      "INVALID_INPUT",
      `Evidence ${signal.signalId} has invalid completeness ${String(signal.completeness)}`
    );
  }
  if (!Number.isFinite(signal.weight) || signal.weight < 0) {
    throw new JavaIntelligenceError(
      "INVALID_INPUT",
      `Evidence ${signal.signalId} has invalid weight ${String(signal.weight)}`
    );
  }
}

const COMPLETENESS_RANK_KEYS = new Set(Object.keys(COMPLETENESS_RANK));
