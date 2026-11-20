// Optional request-level fields shared by the JSONL recorder and stats reader.
export const REQUEST_SCOPES = ["repo", "daemon"] as const;
export const DEADLINE_SOURCES = ["default", "explicit", "route"] as const;
export const PREPARE_OUTCOMES = ["none", "covered", "capped", "backoff", "aborted", "stopped"] as const;
export const REQUEST_STAGES = [
  "status.resolve", "status.view", "runtime.repo-resolve", "runtime.context", "runtime.index-owner",
  "request.resolve", "request.admit", "request.create", "request.prepare", "request.acquire", "request.handler"
] as const;
export const IMPACT_RESULT_KINDS = ["PLAN", "NOT_READY", "AMBIGUOUS", "NOT_FOUND", "REJECTED"] as const;

export type PrepareOutcome = typeof PREPARE_OUTCOMES[number];
export type RequestStage = typeof REQUEST_STAGES[number];
export type ImpactResultKind = typeof IMPACT_RESULT_KINDS[number];

export type RequestDiagnostics = {
  scope?: typeof REQUEST_SCOPES[number];
  effectiveDeadlineMs?: number;
  deadlineSource?: typeof DEADLINE_SOURCES[number];
  prepareMs?: number;
  prepareCapMs?: number;
  prepareOutcome?: PrepareOutcome;
  bindingVersion?: number;
  handlerRemainingMs?: number;
  failureStage?: RequestStage;
  resultKind?: ImpactResultKind;
};

export function parseRequestDiagnostics(row: Record<string, unknown>): RequestDiagnostics & { repoHash?: string } {
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => values.find(value => value === row[key]);
  const nonNegativeInt = (key: string, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    const value = row[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
  };
  const fields = {
    scope: oneOf("scope", REQUEST_SCOPES),
    repoHash: typeof row.repoHash === "string" && /^[0-9a-f]{12}$/.test(row.repoHash) ? row.repoHash : undefined,
    effectiveDeadlineMs: nonNegativeInt("effectiveDeadlineMs", 15_000),
    deadlineSource: oneOf("deadlineSource", DEADLINE_SOURCES),
    prepareMs: nonNegativeInt("prepareMs"),
    prepareCapMs: nonNegativeInt("prepareCapMs", 1_000),
    prepareOutcome: oneOf("prepareOutcome", PREPARE_OUTCOMES),
    bindingVersion: nonNegativeInt("bindingVersion"),
    handlerRemainingMs: nonNegativeInt("handlerRemainingMs", 15_000),
    failureStage: oneOf("failureStage", REQUEST_STAGES),
    resultKind: oneOf("resultKind", IMPACT_RESULT_KINDS)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
