// input: Candidate map, anchor, options, and JavaIndex facts.
// output: Score-sorted candidates with protected read-plan paths.
// pos: Finalize rank stage for AgentRouter (Task 22: async).
import type { RoutingPolicy } from "../routing-policy.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaMethodFact, JavaSourceFacts } from "../java-index/router-facts.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { truncateCandidateTail } from "./ranking-signals.js";
import { finalizeScore } from "./finalize-scoring.js";
import {
  candidateLimit,
  defaultReadPlanMax,
  legacyReadPlanSorted,
  selectReadPlanFiles
} from "./read-plan.js";

type FinalizeRankInput = {
  readonly candidates: ReadonlyMap<string, CandidateFile>;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly suppressed: Record<string, number>;
  readonly javaIndex: RouterIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly extraProtectedPaths?: ReadonlySet<string>;
  readonly generation?: number;
};

type NonLspReadPlanPathsInput = {
  readonly candidates: ReadonlyMap<string, CandidateFile>;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly generation?: number;
};

export async function finalizeRank(input: FinalizeRankInput): Promise<CandidateFile[]> {
  const anchorFacts = await factsFor(input.javaIndex, input.anchor.absolutePath, input.generation);
  const factsCache = new Map<string, JavaSourceFacts | undefined>();
  const methodCache = new Map<string, JavaMethodFact | undefined>();
  if (anchorFacts) factsCache.set(input.anchor.absolutePath, anchorFacts);
  const scored: CandidateFile[] = [];
  for (const candidate of input.candidates.values()) {
    if (candidate.module && input.options.excludeModules.includes(candidate.module)) {
      input.suppressed.excludedModules += 1;
      continue;
    }
    scored.push(await finalizeScore({
      candidate,
      anchor: input.anchor,
      options: input.options,
      suppressed: input.suppressed,
      anchorFacts,
      javaIndex: input.javaIndex,
      routingPolicy: input.routingPolicy,
      generation: input.generation,
      factsCache,
      methodCache
    }));
  }
  const ranked = scored.sort((left, right) =>
    right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath)
  );
  const maxItems = input.options.readPlanMaxItems ?? defaultReadPlanMax(input.options.mode);
  const sortedForPlan = legacyReadPlanSorted(ranked, input.options);
  const readPlanCovered = new Set(selectReadPlanFiles({ files: sortedForPlan, options: input.options, maxItems }));
  // An interface implementation is static JavaIndex evidence worth exposing
  // even when its lower score does not earn one of the small read-plan
  // windows.  Candidate-tail truncation must not erase that relation; callers
  // can then choose it deliberately without spending read-plan budget.
  for (const file of ranked) {
    if (file.reasons.includes("typeGraph:implementation-lookup")) {
      readPlanCovered.add(file);
    }
  }
  for (const file of ranked) {
    if (input.extraProtectedPaths?.has(file.absolutePath)) {
      readPlanCovered.add(file);
    }
  }
  return truncateCandidateTail(ranked, readPlanCovered, candidateLimit(input.options.mode, input.anchor.profile));
}

export async function nonLspReadPlanPaths(input: NonLspReadPlanPathsInput): Promise<Set<string>> {
  const suppressed = { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 };
  const ranked = await finalizeRank({ ...input, suppressed });
  const maxItems = input.options.readPlanMaxItems ?? defaultReadPlanMax(input.options.mode);
  if (input.options.semanticPolicy === "required") {
    return new Set(
      legacyReadPlanSorted(ranked, input.options)
        .slice(0, maxItems)
        .map(file => file.absolutePath)
    );
  }
  return new Set(
    selectReadPlanFiles({ files: ranked, options: input.options, maxItems })
      .map(file => file.absolutePath)
  );
}

async function factsFor(
  javaIndex: RouterIndex,
  absolutePath: string,
  generation?: number
): Promise<JavaSourceFacts | undefined> {
  try {
    return await javaIndex.factsFor(absolutePath, generation);
  } catch {
    return undefined;
  }
}
