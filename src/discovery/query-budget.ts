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

  visited(): number {
    return this.used;
  }
}