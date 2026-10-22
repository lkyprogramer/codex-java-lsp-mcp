// input: snapshots the owner published, or restored, without a verdict.
// output: VERIFIED / FAILED verdicts (snapshot-store verifySnapshot); a failure reported with the workspaces it took out of service.
// pos: MAC-12 plan B, contract §2.7: the full integrity check and file digest leave the edit-visible
//      publish path. One snapshot at a time on one reader, after a quiet delay, so an edit storm does
//      not pay a full-database check per publish: a snapshot that is no longer served is skipped, and
//      one being checked when a newer publish replaces it is stopped at its next table.
import type { SnapshotStore, VerifyResult } from "./snapshot-store.js";

export type VerificationEvent = {
  type: "verification";
  snapshotId: string;
  outcome: "verified" | "failed" | "skipped" | "aborted" | "error";
  elapsedMs: number;
  error?: string;
  /** FAILED: the workspaces whose binding was quarantined. */
  quarantined?: string[];
};

export type SnapshotVerifierOptions = {
  /** Quiet time after the last enqueue before a check starts (default VERIFY_DELAY_MS). */
  delayMs?: number;
  /** Readers per check (default 1: the background check never takes the publish path's workers). */
  workers?: number;
  onEvent?: (event: VerificationEvent) => void;
  /** A FAILED verdict quarantined these workspaces: they rebuild in full. */
  onFailed?: (workspaceIds: string[]) => void;
  /** A check ended (its verify lease is released). */
  onSettled?: () => void;
};

export const VERIFY_DELAY_MS = 2_000;
/** A check that ended without a verdict for another reason than an abort is retried this much later. */
export const VERIFY_RETRY_MS = 30_000;

export class SnapshotVerifier {
  private readonly pending = new Set<string>();
  private current?: { snapshotId: string; controller: AbortController; done: Promise<void> };
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly store: SnapshotStore, private readonly options: SnapshotVerifierOptions = {}) {}

  /** Check `snapshotId` once it has been quiet; a check of a snapshot no longer served stops. */
  enqueue(snapshotId: string): void {
    if (this.stopped) return;
    this.pending.add(snapshotId);
    if (this.current && !this.wanted(this.current.snapshotId)) this.current.controller.abort(new Error("superseded"));
    this.arm();
  }

  status() {
    return { pending: [...this.pending], current: this.current?.snapshotId };
  }

  /** No new check starts; a running one stops at its next table and its readers exit before this resolves. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.current?.controller.abort(new Error("stopped"));
    await this.current?.done;
  }

  /** Served and without a verdict. */
  private wanted(snapshotId: string): boolean {
    return this.store.isBound(snapshotId) && !this.store.verification(snapshotId);
  }

  private arm(): void {
    if (this.stopped || this.current) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.next(); }, this.options.delayMs ?? VERIFY_DELAY_MS);
    this.timer.unref?.();
  }

  private next(): void {
    if (this.stopped || this.current) return;
    for (const snapshotId of this.pending) {
      this.pending.delete(snapshotId);
      if (!this.wanted(snapshotId)) {
        this.emit({ type: "verification", snapshotId, outcome: "skipped", elapsedMs: 0 });
        continue;
      }
      const controller = new AbortController();
      const started = performance.now();
      const done = this.store.verifySnapshot(snapshotId, { workers: this.options.workers ?? 1, signal: controller.signal })
        .then((result: VerifyResult) => {
          const elapsedMs = performance.now() - started;
          if (result.result === "VERIFIED") this.emit({ type: "verification", snapshotId, outcome: "verified", elapsedMs });
          else {
            this.emit({ type: "verification", snapshotId, outcome: "failed", elapsedMs, error: result.error, quarantined: result.quarantined });
            if (result.quarantined.length) this.options.onFailed?.(result.quarantined);
          }
        }, (error: unknown) => {
          // Aborted (superseded, stop) or a store error (lease refused, record write): no verdict, the snapshot stays unverified.
          const aborted = controller.signal.aborted;
          this.emit({ type: "verification", snapshotId, outcome: aborted ? "aborted" : "error",
            elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
          if (!aborted) setTimeout(() => this.enqueue(snapshotId), VERIFY_RETRY_MS).unref?.();
        })
        .finally(() => {
          this.current = undefined;
          this.options.onSettled?.();
          if (this.pending.size) this.arm();
        });
      this.current = { snapshotId, controller, done };
      return;
    }
  }

  private emit(event: VerificationEvent): void {
    try { this.options.onEvent?.(event); } catch { /* telemetry never stops verification */ }
  }
}
