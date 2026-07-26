import type { SourceRootCoverage } from "./index-types.js";

// Task 21 defines the real extractorVersion format
// (schema-2|tree-sitter-<version>|tree-sitter-java-<version>|extractor-code-<buildHash>)
// and is what wires a real value into new entries; this tracker just needs
// some string until then, since SourceRootCoverage.extractorVersion isn't
// optional.
const PENDING_EXTRACTOR_VERSION = "pending";

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
      extractorVersion: this.states.get(root)?.extractorVersion ?? PENDING_EXTRACTOR_VERSION
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
      extractorVersion: entry?.extractorVersion ?? PENDING_EXTRACTOR_VERSION
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
