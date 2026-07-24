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
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new JavaIntelligenceError(
          "DEADLINE_EXCEEDED",
          `Deadline exceeded during ${stage} after ${timeoutMs}ms`
        ));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
