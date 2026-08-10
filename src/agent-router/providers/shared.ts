// input: A provider's own touched CandidateFile map and the identity of a provider run.
// output: Signal-id allocation and the zero-value CandidateFile identity element.
// pos: Task 24 Steps 5-8 - shared plumbing for every providers/*-provider.ts file.
import { classifyPath } from "../../repo-layout.js";
import type { CandidateFile } from "../../agent-types.js";
import type { EvidenceCandidateMetadata } from "../evidence.js";

export function candidateMetadata(
  candidate: Pick<CandidateFile, "categories" | "reasons" | "verifiedBy" | "matchCount">,
  overrides: Partial<EvidenceCandidateMetadata> = {}
): EvidenceCandidateMetadata {
  return {
    categories: [...(overrides.categories ?? candidate.categories)],
    reasons: [...(overrides.reasons ?? candidate.reasons)],
    verifiedBy: [...(overrides.verifiedBy ?? candidate.verifiedBy ?? [])],
    matchCount: overrides.matchCount ?? candidate.matchCount
  };
}

/**
 * The identity element of `mergeCandidate`'s fold: merging this into any
 * `CandidateFile` (or merging any `CandidateFile` into this) yields that
 * other `CandidateFile` unchanged. Seeding a provider's private map with one
 * zero stub per already-known path lets that provider's unmodified legacy
 * collector (`collectImportGraphCandidates`, ...) both see prior candidates
 * for its own `.has()`/read logic AND, after
 * running, report each touched entry as exactly this provider's own net
 * contribution - the stub contributes nothing to score/reasons/positions.
 */
export function zeroCandidateStub(repoRoot: string, absolutePath: string): CandidateFile {
  const context = classifyPath(repoRoot, absolutePath);
  return {
    absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score: 0,
    matchCount: 0,
    positions: [],
    categories: [],
    reasons: [],
    verifiedBy: [],
    scoreBreakdown: []
  };
}

export function seedZeroStubs(repoRoot: string, paths: readonly string[]): Map<string, CandidateFile> {
  const map = new Map<string, CandidateFile>();
  for (const path of paths) {
    if (!map.has(path)) {
      map.set(path, zeroCandidateStub(repoRoot, path));
    }
  }
  return map;
}

/**
 * A touched candidate is one a provider's wrapped collector actually merged
 * evidence into. Providers project only those private collector entries into
 * EvidenceSignal metadata; untouched zero stubs never cross that boundary.
 */
export function isTouchedCandidate(candidate: CandidateFile): boolean {
  return candidate.score !== 0 || candidate.reasons.length > 0 || candidate.matchCount !== 0;
}

let signalSequence = 0;

export function nextSignalId(providerId: string): string {
  signalSequence += 1;
  return `${providerId}:${signalSequence}`;
}
