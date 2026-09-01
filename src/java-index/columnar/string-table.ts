// input: Dynamic JavaIndex strings (paths, FQNs, composite ids).
// output: u32 handles into one UTF-8 buffer. get() memoizes one JS string per handle.
// pos: M1 P1 string table. V8 does not intern dynamically built ids.

const EMPTY = 0;
const EMPTY_SLOT = 0xffffffff;
export const STRING_TABLE_INITIAL_BYTES = 1 << 16;
const STRING_TABLE_INITIAL_HANDLES = 1024;
const STRING_TABLE_INITIAL_BUCKETS = 2048;

export type U8 = Uint8Array<ArrayBufferLike>;
export type U32 = Uint32Array<ArrayBufferLike>;

export class StringTable {
  private bytes = Buffer.allocUnsafe(STRING_TABLE_INITIAL_BYTES);
  private used = 0;
  private offsets: U32 = new Uint32Array(STRING_TABLE_INITIAL_HANDLES);
  private lengths: U32 = new Uint32Array(STRING_TABLE_INITIAL_HANDLES);
  private count = 1; // handle 0 is the empty string
  private buckets: U32 = new Uint32Array(STRING_TABLE_INITIAL_BUCKETS).fill(EMPTY_SLOT);
  private memo: Array<string | undefined> = [""];

  get size(): number {
    return this.count;
  }

  byteSize(): number {
    return this.bytes.byteLength + this.offsets.byteLength + this.lengths.byteLength + this.buckets.byteLength;
  }

  allocatedPayloadBytes(): number {
    return this.bytes.byteLength;
  }

  intern(value: string): number {
    if (value.length === 0) return EMPTY;
    const encoded = Buffer.from(value, "utf8");
    const hash = hashBytes(encoded);
    const existing = this.lookup(encoded, hash);
    if (existing !== undefined) return existing;
    this.ensureBytes(encoded.byteLength);
    const handle = this.count;
    if (handle >= this.offsets.length) {
      this.offsets = growU32(this.offsets, handle + 1);
      this.lengths = growU32(this.lengths, handle + 1);
    }
    this.offsets[handle] = this.used;
    this.lengths[handle] = encoded.byteLength;
    encoded.copy(this.bytes, this.used);
    this.used += encoded.byteLength;
    this.memo[handle] = value;
    this.count += 1;
    this.maybeRehash();
    this.place(handle, hash);
    return handle;
  }

  get(handle: number): string {
    const memoized = this.memo[handle];
    if (memoized !== undefined) return memoized;
    if (handle === EMPTY) return "";
    if (handle <= 0 || handle >= this.count) throw new Error(`invalid string handle ${handle}`);
    const text = this.bytes.toString("utf8", this.offsets[handle], this.offsets[handle]! + this.lengths[handle]!);
    this.memo[handle] = text;
    return text;
  }

  interned(value: string): string {
    return this.get(this.intern(value));
  }

  clear(): void {
    this.bytes = Buffer.allocUnsafe(STRING_TABLE_INITIAL_BYTES);
    this.used = 0;
    this.offsets = new Uint32Array(STRING_TABLE_INITIAL_HANDLES);
    this.lengths = new Uint32Array(STRING_TABLE_INITIAL_HANDLES);
    this.count = 1;
    this.buckets = new Uint32Array(STRING_TABLE_INITIAL_BUCKETS).fill(EMPTY_SLOT);
    this.memo = [""];
  }

  private lookup(encoded: Buffer, hash: number): number | undefined {
    const mask = this.buckets.length - 1;
    let slot = hash & mask;
    for (;;) {
      const handle = this.buckets[slot]!;
      if (handle === EMPTY_SLOT) return undefined;
      if (this.lengths[handle] === encoded.byteLength && this.bytes.compare(encoded, 0, encoded.byteLength, this.offsets[handle], this.offsets[handle]! + encoded.byteLength) === 0) {
        return handle;
      }
      slot = (slot + 1) & mask;
    }
  }

  private place(handle: number, hash = hashBytes(this.bytes.subarray(this.offsets[handle], this.offsets[handle]! + this.lengths[handle]!))): void {
    const mask = this.buckets.length - 1;
    let slot = hash & mask;
    while (this.buckets[slot] !== EMPTY_SLOT) slot = (slot + 1) & mask;
    this.buckets[slot] = handle;
  }

  private maybeRehash(): void {
    if (this.count * 10 <= this.buckets.length * 7) return;
    this.buckets = new Uint32Array(this.buckets.length * 2).fill(EMPTY_SLOT) as U32;
    for (let handle = 1; handle < this.count; handle += 1) this.place(handle);
  }

  private ensureBytes(extra: number): void {
    if (this.used + extra <= this.bytes.byteLength) return;
    let next = this.bytes.byteLength * 2;
    while (next < this.used + extra) next *= 2;
    const grown = Buffer.allocUnsafe(next);
    this.bytes.copy(grown, 0, 0, this.used);
    this.bytes = grown;
  }
}

export function hashBytes(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function growU32(values: U32, min: number): U32 {
  let next = values.length || 16;
  while (next < min) next *= 2;
  const grown = new Uint32Array(next);
  grown.set(values);
  return grown;
}

export function growU8(values: U8, min: number): U8 {
  let next = values.length || 16;
  while (next < min) next *= 2;
  const grown = new Uint8Array(next);
  grown.set(values);
  return grown;
}
