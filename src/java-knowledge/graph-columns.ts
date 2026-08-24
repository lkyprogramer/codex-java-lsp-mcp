// input: Knowledge-graph nodes/edges. output: SoA columns; materialize() rebuilds public records.
// pos: M6-2 P1. OPEN/digest keep columns only; query paths materialize on read.
import { ALL_EDGE_KINDS, type EdgeKind } from "./edge-kinds.js";
import { NODE_KINDS, type GraphEdge, type GraphNode, type NodeKind } from "./schema.js";
import { StringTable, growU32, growU8, type U32, type U8 } from "../java-index/columnar/string-table.js";

const NODE_KIND_INDEX = indexMap(NODE_KINDS);
const EDGE_KIND_INDEX = indexMap(ALL_EDGE_KINDS);

export class GraphNodeColumns {
  readonly strings: StringTable;
  private capacity = 16;
  private rowCount = 0;
  private liveCount = 0;
  private id: U32 = new Uint32Array(this.capacity);
  private path: U32 = new Uint32Array(this.capacity);
  private name: U32 = new Uint32Array(this.capacity);
  private javaIndexId: U32 = new Uint32Array(this.capacity);
  private generation: U32 = new Uint32Array(this.capacity);
  private owner: U32 = new Uint32Array(this.capacity);
  private kind: U8 = new Uint8Array(this.capacity);
  private deleted: U8 = new Uint8Array(this.capacity);
  private readonly byId = new Map<string, number>();
  private readonly extraOwners = new Map<number, Set<number>>();
  private memo: Array<GraphNode | undefined> = [];

  constructor(strings: StringTable) {
    this.strings = strings;
  }

  get size(): number {
    return this.liveCount;
  }

  has(nodeId: string): boolean {
    return this.byId.has(nodeId);
  }

  rowOf(nodeId: string): number | undefined {
    return this.byId.get(nodeId);
  }

  idAt(row: number): string {
    return this.strings.get(this.id[row]!);
  }

  kindAt(row: number): NodeKind {
    return NODE_KINDS[this.kind[row]!]!;
  }

  *liveRows(): Iterable<number> {
    for (let row = 0; row < this.rowCount; row += 1) {
      if (!this.deleted[row]) yield row;
    }
  }

  *ids(): Iterable<string> {
    for (const row of this.liveRows()) yield this.idAt(row);
  }

  *entries(): Iterable<[string, GraphNode]> {
    for (const row of this.liveRows()) yield [this.idAt(row), this.materialize(row)];
  }

  upsert(node: GraphNode): number {
    const internedId = this.strings.interned(node.id);
    const existing = this.byId.get(internedId);
    if (existing !== undefined) {
      this.write(existing, node, internedId);
      return existing;
    }
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.write(row, node, internedId);
    this.rowCount += 1;
    this.liveCount += 1;
    this.byId.set(internedId, row);
    return row;
  }

  addOwner(row: number, ownerFile: string): void {
    const handle = this.strings.intern(ownerFile);
    const current = this.owner[row]!;
    if (current === 0) {
      this.owner[row] = handle;
      return;
    }
    if (current === handle) return;
    const extra = this.extraOwners.get(row);
    if (extra) extra.add(handle);
    else this.extraOwners.set(row, new Set([handle]));
  }

  removeOwner(row: number, ownerFile: string): boolean {
    const handle = this.strings.intern(ownerFile);
    const extra = this.extraOwners.get(row);
    if (extra?.delete(handle)) {
      if (extra.size === 0) this.extraOwners.delete(row);
      return this.hasOwners(row);
    }
    if (this.owner[row] !== handle) return this.hasOwners(row);
    if (extra && extra.size > 0) {
      const next = extra.values().next().value!;
      extra.delete(next);
      this.owner[row] = next;
      if (extra.size === 0) this.extraOwners.delete(row);
      return true;
    }
    this.owner[row] = 0;
    return false;
  }

  remove(nodeId: string): GraphNode | undefined {
    const row = this.byId.get(nodeId);
    if (row === undefined) return undefined;
    const node = this.materialize(row);
    this.deleted[row] = 1;
    this.liveCount -= 1;
    this.byId.delete(this.strings.get(this.id[row]!));
    this.extraOwners.delete(row);
    this.owner[row] = 0;
    this.memo[row] = undefined;
    return node;
  }

  materialize(row: number): GraphNode {
    if (this.deleted[row]) throw new Error(`materialize of deleted graph node row ${row}`);
    const cached = this.memo[row];
    if (cached) return cached;
    const relativePath = this.strings.get(this.path[row]!);
    const simpleName = this.strings.get(this.name[row]!);
    const javaIndexId = this.strings.get(this.javaIndexId[row]!);
    const node: GraphNode = {
      id: this.strings.get(this.id[row]!),
      kind: this.kindAt(row),
      generation: this.generation[row]!,
      ...(relativePath ? { relativePath } : {}),
      ...(simpleName ? { simpleName } : {}),
      ...(javaIndexId ? { javaIndexId } : {})
    };
    this.memo[row] = node;
    return node;
  }

  clear(): void {
    this.rowCount = 0;
    this.liveCount = 0;
    this.byId.clear();
    this.extraOwners.clear();
    this.deleted.fill(0);
    this.owner.fill(0);
    this.memo = [];
  }

  private hasOwners(row: number): boolean {
    return this.owner[row] !== 0 || (this.extraOwners.get(row)?.size ?? 0) > 0;
  }

  private write(row: number, node: GraphNode, internedId: string): void {
    const kind = NODE_KIND_INDEX.get(node.kind);
    if (kind === undefined) throw new Error(`unknown graph node kind ${node.kind}`);
    this.id[row] = this.strings.intern(internedId);
    this.path[row] = this.strings.intern(node.relativePath ?? "");
    this.name[row] = this.strings.intern(node.simpleName ?? "");
    this.javaIndexId[row] = this.strings.intern(node.javaIndexId ?? "");
    this.generation[row] = node.generation;
    this.kind[row] = kind;
    this.deleted[row] = 0;
    this.memo[row] = undefined;
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.id = growU32(this.id, next);
    this.path = growU32(this.path, next);
    this.name = growU32(this.name, next);
    this.javaIndexId = growU32(this.javaIndexId, next);
    this.generation = growU32(this.generation, next);
    this.owner = growU32(this.owner, next);
    this.kind = growU8(this.kind, next);
    this.deleted = growU8(this.deleted, next);
    this.capacity = next;
  }
}

export class GraphEdgeColumns {
  readonly strings: StringTable;
  private capacity = 16;
  private rowCount = 0;
  private liveCount = 0;
  private edgeId: U32 = new Uint32Array(this.capacity);
  private fromId: U32 = new Uint32Array(this.capacity);
  private toId: U32 = new Uint32Array(this.capacity);
  private sourceFile: U32 = new Uint32Array(this.capacity);
  private generation: U32 = new Uint32Array(this.capacity);
  private owner: U32 = new Uint32Array(this.capacity);
  private kind: U8 = new Uint8Array(this.capacity);
  private deleted: U8 = new Uint8Array(this.capacity);
  private readonly byId = new Map<string, number>();
  private readonly extraOwners = new Map<number, Set<number>>();
  private memo: Array<GraphEdge | undefined> = [];

  constructor(strings: StringTable) {
    this.strings = strings;
  }

  get size(): number {
    return this.liveCount;
  }

  has(edgeId: string): boolean {
    return this.byId.has(edgeId);
  }

  rowOf(edgeId: string): number | undefined {
    return this.byId.get(edgeId);
  }

  idAt(row: number): string {
    return this.strings.get(this.edgeId[row]!);
  }

  fromIdAt(row: number): string {
    return this.strings.get(this.fromId[row]!);
  }

  toIdAt(row: number): string {
    return this.strings.get(this.toId[row]!);
  }

  kindAt(row: number): EdgeKind {
    return ALL_EDGE_KINDS[this.kind[row]!]!;
  }

  *liveRows(): Iterable<number> {
    for (let row = 0; row < this.rowCount; row += 1) {
      if (!this.deleted[row]) yield row;
    }
  }

  *ids(): Iterable<string> {
    for (const row of this.liveRows()) yield this.idAt(row);
  }

  *entries(): Iterable<[string, GraphEdge]> {
    for (const row of this.liveRows()) yield [this.idAt(row), this.materialize(row)];
  }

  add(edge: GraphEdge): { row: number; created: boolean } {
    const internedId = this.strings.interned(edge.edgeId);
    const existing = this.byId.get(internedId);
    if (existing !== undefined) return { row: existing, created: false };
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.write(row, edge, internedId);
    this.rowCount += 1;
    this.liveCount += 1;
    this.byId.set(internedId, row);
    return { row, created: true };
  }

  addOwner(row: number, ownerFile: string): void {
    const handle = this.strings.intern(ownerFile);
    const current = this.owner[row]!;
    if (current === 0) {
      this.owner[row] = handle;
      return;
    }
    if (current === handle) return;
    const extra = this.extraOwners.get(row);
    if (extra) extra.add(handle);
    else this.extraOwners.set(row, new Set([handle]));
  }

  removeOwner(row: number, ownerFile: string): boolean {
    const handle = this.strings.intern(ownerFile);
    const extra = this.extraOwners.get(row);
    if (extra?.delete(handle)) {
      if (extra.size === 0) this.extraOwners.delete(row);
      return this.hasOwners(row);
    }
    if (this.owner[row] !== handle) return this.hasOwners(row);
    if (extra && extra.size > 0) {
      const next = extra.values().next().value!;
      extra.delete(next);
      this.owner[row] = next;
      if (extra.size === 0) this.extraOwners.delete(row);
      return true;
    }
    this.owner[row] = 0;
    return false;
  }

  remove(edgeId: string): GraphEdge | undefined {
    const row = this.byId.get(edgeId);
    if (row === undefined) return undefined;
    const edge = this.materialize(row);
    this.deleted[row] = 1;
    this.liveCount -= 1;
    this.byId.delete(this.strings.get(this.edgeId[row]!));
    this.extraOwners.delete(row);
    this.owner[row] = 0;
    this.memo[row] = undefined;
    return edge;
  }

  materialize(row: number): GraphEdge {
    if (this.deleted[row]) throw new Error(`materialize of deleted graph edge row ${row}`);
    const cached = this.memo[row];
    if (cached) return cached;
    const sourceFile = this.strings.get(this.sourceFile[row]!);
    const edge: GraphEdge = {
      edgeId: this.strings.get(this.edgeId[row]!),
      kind: this.kindAt(row),
      fromId: this.strings.get(this.fromId[row]!),
      toId: this.strings.get(this.toId[row]!),
      generation: this.generation[row]!,
      ...(sourceFile ? { sourceFile } : {})
    };
    this.memo[row] = edge;
    return edge;
  }

  clear(): void {
    this.rowCount = 0;
    this.liveCount = 0;
    this.byId.clear();
    this.extraOwners.clear();
    this.deleted.fill(0);
    this.owner.fill(0);
    this.memo = [];
  }

  private hasOwners(row: number): boolean {
    return this.owner[row] !== 0 || (this.extraOwners.get(row)?.size ?? 0) > 0;
  }

  private write(row: number, edge: GraphEdge, internedId: string): void {
    const kind = EDGE_KIND_INDEX.get(edge.kind);
    if (kind === undefined) throw new Error(`unknown graph edge kind ${edge.kind}`);
    this.edgeId[row] = this.strings.intern(internedId);
    this.fromId[row] = this.strings.intern(edge.fromId);
    this.toId[row] = this.strings.intern(edge.toId);
    this.sourceFile[row] = this.strings.intern(edge.sourceFile ?? "");
    this.generation[row] = edge.generation;
    this.kind[row] = kind;
    this.deleted[row] = 0;
    this.memo[row] = undefined;
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.edgeId = growU32(this.edgeId, next);
    this.fromId = growU32(this.fromId, next);
    this.toId = growU32(this.toId, next);
    this.sourceFile = growU32(this.sourceFile, next);
    this.generation = growU32(this.generation, next);
    this.owner = growU32(this.owner, next);
    this.kind = growU8(this.kind, next);
    this.deleted = growU8(this.deleted, next);
    this.capacity = next;
  }
}

export class GraphRecordMap<T> implements ReadonlyMap<string, T> {
  constructor(
    private readonly ops: {
      size(): number;
      get(id: string): T | undefined;
      has(id: string): boolean;
      ids(): Iterable<string>;
      entries(): Iterable<[string, T]>;
    }
  ) {}

  get size(): number {
    return this.ops.size();
  }

  get(id: string): T | undefined {
    return this.ops.get(id);
  }

  has(id: string): boolean {
    return this.ops.has(id);
  }

  *keys(): IterableIterator<string> {
    yield* this.ops.ids();
  }

  *values(): IterableIterator<T> {
    for (const [, value] of this.ops.entries()) yield value;
  }

  *entries(): IterableIterator<[string, T]> {
    yield* this.ops.entries();
  }

  forEach(fn: (value: T, key: string, map: ReadonlyMap<string, T>) => void): void {
    for (const [key, value] of this.entries()) fn(value, key, this);
  }

  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.entries();
  }
}

function indexMap<T extends string>(values: readonly T[]): Map<T, number> {
  return new Map(values.map((value, index) => [value, index]));
}
