// input: familyHash + rootId (repoHash).
// output: A WorkerLike handle multiplexed onto one OS process per Git family.
// pos: FS2(a). Existing RPCs gain rootId; request ids are remapped per handle.
import { spawnJavaIndexWorkerProcess, type WorkerLike } from "./java-index-worker-process.js";

type PendingMap = Map<number, number>;

type FamilySlot = {
  child: WorkerLike;
  roots: Set<string>;
  nextId: number;
  handles: Set<FamilyWorkerHandle>;
};

class FamilyWorkerHandle implements WorkerLike {
  private readonly outbound: PendingMap = new Map();
  private readonly messageListeners: Array<(value: unknown) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private terminated = false;

  constructor(
    private readonly pool: FamilyWorkerPool,
    private readonly familyKey: string,
    private readonly rootId: string,
    private readonly slot: FamilySlot
  ) {
    this.slot.roots.add(rootId);
    this.slot.handles.add(this);
    this.slot.child.on("message", (value: unknown) => this.dispatchMessage(value));
    this.slot.child.on("error", (error: Error) => {
      for (const listener of this.errorListeners) listener(error);
    });
    this.slot.child.on("exit", (code: number) => {
      for (const listener of this.exitListeners) listener(code);
    });
  }

  postMessage(value: unknown): void {
    if (this.terminated) return;
    const envelope = value as { id: number };
    const innerId = this.slot.nextId += 1;
    this.outbound.set(innerId, envelope.id);
    this.slot.child.postMessage({ ...(value as object), id: innerId, rootId: this.rootId });
  }

  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)
  ): this {
    if (event === "message") this.messageListeners.push(listener as (value: unknown) => void);
    else if (event === "error") this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number) => void);
    return this;
  }

  unref(): void {
    this.slot.child.unref?.();
  }

  async terminate(): Promise<number> {
    if (this.terminated) return 0;
    this.terminated = true;
    return this.pool.release(this.familyKey, this.rootId, this);
  }

  dispatchMessage(value: unknown): void {
    const envelope = value as { id?: number };
    if (typeof envelope.id !== "number") return;
    const outerId = this.outbound.get(envelope.id);
    if (outerId === undefined) return;
    this.outbound.delete(envelope.id);
    const remapped = { ...(value as object), id: outerId };
    for (const listener of this.messageListeners) listener(remapped);
  }
}

export class FamilyWorkerPool {
  private readonly slots = new Map<string, FamilySlot>();

  constructor(private readonly spawn: () => WorkerLike = spawnJavaIndexWorkerProcess) {}

  acquire(familyKey: string, rootId: string): WorkerLike {
    let slot = this.slots.get(familyKey);
    if (!slot) {
      slot = { child: this.spawn(), roots: new Set(), nextId: 0, handles: new Set() };
      this.slots.set(familyKey, slot);
    }
    return new FamilyWorkerHandle(this, familyKey, rootId, slot);
  }

  async release(familyKey: string, rootId: string, handle: FamilyWorkerHandle): Promise<number> {
    const slot = this.slots.get(familyKey);
    if (!slot) return 0;
    slot.handles.delete(handle);
    slot.roots.delete(rootId);
    if (slot.roots.size > 0) return 0;
    this.slots.delete(familyKey);
    return slot.child.terminate();
  }

  liveFamilies(): string[] {
    return [...this.slots.keys()];
  }

  rootCount(familyKey: string): number {
    return this.slots.get(familyKey)?.roots.size ?? 0;
  }
}

const defaultFamilyPool = new FamilyWorkerPool();

export function familyWorkerFactory(familyKey: string, rootId: string): () => WorkerLike {
  return () => defaultFamilyPool.acquire(familyKey, rootId);
}

export function defaultFamilyWorkerPool(): FamilyWorkerPool {
  return defaultFamilyPool;
}
