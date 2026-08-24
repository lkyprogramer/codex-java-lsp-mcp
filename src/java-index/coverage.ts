import { computeExtractorVersion } from "./build-fingerprint.js";
import type { SourceRootCoverage } from "./index-types.js";

// Process-wide and constant for this runtime's lifetime (see
// build-fingerprint.ts); computed once at module load, not per-entry.
const EXTRACTOR_VERSION = computeExtractorVersion();

// Per-source-root coverage state machine per architecture V3 §9.10: tracks
// whether a root's facts are trustworthy enough to answer a *negative*
// lookup (no code in this repo matches X) as opposed to merely offering
// positive hits.
export class CoverageTracker {
  private readonly states = new Map<string, SourceRootCoverage>();

  begin(root: string, generation: number, discoveredFiles: number): void {
    this.states.set(root, {
      root,
      generation,
      state: "BUILDING",
      discoveredFiles,
      indexedFiles: 0,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: this.states.get(root)?.extractorVersion ?? EXTRACTOR_VERSION
    });
  }

  indexed(root: string): void {
    const entry = this.states.get(root);
    if (!entry) return;
    entry.indexedFiles += 1;
  }

  recovered(root: string, _file: string, _errorCount: number): void {
    const entry = this.states.get(root);
    if (!entry) return;
    entry.indexedFiles += 1;
    entry.recoveredFiles += 1;
  }

  failed(root: string, _file: string, _error: unknown): void {
    const entry = this.states.get(root);
    if (!entry) return;
    entry.failedFiles += 1;
  }

  // Advances a root to COMPLETE at `generation`, keeping its accumulated
  // indexed/failed/recovered counts - callers that already know a root
  // stayed healthy across an incremental batch (watcher healthy, every
  // add/change/delete applied) may call this directly without a preceding
  // begin(), advancing straight to COMPLETE at the new generation rather
  // than forcing a full re-sweep after every save.
  complete(root: string, generation: number): void {
    const entry = this.states.get(root);
    if (!entry) return;
    this.states.set(root, {
      ...entry,
      generation,
      state: "COMPLETE",
      completedAt: new Date().toISOString()
    });
  }

  // Installs a persisted coverage entry (Step 6a) as provisional: forced to
  // BUILDING regardless of the state it was persisted in, keeping its
  // failed/recovered counts exactly as persisted. An identical-manifest
  // verification proves the repo's *content* has not changed since these
  // counts were recorded, so the prior parse outcome (failures included) is
  // still the current truth - a save/reload cycle must not launder a
  // recovered or failed parse into fresh negative-answer trust by zeroing
  // these. Only an explicit complete()/invalidate() call after verification
  // may advance the root out of BUILDING.
  restoreProvisional(entry: SourceRootCoverage): void {
    this.states.set(entry.root, { ...entry, state: "BUILDING" });
  }

  invalidate(root: string, generation: number): void {
    const entry = this.states.get(root);
    this.states.set(root, {
      root,
      generation,
      state: "DEGRADED",
      discoveredFiles: entry?.discoveredFiles ?? 0,
      indexedFiles: entry?.indexedFiles ?? 0,
      failedFiles: entry?.failedFiles ?? 0,
      recoveredFiles: entry?.recoveredFiles ?? 0,
      extractorVersion: entry?.extractorVersion ?? EXTRACTOR_VERSION
    });
  }

  // §9.10: negative cache only valid at COMPLETE, matching generation, with
  // zero failed and zero recovered files - a recovered parse's facts may
  // still serve positive hits, but never ground a negative conclusion.
  canAnswerNegative(root: string, generation: number): boolean {
    const entry = this.states.get(root);
    if (!entry) return false;
    return entry.state === "COMPLETE"
      && entry.generation === generation
      && entry.failedFiles === 0
      && entry.recoveredFiles === 0;
  }

  snapshot(): SourceRootCoverage[] {
    return [...this.states.values()];
  }
}
