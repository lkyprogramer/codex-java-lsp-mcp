// input: MCP stdio lifecycle events and tool request completion.
// output: Idempotent whole-server shutdown on transport loss or bounded inactivity.
// pos: Process-level lifecycle owner; separate from per-repo JDT LS eviction.

const DEFAULT_SERVER_IDLE_TTL_MS = 900000;

export type ServerShutdownReason =
  | "idle_timeout"
  | "startup_failure"
  | "stdio_close"
  | "stdio_end"
  | "stdio_error"
  | "sigint"
  | "sigterm";

export type ServerLifecycleTimer = {
  unref?(): unknown;
};

export type ServerLifecycleClock = {
  setTimeout(callback: () => void, delayMs: number): ServerLifecycleTimer;
  clearTimeout(timer: ServerLifecycleTimer): void;
};

type StdioInput = Pick<NodeJS.EventEmitter, "once" | "off">;

type ServerLifecycleOptions = {
  stdin: StdioInput;
  idleTtlMs: number;
  shutdown(reason: ServerShutdownReason): Promise<void>;
  exit?(code: number): void;
  reportFailure?(reason: ServerShutdownReason, error: unknown): void;
  clock?: ServerLifecycleClock;
};

const systemClock: ServerLifecycleClock = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as NodeJS.Timeout);
  }
};

/** Parses the whole-MCP idle TTL. Zero deliberately disables process self-retirement. */
export function parseServerIdleTtlMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_SERVER_IDLE_TTL_MS;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SERVER_IDLE_TTL_MS;
}

export function serverIdleTtlMs(): number {
  return parseServerIdleTtlMs(process.env.JAVA_LSP_SERVER_IDLE_TTL_MS);
}

export class McpServerLifecycle {
  private readonly clock: ServerLifecycleClock;
  private readonly onStdioEnd = () => { void this.shutdown("stdio_end"); };
  private readonly onStdioClose = () => { void this.shutdown("stdio_close"); };
  private readonly onStdioError = () => { void this.shutdown("stdio_error", 1); };
  private activeRequests = 0;
  private idleTimer?: ServerLifecycleTimer;
  private listening = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: ServerLifecycleOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Starts transport-loss detection; call markReady() once the MCP transport is connected. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.stdin.once("end", this.onStdioEnd);
    this.options.stdin.once("close", this.onStdioClose);
    this.options.stdin.once("error", this.onStdioError);
  }

  markReady(): void {
    this.scheduleIdleShutdown();
  }

  async runRequest<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shutdownPromise) {
      throw new Error("codex-java-lsp is shutting down");
    }
    this.activeRequests += 1;
    this.clearIdleShutdown();
    try {
      return await operation();
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) {
        this.scheduleIdleShutdown();
      }
    }
  }

  shutdown(reason: ServerShutdownReason, exitCode = 0): Promise<void> {
    if (!this.shutdownPromise) {
      this.clearIdleShutdown();
      this.detachStdioListeners();
      this.shutdownPromise = this.finishShutdown(reason, exitCode);
    }
    return this.shutdownPromise;
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer || this.activeRequests > 0 || this.shutdownPromise || this.options.idleTtlMs === 0) {
      return;
    }
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeRequests === 0) {
        void this.shutdown("idle_timeout");
      }
    }, this.options.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private clearIdleShutdown(): void {
    if (!this.idleTimer) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private detachStdioListeners(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.stdin.off("end", this.onStdioEnd);
    this.options.stdin.off("close", this.onStdioClose);
    this.options.stdin.off("error", this.onStdioError);
  }

  private async finishShutdown(reason: ServerShutdownReason, exitCode: number): Promise<void> {
    try {
      await this.options.shutdown(reason);
      (this.options.exit ?? process.exit)(exitCode);
    } catch (error) {
      this.options.reportFailure?.(reason, error);
      (this.options.exit ?? process.exit)(1);
    }
  }
}
