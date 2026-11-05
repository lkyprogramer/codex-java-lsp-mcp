// input: the owner's lock (fd4) and its Gradle domain recovery state.
// output: two admission gates for a (re)started owner: static (builder/query slots) and semantic (JDT).
// pos: MAC-06C. The launcher acquires the owner lock only after every process
//      of the previous owner group closed its inherited fd4, so a new owner
//      exists only once the old group released the lock. Static slots open
//      after this owner verified its own lock; semantic admission stays with
//      GradleDomain until its external cleanup proved the old daemons gone.
//      Formal binding/transport/GC recovery is G09, not this gate.
import type { GradleDomain } from "../mac-platform/gradle-domain.js";

export type OwnerAdmissionStatus = {
  staticAdmission: "CLOSED" | "OPEN";
  semanticState: ReturnType<GradleDomain["status"]>["semanticState"] | "NONE";
  failure?: string;
};

export class OwnerAdmission {
  private staticOpen = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    /** Verifies this process still holds the owner lock it was started with (assertOwnerLock). */
    private readonly verifyLock: () => void,
    private readonly semantic?: Pick<GradleDomain, "status" | "assertSemanticAdmission" | "ownerBindingRestored">
  ) {}

  /** Gate for BuildScheduler/QueryPool `admitted`. */
  readonly admitted = (): boolean => this.staticOpen;

  /** Wakes a gated scheduler or pool once static admission opens. */
  onOpen(listener: () => void): void {
    this.listeners.add(listener);
    if (this.staticOpen) listener();
  }

  /** Opens builder/query slots. Throws, leaving them closed, unless this owner holds its lock. */
  openStatic(): void {
    if (this.staticOpen) return;
    this.verifyLock();
    this.staticOpen = true;
    this.semantic?.ownerBindingRestored();
    for (const listener of this.listeners) listener();
  }

  /** Semantic (JDT) work waits for the Gradle domain's own recovery, whatever the static gate says. */
  assertSemanticAdmission(): void {
    if (!this.semantic) throw new Error("no semantic domain");
    this.semantic.assertSemanticAdmission();
  }

  status(): OwnerAdmissionStatus {
    const semantic = this.semantic?.status();
    return { staticAdmission: this.staticOpen ? "OPEN" : "CLOSED", semanticState: semantic?.semanticState ?? "NONE",
      ...(semantic?.failure ? { failure: semantic.failure } : {}) };
  }
}
