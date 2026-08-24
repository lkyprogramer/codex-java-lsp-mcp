// input: Provider outcomes produced in the fixed request pipeline order.
// output: One request-local path/outcome ledger with lazy normalized evidence.
// pos: V3.2-09 - removes duplicated after-phase state without becoming a plugin pipeline.
import type { CandidateEvidence, ProviderOutcome } from "./evidence.js";
import { normalizeEvidence } from "./evidence-normalizer.js";

export class EvidenceLedger {
  private readonly candidatePaths: Set<string>;
  private readonly providerOutcomes: ProviderOutcome[] = [];
  private normalizedMemo?: ReadonlyMap<string, CandidateEvidence>;

  constructor(
    private readonly repoRoot: string,
    seedPaths: readonly string[]
  ) {
    this.candidatePaths = new Set(seedPaths);
  }

  append(outcome: ProviderOutcome): void {
    this.providerOutcomes.push(outcome);
    for (const signal of outcome.evidence) this.candidatePaths.add(signal.candidateFile);
    this.normalizedMemo = undefined;
  }

  paths(): readonly string[] {
    return [...this.candidatePaths];
  }

  normalized(): ReadonlyMap<string, CandidateEvidence> {
    if (!this.normalizedMemo) {
      this.normalizedMemo = normalizeEvidence(
        this.providerOutcomes.flatMap(outcome => outcome.evidence),
        this.repoRoot
      );
    }
    return this.normalizedMemo;
  }

  outcomes(): readonly ProviderOutcome[] {
    return [...this.providerOutcomes];
  }
}
