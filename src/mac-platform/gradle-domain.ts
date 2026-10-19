import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";

export function jdtGradleHome(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.JAVA_LSP_SERVICE_STATE_ROOT ?? path.join(os.homedir(), "Library/Application Support/codex-java-lsp-mcp/state");
  if (!path.isAbsolute(root)) throw new Error("absolute service state root required");
  return path.join(root, "jdt-gradle-home");
}
export type GradleDistribution = { version: string; launcher: string; launcherSha256: string; javaHome: string };
/**
 * The versions to clean, read when a cleanup runs (a daemon may have started since the last one).
 * `unavailable`: versions this home used that have no verified local distribution; the others are
 * still stopped, then the cleanup fails.
 */
export type GradleDistributionSource = (home: string) => Promise<{ distributions: readonly GradleDistribution[]; unavailable: readonly string[] }>;
/** An explicitly configured local installation; `gradleHome` is required for the one JDT imports with. */
export type ConfiguredGradleDistribution = GradleDistribution & { gradleHome?: string };
export type GradleDistributionConfig = { distributions: readonly ConfiguredGradleDistribution[]; import?: string };
/** JDT import with a configured installation instead of the project's wrapper. */
export type GradleImport = { gradleHome: string; javaHome: string };
export type GradleDomainState = "RECOVERING" | "READY" | "RECOVERY_BLOCKED";
export type GradleCleanupIO = {
  execute(distribution: GradleDistribution, args: string[], home: string, timeoutMs: number): Promise<string>;
  alive(pid: number): boolean;
  /** The command line of a live pid (observed only, never a kill target); undefined when unknown. */
  command?(pid: number): Promise<string | undefined>;
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
  },
  async command(pid) {
    try { return (await execute("/bin/ps", ["-o", "command=", "-p", String(pid)], { timeout: 2000, maxBuffer: 64 * 1024 })).stdout.trim() || undefined; }
    catch { return undefined; }
  }
};

/** A daemon log newer than this may belong to a daemon still registering; older ones belong to registered or dead daemons. */
const STARTING_DAEMON_LOG_MS = 5 * 60_000;

/** Service-domain cleanup. Session stop never stops another repo's Gradle. */
export class GradleDomain {
  private state: GradleDomainState = "RECOVERING";
  private inFlight?: Promise<void>;
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private failure?: string;
  private staticReady = false;
  constructor(readonly home: string, private readonly distributions: readonly GradleDistribution[] | GradleDistributionSource,
    private readonly io = defaultGradleCleanupIO, private readonly importSource?: () => GradleImport | undefined) {
    if (!path.isAbsolute(home) || path.resolve(home) !== home || (typeof distributions !== "function" && !validDistributions(distributions)))
      throw new Error("explicit private Gradle domain and frozen versions required");
  }
  /** The installation JDT imports with, as configured for the last cleanup (semantic admission follows only a successful one). */
  get gradleImport(): GradleImport | undefined { return this.importSource?.(); }
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
    let distributions: readonly GradleDistribution[];
    let unavailable: readonly string[] = [];
    if (typeof this.distributions === "function") {
      const source = this.distributions;
      // Discovered: no daemon registry in this home means nothing of this domain can be running.
      ({ distributions, unavailable } = await this.bounded(() => source(this.home), deadline, "Gradle distribution discovery"));
      if (!validDistributions(distributions)) throw new Error("discovered Gradle distributions are invalid");
    } else {
      distributions = this.distributions;
      if (distributions.length === 0) throw new Error("actual Gradle distributions are not frozen");
    }
    for (const distribution of distributions) {
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
      // A daemon whose client died before it registered (an owner killed during a first import) is
      // invisible to --status and --stop, but its fresh log names it: --stop again once it registered.
      while ((await this.bounded(() => this.startingDaemons(distribution.version), deadline, "Gradle daemon log scan")).length) {
        remaining(); await delay(250);
        await command(["--stop"]);
      }
    }
    if (unavailable.length) throw new Error(`Gradle ${unavailable.join(", ")} ran in this domain but has no verified local distribution`);
  }
  /** Live pids of this home's recent daemon logs for one version that still run that version's daemon. */
  private async startingDaemons(version: string): Promise<number[]> {
    const command = this.io.command;
    if (!command) return [];
    const dir = path.join(this.home, "daemon", version);
    const names = await readdir(dir).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; });
    const daemon = new RegExp(`org\\.gradle\\.launcher\\.daemon\\.bootstrap\\.GradleDaemon ${version.replaceAll(".", "\\.")}(\\s|$)`);
    const pids: number[] = [];
    for (const name of names) {
      const pid = Number(/^daemon-(\d+)\.out\.log$/.exec(name)?.[1]);
      if (!pid || !this.io.alive(pid)) continue;
      const info = await stat(path.join(dir, name)).catch(() => undefined);
      if (!info || Date.now() - info.birthtimeMs > STARTING_DAEMON_LOG_MS) continue;
      if (daemon.test((await command.call(this.io, pid)) ?? "")) pids.push(pid);
    }
    return pids;
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

const GRADLE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
function validDistributions(distributions: readonly GradleDistribution[]): boolean {
  return new Set(distributions.map(item => item.version)).size === distributions.length && distributions.every(item =>
    GRADLE_VERSION.test(item.version) && path.isAbsolute(item.launcher) && path.isAbsolute(item.javaHome) && /^[a-f0-9]{64}$/.test(item.launcherSha256));
}

/**
 * `JAVA_LSP_GRADLE_DISTRIBUTIONS`: an absolute path to
 * `{ "distributions": [{ version, launcher, launcherSha256, javaHome, gradleHome? }], "import"?: version }`.
 */
export function loadGradleDistributionConfig(env: NodeJS.ProcessEnv = process.env): GradleDistributionConfig {
  const file = env.JAVA_LSP_GRADLE_DISTRIBUTIONS;
  if (!file) return { distributions: [] };
  if (!path.isAbsolute(file)) throw new Error("JAVA_LSP_GRADLE_DISTRIBUTIONS must be an absolute path");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GradleDistributionConfig>;
  const distributions = Array.isArray(parsed.distributions) ? parsed.distributions : [];
  if (!validDistributions(distributions) || distributions.some(item => item.gradleHome !== undefined && !path.isAbsolute(item.gradleHome)))
    throw new Error(`invalid Gradle distributions in ${file}`);
  if (parsed.import !== undefined && !distributions.some(item => item.version === parsed.import && item.gradleHome))
    throw new Error(`Gradle import version ${parsed.import} has no configured gradleHome`);
  return { distributions, ...(parsed.import ? { import: parsed.import } : {}) };
}

/**
 * The versions this home actually used (its `daemon/<version>` registries), each matched to a
 * configured installation or, failing that, to a wrapper distribution this home itself unpacked.
 * A used version with neither cannot be stopped: cleanup fails rather than download one.
 */
export function discoveredGradleDistributions(config: GradleDistributionConfig, javaHome = process.env.JAVA_HOME): GradleDistributionSource {
  return async home => {
    const versions = (await readdir(path.join(home, "daemon"), { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })).filter(entry => entry.isDirectory() && GRADLE_VERSION.test(entry.name)).map(entry => entry.name).sort();
    const distributions: GradleDistribution[] = [];
    const unavailable: string[] = [];
    for (const version of versions) {
      const configured = config.distributions.find(item => item.version === version);
      if (configured) { distributions.push({ version, launcher: configured.launcher, launcherSha256: configured.launcherSha256, javaHome: configured.javaHome }); continue; }
      const launcher = await wrapperLauncher(home, version);
      const java = config.distributions[0]?.javaHome ?? javaHome;
      if (!launcher || !java || !path.isAbsolute(java)) { unavailable.push(version); continue; }
      distributions.push({ version, launcher, launcherSha256: createHash("sha256").update(await readFile(launcher)).digest("hex"), javaHome: java });
    }
    return { distributions, unavailable };
  };
}

/** `wrapper/dists/gradle-<v>-{bin,all}/<hash>/gradle-<v>/bin/gradle`, completed (`.zip.ok`) by this home's wrapper. */
async function wrapperLauncher(home: string, version: string): Promise<string | undefined> {
  for (const type of ["bin", "all"]) {
    const dist = path.join(home, "wrapper", "dists", `gradle-${version}-${type}`);
    for (const hash of (await readdir(dist).catch(() => [])).sort()) {
      const launcher = path.join(dist, hash, `gradle-${version}`, "bin", "gradle");
      const complete = await Promise.all([access(launcher), access(path.join(dist, hash, `gradle-${version}-${type}.zip.ok`))]).then(() => true, () => false);
      if (complete) return launcher;
    }
  }
  return undefined;
}

/**
 * The owner daemon's domain: its private home, the versions that home used, and the configured JDT
 * import installation. The configuration is read by every cleanup: an error does not disable the
 * gate, that cleanup fails (RECOVERY_BLOCKED), and a corrected file takes effect at the next one.
 */
export function serviceGradleDomain(env: NodeJS.ProcessEnv = process.env, io = defaultGradleCleanupIO): GradleDomain {
  let imported: GradleImport | undefined;
  return new GradleDomain(jdtGradleHome(env), async home => {
    imported = undefined;
    const config = loadGradleDistributionConfig(env);
    const distribution = config.distributions.find(item => item.version === config.import);
    const found = await discoveredGradleDistributions(config, env.JAVA_HOME)(home);
    if (distribution?.gradleHome) imported = { gradleHome: distribution.gradleHome, javaHome: distribution.javaHome };
    return found;
  }, io, () => imported);
}
