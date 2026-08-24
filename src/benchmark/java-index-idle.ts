// input: The latest JavaIndex worker status during benchmark preparation.
// output: Whether foreground/background work and source-root BUILDING state have all settled.
// pos: Shared quiescence contract that prevents benchmark samples from starting before final relink/coverage publication.
import type { JavaIndexStatus } from "../java-index/index-types.js";

export function isJavaIndexQuiescent(status: JavaIndexStatus): boolean {
  return status.pendingForeground === 0
    && status.pendingBackground === 0
    && status.coverage.every(root => root.state !== "BUILDING");
}

export function areJavaSourceRootsCompleteAt(
  status: JavaIndexStatus,
  generation: number,
  roots: readonly string[]
): boolean {
  if (roots.length === 0) return false;
  const coverage = new Map(status.coverage.map(entry => [entry.root, entry]));
  return roots.every(root => {
    const entry = coverage.get(root);
    return entry?.generation === generation
      && entry.state === "COMPLETE"
      && entry.failedFiles === 0
      && entry.recoveredFiles === 0;
  });
}

export function isJavaIndexCompleteAt(status: JavaIndexStatus, generation: number): boolean {
  return status.state === "READY"
    && status.indexedGeneration === generation
    && status.lastError === undefined
    && status.snapshotVerificationPending !== true
    && status.pendingForeground === 0
    && status.pendingBackground === 0
    && status.coverage.length > 0
    && areJavaSourceRootsCompleteAt(status, generation, status.coverage.map(entry => entry.root))
    && status.resourceCoverage.every(entry =>
      entry.generation === generation
      && entry.state === "COMPLETE"
      && entry.failedFiles === 0
    );
}

export function isJavaIndexSnapshotDurableAt(status: JavaIndexStatus, generation: number): boolean {
  return isJavaIndexCompleteAt(status, generation)
    && status.snapshot?.state === "DURABLE"
    && status.snapshot.durableGeneration === generation
    && Boolean(status.snapshot.durableManifestFingerprint)
    && status.snapshotBytes > 0;
}
