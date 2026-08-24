// input: HTTP listener readiness, MCP POST admission, and daemon shutdown requests.
// output: A bounded READY -> DRAINING -> CLOSED lifecycle with in-flight request accounting.
// pos: Transport-level lifecycle; JavaLspApplication owns repository/JDT shutdown separately.
export type HttpServerState = "created" | "ready" | "draining" | "closed";

export type HttpServerLifecycleSnapshot = {
  state: HttpServerState;
  activeRequests: number;
  uptimeMs: number;
};

export class HttpServerLifecycle {
  private readonly createdAt = Date.now();
  private readonly idleWaiters = new Set<() => void>();
  private currentState: HttpServerState = "created";
  private activeRequests = 0;
  private drainPromise?: Promise<void>;

  snapshot(): HttpServerLifecycleSnapshot {
    return {
      state: this.currentState,
      activeRequests: this.activeRequests,
      uptimeMs: Math.max(0, Date.now() - this.createdAt)
    };
  }

  markReady(): void {
    if (this.currentState !== "created") {
      throw new Error(`Cannot mark HTTP server ready from ${this.currentState}.`);
    }
    this.currentState = "ready";
  }

  enterRequest(): (() => void) | undefined {
    if (this.currentState !== "ready") {
      return undefined;
    }
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  drain(deadlineMs: number): Promise<void> {
    if (this.currentState === "closed") {
      return Promise.resolve();
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      return Promise.reject(new Error(`Invalid HTTP drain deadline: ${deadlineMs}`));
    }
    if (!this.drainPromise) {
      this.currentState = "draining";
      this.drainPromise = this.waitForIdle(deadlineMs);
    }
    return this.drainPromise;
  }

  close(): void {
    this.currentState = "closed";
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private waitForIdle(deadlineMs: number): Promise<void> {
    if (this.activeRequests === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        error ? reject(error) : resolve();
      };
      const onIdle = () => finish();
      const timer = setTimeout(() => {
        finish(new Error(`Timed out draining ${this.activeRequests} HTTP request(s).`));
      }, deadlineMs);
      this.idleWaiters.add(onIdle);
    });
  }
}
