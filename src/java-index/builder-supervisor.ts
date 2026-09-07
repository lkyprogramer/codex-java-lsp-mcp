import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { close, openIndexDb } from "./sql/driver.js";
import { readBuildProgress } from "./builder/progress.js";

export const DEFAULT_BUILDER_IDLE_MS = 60_000;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
export const DEFAULT_STALL_MS = 120_000;
export const DEFAULT_MAX_RESTARTS = 2;

export type BuilderSupervisorJob = {
  id?: number; kind: "refresh" | "resources" | "reconcile"; generation?: number; changed?: string[]; deleted?: string[];
};
export type BuilderSupervisorResult = { id: number; ok: boolean; indexedGeneration: number; files: number; error?: string };
export type BuilderSupervisorState = "idle" | "busy" | "cold-building" | "absent";
export type BuilderSupervisorStatus = { state: BuilderSupervisorState; pid?: number; queued: number };
export type BuilderSupervisorOptions = {
  repoRoot: string; dbPath: string; scriptPath?: string; idleMs?: number;
  watchdogIntervalMs?: number; stallMs?: number; maxRestarts?: number; env?: NodeJS.ProcessEnv;
};
type QueueItem =
  | { kind: "serve"; job: BuilderSupervisorJob; resolve: (result: BuilderSupervisorResult) => void }
  | { kind: "cold"; resolve: () => void; reject: (error: Error) => void };

function envIdleMs(): number {
  const raw = Number(process.env.JAVA_LSP_BUILDER_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BUILDER_IDLE_MS;
}

function builderExecArgv(source = process.execArgv): string[] {
  const filtered = source.filter(arg => !/--max[-_]old[-_]space[-_]size/i.test(arg) && !arg.startsWith("--test"));
  if (filtered.includes("--disable-warning=ExperimentalWarning")) return filtered;
  return ["--disable-warning=ExperimentalWarning", ...filtered];
}

function builderEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!env.NODE_OPTIONS) return env;
  const stripped = env.NODE_OPTIONS.replace(/--max[-_]old[-_]space[-_]size=\d+/gi, "").replace(/\s+/g, " ").trim();
  if (stripped) env.NODE_OPTIONS = stripped;
  else delete env.NODE_OPTIONS;
  return env;
}

function defaultScriptPath(): string {
  return fileURLToPath(new URL("./builder/builder-main.js", import.meta.url));
}

function progressFingerprint(dbPath: string): string {
  try {
    const db = openIndexDb(dbPath, { readOnly: true });
    try {
      const progress = readBuildProgress(db);
      return progress ? `${progress.phase}:${progress.done}:${progress.total}` : "";
    } finally {
      close(db);
    }
  } catch {
    return "";
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, "exit").then(() => undefined, () => undefined);
}

function failResult(id: number, error: string): BuilderSupervisorResult {
  return { id, ok: false, indexedGeneration: 0, files: 0, error };
}

function asResult(id: number, raw: unknown): BuilderSupervisorResult {
  const value = raw as Partial<BuilderSupervisorResult>;
  return {
    id: typeof value.id === "number" ? value.id : id,
    ok: value.ok === true,
    indexedGeneration: typeof value.indexedGeneration === "number" ? value.indexedGeneration : 0,
    files: typeof value.files === "number" ? value.files : 0,
    ...(typeof value.error === "string" ? { error: value.error } : value.ok === true ? {} : { error: "builder failed" })
  };
}

export class BuilderSupervisor {
  private readonly idleMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly stallMs: number;
  private readonly maxRestarts: number;
  private readonly scriptPath: string;
  private nextId = 1;
  private child: ChildProcess | undefined;
  private lines: Interface | undefined;
  private role: "serve" | "cold" | undefined;
  private queue: QueueItem[] = [];
  private pumping = false;
  private inflight = false;
  private coldRunning = false;
  private stopped = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private exiting = false;

  constructor(private readonly options: BuilderSupervisorOptions) {
    this.idleMs = options.idleMs ?? envIdleMs();
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.scriptPath = options.scriptPath ?? defaultScriptPath();
  }

  status(): BuilderSupervisorStatus {
    const pid = this.child?.pid;
    const queued = this.queue.length;
    if (this.coldRunning) return { state: "cold-building", ...(pid !== undefined ? { pid } : {}), queued };
    if (this.inflight || this.pumping && queued > 0) {
      return { state: "busy", ...(pid !== undefined ? { pid } : {}), queued };
    }
    if (this.child && this.role === "serve" && !this.exiting) {
      return { state: "idle", ...(pid !== undefined ? { pid } : {}), queued };
    }
    return { state: "absent", queued };
  }

  submit(job: BuilderSupervisorJob): Promise<BuilderSupervisorResult> {
    const withId = { ...job, id: job.id ?? this.nextId++ };
    return new Promise(resolve => {
      this.queue.push({ kind: "serve", job: withId, resolve });
      void this.pump();
    });
  }

  coldBuild(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "cold", resolve, reject });
      void this.pump();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearIdle();
    this.clearWatchdog();
    await this.shutdownChild();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const item = this.queue.shift()!;
        this.clearIdle();
        this.inflight = true;
        this.coldRunning = item.kind === "cold";
        try {
          if (item.kind === "serve") item.resolve(await this.runServe(item.job));
          else {
            await this.runCold();
            item.resolve();
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (item.kind === "serve") item.resolve(failResult(item.job.id ?? -1, error.message));
          else item.reject(error);
        } finally {
          this.inflight = false;
          this.coldRunning = false;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.stopped && this.queue.length === 0) this.armIdle();
    }
  }

  private async runServe(job: BuilderSupervisorJob): Promise<BuilderSupervisorResult> {
    const id = job.id ?? -1;
    for (let attempt = 0; attempt <= this.maxRestarts; attempt += 1) {
      if (this.stopped) return failResult(id, "builder stopped");
      try {
        return await this.runServeOnce(job);
      } catch (err) {
        await this.killChild();
        if (this.stopped || attempt === this.maxRestarts) {
          return failResult(id, err instanceof Error ? err.message : String(err));
        }
      }
    }
    return failResult(id, "builder stalled");
  }

  private async runCold(): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRestarts; attempt += 1) {
      if (this.stopped) return;
      try {
        await this.runColdOnce();
        return;
      } catch (err) {
        await this.killChild();
        if (this.stopped || attempt === this.maxRestarts) throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  private async runServeOnce(job: BuilderSupervisorJob): Promise<BuilderSupervisorResult> {
    const child = await this.ensureServe();
    const id = job.id ?? -1;
    const result = this.waitForResult(id);
    const stalled = this.watchStall();
    try {
      child.stdin!.write(`${JSON.stringify(job)}\n`);
      return asResult(id, await Promise.race([result.promise, stalled]));
    } finally {
      result.cancel();
      this.clearWatchdog();
    }
  }

  private async runColdOnce(): Promise<void> {
    await this.shutdownChild();
    const child = this.spawn("cold");
    child.stdout?.resume();
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    const stalled = this.watchStall();
    try {
      const outcome = await Promise.race([
        exit.then(([code, signal]) => ({ type: "exit" as const, code, signal })),
        stalled.then(() => ({ type: "stall" as const }), () => ({ type: "stall" as const }))
      ]);
      if (outcome.type === "stall") {
        child.kill("SIGKILL");
        await waitForExit(child);
        throw new Error("builder stalled");
      }
      if (outcome.code !== 0) throw new Error(`cold-build exited ${outcome.code ?? outcome.signal ?? "unknown"}`);
    } finally {
      this.clearWatchdog();
      if (this.child === child) this.clearChild(child);
    }
  }

  private async ensureServe(): Promise<ChildProcess> {
    if (this.child && this.role === "serve" && !this.exiting) return this.child;
    if (this.child) await this.shutdownChild();
    return this.spawn("serve");
  }

  private spawn(role: "serve" | "cold"): ChildProcess {
    const child = fork(this.scriptPath, ["--repo", this.options.repoRoot, "--db", this.options.dbPath, "--mode", role], {
      execArgv: builderExecArgv(),
      env: builderEnv(this.options.env),
      stdio: ["pipe", "pipe", "inherit", "ipc"]
    });
    this.child = child;
    this.role = role;
    this.exiting = false;
    if (role === "serve" && child.stdout) {
      this.lines = createInterface({ input: child.stdout });
    }
    child.once("exit", () => {
      if (this.child === child) this.clearChild(child);
    });
    return child;
  }

  private waitForResult(id: number): { promise: Promise<unknown>; cancel: () => void } {
    const child = this.child;
    const lines = this.lines;
    if (!child || !lines) {
      return { promise: Promise.reject(new Error("builder stdout missing")), cancel() {} };
    }
    let cancel: () => void = () => undefined;
    const promise = new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (typeof parsed === "object" && parsed !== null && (parsed as { id?: unknown }).id === id) {
          cleanup();
          resolve(parsed);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("builder exited"));
      };
      const cleanup = () => {
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      cancel = cleanup;
      lines.on("line", onLine);
      child.once("exit", onExit);
    });
    return { promise, cancel };
  }

  private watchStall(): Promise<never> {
    let last = progressFingerprint(this.options.dbPath);
    let changedAt = Date.now();
    return new Promise((_resolve, reject) => {
      this.clearWatchdog();
      this.watchdogTimer = setInterval(() => {
        const next = progressFingerprint(this.options.dbPath);
        if (next !== last) {
          last = next;
          changedAt = Date.now();
          return;
        }
        if (Date.now() - changedAt >= this.stallMs) {
          this.clearWatchdog();
          reject(new Error("builder stalled"));
        }
      }, this.watchdogIntervalMs);
    });
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.child || this.role !== "serve" || this.stopped || this.queue.length > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.shutdownChild();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private async shutdownChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.exiting = true;
    this.clearIdle();
    child.stdin?.on("error", () => {});
    const alive = child.exitCode === null && child.signalCode === null;
    if (this.role === "serve" && alive && child.stdin?.writable) {
      try {
        child.stdin.write(`${JSON.stringify({ kind: "exit" })}\n`);
      } catch {
        child.kill("SIGKILL");
      }
    } else if (alive) {
      child.kill("SIGKILL");
    }
    const timedOut = await Promise.race([
      waitForExit(child).then(() => false),
      new Promise<boolean>(resolve => {
        setTimeout(() => resolve(true), 1000);
      })
    ]);
    if (timedOut) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    this.clearChild(child);
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
    this.clearChild(child);
  }

  private clearChild(child: ChildProcess): void {
    if (this.child !== child && this.child !== undefined) return;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    this.role = undefined;
    this.exiting = false;
  }
}
