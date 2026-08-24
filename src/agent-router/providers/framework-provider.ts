// input: ProviderInput (carries frameworkIndex - a FrameworkIndexView bound to this request's generation).
// output: FrameworkCollectResult - the outcome slots into index.ts's outcomes array unchanged;
//         metadata/diagnostics are a request-scoped side channel index.ts holds aside (Task 31 decides
//         external exposure).
// pos: Task 27 Slice D registered springAdapter here - the first commit where framework evidence
//      reaches production ranking on every request (not just Spring repos): frameworkOutcome stops
//      being permanently empty, afterFrameworkPaths in index.ts starts diverging from
//      afterStaticPaths, and framework-category candidates start consuming read-plan-budget.ts's
//      "verified" quota alongside JDT-exact/semantic-definition evidence for SPRING_CALL_PATH
//      (that classification is Slice C's own deliberate design - see read-plan-budget.ts's
//      evidenceClassOf comment). Task 28 Slice D added mybatisAdapter here, extending the same
//      "verified" quota to MYBATIS_NAMESPACE/MYBATIS_STATEMENT_METHOD. Both packs' isActive() calls
//      run unconditionally whenever frameworkStatus().coverage !== "complete", so a repo using
//      neither framework still pays two repositoryFactMarkers() scans per request instead of one -
//      each is a single early-exiting in-process pass over the store, cached for the rest of the
//      generation, not an added IPC round trip. Three-repo quality and latency are release-gated by
//      the source-locked paired matrix; provider-specific attribution remains a separate reporting
//      concern so an aggregate framework result is not mistaken for proof of one adapter's value.
import type { FrameworkAdapter, FrameworkCollectResult } from "../framework/adapter.js";
import { runFrameworkAdapters } from "../framework/runner.js";
import { mapstructAdapter } from "../framework/mapstruct-adapter.js";
import { mybatisAdapter } from "../framework/mybatis-adapter.js";
import { springAdapter } from "../framework/spring-adapter.js";
import type { CandidateEvidence, ProviderInput } from "../evidence.js";

/** Every registered framework pack (Task 27 Slice D's Spring pack, Task 28 Slice D's MyBatis pack; later Task 29 appends theirs here). */
export const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [springAdapter, mybatisAdapter, mapstructAdapter];

export async function collectFrameworkEvidence(
  input: ProviderInput,
  adapters: readonly FrameworkAdapter[] = FRAMEWORK_ADAPTERS,
  staticEvidence: readonly CandidateEvidence[] = []
): Promise<FrameworkCollectResult> {
  if (adapters.length === 0) {
    return {
      outcome: {
        providerId: "framework",
        providerVersion: "1",
        evidence: [],
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
    staticEvidence,
    frameworkIndex: input.frameworkIndex,
    generation: input.generation,
    budget: input.budget
  });
}
