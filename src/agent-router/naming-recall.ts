import type { LayoutContext } from "../layout-probe.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor, RgPlanSection } from "../agent-types.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { executeRgPlan, type RgExecutionResult } from "./rg-execution.js";
import { buildRgPlan, type RgCommandSummary } from "./rg-plan.js";
import { timed } from "./runtime.js";

type CollectNamingRecallInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly phaseMs: Record<string, number>;
  readonly repoRoot: string;
  readonly layoutContext: LayoutContext;
  readonly concurrency: number;
  readonly loadSummary: (
    section: RgPlanSection,
    options: ImpactOptions,
    anchors: readonly ResolvedAnchor[]
  ) => Promise<RgCommandSummary>;
};

export async function collectNamingRecall(input: CollectNamingRecallInput): Promise<RgExecutionResult> {
  const rgPlan = input.anchors.flatMap(anchor => buildRgPlan({
    repoRoot: input.repoRoot,
    anchor,
    options: input.options,
    layoutContext: input.layoutContext
  }));
  const rgExecution = await timed(input.phaseMs, "rg", async () => executeRgPlan({
    plan: rgPlan,
    options: input.options,
    anchors: input.anchors,
    concurrency: input.concurrency,
    loadSummary: input.loadSummary
  }));
  for (const file of rgExecution.files) {
    mergeCandidate(input.candidates, file);
  }
  return rgExecution;
}
