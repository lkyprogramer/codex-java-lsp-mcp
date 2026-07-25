// input: Classified JDT start failures and READY stability signals.
// output: A gate that says whether a new JDT start attempt is allowed right now.
// pos: Stops a broken or misconfigured JDT from being respawned on every request.
import type { JavaIntelligenceErrorCode } from "./runtime/intelligence-error.js";

export type JdtRestartBackoffStatus = {
  consecutiveFailures: number;
  retryAfterMs?: number;
  blockedUntilExplicitReset: boolean;
  lastErrorCode?: JavaIntelligenceErrorCode;
};

export type JdtRestartBackoffGate = {
  allowed: boolean;
  retryAfterMs?: number;
  blockedUntilExplicitReset: boolean;
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

// A configuration failure will repeat identically until a human changes something,
// so it is gated until an explicit reset rather than a timer.
const CONFIG_CODES = new Set<JavaIntelligenceErrorCode>(["JDT_CONFIG_ERROR"]);

// Caller-side outcomes say nothing about JDT health and must never gate a restart.
// The four lease codes are cross-process contention (another session owns the
// worktree/machine slot, or the shared lease config is transiently unusable),
// not a signal that *this* process's JDT is unhealthy.
const IGNORED_CODES = new Set<JavaIntelligenceErrorCode>([
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "JDT_BUSY_OTHER_SESSION",
  "JDT_ORPHANED",
  "JDT_NOT_READY",
  "LEASE_CONFIG_ERROR"
]);

export class JdtRestartBackoff {
  private failures = 0;
  private nextRetryAtMs = 0;
  private blocked = false;
  private lastErrorCode?: JavaIntelligenceErrorCode;

  constructor(private readonly now: () => number = Date.now) {}

  check(): JdtRestartBackoffGate {
    if (this.blocked) return { allowed: false, blockedUntilExplicitReset: true };
    const retryAfterMs = Math.max(0, this.nextRetryAtMs - this.now());
    return retryAfterMs > 0
      ? { allowed: false, retryAfterMs, blockedUntilExplicitReset: false }
      : { allowed: true, blockedUntilExplicitReset: false };
  }

  recordFailure(code: JavaIntelligenceErrorCode): void {
    if (IGNORED_CODES.has(code)) return;
    this.lastErrorCode = code;
    if (CONFIG_CODES.has(code)) {
      this.blocked = true;
      return;
    }
    this.failures += 1;
    const delayMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, this.failures - 1));
    this.nextRetryAtMs = this.now() + delayMs;
  }

  recordReadyStarted(): void {
    // Lifecycle is READY, but failures remain until the stability window proves health.
    // A JDT that initializes and then dies immediately must keep backing off.
  }

  recordReadyStable(): void {
    this.reset();
  }

  reset(): void {
    this.failures = 0;
    this.nextRetryAtMs = 0;
    this.blocked = false;
    this.lastErrorCode = undefined;
  }

  status(): JdtRestartBackoffStatus {
    const retryAfterMs = Math.max(0, this.nextRetryAtMs - this.now());
    return {
      consecutiveFailures: this.failures,
      retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
      blockedUntilExplicitReset: this.blocked,
      lastErrorCode: this.lastErrorCode
    };
  }
}
