// input: ProviderInput (carries frameworkIndex - a FrameworkIndexView bound to this request's generation).
// output: FrameworkCollectResult - the outcome slots into index.ts's outcomes array unchanged;
//         metadata/diagnostics are a request-scoped side channel index.ts holds aside (Task 31 decides
//         external exposure).
// pos: Task 27 Slice C - the registry is empty until Slice D registers the Spring pack, so production
//      behavior is unchanged by this file alone: this is the wiring, not the framework knowledge.
import type { FrameworkAdapter, FrameworkCollectResult } from "../framework/adapter.js";
import { runFrameworkAdapters } from "../framework/runner.js";
import type { ProviderInput } from "../evidence.js";

/** Populated by each framework pack (Slice D's Spring pack, later Task 28/29) - empty here by design. */
export const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [];

export async function collectFrameworkEvidence(
  input: ProviderInput,
  adapters: readonly FrameworkAdapter[] = FRAMEWORK_ADAPTERS
): Promise<FrameworkCollectResult> {
  if (adapters.length === 0) {
    return {
      outcome: {
        providerId: "framework",
        providerVersion: "1",
        evidence: [],
        candidates: [],
        completion: "COMPLETE",
        elapsedMs: 0
      },
      metadata: {},
      diagnostics: []
    };
  }
  return runFrameworkAdapters(adapters, {
    repoRoot: input.repoRoot,
    anchors: input.anchors,
    candidateFiles: input.existingCandidatePaths,
    frameworkIndex: input.frameworkIndex,
    generation: input.generation,
    budget: input.budget
  });
}
