// input: session-level idle-prewarm lifecycle events.
// output: Hit-rate aggregates: prewarmed count, delay to first real semantic
//         request, and the fraction of prewarms that were never queried.
// pos: V4-11. Production opt-in prewarm stays default-off; this tracker is the
//      measurement surface the trial gate reads.

export type IdlePrewarmSnapshot = {
  prewarmedSessions: number;
  firstSemanticDelayMs: number[];
  neverQueried: number;
  queriedAfterPrewarm: number;
  neverQueriedFraction: number;
};

type SessionRecord = {
  prewarmedAtMs: number;
  firstSemanticAtMs?: number;
};

export class IdlePrewarmTracker {
  private readonly sessions = new Map<string, SessionRecord>();

  recordPrewarm(sessionId: string, nowMs = Date.now()): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { prewarmedAtMs: nowMs });
  }

  recordFirstSemanticRequest(sessionId: string, nowMs = Date.now()): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.firstSemanticAtMs !== undefined) return;
    record.firstSemanticAtMs = nowMs;
  }

  recordSessionClosed(sessionId: string): void {
    // Closing is observed through snapshot(); keep the record so never-queried
    // sessions remain visible until the caller snapshots and forgets them.
    void sessionId;
  }

  snapshot(): IdlePrewarmSnapshot {
    const firstSemanticDelayMs: number[] = [];
    let neverQueried = 0;
    let queriedAfterPrewarm = 0;
    for (const record of this.sessions.values()) {
      if (record.firstSemanticAtMs === undefined) {
        neverQueried += 1;
        continue;
      }
      queriedAfterPrewarm += 1;
      firstSemanticDelayMs.push(Math.max(0, record.firstSemanticAtMs - record.prewarmedAtMs));
    }
    const prewarmedSessions = this.sessions.size;
    return {
      prewarmedSessions,
      firstSemanticDelayMs,
      neverQueried,
      queriedAfterPrewarm,
      neverQueriedFraction: prewarmedSessions === 0 ? 0 : neverQueried / prewarmedSessions
    };
  }

  reset(): void {
    this.sessions.clear();
  }
}

export const idlePrewarmTracker = new IdlePrewarmTracker();
