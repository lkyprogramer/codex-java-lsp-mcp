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

/**
 * Classifies a semantic failure. Every caught error used to be reported as a
 * timeout, which hid genuine JDT faults and made backoff decisions wrong.
 */
export function classifySemanticError(error: unknown): JavaIntelligenceError {
  if (error instanceof JavaIntelligenceError) return error;
  const record = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error);

  if (name === "AbortError" || code === "ABORT_ERR" || code === "ERR_CANCELED") {
    return new JavaIntelligenceError("CANCELLED", message, error);
  }
  if (code === "ETIMEDOUT" || /timed out|deadline exceeded/i.test(message)) {
    return new JavaIntelligenceError("DEADLINE_EXCEEDED", message, error);
  }
  if (/not started|not ready/i.test(message)) {
    return new JavaIntelligenceError("JDT_NOT_READY", message, error);
  }
  if (/connection.*closed|process.*exit|broken pipe|EPIPE/i.test(message)) {
    return new JavaIntelligenceError("JDT_BROKEN", message, error);
  }
  return new JavaIntelligenceError("JDT_SERVER_ERROR", message, error);
}

/** True when the failure says nothing about JDT health. */
export function isExpectedSemanticOutcome(code: JavaIntelligenceErrorCode): boolean {
  return code === "DEADLINE_EXCEEDED"
    || code === "CANCELLED"
    || code === "JDT_BACKOFF"
    || code === "JDT_NOT_READY"
    || code === "JDT_CONFIG_ERROR";
}
