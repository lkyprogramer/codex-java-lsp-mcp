// input: MCP stdio lifecycle events and process signals.
// output: Idempotent whole-server shutdown only when its transport actually ends.
// pos: Process-level lifecycle owner; separate from per-repo JDT LS eviction.

export type ServerShutdownReason =
  | "startup_failure"
  | "stdio_close"
  | "stdio_end"
  | "stdio_error"
  | "sigint"
  | "sigterm";

type StdioInput = Pick<NodeJS.EventEmitter, "once" | "off">;

type ServerLifecycleOptions = {
  stdin: StdioInput;
  shutdown(reason: ServerShutdownReason): Promise<void>;
  exit?(code: number): void;
  reportFailure?(reason: ServerShutdownReason, error: unknown): void;
};

export class McpServerLifecycle {
  private readonly onStdioEnd = () => { void this.shutdown("stdio_end"); };
  private readonly onStdioClose = () => { void this.shutdown("stdio_close"); };
  private readonly onStdioError = () => { void this.shutdown("stdio_error", 1); };
  private listening = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: ServerLifecycleOptions) {}

  /** Starts transport-loss detection; an idle, open stdio connection must stay alive. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.stdin.once("end", this.onStdioEnd);
    this.options.stdin.once("close", this.onStdioClose);
    this.options.stdin.once("error", this.onStdioError);
  }

  shutdown(reason: ServerShutdownReason, exitCode = 0): Promise<void> {
    if (!this.shutdownPromise) {
      this.detachStdioListeners();
      this.shutdownPromise = this.finishShutdown(reason, exitCode);
    }
    return this.shutdownPromise;
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
