// input: Search results keyed by query and repo generation.
// output: Only whole searches, and only for the generation they were taken at.
// pos: The single place rg results may be reused; partial output must never land here.
import { isCacheableCompletion } from "../runtime/completion.js";
import type { SearchResult } from "./search-types.js";

type CacheEntry = {
  generation: number;
  expiresAt: number;
  result: SearchResult;
};

export class GenerationRgCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, generation: number): SearchResult | undefined {
    const item = this.entries.get(key);
    if (!item || item.generation !== generation || item.expiresAt <= Date.now()) {
      if (item) this.entries.delete(key);
      return undefined;
    }
    return item.result;
  }

  set(key: string, generation: number, result: SearchResult): void {
    // A timed-out or truncated search is indistinguishable from "no such code"
    // once cached, so it is dropped rather than stored.
    if (!isCacheableCompletion(result.completion) || this.ttlMs <= 0) return;
    this.entries.set(key, {
      generation,
      expiresAt: Date.now() + this.ttlMs,
      result
    });
  }

  invalidateBefore(generation: number): void {
    for (const [key, value] of this.entries) {
      if (value.generation < generation) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
