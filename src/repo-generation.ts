// input: Change events and snapshot-rebase requests.
// output: A monotonic generation number plus a dirty flag every repo-scoped cache
//         keys on.
// pos: The single freshness clock for a repo runtime. clearDirty is compare-and-set
//      so an event arriving during reconcile keeps the runtime dirty.

export class GenerationClock {
  private value = 1;
  private dirty = false;
  private lastReason = "initial";
  private lastChangedAt = new Date();

  snapshot(): { value: number; dirty: boolean } {
    return { value: this.value, dirty: this.dirty };
  }

  rebaseAtLeast(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid generation rebase: ${value}`);
    }
    this.value = Math.max(this.value, value);
    this.lastReason = "snapshot rebase";
    this.lastChangedAt = new Date();
    return this.value;
  }

  status(): { value: number; dirty: boolean; lastReason: string; lastChangedAt: string } {
    return {
      value: this.value,
      dirty: this.dirty,
      lastReason: this.lastReason,
      lastChangedAt: this.lastChangedAt.toISOString()
    };
  }

  advance(reason: string): number {
    this.value += 1;
    this.lastReason = reason;
    this.lastChangedAt = new Date();
    return this.value;
  }

  markDirty(reason: string): number {
    this.dirty = true;
    return this.advance(reason);
  }

  clearDirty(expectedGeneration: number): void {
    // Compare-and-set: a change during reconcile advances the value, so this
    // no-ops and the runtime stays dirty until a reconcile catches up.
    if (this.value === expectedGeneration) this.dirty = false;
  }
}

export type RepoChangeKind =
  | "JAVA_ADD"
  | "JAVA_CHANGE"
  | "JAVA_DELETE"
  | "RESOURCE_CHANGE"
  | "BUILD_CHANGE"
  | "WATCHER_DEGRADED";

export type RepoChange = {
  kind: RepoChangeKind;
  absolutePath: string;
};

export type RepoChangeBatch = {
  generation: number;
  observedAt: string;
  changes: RepoChange[];
};

/**
 * Collapses two events for the same path within one debounce window.
 * `undefined` means the two cancel out (add then delete of a file that never
 * existed for consumers) and no change should be emitted.
 */
export function mergeChangeKind(
  oldKind: RepoChangeKind,
  newKind: RepoChangeKind
): RepoChangeKind | undefined {
  if (oldKind === "JAVA_ADD" && newKind === "JAVA_DELETE") return undefined;
  if (oldKind === "JAVA_ADD") return "JAVA_ADD"; // a just-added file that changes is still an add
  if (oldKind === "JAVA_DELETE" && newKind === "JAVA_ADD") return "JAVA_CHANGE"; // delete+recreate = change
  return newKind;
}
