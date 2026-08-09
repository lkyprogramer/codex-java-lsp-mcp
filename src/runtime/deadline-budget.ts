// input: A per-request absolute timeout.
// output: Remaining-time arithmetic every stage must clamp itself to.
// pos: Replaces independent per-stage timeouts whose worst case was their sum.
import { performance } from "node:perf_hooks";
import { JavaIntelligenceError } from "./intelligence-error.js";

export type MonotonicNow = () => number;

export class DeadlineBudget {
  private constructor(
    readonly deadlineAtMs: number,
    private readonly now: MonotonicNow
  ) {}

  static fromTimeout(
    timeoutMs: number,
    now: MonotonicNow = () => performance.now()
  ): DeadlineBudget {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JavaIntelligenceError("INVALID_INPUT", "timeoutMs must be positive");
    }
    return new DeadlineBudget(now() + timeoutMs, now);
  }

  remainingMs(capMs = Number.MAX_SAFE_INTEGER): number {
    return Math.max(0, Math.min(capMs, Math.ceil(this.deadlineAtMs - this.now())));
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /**
   * Derive a child budget that can use at most `capMs` while preserving a
   * reserved tail of the parent request for mandatory finalization. The child
   * shares the parent's monotonic clock and can never outlive its absolute
   * deadline; unlike rebuilding from `remainingMs()`, it cannot accidentally
   * extend the request between stages.
   */
  forStage(capMs: number, reserveMs = 0): DeadlineBudget {
    if (!Number.isFinite(capMs) || capMs <= 0) {
      throw new JavaIntelligenceError("INVALID_INPUT", "stage capMs must be positive");
    }
    if (!Number.isFinite(reserveMs) || reserveMs < 0) {
      throw new JavaIntelligenceError("INVALID_INPUT", "stage reserveMs must be non-negative");
    }
    const nowMs = this.now();
    const deadlineAtMs = Math.max(
      nowMs,
      Math.min(nowMs + capMs, this.deadlineAtMs - reserveMs)
    );
    return new DeadlineBudget(deadlineAtMs, this.now);
  }

  throwIfExpired(stage: string): void {
    if (this.expired()) {
      throw new JavaIntelligenceError(
        "DEADLINE_EXCEEDED",
        `Deadline exceeded before ${stage}`
      );
    }
  }

  async race<T>(
    stage: string,
    operation: Promise<T>,
    capMs = Number.MAX_SAFE_INTEGER,
    onTimeout?: () => void
  ): Promise<T> {
    const timeoutMs = this.remainingMs(capMs);
    if (timeoutMs <= 0) {
      onTimeout?.();
      throw new JavaIntelligenceError(
        "DEADLINE_EXCEEDED",
        `Deadline exceeded before ${stage}`
      );
    }
    let timer: NodeJS.Timeout | undefined;
    // Deliberately not unref'd. Some raced operations (an in-process slot
    // waiter, for example) hold nothing else open, and an unref'd timer would
    // let the process exit instead of delivering the deadline rejection. The
    // finally below always clears it, so it never outlives the race.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new JavaIntelligenceError(
          "DEADLINE_EXCEEDED",
          `Deadline exceeded during ${stage} after ${timeoutMs}ms`
        ));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
