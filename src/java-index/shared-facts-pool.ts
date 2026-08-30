// input: FileFacts bundles keyed by contentHash.
// output: Referentially shared immutable facts; refcount eviction at zero.
// pos: FS2(c) family-level pool. One instance per family worker process.
import type { JavaFileBundle } from "./index-types.js";

type PoolEntry = {
  bundle: JavaFileBundle;
  refs: number;
};

export class SharedFactsPool {
  private readonly entries = new Map<string, PoolEntry>();

  get size(): number {
    return this.entries.size;
  }

  estimatedBytes(): number {
    let bytes = 0;
    for (const { bundle } of this.entries.values()) {
      bytes += 128
        + bundle.file.relativePath.length * 2
        + bundle.types.length * 160
        + bundle.fields.length * 80
        + bundle.methods.length * 220
        + bundle.edges.length * 96;
    }
    return bytes;
  }

  refCount(contentHash: string): number {
    return this.entries.get(contentHash)?.refs ?? 0;
  }

  peek(contentHash: string): JavaFileBundle | undefined {
    return this.entries.get(contentHash)?.bundle;
  }

  acquire(contentHash: string, materialize: () => JavaFileBundle): JavaFileBundle {
    const hit = this.entries.get(contentHash);
    if (hit) {
      hit.refs += 1;
      return hit.bundle;
    }
    const bundle = materialize();
    this.entries.set(contentHash, { bundle, refs: 1 });
    return bundle;
  }

  release(contentHash: string): void {
    const hit = this.entries.get(contentHash);
    if (!hit) return;
    hit.refs -= 1;
    if (hit.refs <= 0) this.entries.delete(contentHash);
  }
}
