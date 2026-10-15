/**
 * A bounded memo that approximates LRU in O(1) per access: entries enter a
 * young generation, a hit in the old one promotes the entry, and when the
 * young generation fills the old one is dropped whole. It holds between
 * limit/2 and limit entries. Eviction only costs hits, never correctness:
 * callers store values that stay valid until they delete or clear them.
 */
export class BoundedCache<K, V> {
  private young = new Map<K, V>();
  private old = new Map<K, V>();
  private readonly half: number;

  constructor(limit: number) {
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  get(key: K): V | undefined {
    const hit = this.young.get(key);
    if (hit !== undefined) return hit;
    const aged = this.old.get(key);
    if (aged !== undefined) this.set(key, aged);
    return aged;
  }

  set(key: K, value: V): void {
    this.young.set(key, value);
    if (this.young.size >= this.half) {
      this.old = this.young;
      this.young = new Map();
    }
  }

  delete(key: K): void {
    this.young.delete(key);
    this.old.delete(key);
  }

  clear(): void {
    this.young = new Map();
    this.old = new Map();
  }

  get size(): number {
    let size = this.young.size;
    for (const key of this.old.keys()) if (!this.young.has(key)) size += 1;
    return size;
  }
}
