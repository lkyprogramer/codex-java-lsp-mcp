// input: The path set already discovered by other providers this request.
// output: ProviderOutcome carrying SUPPORT/TASK_CONTEXT EvidenceSignal[] with zero score effect.
// pos: Task 24 Step 7 - a tiny context provider; focusModules/taskKeywords stop being direct
//      finalizeScore deltas only once Task 25's ranker consumes these signals instead (plan line 7434).
import { classifyPath } from "../../repo-layout.js";
import type { CandidateFile } from "../../agent-types.js";
import { breakdown, matchesAny, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import { nextSignalId } from "./shared.js";

export const SUPPORT_PROVIDER_ID = "support";
export const SUPPORT_PROVIDER_VERSION = "1";

const SUPPORT_FILE_PATTERN = /\.(xml|sql|ya?ml|properties)$/i;

export async function collectSupportEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const anchorId = input.anchors[0]?.id ?? "A1";
  const evidence: EvidenceSignal[] = [];
  const candidates = new Map<string, CandidateFile>();
  for (const absolutePath of new Set(input.existingCandidatePaths)) {
    const context = classifyPath(input.repoRoot, absolutePath);
    const relativePath = context.relativePath ?? absolutePath;
    if (context.sourceSet === "test" || SUPPORT_FILE_PATTERN.test(relativePath)) {
      evidence.push(makeSignal(input, anchorId, absolutePath, "SUPPORT_FILE", "SUPPORT", 10));
    }
    const focusMatch = Boolean(context.module && input.options.focusModules.includes(context.module));
    const keywordMatch = matchesAny(relativePath, input.options.taskKeywords);
    if (focusMatch) {
      evidence.push(makeSignal(input, anchorId, absolutePath, "FOCUS_MODULE", "TASK_CONTEXT", 35));
      mergeCandidate(candidates, contextCandidate(context, "taskContext:focusModule", 35));
    }
    if (keywordMatch) {
      evidence.push(makeSignal(input, anchorId, absolutePath, "TASK_KEYWORD", "TASK_CONTEXT", 30));
      mergeCandidate(candidates, contextCandidate(context, "taskContext:taskKeyword", 30));
    }
  }
  return {
    providerId: SUPPORT_PROVIDER_ID,
    providerVersion: SUPPORT_PROVIDER_VERSION,
    evidence,
    // Context only reinforces paths that an earlier provider found.  It does
    // not create broad lexical candidates, but its contribution must flow
    // through the same normalized evidence/ranking boundary as every other
    // provider instead of being re-applied in finalizeScore.
    candidates: [...candidates.values()],
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}

function contextCandidate(
  context: ReturnType<typeof classifyPath>,
  reason: string,
  score: number
): CandidateFile {
  return {
    absolutePath: context.absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score,
    matchCount: 0,
    positions: [],
    categories: ["task-context"],
    reasons: [reason],
    confidence: "low",
    verifiedBy: ["taskContext"],
    scoreBreakdown: [breakdown(`evidence.${reason}`, "policy", score, reason)]
  };
}

function makeSignal(
  input: ProviderInput,
  anchorId: string,
  absolutePath: string,
  kind: string,
  family: "SUPPORT" | "TASK_CONTEXT",
  weight: number
): EvidenceSignal {
  return {
    signalId: nextSignalId(SUPPORT_PROVIDER_ID),
    candidateFile: absolutePath,
    anchorId,
    kind,
    family,
    provenance: "FRAMEWORK_INFERRED",
    confidence: 0.5,
    completeness: "COMPLETE",
    weight,
    sourceFile: absolutePath,
    positions: [],
    providerId: SUPPORT_PROVIDER_ID,
    providerVersion: SUPPORT_PROVIDER_VERSION,
    generation: input.generation
  };
}
