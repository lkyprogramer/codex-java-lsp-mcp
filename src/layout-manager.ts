// input: A repo root, reprobed on demand.
// output: The current LayoutContext plus a changed/unchanged verdict.
// pos: Cached layout for the repo runtime; refreshed only when a BUILD_CHANGE
//      event fires, not on every request.
import { layoutBuildFingerprint, probeLayout, type LayoutContext } from "./layout-probe.js";

export interface LayoutSource {
  current(): LayoutContext;
  refresh(): { changed: boolean; layout: LayoutContext };
}

export class LayoutManager implements LayoutSource {
  private value: LayoutContext;
  private fingerprint: string;

  constructor(private readonly repoRoot: string, private readonly layoutProfile = "generic-java") {
    this.value = probeLayout(repoRoot, layoutProfile);
    this.fingerprint = layoutBuildFingerprint(repoRoot);
  }

  current(): LayoutContext {
    return this.value;
  }

  refresh(): { changed: boolean; layout: LayoutContext } {
    const nextFingerprint = layoutBuildFingerprint(this.repoRoot);
    if (nextFingerprint === this.fingerprint) {
      return { changed: false, layout: this.value };
    }
    this.value = probeLayout(this.repoRoot, this.layoutProfile);
    this.fingerprint = nextFingerprint;
    return { changed: true, layout: this.value };
  }
}
