// input: StaticEdge facts. output: SoA columns keyed by row; materialize() rebuilds the public object.
// pos: M1 P1 edge columns. Tombstones cover replaceFile; loadSnapshotData allocates tight.
import type { StaticEdge, StaticEdgeKind, StaticEdgeResolutionKind } from "../index-types.js";
import type { TypeResolutionStrategy } from "../index-types.js";
import { RangePool } from "./range-pool.js";
import { StringTable, growU32, growU8 } from "./string-table.js";

export const EDGE_KINDS: readonly StaticEdgeKind[] = [
  "DECLARES",
  "EXTENDS",
  "IMPLEMENTS",
  "PERMITS",
  "IMPORTS",
  "FIELD_TYPE",
  "PARAM_TYPE",
  "RETURN_TYPE",
  "THROWS_TYPE",
  "LOCAL_TYPE",
  "CALLS",
  "CONSTRUCTS",
  "METHOD_REFERENCE",
  "ANNOTATED_WITH"
];

export const RESOLUTION_KINDS: readonly StaticEdgeResolutionKind[] = [
  "AST_EXPLICIT",
  "TYPE_REFERENCE",
  "SAME_OWNER_NAME_ARITY",
  "DECLARED_RECEIVER_NAME_ARITY",
  "SUPER_CHAIN_NAME_ARITY",
  "CONSTRUCTOR_TYPE",
  "METHOD_REFERENCE_OWNER"
];

export const TYPE_STRATEGIES: readonly TypeResolutionStrategy[] = [
  "QUALIFIED",
  "EXPLICIT_IMPORT",
  "ENCLOSING_TYPE",
  "SAME_PACKAGE",
  "JAVA_LANG",
  "WILDCARD_IMPORT",
  "REPO_UNIQUE_SIMPLE_NAME"
];

const KIND_INDEX = indexMap(EDGE_KINDS);
const RESOLUTION_INDEX = indexMap(RESOLUTION_KINDS);
const STRATEGY_INDEX = indexMap(TYPE_STRATEGIES);
const NO_STRATEGY = 0xff;

export class EdgeColumns {
  readonly strings: StringTable;
  readonly ranges: RangePool;
  private capacity = 16;
  private rowCount = 0;
  private liveCount = 0;
  private edgeId: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private fromId: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private toId: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private sourceFile: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private rangeIdx: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private generation: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private kind: Uint8Array<ArrayBufferLike> = new Uint8Array(this.capacity);
  private resolutionKind: Uint8Array<ArrayBufferLike> = new Uint8Array(this.capacity);
  private typeStrategy: Uint8Array<ArrayBufferLike> = new Uint8Array(this.capacity);
  private deleted: Uint8Array<ArrayBufferLike> = new Uint8Array(this.capacity);
  private confidence: Uint32Array<ArrayBufferLike> = new Uint32Array(this.capacity);
  private readonly byEdgeId = new Map<string, number>();

  constructor(strings = new StringTable(), ranges = new RangePool()) {
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
    return this.edgeId.byteLength
      + this.fromId.byteLength
      + this.toId.byteLength
      + this.sourceFile.byteLength
      + this.rangeIdx.byteLength
      + this.generation.byteLength
      + this.kind.byteLength
      + this.resolutionKind.byteLength
      + this.typeStrategy.byteLength
      + this.deleted.byteLength
      + this.confidence.byteLength;
  }

  reclaimFrom(live: readonly StaticEdge[]): void {
    this.clear();
    const next = Math.max(16, live.length);
    this.edgeId = new Uint32Array(next);
    this.fromId = new Uint32Array(next);
    this.toId = new Uint32Array(next);
    this.sourceFile = new Uint32Array(next);
    this.rangeIdx = new Uint32Array(next);
    this.generation = new Uint32Array(next);
    this.kind = new Uint8Array(next);
    this.resolutionKind = new Uint8Array(next);
    this.typeStrategy = new Uint8Array(next);
    this.deleted = new Uint8Array(next);
    this.confidence = new Uint32Array(next);
    this.capacity = next;
    for (const edge of live) this.add(edge);
  }

  has(edgeId: string): boolean {
    return this.byEdgeId.has(edgeId);
  }

  rowOf(edgeId: string): number | undefined {
    return this.byEdgeId.get(edgeId);
  }

  add(edge: StaticEdge): number {
    const internedId = this.strings.interned(edge.edgeId);
    const existing = this.byEdgeId.get(internedId);
    if (existing !== undefined) {
      this.write(existing, edge, internedId);
      return existing;
    }
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.write(row, edge, internedId);
    this.rowCount += 1;
    this.liveCount += 1;
    this.byEdgeId.set(internedId, row);
    return row;
  }

  remove(edgeId: string): StaticEdge | undefined {
    const row = this.byEdgeId.get(edgeId);
    if (row === undefined) return undefined;
    const edge = this.materialize(row);
    this.deleted[row] = 1;
    this.liveCount -= 1;
    this.byEdgeId.delete(this.strings.get(this.edgeId[row]!));
    return edge;
  }

  stampGeneration(row: number, generation: number): void {
    this.generation[row] = generation;
  }

  materialize(row: number): StaticEdge {
    if (this.deleted[row]) throw new Error(`materialize of deleted edge row ${row}`);
    const range = this.ranges.get(this.rangeIdx[row]!);
    const strategy = this.typeStrategy[row]!;
    return {
      edgeId: this.strings.get(this.edgeId[row]!),
      fromId: this.strings.get(this.fromId[row]!),
      toId: this.strings.get(this.toId[row]!),
      kind: EDGE_KINDS[this.kind[row]!]!,
      confidence: this.confidence[row]! / 10_000,
      sourceFile: this.strings.get(this.sourceFile[row]!),
      generation: this.generation[row]!,
      resolution: {
        kind: RESOLUTION_KINDS[this.resolutionKind[row]!]!,
        ...(strategy === NO_STRATEGY ? {} : { typeStrategy: TYPE_STRATEGIES[strategy] })
      },
      ...(range ? { range } : {})
    };
  }

  *liveRows(): Iterable<number> {
    for (let row = 0; row < this.rowCount; row += 1) {
      if (!this.deleted[row]) yield row;
    }
  }

  *values(): Iterable<StaticEdge> {
    for (const row of this.liveRows()) yield this.materialize(row);
  }

  clear(): void {
    this.rowCount = 0;
    this.liveCount = 0;
    this.byEdgeId.clear();
    this.deleted.fill(0);
  }

  private write(row: number, edge: StaticEdge, internedId: string): void {
    const kind = KIND_INDEX.get(edge.kind);
    const resolution = RESOLUTION_INDEX.get(edge.resolution.kind);
    if (kind === undefined) throw new Error(`unknown edge kind ${edge.kind}`);
    if (resolution === undefined) throw new Error(`unknown edge resolution ${edge.resolution.kind}`);
    this.edgeId[row] = this.strings.intern(internedId);
    this.fromId[row] = this.strings.intern(edge.fromId);
    this.toId[row] = this.strings.intern(edge.toId);
    this.sourceFile[row] = this.strings.intern(edge.sourceFile);
    this.rangeIdx[row] = this.ranges.intern(edge.range);
    this.generation[row] = edge.generation;
    this.kind[row] = kind;
    this.resolutionKind[row] = resolution;
    this.typeStrategy[row] = edge.resolution.typeStrategy === undefined
      ? NO_STRATEGY
      : STRATEGY_INDEX.get(edge.resolution.typeStrategy) ?? NO_STRATEGY;
    this.confidence[row] = Math.round(edge.confidence * 10_000);
    this.deleted[row] = 0;
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.edgeId = growU32(this.edgeId, next);
    this.fromId = growU32(this.fromId, next);
    this.toId = growU32(this.toId, next);
    this.sourceFile = growU32(this.sourceFile, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.generation = growU32(this.generation, next);
    this.kind = growU8(this.kind, next);
    this.resolutionKind = growU8(this.resolutionKind, next);
    this.typeStrategy = growU8(this.typeStrategy, next);
    this.deleted = growU8(this.deleted, next);
    this.confidence = growU32(this.confidence, next);
    this.capacity = next;
  }
}

function indexMap<T extends string>(values: readonly T[]): Map<T, number> {
  return new Map(values.map((value, index) => [value, index]));
}
