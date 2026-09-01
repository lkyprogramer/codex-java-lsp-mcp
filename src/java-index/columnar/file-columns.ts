// input: JavaFileFacts plus nested imports/type-id lists.
// output: SoA file rows; materialize() rebuilds the public object.
// pos: M6-3 P1 files/imports/ranges columns. Tombstone+append is the overlay.
import type { JavaFileFacts, JavaImportFact, JavaParseState, JavaSourceSet } from "../index-types.js";
import { RangePool } from "./range-pool.js";
import { StringTable, growU32, growU8, type U32, type U8 } from "./string-table.js";

const SOURCE_SETS: readonly JavaSourceSet[] = ["main", "test", "generated", "unknown"];
const PARSE_STATES: readonly JavaParseState[] = ["COMPLETE", "RECOVERED", "FAILED"];
const SOURCE_SET_INDEX = new Map(SOURCE_SETS.map((item, index) => [item, index]));
const PARSE_STATE_INDEX = new Map(PARSE_STATES.map((item, index) => [item, index]));
const FLAG_WILDCARD = 1;
const FLAG_STATIC = 2;

type F64 = Float64Array<ArrayBufferLike>;

export class FileColumns {
  readonly strings: StringTable;
  readonly ranges: RangePool;
  private capacity = 16;
  private rowCount = 0;
  private liveCount = 0;
  private fileId: U32 = new Uint32Array(this.capacity);
  private relativePath: U32 = new Uint32Array(this.capacity);
  private sourceRoot: U32 = new Uint32Array(this.capacity);
  private module: U32 = new Uint32Array(this.capacity);
  private packageName: U32 = new Uint32Array(this.capacity);
  private contentHash: U32 = new Uint32Array(this.capacity);
  private sizeBytes: U32 = new Uint32Array(this.capacity);
  private generation: U32 = new Uint32Array(this.capacity);
  private parseErrorCount: U32 = new Uint32Array(this.capacity);
  private importStart: U32 = new Uint32Array(this.capacity);
  private importCount: U32 = new Uint32Array(this.capacity);
  private topStart: U32 = new Uint32Array(this.capacity);
  private topCount: U32 = new Uint32Array(this.capacity);
  private allStart: U32 = new Uint32Array(this.capacity);
  private allCount: U32 = new Uint32Array(this.capacity);
  private mtimeMs: F64 = new Float64Array(this.capacity);
  private ctimeMs: F64 = new Float64Array(this.capacity);
  private sourceSet: U8 = new Uint8Array(this.capacity);
  private parseState: U8 = new Uint8Array(this.capacity);
  private deleted: U8 = new Uint8Array(this.capacity);
  private readonly byPath = new Map<string, number>();
  private memo: Array<JavaFileFacts | undefined> = [];
  private importName: number[] = [];
  private importFlags: number[] = [];
  private importRange: number[] = [];
  private typeIds: number[] = [];

  constructor(strings: StringTable, ranges: RangePool) {
    this.strings = strings;
    this.ranges = ranges;
  }

  get size(): number {
    return this.liveCount;
  }

  get rows(): number {
    return this.rowCount;
  }

  tombstoneRatio(): number {
    return this.rowCount === 0 ? 0 : (this.rowCount - this.liveCount) / this.rowCount;
  }

  estimatedBytes(): number {
    return this.fileId.byteLength
      + this.relativePath.byteLength
      + this.sourceRoot.byteLength
      + this.module.byteLength
      + this.packageName.byteLength
      + this.contentHash.byteLength
      + this.sizeBytes.byteLength
      + this.generation.byteLength
      + this.parseErrorCount.byteLength
      + this.importStart.byteLength
      + this.importCount.byteLength
      + this.topStart.byteLength
      + this.topCount.byteLength
      + this.allStart.byteLength
      + this.allCount.byteLength
      + this.mtimeMs.byteLength
      + this.ctimeMs.byteLength
      + this.sourceSet.byteLength
      + this.parseState.byteLength
      + this.deleted.byteLength
      + this.importName.length * 8
      + this.importFlags.length * 8
      + this.importRange.length * 8
      + this.typeIds.length * 8;
  }

  reclaimFrom(live: readonly JavaFileFacts[]): void {
    this.clear();
    const next = Math.max(16, live.length);
    this.fileId = new Uint32Array(next);
    this.relativePath = new Uint32Array(next);
    this.sourceRoot = new Uint32Array(next);
    this.module = new Uint32Array(next);
    this.packageName = new Uint32Array(next);
    this.contentHash = new Uint32Array(next);
    this.sizeBytes = new Uint32Array(next);
    this.generation = new Uint32Array(next);
    this.parseErrorCount = new Uint32Array(next);
    this.importStart = new Uint32Array(next);
    this.importCount = new Uint32Array(next);
    this.topStart = new Uint32Array(next);
    this.topCount = new Uint32Array(next);
    this.allStart = new Uint32Array(next);
    this.allCount = new Uint32Array(next);
    this.mtimeMs = new Float64Array(next);
    this.ctimeMs = new Float64Array(next);
    this.sourceSet = new Uint8Array(next);
    this.parseState = new Uint8Array(next);
    this.deleted = new Uint8Array(next);
    this.capacity = next;
    for (const file of live) this.add(file);
  }

  has(relativePath: string): boolean {
    return this.byPath.has(relativePath);
  }

  rowOf(relativePath: string): number | undefined {
    return this.byPath.get(relativePath);
  }

  add(file: JavaFileFacts): number {
    const internedPath = this.strings.interned(file.relativePath);
    const existing = this.byPath.get(internedPath);
    if (existing !== undefined) {
      this.deleted[existing] = 1;
      this.liveCount -= 1;
      this.memo[existing] = undefined;
      this.byPath.delete(this.strings.get(this.relativePath[existing]!));
    }
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.write(row, file, internedPath);
    this.rowCount += 1;
    this.liveCount += 1;
    this.byPath.set(internedPath, row);
    return row;
  }

  stampGeneration(relativePath: string, generation: number): void {
    const row = this.byPath.get(relativePath);
    if (row === undefined) return;
    this.generation[row] = generation;
    this.memo[row] = undefined;
  }

  remove(relativePath: string): JavaFileFacts | undefined {
    const row = this.byPath.get(relativePath);
    if (row === undefined) return undefined;
    const file = this.materialize(row);
    this.deleted[row] = 1;
    this.liveCount -= 1;
    this.memo[row] = undefined;
    this.byPath.delete(this.strings.get(this.relativePath[row]!));
    return file;
  }

  materialize(row: number): JavaFileFacts {
    if (this.deleted[row]) throw new Error(`materialize of deleted file row ${row}`);
    const cached = this.memo[row];
    if (cached) return cached;
    const importOffset = this.importStart[row]!;
    const imports: JavaImportFact[] = [];
    for (let index = 0; index < this.importCount[row]!; index += 1) {
      const slot = importOffset + index;
      const flags = this.importFlags[slot]!;
      const range = this.ranges.getObject(this.importRange[slot]!);
      imports.push({
        qualifiedName: this.strings.get(this.importName[slot]!),
        wildcard: (flags & FLAG_WILDCARD) !== 0,
        static: (flags & FLAG_STATIC) !== 0,
        range: range!
      });
    }
    const ctime = this.ctimeMs[row]!;
    const file: JavaFileFacts = {
      fileId: this.strings.get(this.fileId[row]!),
      relativePath: this.strings.get(this.relativePath[row]!),
      sourceRoot: this.strings.get(this.sourceRoot[row]!),
      module: this.strings.get(this.module[row]!),
      sourceSet: SOURCE_SETS[this.sourceSet[row]!]!,
      packageName: this.strings.get(this.packageName[row]!),
      imports,
      topLevelTypeIds: this.sliceIds(this.topStart[row]!, this.topCount[row]!),
      allTypeIds: this.sliceIds(this.allStart[row]!, this.allCount[row]!),
      contentHash: this.strings.get(this.contentHash[row]!),
      size: this.sizeBytes[row]!,
      mtimeMs: this.mtimeMs[row]!,
      parseState: PARSE_STATES[this.parseState[row]!]!,
      parseErrorCount: this.parseErrorCount[row]!,
      generation: this.generation[row]!,
      ...(ctime > 0 ? { ctimeMs: ctime } : {})
    };
    this.memo[row] = file;
    return file;
  }

  *values(): Iterable<JavaFileFacts> {
    for (let row = 0; row < this.rowCount; row += 1) {
      if (!this.deleted[row]) yield this.materialize(row);
    }
  }

  clear(): void {
    this.rowCount = 0;
    this.liveCount = 0;
    this.byPath.clear();
    this.memo = [];
    this.importName = [];
    this.importFlags = [];
    this.importRange = [];
    this.typeIds = [];
    this.deleted.fill(0);
  }

  private sliceIds(start: number, count: number): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) ids.push(this.strings.get(this.typeIds[start + index]!));
    return ids;
  }

  private write(row: number, file: JavaFileFacts, internedPath: string): void {
    const sourceSet = SOURCE_SET_INDEX.get(file.sourceSet);
    const parseState = PARSE_STATE_INDEX.get(file.parseState);
    if (sourceSet === undefined) throw new Error(`unknown sourceSet ${file.sourceSet}`);
    if (parseState === undefined) throw new Error(`unknown parseState ${file.parseState}`);
    this.fileId[row] = this.strings.intern(file.fileId);
    this.relativePath[row] = this.strings.intern(internedPath);
    this.sourceRoot[row] = this.strings.intern(file.sourceRoot);
    this.module[row] = this.strings.intern(file.module);
    this.packageName[row] = this.strings.intern(file.packageName);
    this.contentHash[row] = this.strings.intern(file.contentHash);
    this.sizeBytes[row] = file.size >>> 0;
    this.generation[row] = file.generation;
    this.parseErrorCount[row] = file.parseErrorCount;
    this.mtimeMs[row] = file.mtimeMs;
    this.ctimeMs[row] = file.ctimeMs ?? 0;
    this.sourceSet[row] = sourceSet;
    this.parseState[row] = parseState;
    this.deleted[row] = 0;
    this.memo[row] = undefined;
    this.importStart[row] = this.importName.length;
    this.importCount[row] = file.imports.length;
    for (const item of file.imports) {
      this.importName.push(this.strings.intern(item.qualifiedName));
      this.importFlags.push((item.wildcard ? FLAG_WILDCARD : 0) | (item.static ? FLAG_STATIC : 0));
      this.importRange.push(this.ranges.intern(item.range));
    }
    this.topStart[row] = this.typeIds.length;
    this.topCount[row] = file.topLevelTypeIds.length;
    for (const id of file.topLevelTypeIds) this.typeIds.push(this.strings.intern(id));
    this.allStart[row] = this.typeIds.length;
    this.allCount[row] = file.allTypeIds.length;
    for (const id of file.allTypeIds) this.typeIds.push(this.strings.intern(id));
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.fileId = growU32(this.fileId, next);
    this.relativePath = growU32(this.relativePath, next);
    this.sourceRoot = growU32(this.sourceRoot, next);
    this.module = growU32(this.module, next);
    this.packageName = growU32(this.packageName, next);
    this.contentHash = growU32(this.contentHash, next);
    this.sizeBytes = growU32(this.sizeBytes, next);
    this.generation = growU32(this.generation, next);
    this.parseErrorCount = growU32(this.parseErrorCount, next);
    this.importStart = growU32(this.importStart, next);
    this.importCount = growU32(this.importCount, next);
    this.topStart = growU32(this.topStart, next);
    this.topCount = growU32(this.topCount, next);
    this.allStart = growU32(this.allStart, next);
    this.allCount = growU32(this.allCount, next);
    this.mtimeMs = growF64(this.mtimeMs, next);
    this.ctimeMs = growF64(this.ctimeMs, next);
    this.sourceSet = growU8(this.sourceSet, next);
    this.parseState = growU8(this.parseState, next);
    this.deleted = growU8(this.deleted, next);
    this.capacity = next;
  }
}

export class FileIdMap {
  constructor(
    private readonly columns: FileColumns,
    private readonly overlay: Map<string, JavaFileFacts> = new Map()
  ) {}

  get size(): number {
    return this.columns.size + this.overlay.size;
  }

  get(relativePath: string): JavaFileFacts | undefined {
    const row = this.columns.rowOf(relativePath);
    if (row !== undefined) return this.columns.materialize(row);
    return this.overlay.get(relativePath);
  }

  has(relativePath: string): boolean {
    return this.columns.has(relativePath) || this.overlay.has(relativePath);
  }

  values(): IterableIterator<JavaFileFacts> {
    return this.iterate() as IterableIterator<JavaFileFacts>;
  }

  private *iterate(): IterableIterator<JavaFileFacts> {
    yield* this.columns.values();
    yield* this.overlay.values();
  }
}

function growF64(values: F64, min: number): F64 {
  let next = values.length || 16;
  while (next < min) next *= 2;
  const grown = new Float64Array(next);
  grown.set(values);
  return grown;
}
