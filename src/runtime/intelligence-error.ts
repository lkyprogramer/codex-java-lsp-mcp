// input: Failures raised by JDT LS, ripgrep, the index and request budgets.
// output: One classified error type shared by every provider boundary.
// pos: Error taxonomy; callers branch on `code`, never on message text.
export type JavaIntelligenceErrorCode =
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "JDT_NOT_READY"
  | "JDT_BROKEN"
  | "JDT_BACKOFF"
  | "JDT_BUSY_OTHER_SESSION"
  | "JDT_ORPHANED"
  | "JDT_CONFIG_ERROR"
  | "LEASE_CONFIG_ERROR"
  | "JDT_SERVER_ERROR"
  | "SEARCH_TIMEOUT"
  | "SEARCH_FAILED"
  | "INDEX_PARTIAL"
  | "INDEX_CORRUPT"
  | "OUTSIDE_REPO"
  | "INVALID_INPUT";

export class JavaIntelligenceError extends Error {
  constructor(
    readonly code: JavaIntelligenceErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message, { cause });
    this.name = "JavaIntelligenceError";
  }
}
