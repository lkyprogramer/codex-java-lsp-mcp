// input: A resolved repo plus the public java_impact options and freshness state.
// output: The per-request identity, generation, freshness policy and absolute
//         budget every stage shares.
// pos: Created once per MCP request by the runtime manager's freshness barrier;
//      never rebuilt inside a provider and never stored on shared runtime state.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DeadlineBudget } from "./deadline-budget.js";

export type RequestMode = "minimal" | "balanced" | "precision" | "recall";
export type SemanticPolicy = "fast" | "auto" | "required";

export type RequestFreshnessMode =
  | "NORMAL"
  | "WATCHER_NOT_READY"
  | "WATCHER_DEGRADED"
  | "RECONCILING";

export type IndexOpenSource = "own-snapshot" | "sibling-seed" | "cold";

export type RequestContext = {
  requestId: string;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  generation: number;
  freshnessMode: RequestFreshnessMode;
  cacheReadAllowed: boolean;
  cacheWriteAllowed: boolean;
  negativeLookupAllowed: boolean;
  /** How JavaIndex was populated for this runtime (own snapshot, sibling seed, or cold). */
  indexOpenSource?: IndexOpenSource;
  mode: RequestMode;
  budget: DeadlineBudget;
  startedAtMs: number;
};

export const MAX_REQUEST_DEADLINE_MS = 15000;

export function defaultDeadlineMs(mode: RequestMode, policy: SemanticPolicy): number {
  if (policy === "required") return 5000;
  if (policy === "auto") return 3000;
  if (mode === "minimal") return 1500;
  return 2000;
}

export function createRequestContext(input: {
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  generation: number;
  freshnessMode: RequestFreshnessMode;
  cacheReadAllowed: boolean;
  cacheWriteAllowed: boolean;
  negativeLookupAllowed: boolean;
  indexOpenSource?: IndexOpenSource;
  mode: RequestMode;
  semanticPolicy: SemanticPolicy;
  deadlineMs?: number;
  budget?: DeadlineBudget;
}): RequestContext {
  const deadlineMs = Math.min(
    MAX_REQUEST_DEADLINE_MS,
    input.deadlineMs ?? defaultDeadlineMs(input.mode, input.semanticPolicy)
  );
  return {
    requestId: randomUUID(),
    repoRoot: input.repoRoot,
    repoHash: input.repoHash,
    familyHash: input.familyHash,
    generation: input.generation,
    freshnessMode: input.freshnessMode,
    cacheReadAllowed: input.cacheReadAllowed,
    cacheWriteAllowed: input.cacheWriteAllowed,
    negativeLookupAllowed: input.negativeLookupAllowed,
    indexOpenSource: input.indexOpenSource,
    mode: input.mode,
    budget: input.budget ?? DeadlineBudget.fromTimeout(deadlineMs),
    startedAtMs: performance.now()
  };
}
