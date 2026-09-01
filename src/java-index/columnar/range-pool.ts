// input: SourceRange coordinate tuples from facts and edges.
// output: u32 handles into a de-duplicated Int32Array of (startLine,startCol,endLine,endCol).
// pos: M1 P1 range pool. Handle 0 means "no range".
import type { SourceRange } from "../../runtime/source-range.js";
import { growU32, hashBytes } from "./string-table.js";

const EMPTY_SLOT = 0xffffffff;
export const NO_RANGE = 0;

type I32 = Int32Array<ArrayBufferLike>;
type U32 = Uint32Array<ArrayBufferLike>;

export class RangePool {
  private coords: I32 = new Int32Array(1024);
  private count = 1; // handle 0 is absent
  private buckets: U32 = new Uint32Array(2048).fill(EMPTY_SLOT);
  private memo: Array<SourceRange | undefined> = [undefined];

  get size(): number {
    return this.count - 1;
  }

  byteSize(): number {
    return this.coords.byteLength + this.buckets.byteLength;
  }

  intern(range: SourceRange | undefined): number {
    if (!range) return NO_RANGE;
    const startLine = range.start.line;
    const startCol = range.start.column;
    const endLine = range.end.line;
    const endCol = range.end.column;
    const hash = hashRange(startLine, startCol, endLine, endCol);
    const existing = this.lookup(startLine, startCol, endLine, endCol, hash);
    if (existing !== undefined) return existing;
    const handle = this.count;
    const offset = handle * 4;
    if (offset + 4 > this.coords.length) this.coords = growI32(this.coords, offset + 4);
    this.coords[offset] = startLine;
    this.coords[offset + 1] = startCol;
    this.coords[offset + 2] = endLine;
    this.coords[offset + 3] = endCol;
    this.count += 1;
    this.maybeRehash();
    this.place(handle, hash);
    return handle;
  }

  internObject(range: SourceRange): SourceRange {
    return this.getObject(this.intern(range))!;
  }

  get(handle: number): SourceRange | undefined {
    if (handle === NO_RANGE) return undefined;
    return this.getObject(handle);
  }

  getObject(handle: number): SourceRange | undefined {
    if (handle === NO_RANGE) return undefined;
    const memoized = this.memo[handle];
    if (memoized) return memoized;
    if (handle <= 0 || handle >= this.count) throw new Error(`invalid range handle ${handle}`);
    const offset = handle * 4;
    const range: SourceRange = {
      start: { line: this.coords[offset]!, column: this.coords[offset + 1]! },
      end: { line: this.coords[offset + 2]!, column: this.coords[offset + 3]! }
    };
    this.memo[handle] = range;
    return range;
  }

  clear(): void {
    this.count = 1;
    this.buckets.fill(EMPTY_SLOT);
    this.memo = [undefined];
  }

  private lookup(startLine: number, startCol: number, endLine: number, endCol: number, hash: number): number | undefined {
    const mask = this.buckets.length - 1;
    let slot = hash & mask;
    for (;;) {
      const handle = this.buckets[slot]!;
      if (handle === EMPTY_SLOT) return undefined;
      const offset = handle * 4;
      if (
        this.coords[offset] === startLine
        && this.coords[offset + 1] === startCol
        && this.coords[offset + 2] === endLine
        && this.coords[offset + 3] === endCol
      ) {
        return handle;
      }
      slot = (slot + 1) & mask;
    }
  }

  private place(handle: number, hash = hashRange(
    this.coords[handle * 4]!,
    this.coords[handle * 4 + 1]!,
    this.coords[handle * 4 + 2]!,
    this.coords[handle * 4 + 3]!
  )): void {
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
}

function hashRange(startLine: number, startCol: number, endLine: number, endCol: number): number {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, startLine, true);
  view.setInt32(4, startCol, true);
  view.setInt32(8, endLine, true);
  view.setInt32(12, endCol, true);
  return hashBytes(bytes);
}

function growI32(values: I32, min: number): I32 {
  let next = values.length || 16;
  while (next < min) next *= 2;
  const grown = new Int32Array(next);
  grown.set(values);
  return grown;
}
