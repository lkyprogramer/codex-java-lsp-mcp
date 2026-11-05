import { performance } from "node:perf_hooks";

// T07: the query work budget bounds physical query work (posting rows
// visited), NOT the number of returned rows. The remaining-time source is
// owned by the caller (parent deadline); synchronous SQLite cannot hard-stop
// mid-statement, so deadlines are honored only at the interruptible
// boundary between posting rows.
export class QueryWorkBudget {
  private used = 0;

  constructor(
    readonly maxPostings: number,
    private readonly remainingMs: () => number
  ) {
    if (!Number.isInteger(maxPostings) || maxPostings < 1) {
      throw new Error("invalid work limit");
    }
  }

  take(): "ok" | "deadline" | "postings" {
    if (this.remainingMs() <= 0) return "deadline";
    if (this.used >= this.maxPostings) return "postings";
    this.used += 1;
    return "ok";
  }

  /** R09: the absolute deadline, checked at every stage/row boundary. */
  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  remaining(): number {
    return this.remainingMs();
  }

  visited(): number {
    return this.used;
  }
}

/**
 * R09: one entry per query stage (lookup, postings, rank, merge, locators,
 * preview). Times are milliseconds since the request's trace started;
 * `remainingMs` is the deadline left when the stage ended (null without a
 * deadline); `visited` counts the rows that stage touched.
 */
export type QueryStageTrace = {
  operation: string;
  beginMs: number;
  endMs: number;
  remainingMs: number | null;
  visited: number;
};

export class QueryTrace {
  readonly stages: QueryStageTrace[] = [];
  private readonly origin: number;

  constructor(
    private readonly remainingMs?: () => number,
    private readonly now: () => number = () => performance.now()
  ) {
    this.origin = now();
  }

  /** Opens a stage; the returned callback closes it with the rows visited. */
  start(operation: string): (visited: number) => void {
    const beginMs = this.now() - this.origin;
    return visited => this.record(operation, beginMs, visited);
  }

  /** Runs `fn` as one stage; `fn` reports the rows it visited. */
  stage<T>(operation: string, fn: () => { value: T; visited: number }): T {
    const end = this.start(operation);
    const { value, visited } = fn();
    end(visited);
    return value;
  }

  async stageAsync<T>(operation: string, fn: () => Promise<{ value: T; visited: number }>): Promise<T> {
    const end = this.start(operation);
    const { value, visited } = await fn();
    end(visited);
    return value;
  }

  private record(operation: string, beginMs: number, visited: number): void {
    const endMs = this.now() - this.origin;
    const remaining = this.remainingMs ? this.remainingMs() : undefined;
    this.stages.push({
      operation,
      beginMs: round3(beginMs),
      endMs: round3(endMs),
      remainingMs: remaining === undefined || !Number.isFinite(remaining) ? null : round3(Math.max(0, remaining)),
      visited
    });
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
