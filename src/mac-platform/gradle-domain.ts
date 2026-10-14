import path from "node:path";
import os from "node:os";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";

export function jdtGradleHome(): string {
  const root = process.env.JAVA_LSP_SERVICE_STATE_ROOT ?? path.join(os.homedir(), "Library/Application Support/codex-java-lsp-mcp/state");
  if (!path.isAbsolute(root)) throw new Error("absolute service state root required");
  return path.join(root, "jdt-gradle-home");
}
export type GradleDistribution = { version: string; launcher: string; launcherSha256: string; javaHome: string };
export type GradleDomainState = "RECOVERING" | "READY" | "RECOVERY_BLOCKED";
export type GradleCleanupIO = {
  execute(distribution: GradleDistribution, args: string[], home: string, timeoutMs: number): Promise<string>;
  alive(pid: number): boolean;
};
const execute = promisify(execFile);
export const defaultGradleCleanupIO: GradleCleanupIO = {
  async execute(distribution, args, home, timeoutMs) {
    const started = performance.now();
    const digest = createHash("sha256").update(await readFile(distribution.launcher)).digest("hex");
    if (digest !== distribution.launcherSha256) throw new Error("frozen Gradle launcher changed");
    const remainingMs = Math.ceil(timeoutMs - (performance.now() - started));
    if (remainingMs <= 0) throw new Error("Gradle command deadline exceeded");
    return (await execute(distribution.launcher, [...args, "--gradle-user-home", home], {
      timeout: remainingMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { HOME: process.env.HOME, PATH: `${distribution.javaHome}/bin:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR,
        JAVA_HOME: distribution.javaHome, GRADLE_USER_HOME: home }
    })).stdout;
  },
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
};

/** Service-domain cleanup. Session stop never stops another repo's Gradle. */
export class GradleDomain {
  private state: GradleDomainState = "RECOVERING";
  private inFlight?: Promise<void>;
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private failure?: string;
  private staticReady = false;
  constructor(readonly home: string, readonly distributions: readonly GradleDistribution[], private readonly io = defaultGradleCleanupIO) {
    if (!path.isAbsolute(home) || path.resolve(home) !== home || new Set(distributions.map(item => item.version)).size !== distributions.length ||
        distributions.some(item => !/^\d+\.\d+(?:\.\d+)?$/.test(item.version) || !path.isAbsolute(item.launcher) || !path.isAbsolute(item.javaHome) || !/^[a-f0-9]{64}$/.test(item.launcherSha256)))
      throw new Error("explicit private Gradle domain and frozen versions required");
  }
  ownerBindingRestored(): void { this.staticReady = true; }
  status(): { staticAdmission: boolean; semanticState: GradleDomainState; failure?: string } {
    return { staticAdmission: this.staticReady, semanticState: this.state, ...(this.failure ? { failure: this.failure } : {}) };
  }
  assertSemanticAdmission(): void {
    if (this.state !== "READY") throw new JavaIntelligenceError("JDT_NOT_READY", `semanticState=${this.state}${this.failure ? `: ${this.failure}` : ""}`);
  }
  recover(closeJdt: () => Promise<void>, faultAt = performance.now(), budgetMs = 10000): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!Number.isFinite(faultAt) || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 10000) throw new Error("bounded Gradle recovery required");
    this.state = "RECOVERING";
    this.failure = undefined;
    const operation = this.cleanup(closeJdt, faultAt + budgetMs).then(() => { this.state = "READY"; }, error => {
      this.state = "RECOVERY_BLOCKED";
      this.failure = error instanceof Error ? error.message : "Gradle cleanup failed";
      throw error;
    }).finally(() => {
      // Returning a bounded error is not proof that a timed-out callback/CLI
      // exited. Keep the single-flight claim until the actual operation settles.
      if (this.inFlight === operation && this.pendingOperations.size === 0) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }
  private async cleanup(closeJdt: () => Promise<void>, deadline: number): Promise<void> {
    const remaining = () => { const ms = Math.ceil(deadline - performance.now()); if (ms <= 0) throw new Error("Gradle recovery deadline exceeded"); return ms; };
    // A hung caller is still bounded. No new semantic admission is possible
    // until every session and actual daemon exit has been proved.
    await this.bounded(closeJdt, deadline, "JDT close");
    await mkdir(this.home, { recursive: true });
    if (await realpath(this.home) !== this.home) throw new Error("canonical private Gradle home required");
    if (this.distributions.length === 0) throw new Error("actual Gradle distributions are not frozen");
    for (const distribution of this.distributions) {
      const command = (args: string[]) => this.bounded(() => this.io.execute(distribution, args, this.home, remaining()), deadline, "Gradle command");
      const status = await command(["--status"]);
      // Gradle's version-scoped registry is authoritative for this domain;
      // PIDs are observed, never used as targets of a kill operation.
      const pids = status.split("\n").flatMap(line => {
        const match = /^\s*(\d+)\s+(IDLE|BUSY|CANCELED|STOPPED)\b/.exec(line);
        return match ? [Number(match[1])] : [];
      });
      if (!/No Gradle daemons are running|\bPID\s+STATUS\b/.test(status)) throw new Error("unrecognized Gradle status response");
      await command(["--stop"]);
      while (pids.some(pid => this.io.alive(pid))) { remaining(); await delay(25); }
      const after = await command(["--status"]);
      if (/^\s*\d+\s+(IDLE|BUSY|CANCELED)\b/m.test(after)) throw new Error("Gradle daemon remains after stop");
      if (!/No Gradle daemons are running|\bPID\s+STATUS\b/.test(after)) throw new Error("unrecognized Gradle status response");
    }
  }
  private async bounded<T>(operation: () => Promise<T>, deadline: number, stage: string): Promise<T> {
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) throw new Error(`${stage} deadline exceeded`);
    const running = Promise.resolve().then(operation);
    this.pendingOperations.add(running);
    const settled = () => {
      this.pendingOperations.delete(running);
      if (this.state === "RECOVERY_BLOCKED" && this.pendingOperations.size === 0) this.inFlight = undefined;
    };
    void running.then(settled, settled);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([running, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} deadline exceeded`)), remainingMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}
