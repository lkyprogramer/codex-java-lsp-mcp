// input: The latest JavaIndex worker status during benchmark preparation.
// output: Whether foreground/background work and source-root BUILDING state have all settled.
// pos: Shared quiescence contract that prevents benchmark samples from starting before final relink/coverage publication.
import type { JavaIndexStatus } from "../java-index/index-types.js";

export function isJavaIndexQuiescent(status: JavaIndexStatus): boolean {
  return status.pendingForeground === 0
    && status.pendingBackground === 0
    && status.coverage.every(root => root.state !== "BUILDING");
}
