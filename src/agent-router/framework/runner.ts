// input: A registry of FrameworkAdapters plus one request's FrameworkAdapterContext.
// output: One merged ProviderOutcome (ready to slot into index.ts's outcomes array with zero
//         special-casing) plus side-channel metadata/diagnostics per adapter.
// pos: Task 27 Slice C - generic runner; registers/runs adapters, never interprets their output.
import type { Completion } from "../../runtime/completion.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import type { ProviderOutcome } from "../evidence.js";
import type { FrameworkAdapter, FrameworkAdapterContext, FrameworkAdapterMetadata } from "./adapter.js";
import { createFrameworkPreflight } from "./shared.js";

export const FRAMEWORK_PROVIDER_ID = "framework";
export const FRAMEWORK_PROVIDER_VERSION = "1";

/** A traversal seed larger than this is a candidate-discovery problem upstream, not something an adapter should pay to scan per request. */
export const MAX_FRAMEWORK_TRAVERSAL_FILES = 200;

export type FrameworkRunResult = {
  outcome: ProviderOutcome;
  /** Keyed by adapter id - only adapters that were active and ran successfully contribute an entry. */
  metadata: Record<string, FrameworkAdapterMetadata>;
  diagnostics: string[];
};

/**
 * Adapters often need the same bounded whole-file facts for activation and
 * collection.  Preserve the index boundary, but reuse an identical request
 * within this router invocation so framework packs do not pay duplicate
 * worker serialization/deserialization cost.  A rejected query is evicted:
 * an adapter's fail-soft retry opportunity must remain independent.
 */
function requestMemoizedFrameworkFacts(index: FrameworkIndexView) {
  const factsByRequest = new Map<string, Promise<Awaited<ReturnType<FrameworkIndexView["frameworkFactsForFiles"]>>>>();
  return (files: readonly string[], generation?: number) => {
    const key = `${generation ?? ""}\0${files.join("\0")}`;
    const cached = factsByRequest.get(key);
    if (cached) return cached;
    const request = index.frameworkFactsForFiles(files, generation);
    factsByRequest.set(key, request);
    void request.catch(() => factsByRequest.delete(key));
    return request;
  };
}

// Completion vocabulary has no inherent order; this is the runner's own
// "how whole is the merged result" ranking, worst first, used only to fold
// multiple adapters'/stages' completions into one.
const COMPLETION_SEVERITY: Record<Completion, number> = {
  FAILED: 0,
  CANCELLED: 1,
  PARTIAL_TIMEOUT: 2,
  PARTIAL_LIMIT: 3,
  COMPLETE: 4
};

function worseCompletion(left: Completion, right: Completion): Completion {
  return COMPLETION_SEVERITY[left] <= COMPLETION_SEVERITY[right] ? left : right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs every registered adapter against one bounded context, fail-soft: an
 * adapter that throws is logged and never fails the request - one broken
 * framework pack must not take down candidate discovery for every other
 * evidence source. Activation failures run the bounded collector
 * conservatively, because skipping would turn an unknown framework state into
 * a false negative. A
 * deadline check before each adapter stops the loop early (not mid-adapter;
 * an adapter's own collect() is responsible for respecting the same budget
 * internally, same convention as every other provider in this codebase) and
 * marks the merged result PARTIAL_TIMEOUT rather than silently returning
 * whatever ran before the cutoff as if it were complete.
 */
export async function runFrameworkAdapters(
  adapters: readonly FrameworkAdapter[],
  context: FrameworkAdapterContext
): Promise<FrameworkRunResult> {
  const startedAt = Date.now();
  if (adapters.length === 0) {
    return {
      outcome: {
        providerId: FRAMEWORK_PROVIDER_ID,
        providerVersion: FRAMEWORK_PROVIDER_VERSION,
        evidence: [],
        completion: "COMPLETE",
        elapsedMs: Date.now() - startedAt
      },
      metadata: {},
      diagnostics: []
    };
  }
  const preflight = createFrameworkPreflight(context.frameworkIndex);
  const boundedContext: FrameworkAdapterContext = {
    ...context,
    preflight,
    requestFrameworkFactsForFiles: requestMemoizedFrameworkFacts(context.frameworkIndex),
    candidateFiles: context.candidateFiles.slice(0, MAX_FRAMEWORK_TRAVERSAL_FILES),
    staticEvidence: context.staticEvidence.filter(candidate =>
      context.candidateFiles.slice(0, MAX_FRAMEWORK_TRAVERSAL_FILES).includes(candidate.file))
  };
  const evidence: ProviderOutcome["evidence"] = [];
  const metadata: Record<string, FrameworkAdapterMetadata> = {};
  const diagnostics: string[] = [];
  let completion: Completion = "COMPLETE";

  for (const adapter of adapters) {
    if (context.budget.expired()) {
      completion = worseCompletion(completion, "PARTIAL_TIMEOUT");
      diagnostics.push(`framework adapter runner: deadline exhausted before adapter "${adapter.id}" ran`);
      break;
    }
    let active: boolean;
    try {
      active = await adapter.isActive(boundedContext);
    } catch (error) {
      diagnostics.push(`framework adapter "${adapter.id}" isActive() threw: ${errorMessage(error)}`);
      completion = worseCompletion(completion, "FAILED");
      active = !context.budget.expired();
      if (active) {
        diagnostics.push(`framework adapter "${adapter.id}" is running conservatively after activation failure`);
      }
    }
    if (context.budget.expired()) {
      completion = worseCompletion(completion, "PARTIAL_TIMEOUT");
      diagnostics.push(`framework adapter runner: deadline exhausted while adapter "${adapter.id}" was activating`);
      break;
    }
    if (!active) continue;
    try {
      const result = await adapter.collect(boundedContext);
      evidence.push(...result.outcome.evidence);
      metadata[adapter.id] = result.metadata;
      diagnostics.push(...result.diagnostics);
      completion = worseCompletion(completion, result.outcome.completion);
    } catch (error) {
      diagnostics.push(`framework adapter "${adapter.id}" collect() threw: ${errorMessage(error)}`);
      completion = worseCompletion(completion, "FAILED");
    }
  }

  if (preflight.statusUnavailable()) {
    completion = worseCompletion(completion, "FAILED");
  }
  diagnostics.push(...preflight.diagnostics());

  return {
    outcome: {
      providerId: FRAMEWORK_PROVIDER_ID,
      providerVersion: FRAMEWORK_PROVIDER_VERSION,
      evidence,
      completion,
      elapsedMs: Date.now() - startedAt
    },
    metadata,
    diagnostics
  };
}
