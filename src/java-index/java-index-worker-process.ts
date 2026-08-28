// input: Path of the compiled java-index-worker.js and a JSON-RPC WorkerLike.
// output: A forked Node process with its own --max-old-space-size, isolated from the HTTP daemon.
// pos: Production JavaIndex host. Worker threads inherit the daemon's 768 cap and a V8 OOM aborts the whole process.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  unref?(): void;
  terminate(): Promise<number>;
}

/** Production old-generation cap for the index child. S4 chunked rest segments keep hydrate under this. */
export const JAVA_INDEX_WORKER_MAX_OLD_GENERATION_SIZE_MB = 1536;

const WORKER_KILL_GRACE_MS = 2000;

export function javaIndexWorkerScriptUrl(): URL {
  return new URL("./java-index-worker.js", import.meta.url);
}

export function javaIndexWorkerExecArgv(): string[] {
  return [`--max-old-space-size=${JAVA_INDEX_WORKER_MAX_OLD_GENERATION_SIZE_MB}`];
}

export function envForJavaIndexWorker(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (!env.NODE_OPTIONS) return env;
  const stripped = env.NODE_OPTIONS
    .replace(/--max[-_]old[-_]space[-_]size=\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped) env.NODE_OPTIONS = stripped;
  else delete env.NODE_OPTIONS;
  return env;
}

function isSpawnEbadf(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  return err?.code === "EBADF" || /spawn EBADF/i.test(String(err?.message ?? error));
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export function spawnJavaIndexWorkerProcess(): WorkerLike {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const child = fork(fileURLToPath(javaIndexWorkerScriptUrl()), [], {
        execArgv: javaIndexWorkerExecArgv(),
        env: envForJavaIndexWorker(),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        serialization: "advanced"
      });
      return new ChildProcessWorker(child);
    } catch (error) {
      lastError = error;
      if (!isSpawnEbadf(error) || attempt === 4) throw error;
      sleepSync(25 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class ChildProcessWorker implements WorkerLike {
  private exitCode: number | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly child: ChildProcess) {
    this.child.once("exit", (code, signal) => {
      this.clearKillTimer();
      this.exitCode = code ?? signalExitCode(signal);
    });
  }

  postMessage(value: unknown): void {
    if (!this.child.connected) return;
    this.child.send(value as object);
  }

  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)
  ): this {
    if (event === "message") {
      this.child.on("message", listener as (value: unknown) => void);
      return this;
    }
    if (event === "error") {
      this.child.on("error", listener as (error: Error) => void);
      return this;
    }
    this.child.on("exit", (code, signal) => {
      (listener as (code: number) => void)(code ?? signalExitCode(signal));
    });
    return this;
  }

  unref(): void {
    this.child.unref();
  }

  terminate(): Promise<number> {
    if (this.exitCode !== undefined) return Promise.resolve(this.exitCode);
    if (this.child.exitCode !== null || this.child.signalCode) {
      return Promise.resolve(this.child.exitCode ?? signalExitCode(this.child.signalCode));
    }
    return new Promise(resolve => {
      this.child.once("exit", (code, signal) => {
        this.clearKillTimer();
        resolve(code ?? signalExitCode(signal));
      });
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (this.child.exitCode === null && !this.child.signalCode) {
          this.child.kill("SIGKILL");
        }
      }, WORKER_KILL_GRACE_MS);
      this.killTimer.unref();
    });
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }
}

function signalExitCode(_signal: NodeJS.Signals | null): number {
  return 1;
}
