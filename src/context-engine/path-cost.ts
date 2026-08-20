// input: A candidate graph edge plus hop/module/obligation context.
// output: Additive path cost used by bounded beam search. Lower is better.
// pos: N3-02. Deterministic; no learned weights.
import type { EdgeKind } from "../java-knowledge/edge-kinds.js";

const RELATION_PRIOR: Partial<Record<EdgeKind, number>> = {
  CALLS_EXACT: 1,
  CALLED_BY: 1.1,
  DISPATCHES_TO: 1.2,
  CALLS_VIRTUAL: 1.3,
  IMPLEMENTS: 1.1,
  EXTENDS: 1.2,
  SPRING_INJECTS: 1.15,
  PUBLISHES_EVENT: 1.2,
  CONSUMES_EVENT: 1.2,
  MYBATIS_METHOD_BINDS_STATEMENT: 1.05,
  REPOSITORY_MANAGES_ENTITY: 1.05,
  CONTAINS: 1.8,
  IMPORTS: 2.2,
  MODULE_DEPENDS_ON: 2.4
};

export type PathCostInput = {
  kind: EdgeKind;
  hop: number;
  crossModule: boolean;
  closesObligation: boolean;
  lexicalMatch: boolean;
};

export function pathCost(input: PathCostInput): number {
  const relation = RELATION_PRIOR[input.kind] ?? 1.6;
  const hopPenalty = input.hop * 0.35;
  const modulePenalty = input.crossModule ? 0.4 : 0;
  const obligationBonus = input.closesObligation ? -0.8 : 0;
  const lexicalBonus = input.lexicalMatch ? -0.3 : 0;
  return relation + hopPenalty + modulePenalty + obligationBonus + lexicalBonus;
}
