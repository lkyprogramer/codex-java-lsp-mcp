import type { RoutingPolicy } from "../routing-policy.js";
import type { SourceIndex, JavaSourceFacts } from "../source-index.js";
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
  readonly sourceIndex: SourceIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly extraProtectedPaths?: ReadonlySet<string>;
};

type NonLspReadPlanPathsInput = {
  readonly candidates: ReadonlyMap<string, CandidateFile>;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly sourceIndex: SourceIndex;
  readonly routingPolicy: RoutingPolicy;
};

export function finalizeRank(input: FinalizeRankInput): CandidateFile[] {
  const anchorFacts = factsFor(input.sourceIndex, input.anchor.absolutePath);
  const ranked = [...input.candidates.values()]
    .filter(candidate => {
      if (candidate.module && input.options.excludeModules.includes(candidate.module)) {
        input.suppressed.excludedModules += 1;
        return false;
      }
      return true;
    })
    .map(candidate => finalizeScore({
      candidate,
      anchor: input.anchor,
      options: input.options,
      suppressed: input.suppressed,
      anchorFacts,
      sourceIndex: input.sourceIndex,
      routingPolicy: input.routingPolicy
    }))
    .sort((left, right) => right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  const maxItems = input.options.readPlanMaxItems ?? defaultReadPlanMax(input.options.mode);
  const sortedForPlan = legacyReadPlanSorted(ranked, input.options);
  const readPlanCovered = new Set(selectReadPlanFiles({ files: sortedForPlan, options: input.options, maxItems }));
  for (const file of ranked) {
    if (input.extraProtectedPaths?.has(file.absolutePath)) {
      readPlanCovered.add(file);
    }
  }
  return truncateCandidateTail(ranked, readPlanCovered, candidateLimit(input.options.mode, input.anchor.profile));
}

export function nonLspReadPlanPaths(input: NonLspReadPlanPathsInput): Set<string> {
  const suppressed = { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 };
  const ranked = finalizeRank({ ...input, suppressed });
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

function factsFor(sourceIndex: SourceIndex, absolutePath: string): JavaSourceFacts | undefined {
  try {
    return sourceIndex.factsFor(absolutePath);
  } catch {
    return undefined;
  }
}
