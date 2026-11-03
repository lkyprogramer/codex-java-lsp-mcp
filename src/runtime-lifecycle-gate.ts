// input: Per-repository query and lifecycle-control operations.
// output: Phase-fair concurrent query leases and exclusive controls with bounded admission.
// pos: Runtime-local concurrency boundary; never owns cross-process or allocation locks.

type AdmissionTicket = {
  kind: "query" | "control";
  resolve(): void;
  clear(): void;
};

export type RuntimeLifecycleGateState = {
  activeQueries: number;
  controlActive: boolean;
  pendingControls: number;
};

export class RuntimeLifecycleGate {
  private activeQueries = 0;
  private controlActive = false;
  private readonly admissionQueue: AdmissionTicket[] = [];

  state(): RuntimeLifecycleGateState {
    return {
      activeQueries: this.activeQueries,
      controlActive: this.controlActive,
      pendingControls: this.admissionQueue.filter(ticket => ticket.kind === "control").length
    };
  }

  isIdle(): boolean {
    return this.activeQueries === 0 && !this.controlActive && this.admissionQueue.length === 0;
  }

  tryRunQuery<T>(operation: () => Promise<T>): Promise<T> | undefined {
    if (this.controlActive || this.admissionQueue.length > 0) {
      return undefined;
    }
    this.activeQueries += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.activeQueries = Math.max(0, this.activeQueries - 1);
        this.pumpAdmissions();
      });
  }

  async withQuery<T>(operation: () => Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
    await this.acquire("query", deadlineAt(deadlineMs), signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.activeQueries = Math.max(0, this.activeQueries - 1);
      this.pumpAdmissions();
    }
  }

  async withControl<T>(operation: () => Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
    await this.acquire("control", deadlineAt(deadlineMs), signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.controlActive = false;
      this.pumpAdmissions();
    }
  }

  private acquire(kind: AdmissionTicket["kind"], deadline: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(timeoutError(`${kind} admission`));
        return;
      }
      const remove = (error: unknown) => {
        const index = this.admissionQueue.indexOf(ticket);
        if (index < 0) {
          return;
        }
        this.admissionQueue.splice(index, 1);
        ticket.clear();
        reject(error);
        this.pumpAdmissions();
      };
      const abort = () => remove(signal?.reason);
      const timer = setTimeout(() => remove(timeoutError(this.timeoutLabel(ticket))), remaining);
      const ticket: AdmissionTicket = {
        kind, resolve,
        clear() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      };
      this.admissionQueue.push(ticket);
      signal?.addEventListener("abort", abort, { once: true });
      this.pumpAdmissions();
    });
  }

  private pumpAdmissions(): void {
    if (this.controlActive) {
      return;
    }
    if (this.activeQueries > 0) {
      this.admitQueryPhase();
      return;
    }
    const next = this.admissionQueue[0];
    if (!next) {
      return;
    }
    if (next.kind === "control") {
      this.admissionQueue.shift();
      this.controlActive = true;
      next.clear();
      next.resolve();
      return;
    }
    this.admitQueryPhase();
  }

  private admitQueryPhase(): void {
    while (this.admissionQueue[0]?.kind === "query") {
      const query = this.admissionQueue.shift()!;
      this.activeQueries += 1;
      query.clear();
      query.resolve();
    }
  }

  private timeoutLabel(ticket: AdmissionTicket): string {
    if (ticket.kind === "control" && this.activeQueries > 0) {
      return `draining ${this.activeQueries} quer${this.activeQueries === 1 ? "y" : "ies"}`;
    }
    return `${ticket.kind} admission`;
  }
}

function deadlineAt(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new Error(`Invalid runtime lifecycle deadline: ${deadlineMs}`);
  }
  return Date.now() + deadlineMs;
}

function timeoutError(label: string): Error {
  return new Error(`Timed out waiting for runtime lifecycle ${label}.`);
}
