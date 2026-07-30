// input: ProviderInput (carries frameworkIndex - a FrameworkIndexView bound to this request's generation).
// output: FrameworkCollectResult - the outcome slots into index.ts's outcomes array unchanged;
//         metadata/diagnostics are a request-scoped side channel index.ts holds aside (Task 31 decides
//         external exposure).
// pos: Task 27 Slice D registration commit. This is the first commit where framework evidence reaches
//      production ranking on every request (not just Spring repos): frameworkOutcome stops being
//      permanently empty, afterFrameworkPaths in index.ts starts diverging from afterStaticPaths, and
//      framework-category candidates start consuming read-plan-budget.ts's "verified" quota alongside
//      JDT-exact/semantic-definition evidence (that classification was Slice C's own deliberate design,
//      not new here - see read-plan-budget.ts's evidenceClassOf comment - but this commit is what makes
//      it fire on a real repo for the first time). The three-repo P95/recall gate has NOT been run
//      against this change in this environment (EPERM-blocked from the golden repos) - it is required
//      before Task 27 is considered closed, specifically to check whether SPRING_INJECTION (weight 90)
//      and SPRING_CALL_PATH (weight 100) crowd real JDT-verified evidence out of the verified quota on
//      a DI-heavy Spring repo.
import type { FrameworkAdapter, FrameworkCollectResult } from "../framework/adapter.js";
import { runFrameworkAdapters } from "../framework/runner.js";
import { springAdapter } from "../framework/spring-adapter.js";
import type { ProviderInput } from "../evidence.js";

/** Every registered framework pack (Slice D's Spring pack; later Task 28/29 append theirs here). */
export const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [springAdapter];

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
