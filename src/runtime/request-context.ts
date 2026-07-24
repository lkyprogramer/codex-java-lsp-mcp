// input: A resolved repo plus the public java_impact options.
// output: The per-request identity, generation and absolute budget every stage shares.
// pos: Created once per MCP request; never rebuilt inside a provider.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DeadlineBudget } from "./deadline-budget.js";

export type RequestMode = "minimal" | "balanced" | "precision" | "recall";
export type SemanticPolicy = "fast" | "auto" | "required";

export type RequestContext = {
  requestId: string;
  repoRoot: string;
  repoHash: string;
  generation: number;
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
  generation: number;
  mode: RequestMode;
  semanticPolicy: SemanticPolicy;
  deadlineMs?: number;
}): RequestContext {
  const deadlineMs = Math.min(
    MAX_REQUEST_DEADLINE_MS,
    input.deadlineMs ?? defaultDeadlineMs(input.mode, input.semanticPolicy)
  );
  return {
    requestId: randomUUID(),
    repoRoot: input.repoRoot,
    repoHash: input.repoHash,
    generation: input.generation,
    mode: input.mode,
    budget: DeadlineBudget.fromTimeout(deadlineMs),
    startedAtMs: performance.now()
  };
}
