// input: A V6 impact payload plus a retrieval section.
// output: Additive ImpactResultV7. V6 core fields stay intact.
// pos: V5R Phase 5. Default analyze without retrieval.enabled stays on V6.
import { withConvergedCostV6 } from "./output-v6.js";
import type { ImpactResultV6, ImpactResultV7, RetrievalSectionV1 } from "../agent-types.js";

export function toAnalysisResultV7(payload: ImpactResultV6, retrieval: RetrievalSectionV1): ImpactResultV7 {
  const { version: _version, ...rest } = payload;
  const next: ImpactResultV7 = {
    ...rest,
    version: 7,
    kind: "analysis",
    retrieval
  };
  return withConvergedCostV6(next, next.cost.readBytes, next.cost.suppressedRawBytes);
}

export function toContinuationResultV7(input: {
  analysis: Pick<ImpactResultV6, "target" | "freshness" | "semantic">;
  files: ImpactResultV7["files"];
  readPlan: ImpactResultV7["readPlan"];
  retrieval: RetrievalSectionV1;
  readBytes: number;
}): ImpactResultV7 {
  const payload: ImpactResultV7 = {
    version: 7,
    kind: "continuation",
    target: input.analysis.target,
    freshness: input.analysis.freshness,
    semantic: input.analysis.semantic,
    files: input.files,
    readPlan: input.readPlan,
    evidenceGaps: [],
    cost: { resultBytes: 0, readBytes: input.readBytes, estimatedTokens: 0, suppressedRawBytes: 0 },
    retrieval: input.retrieval
  };
  return withConvergedCostV6(payload, input.readBytes, 0);
}
