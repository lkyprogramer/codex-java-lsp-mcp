// input: JavaMethodFacts with nested TypeRef/CallSite trees.
// output: SoA rows; materialize() rebuilds the public object graph.
// pos: M2 P1 method/callSite/typeRef columns. Tombstone+append is the overlay.
import type {
  JavaAnnotationFact,
  JavaCallSiteFact,
  JavaCallSiteKind,
  JavaMethodFacts,
  JavaTypeRef
} from "../index-types.js";
import { TYPE_STRATEGIES } from "./edge-columns.js";
import { RangePool } from "./range-pool.js";
import { StringTable, growU32, growU8, type U8, type U32 } from "./string-table.js";

const NONE = 0;
const CALL_KINDS: readonly JavaCallSiteKind[] = ["METHOD_INVOCATION", "CONSTRUCTOR_INVOCATION", "METHOD_REFERENCE"];
const CALL_KIND_INDEX = new Map(CALL_KINDS.map((kind, index) => [kind, index]));
const STRATEGY_INDEX = new Map(TYPE_STRATEGIES.map((item, index) => [item, index]));
const WILDCARD = { extends: 1, super: 2, unbounded: 3 } as const;

export class MethodColumns {
  readonly strings: StringTable;
  readonly ranges: RangePool;
  private capacity = 16;
  private rowCount = 0;
  private liveCount = 0;
  private methodId: U32 = new Uint32Array(this.capacity);
  private ownerTypeId: U32 = new Uint32Array(this.capacity);
  private name: U32 = new Uint32Array(this.capacity);
  private signatureKey: U32 = new Uint32Array(this.capacity);
  private rangeIdx: U32 = new Uint32Array(this.capacity);
  private bodyRangeIdx: U32 = new Uint32Array(this.capacity);
  private returnRef: U32 = new Uint32Array(this.capacity);
  private modifierStart: U32 = new Uint32Array(this.capacity);
  private modifierCount: U32 = new Uint32Array(this.capacity);
  private annotationStart: U32 = new Uint32Array(this.capacity);
  private annotationCount: U32 = new Uint32Array(this.capacity);
  private paramStart: U32 = new Uint32Array(this.capacity);
  private paramCount: U32 = new Uint32Array(this.capacity);
  private throwsStart: U32 = new Uint32Array(this.capacity);
  private throwsCount: U32 = new Uint32Array(this.capacity);
  private callStart: U32 = new Uint32Array(this.capacity);
  private callCount: U32 = new Uint32Array(this.capacity);
  private localStart: U32 = new Uint32Array(this.capacity);
  private localCount: U32 = new Uint32Array(this.capacity);
  private ctor: U8 = new Uint8Array(this.capacity);
  private deleted: U8 = new Uint8Array(this.capacity);
  private readonly byId = new Map<string, number>();
  private readonly typeRefs = new TypeRefArena();
  private readonly callSites = new CallSiteArena();
  private readonly annotations = new AnnotationArena();
  private readonly params = new ParameterArena();
  private modifierHandles: number[] = [];
  private throwsHandles: number[] = [];
  private localHandles: number[] = [];

  constructor(strings: StringTable, ranges: RangePool) {
    this.strings = strings;
    this.ranges = ranges;
    this.typeRefs.strings = strings;
    this.typeRefs.ranges = ranges;
    this.callSites.strings = strings;
    this.callSites.ranges = ranges;
    this.callSites.typeRefs = this.typeRefs;
    this.annotations.strings = strings;
    this.annotations.ranges = ranges;
    this.params.strings = strings;
    this.params.ranges = ranges;
    this.params.typeRefs = this.typeRefs;
    this.params.annotations = this.annotations;
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
    return this.methodId.byteLength
      + this.ownerTypeId.byteLength
      + this.name.byteLength
      + this.signatureKey.byteLength
      + this.rangeIdx.byteLength
      + this.bodyRangeIdx.byteLength
      + this.returnRef.byteLength
      + this.modifierStart.byteLength
      + this.modifierCount.byteLength
      + this.annotationStart.byteLength
      + this.annotationCount.byteLength
      + this.paramStart.byteLength
      + this.paramCount.byteLength
      + this.throwsStart.byteLength
      + this.throwsCount.byteLength
      + this.callStart.byteLength
      + this.callCount.byteLength
      + this.localStart.byteLength
      + this.localCount.byteLength
      + this.ctor.byteLength
      + this.deleted.byteLength
      + this.modifierHandles.length * 8
      + this.throwsHandles.length * 8
      + this.localHandles.length * 8;
  }

  reclaimFrom(live: readonly JavaMethodFacts[]): void {
    this.clear();
    const next = Math.max(16, live.length);
    this.methodId = new Uint32Array(next);
    this.ownerTypeId = new Uint32Array(next);
    this.name = new Uint32Array(next);
    this.signatureKey = new Uint32Array(next);
    this.rangeIdx = new Uint32Array(next);
    this.bodyRangeIdx = new Uint32Array(next);
    this.returnRef = new Uint32Array(next);
    this.modifierStart = new Uint32Array(next);
    this.modifierCount = new Uint32Array(next);
    this.annotationStart = new Uint32Array(next);
    this.annotationCount = new Uint32Array(next);
    this.paramStart = new Uint32Array(next);
    this.paramCount = new Uint32Array(next);
    this.throwsStart = new Uint32Array(next);
    this.throwsCount = new Uint32Array(next);
    this.callStart = new Uint32Array(next);
    this.callCount = new Uint32Array(next);
    this.localStart = new Uint32Array(next);
    this.localCount = new Uint32Array(next);
    this.ctor = new Uint8Array(next);
    this.deleted = new Uint8Array(next);
    this.capacity = next;
    for (const method of live) this.add(method);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  rowOf(id: string): number | undefined {
    return this.byId.get(id);
  }

  add(method: JavaMethodFacts): number {
    const internedId = this.strings.interned(method.methodId);
    const existing = this.byId.get(internedId);
    if (existing !== undefined) {
      this.write(existing, method, internedId);
      return existing;
    }
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.write(row, method, internedId);
    this.rowCount += 1;
    this.liveCount += 1;
    this.byId.set(internedId, row);
    return row;
  }

  remove(id: string): JavaMethodFacts | undefined {
    const row = this.byId.get(id);
    if (row === undefined) return undefined;
    const method = this.materialize(row);
    this.deleted[row] = 1;
    this.liveCount -= 1;
    this.byId.delete(this.strings.get(this.methodId[row]!));
    return method;
  }

  materialize(row: number): JavaMethodFacts {
    if (this.deleted[row]) throw new Error(`materialize of deleted method row ${row}`);
    const body = this.ranges.get(this.bodyRangeIdx[row]!);
    const returnType = this.returnRef[row] ? this.typeRefs.get(this.returnRef[row]!) : undefined;
    const modifierStart = this.modifierStart[row]!;
    const annotationStart = this.annotationStart[row]!;
    const paramStart = this.paramStart[row]!;
    const throwsStart = this.throwsStart[row]!;
    const callStart = this.callStart[row]!;
    const localStart = this.localStart[row]!;
    return {
      methodId: this.strings.get(this.methodId[row]!),
      ownerTypeId: this.strings.get(this.ownerTypeId[row]!),
      name: this.strings.get(this.name[row]!),
      constructor: this.ctor[row] === 1,
      signatureKey: this.strings.get(this.signatureKey[row]!),
      range: this.ranges.getObject(this.rangeIdx[row]!)!,
      modifiers: sliceHandles(this.modifierHandles, modifierStart, this.modifierCount[row]!).map(handle => this.strings.get(handle)),
      annotations: Array.from({ length: this.annotationCount[row]! }, (_, index) => this.annotations.get(annotationStart + index)),
      typeParameters: this.typeParameters.get(this.strings.get(this.methodId[row]!)) ?? [],
      parameters: Array.from({ length: this.paramCount[row]! }, (_, index) => this.params.get(paramStart + index)),
      throws: sliceHandles(this.throwsHandles, throwsStart, this.throwsCount[row]!).map(handle => this.typeRefs.get(handle)),
      callSites: Array.from({ length: this.callCount[row]! }, (_, index) => this.callSites.get(callStart + index)),
      localTypes: sliceHandles(this.localHandles, localStart, this.localCount[row]!).map(handle => this.typeRefs.get(handle)),
      ...(body ? { bodyRange: body } : {}),
      ...(returnType ? { returnType } : {})
    };
  }

  *values(): Iterable<JavaMethodFacts> {
    for (let row = 0; row < this.rowCount; row += 1) {
      if (!this.deleted[row]) yield this.materialize(row);
    }
  }

  clear(): void {
    this.rowCount = 0;
    this.liveCount = 0;
    this.byId.clear();
    this.deleted.fill(0);
    this.modifierHandles = [];
    this.throwsHandles = [];
    this.localHandles = [];
    this.typeRefs.clear();
    this.callSites.clear();
    this.annotations.clear();
    this.params.clear();
    this.typeParameters.clear();
  }

  private write(row: number, method: JavaMethodFacts, internedId: string): void {
    this.methodId[row] = this.strings.intern(internedId);
    this.ownerTypeId[row] = this.strings.intern(method.ownerTypeId);
    this.name[row] = this.strings.intern(method.name);
    this.signatureKey[row] = this.strings.intern(method.signatureKey);
    this.rangeIdx[row] = this.ranges.intern(method.range);
    this.bodyRangeIdx[row] = this.ranges.intern(method.bodyRange);
    this.returnRef[row] = method.returnType ? this.typeRefs.add(method.returnType) : NONE;
    this.ctor[row] = method.constructor ? 1 : 0;
    this.deleted[row] = 0;
    this.modifierStart[row] = this.modifierHandles.length;
    this.modifierCount[row] = method.modifiers.length;
    for (const item of method.modifiers) this.modifierHandles.push(this.strings.intern(item));
    this.annotationStart[row] = this.annotations.count;
    this.annotationCount[row] = method.annotations.length;
    for (const item of method.annotations) this.annotations.add(item);
    this.paramStart[row] = this.params.count;
    this.paramCount[row] = method.parameters.length;
    for (const item of method.parameters) this.params.add(item);
    this.throwsStart[row] = this.throwsHandles.length;
    this.throwsCount[row] = method.throws.length;
    for (const item of method.throws) this.throwsHandles.push(this.typeRefs.add(item));
    this.callStart[row] = this.callSites.count;
    this.callCount[row] = method.callSites.length;
    for (const item of method.callSites) this.callSites.add(item);
    this.localStart[row] = this.localHandles.length;
    this.localCount[row] = method.localTypes.length;
    for (const item of method.localTypes) this.localHandles.push(this.typeRefs.add(item));
    if (method.typeParameters.length > 0) this.typeParameters.set(internedId, method.typeParameters);
    else this.typeParameters.delete(internedId);
  }

  private readonly typeParameters = new Map<string, JavaMethodFacts["typeParameters"]>();

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.methodId = growU32(this.methodId, next);
    this.ownerTypeId = growU32(this.ownerTypeId, next);
    this.name = growU32(this.name, next);
    this.signatureKey = growU32(this.signatureKey, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.bodyRangeIdx = growU32(this.bodyRangeIdx, next);
    this.returnRef = growU32(this.returnRef, next);
    this.modifierStart = growU32(this.modifierStart, next);
    this.modifierCount = growU32(this.modifierCount, next);
    this.annotationStart = growU32(this.annotationStart, next);
    this.annotationCount = growU32(this.annotationCount, next);
    this.paramStart = growU32(this.paramStart, next);
    this.paramCount = growU32(this.paramCount, next);
    this.throwsStart = growU32(this.throwsStart, next);
    this.throwsCount = growU32(this.throwsCount, next);
    this.callStart = growU32(this.callStart, next);
    this.callCount = growU32(this.callCount, next);
    this.localStart = growU32(this.localStart, next);
    this.localCount = growU32(this.localCount, next);
    this.ctor = growU8(this.ctor, next);
    this.deleted = growU8(this.deleted, next);
    this.capacity = next;
  }
}

class TypeRefArena {
  strings!: StringTable;
  ranges!: RangePool;
  private capacity = 16;
  private rowCount = 1;
  private text: U32 = new Uint32Array(this.capacity);
  private simpleName: U32 = new Uint32Array(this.capacity);
  private qualifiedName: U32 = new Uint32Array(this.capacity);
  private rangeIdx: U32 = new Uint32Array(this.capacity);
  private argStart: U32 = new Uint32Array(this.capacity);
  private argCount: U32 = new Uint32Array(this.capacity);
  private payload: U32 = new Uint32Array(this.capacity);
  private payload2: U32 = new Uint32Array(this.capacity);
  private arrayDepth: U8 = new Uint8Array(this.capacity);
  private wildcard: U8 = new Uint8Array(this.capacity);
  private resKind: U8 = new Uint8Array(this.capacity);
  private argHandles: number[] = [];
  private candidateHandles: number[] = [];

  add(ref: JavaTypeRef): number {
    const childHandles = ref.typeArguments.map(argument => this.add(argument));
    this.ensure(this.rowCount + 1);
    const row = this.rowCount;
    this.text[row] = this.strings.intern(ref.text);
    this.simpleName[row] = this.strings.intern(ref.simpleName);
    this.qualifiedName[row] = ref.qualifiedName ? this.strings.intern(ref.qualifiedName) : NONE;
    this.rangeIdx[row] = this.ranges.intern(ref.range);
    this.arrayDepth[row] = ref.arrayDepth;
    this.wildcard[row] = ref.wildcard ? WILDCARD[ref.wildcard] : 0;
    this.argStart[row] = this.argHandles.length;
    this.argCount[row] = childHandles.length;
    this.argHandles.push(...childHandles);
    this.writeResolution(row, ref);
    this.rowCount += 1;
    return row;
  }

  get(handle: number): JavaTypeRef {
    const range = this.ranges.get(this.rangeIdx[handle]!);
    const qualified = this.qualifiedName[handle]!;
    const wildcard = this.wildcard[handle]!;
    return {
      text: this.strings.get(this.text[handle]!),
      simpleName: this.strings.get(this.simpleName[handle]!),
      typeArguments: sliceHandles(this.argHandles, this.argStart[handle]!, this.argCount[handle]!).map(child => this.get(child)),
      arrayDepth: this.arrayDepth[handle]!,
      resolution: this.readResolution(handle),
      ...(qualified ? { qualifiedName: this.strings.get(qualified) } : {}),
      ...(range ? { range } : {}),
      ...(wildcard === 1 ? { wildcard: "extends" as const } : wildcard === 2 ? { wildcard: "super" as const } : wildcard === 3 ? { wildcard: "unbounded" as const } : {})
    };
  }

  clear(): void {
    this.capacity = 16;
    this.rowCount = 1;
    this.text = new Uint32Array(this.capacity);
    this.simpleName = new Uint32Array(this.capacity);
    this.qualifiedName = new Uint32Array(this.capacity);
    this.rangeIdx = new Uint32Array(this.capacity);
    this.argStart = new Uint32Array(this.capacity);
    this.argCount = new Uint32Array(this.capacity);
    this.payload = new Uint32Array(this.capacity);
    this.payload2 = new Uint32Array(this.capacity);
    this.arrayDepth = new Uint8Array(this.capacity);
    this.wildcard = new Uint8Array(this.capacity);
    this.resKind = new Uint8Array(this.capacity);
    this.argHandles = [];
    this.candidateHandles = [];
  }

  private writeResolution(row: number, ref: JavaTypeRef): void {
    const resolution = ref.resolution;
    if (resolution.state === "UNRESOLVED") {
      this.resKind[row] = 0;
      return;
    }
    if (resolution.state === "RESOLVED_REPO") {
      this.resKind[row] = 1;
      this.payload[row] = this.strings.intern(resolution.typeId);
      this.payload2[row] = STRATEGY_INDEX.get(resolution.strategy) ?? 0;
      return;
    }
    if (resolution.state === "EXTERNAL") {
      this.resKind[row] = 2;
      this.payload[row] = this.strings.intern(resolution.qualifiedName);
      this.payload2[row] = STRATEGY_INDEX.get(resolution.strategy) ?? 0;
      return;
    }
    if (resolution.state === "TYPE_VARIABLE") {
      this.resKind[row] = 3;
      this.payload[row] = this.strings.intern(resolution.name);
      return;
    }
    this.resKind[row] = 4;
    this.payload[row] = this.candidateHandles.length;
    this.payload2[row] = resolution.candidates.length;
    for (const candidate of resolution.candidates) this.candidateHandles.push(this.strings.intern(candidate));
  }

  private readResolution(row: number): JavaTypeRef["resolution"] {
    const kind = this.resKind[row]!;
    if (kind === 1) {
      return { state: "RESOLVED_REPO", typeId: this.strings.get(this.payload[row]!), strategy: TYPE_STRATEGIES[this.payload2[row]!]! };
    }
    if (kind === 2) {
      return { state: "EXTERNAL", qualifiedName: this.strings.get(this.payload[row]!), strategy: TYPE_STRATEGIES[this.payload2[row]!]! as "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" };
    }
    if (kind === 3) return { state: "TYPE_VARIABLE", name: this.strings.get(this.payload[row]!) };
    if (kind === 4) {
      return {
        state: "AMBIGUOUS",
        candidates: sliceHandles(this.candidateHandles, this.payload[row]!, this.payload2[row]!).map(handle => this.strings.get(handle))
      };
    }
    return { state: "UNRESOLVED" };
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.text = growU32(this.text, next);
    this.simpleName = growU32(this.simpleName, next);
    this.qualifiedName = growU32(this.qualifiedName, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.argStart = growU32(this.argStart, next);
    this.argCount = growU32(this.argCount, next);
    this.payload = growU32(this.payload, next);
    this.payload2 = growU32(this.payload2, next);
    this.arrayDepth = growU8(this.arrayDepth, next);
    this.wildcard = growU8(this.wildcard, next);
    this.resKind = growU8(this.resKind, next);
    this.capacity = next;
  }
}

class CallSiteArena {
  strings!: StringTable;
  ranges!: RangePool;
  typeRefs!: TypeRefArena;
  private capacity = 16;
  count = 0;
  private kind: U8 = new Uint8Array(this.capacity);
  private name: U32 = new Uint32Array(this.capacity);
  private receiverText: U32 = new Uint32Array(this.capacity);
  private receiverType: U32 = new Uint32Array(this.capacity);
  private rangeIdx: U32 = new Uint32Array(this.capacity);
  private argStart: U32 = new Uint32Array(this.capacity);
  private argCount: U32 = new Uint32Array(this.capacity);
  private arity: U32 = new Uint32Array(this.capacity);
  private argHandles: number[] = [];

  add(site: JavaCallSiteFact): number {
    this.ensure(this.count + 1);
    const row = this.count;
    this.kind[row] = CALL_KIND_INDEX.get(site.kind) ?? 0;
    this.name[row] = this.strings.intern(site.name);
    this.receiverText[row] = site.receiverText ? this.strings.intern(site.receiverText) : NONE;
    this.receiverType[row] = site.receiverDeclaredType ? this.typeRefs.add(site.receiverDeclaredType) : NONE;
    this.rangeIdx[row] = this.ranges.intern(site.range);
    this.arity[row] = site.arity;
    this.argStart[row] = this.argHandles.length;
    this.argCount[row] = site.argumentTypeHints.length;
    for (const hint of site.argumentTypeHints) this.argHandles.push(this.typeRefs.add(hint));
    this.count += 1;
    return row;
  }

  get(row: number): JavaCallSiteFact {
    const receiverText = this.receiverText[row]!;
    const receiverType = this.receiverType[row]!;
    return {
      kind: CALL_KINDS[this.kind[row]!]!,
      name: this.strings.get(this.name[row]!),
      arity: this.arity[row]!,
      argumentTypeHints: sliceHandles(this.argHandles, this.argStart[row]!, this.argCount[row]!).map(handle => this.typeRefs.get(handle)),
      range: this.ranges.getObject(this.rangeIdx[row]!)!,
      ...(receiverText ? { receiverText: this.strings.get(receiverText) } : {}),
      ...(receiverType ? { receiverDeclaredType: this.typeRefs.get(receiverType) } : {})
    };
  }

  clear(): void {
    this.capacity = 16;
    this.count = 0;
    this.kind = new Uint8Array(this.capacity);
    this.name = new Uint32Array(this.capacity);
    this.receiverText = new Uint32Array(this.capacity);
    this.receiverType = new Uint32Array(this.capacity);
    this.rangeIdx = new Uint32Array(this.capacity);
    this.argStart = new Uint32Array(this.capacity);
    this.argCount = new Uint32Array(this.capacity);
    this.arity = new Uint32Array(this.capacity);
    this.argHandles = [];
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.kind = growU8(this.kind, next);
    this.name = growU32(this.name, next);
    this.receiverText = growU32(this.receiverText, next);
    this.receiverType = growU32(this.receiverType, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.argStart = growU32(this.argStart, next);
    this.argCount = growU32(this.argCount, next);
    this.arity = growU32(this.arity, next);
    this.capacity = next;
  }
}

class AnnotationArena {
  strings!: StringTable;
  ranges!: RangePool;
  private capacity = 16;
  count = 0;
  private name: U32 = new Uint32Array(this.capacity);
  private qualifiedName: U32 = new Uint32Array(this.capacity);
  private argumentsText: U32 = new Uint32Array(this.capacity);
  private rangeIdx: U32 = new Uint32Array(this.capacity);

  add(item: JavaAnnotationFact): number {
    this.ensure(this.count + 1);
    const row = this.count;
    this.name[row] = this.strings.intern(item.name);
    this.qualifiedName[row] = item.qualifiedName ? this.strings.intern(item.qualifiedName) : NONE;
    this.argumentsText[row] = item.argumentsText ? this.strings.intern(item.argumentsText) : NONE;
    this.rangeIdx[row] = this.ranges.intern(item.range);
    this.count += 1;
    return row;
  }

  get(row: number): JavaAnnotationFact {
    const qualifiedName = this.qualifiedName[row]!;
    const argumentsText = this.argumentsText[row]!;
    return {
      name: this.strings.get(this.name[row]!),
      range: this.ranges.getObject(this.rangeIdx[row]!)!,
      ...(qualifiedName ? { qualifiedName: this.strings.get(qualifiedName) } : {}),
      ...(argumentsText ? { argumentsText: this.strings.get(argumentsText) } : {})
    };
  }

  clear(): void {
    this.capacity = 16;
    this.count = 0;
    this.name = new Uint32Array(this.capacity);
    this.qualifiedName = new Uint32Array(this.capacity);
    this.argumentsText = new Uint32Array(this.capacity);
    this.rangeIdx = new Uint32Array(this.capacity);
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.name = growU32(this.name, next);
    this.qualifiedName = growU32(this.qualifiedName, next);
    this.argumentsText = growU32(this.argumentsText, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.capacity = next;
  }
}

class ParameterArena {
  strings!: StringTable;
  ranges!: RangePool;
  typeRefs!: TypeRefArena;
  annotations!: AnnotationArena;
  private capacity = 16;
  count = 0;
  private name: U32 = new Uint32Array(this.capacity);
  private typeRef: U32 = new Uint32Array(this.capacity);
  private rangeIdx: U32 = new Uint32Array(this.capacity);
  private annotationStart: U32 = new Uint32Array(this.capacity);
  private annotationCount: U32 = new Uint32Array(this.capacity);
  private varargs: U8 = new Uint8Array(this.capacity);

  add(parameter: JavaMethodFacts["parameters"][number]): number {
    this.ensure(this.count + 1);
    const row = this.count;
    this.name[row] = this.strings.intern(parameter.name);
    this.typeRef[row] = this.typeRefs.add(parameter.type);
    this.rangeIdx[row] = this.ranges.intern(parameter.range);
    this.varargs[row] = parameter.varargs ? 1 : 0;
    this.annotationStart[row] = this.annotations.count;
    this.annotationCount[row] = parameter.annotations.length;
    for (const item of parameter.annotations) this.annotations.add(item);
    this.count += 1;
    return row;
  }

  get(row: number): JavaMethodFacts["parameters"][number] {
    return {
      name: this.strings.get(this.name[row]!),
      type: this.typeRefs.get(this.typeRef[row]!),
      varargs: this.varargs[row] === 1,
      annotations: Array.from({ length: this.annotationCount[row]! }, (_, index) => this.annotations.get(this.annotationStart[row]! + index)),
      range: this.ranges.getObject(this.rangeIdx[row]!)!
    };
  }

  clear(): void {
    this.capacity = 16;
    this.count = 0;
    this.name = new Uint32Array(this.capacity);
    this.typeRef = new Uint32Array(this.capacity);
    this.rangeIdx = new Uint32Array(this.capacity);
    this.annotationStart = new Uint32Array(this.capacity);
    this.annotationCount = new Uint32Array(this.capacity);
    this.varargs = new Uint8Array(this.capacity);
  }

  private ensure(min: number): void {
    if (min <= this.capacity) return;
    let next = this.capacity;
    while (next < min) next *= 2;
    this.name = growU32(this.name, next);
    this.typeRef = growU32(this.typeRef, next);
    this.rangeIdx = growU32(this.rangeIdx, next);
    this.annotationStart = growU32(this.annotationStart, next);
    this.annotationCount = growU32(this.annotationCount, next);
    this.varargs = growU8(this.varargs, next);
    this.capacity = next;
  }
}

function sliceHandles(values: number[], start: number, count: number): number[] {
  return values.slice(start, start + count);
}
