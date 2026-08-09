// input: The path set already discovered by other providers this request.
// output: ProviderOutcome carrying SUPPORT/TASK_CONTEXT EvidenceSignal[] with zero score effect.
// pos: Task 24 Step 7 - a tiny context provider; focusModules/taskKeywords stop being direct
//      direct final-score deltas; Task 25's ranker consumes these signals instead (plan line 7434).
import { classifyPath } from "../../repo-layout.js";
import { matchesAny } from "../candidate-helpers.js";
import type { EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import { nextSignalId } from "./shared.js";

export const SUPPORT_PROVIDER_ID = "support";
export const SUPPORT_PROVIDER_VERSION = "1";

const SUPPORT_FILE_PATTERN = /\.(xml|sql|ya?ml|properties)$/i;

export async function collectSupportEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const anchorId = input.anchors[0]?.id ?? "A1";
  const evidence: EvidenceSignal[] = [];
  for (const absolutePath of new Set(input.existingCandidatePaths)) {
    const context = classifyPath(input.repoRoot, absolutePath);
    const relativePath = context.relativePath ?? absolutePath;
    if (context.sourceSet === "test" || SUPPORT_FILE_PATTERN.test(relativePath)) {
      evidence.push(makeSignal(input, anchorId, absolutePath, "SUPPORT_FILE", "SUPPORT", 10));
    }
    const focusMatch = Boolean(context.module && input.options.focusModules.includes(context.module));
    const keywordMatch = matchesAny(relativePath, input.options.taskKeywords);
    if (focusMatch) {
      // A focus module is an explicit caller scope, unlike a lexical keyword.
      // Its bounded TASK_CONTEXT family contribution offsets, but never waives,
      // the family ranker's cross-module penalty for multi-module tasks.
      evidence.push(makeSignal(input, anchorId, absolutePath, "FOCUS_MODULE", "TASK_CONTEXT", 55));
    }
    if (keywordMatch) {
      evidence.push(makeSignal(input, anchorId, absolutePath, "TASK_KEYWORD", "TASK_CONTEXT", 30));
    }
  }
  return {
    providerId: SUPPORT_PROVIDER_ID,
    providerVersion: SUPPORT_PROVIDER_VERSION,
    evidence,
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
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
    confidence: kind === "FOCUS_MODULE" ? 0.9 : 0.5,
    completeness: "COMPLETE",
    weight,
    sourceFile: absolutePath,
    positions: [],
    providerId: SUPPORT_PROVIDER_ID,
    providerVersion: SUPPORT_PROVIDER_VERSION,
    generation: input.generation,
    candidateMetadata: {
      categories: [kind === "SUPPORT_FILE" ? "config" : "task-context"],
      reasons: [kind === "FOCUS_MODULE"
        ? "taskContext:focusModule"
        : kind === "TASK_KEYWORD" ? "taskContext:taskKeyword" : kind],
      verifiedBy: [kind === "SUPPORT_FILE" ? kind : "taskContext"],
      matchCount: 0
    }
  };
}
