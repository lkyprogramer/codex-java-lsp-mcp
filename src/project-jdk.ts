// input: Java repo files and installed local JDKs.
// output: Project JDK status and build-system facts for JDT LS settings.
// pos: Small stdlib resolver; env is override/fallback, not the normal path.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type BuildSystem = "gradle" | "maven" | "unknown";

export type ProjectJdkStatus = {
  requiredMajor?: number;
  requiredRaw?: string;
  resolvedHome?: string;
  runtimeName?: string;
  primarySource: "env-alias" | "sdkmanrc" | "java-version" | "gradle-toolchain" | "maven" | "mvn-jvm-config" | "env-global" | "fallback" | "missing";
  allSources: string[];
  status: "resolved" | "degraded" | "missing" | "ambiguous";
  candidates: string[];
  notes: string[];
};

type Requirement = {
  major: number;
  raw: string;
  source: ProjectJdkStatus["primarySource"];
  strict: boolean;
};

type InstalledJdk = {
  major: number;
  home: string;
  label: string;
};

export function detectBuildSystem(repoRoot: string): BuildSystem {
  if (existsSync(path.join(repoRoot, "settings.gradle.kts")) || existsSync(path.join(repoRoot, "settings.gradle")) || existsSync(path.join(repoRoot, "build.gradle.kts")) || existsSync(path.join(repoRoot, "build.gradle"))) {
    return "gradle";
  }
  if (existsSync(path.join(repoRoot, "pom.xml"))) {
    return "maven";
  }
  return "unknown";
}

export function resolveProjectJdk(repoRoot: string, aliases: string[] = []): ProjectJdkStatus {
  const installed = listInstalledJdks();
  const aliasEnv = aliases.map(alias => [`JAVA_LSP_PROJECT_JAVA_HOME_${envAlias(alias)}`, process.env[`JAVA_LSP_PROJECT_JAVA_HOME_${envAlias(alias)}`]] as const)
    .find(([, value]) => value && existsSync(value));
  if (aliasEnv?.[1]) {
    return fromHome(aliasEnv[1], "env-alias", installed);
  }

  const requirements = readRequirements(repoRoot);
  const buildReq = requirements.find(req => req.source === "gradle-toolchain" || req.source === "maven");
  const primary = buildReq || requirements[0];
  const conflict = buildReq && requirements.some(req => req.major !== buildReq.major);
  if (conflict && buildReq) {
    return statusForRequirement(buildReq, installed, "ambiguous", ["JDK requirement sources conflict; build file wins but LSP start requires explicit override."]);
  }
  if (primary) {
    return statusForRequirement(primary, installed);
  }

  if (process.env.JAVA_LSP_PROJECT_JAVA_HOME && existsSync(process.env.JAVA_LSP_PROJECT_JAVA_HOME)) {
    return fromHome(process.env.JAVA_LSP_PROJECT_JAVA_HOME, "env-global", installed);
  }

  const fallback = homeMajor(process.env.JDTLS_JAVA_HOME || process.env.JAVA_HOME || "");
  if (fallback) {
    return {
      requiredMajor: fallback.major,
      requiredRaw: String(fallback.major),
      resolvedHome: fallback.home,
      runtimeName: runtimeName(fallback.major),
      primarySource: "fallback",
      allSources: ["fallback"],
      status: "degraded",
      candidates: installed.map(jdk => jdk.label),
      notes: ["No project JDK marker found; using JDT LS runtime JDK as parse fallback."]
    };
  }

  return {
    primarySource: "missing",
    allSources: [],
    status: "missing",
    candidates: installed.map(jdk => jdk.label),
    notes: ["No project JDK marker or fallback JDK found."]
  };
}

function readRequirements(repoRoot: string): Requirement[] {
  return [
    readSdkman(repoRoot),
    readJavaVersion(repoRoot),
    readGradle(repoRoot),
    readMaven(repoRoot),
    readMvnJvmConfig(repoRoot)
  ].filter((value): value is Requirement => value !== undefined);
}

function readSdkman(repoRoot: string): Requirement | undefined {
  const text = readIfExists(path.join(repoRoot, ".sdkmanrc"));
  const raw = text?.match(/java\s*=\s*([^\s]+)/)?.[1];
  const major = parseMajor(raw || "");
  return major ? { major, raw: raw || String(major), source: "sdkmanrc", strict: true } : undefined;
}

function readJavaVersion(repoRoot: string): Requirement | undefined {
  const raw = readIfExists(path.join(repoRoot, ".java-version"))?.trim();
  const major = parseMajor(raw || "");
  return major ? { major, raw: raw || String(major), source: "java-version", strict: true } : undefined;
}

function readGradle(repoRoot: string): Requirement | undefined {
  const text = ["build.gradle.kts", "build.gradle"]
    .map(file => readIfExists(path.join(repoRoot, file)))
    .find(Boolean);
  const raw = text?.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1]
    || text?.match(/VERSION_(\d+)/)?.[1]
    || text?.match(/(?:sourceCompatibility|targetCompatibility)\s*=\s*['"]?(\d+(?:\.\d+)?)['"]?/)?.[1];
  const major = parseMajor(raw || "");
  return major ? { major, raw: raw || String(major), source: "gradle-toolchain", strict: false } : undefined;
}

function readMaven(repoRoot: string): Requirement | undefined {
  const text = readIfExists(path.join(repoRoot, "pom.xml"));
  const raw = text?.match(/<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/)?.[1]
    || text?.match(/<maven\.compiler\.source>\s*([^<]+)\s*<\/maven\.compiler\.source>/)?.[1]
    || text?.match(/<java\.version>\s*([^<]+)\s*<\/java\.version>/)?.[1];
  const major = parseMajor(raw || "");
  return major ? { major, raw: raw || String(major), source: "maven", strict: false } : undefined;
}

function readMvnJvmConfig(repoRoot: string): Requirement | undefined {
  const text = readIfExists(path.join(repoRoot, ".mvn", "jvm.config"));
  const raw = text?.match(/(?:--release|-Djava\.version=)(\d+(?:\.\d+)?)/)?.[1];
  const major = parseMajor(raw || "");
  return major ? { major, raw: raw || String(major), source: "mvn-jvm-config", strict: false } : undefined;
}

function statusForRequirement(requirement: Requirement, installed: InstalledJdk[], forcedStatus?: ProjectJdkStatus["status"], extraNotes: string[] = []): ProjectJdkStatus {
  const exact = installed.find(jdk => jdk.major === requirement.major);
  if (exact) {
    return baseStatus(requirement, exact.home, "resolved", installed, extraNotes);
  }
  const higher = installed.filter(jdk => jdk.major > requirement.major).sort((a, b) => a.major - b.major)[0];
  if (higher && !requirement.strict) {
    return baseStatus(requirement, higher.home, forcedStatus || "degraded", installed, [
      `runtime path is newer than required source level; boot API may be imprecise (${higher.major} > ${requirement.major}).`,
      ...extraNotes
    ]);
  }
  return {
    requiredMajor: requirement.major,
    requiredRaw: requirement.raw,
    runtimeName: runtimeName(requirement.major),
    primarySource: requirement.source,
    allSources: [requirement.source],
    status: forcedStatus || "missing",
    candidates: installed.map(jdk => jdk.label),
    notes: [`Required Java ${requirement.raw} was not found.`, ...extraNotes]
  };
}

function baseStatus(requirement: Requirement, home: string, status: ProjectJdkStatus["status"], installed: InstalledJdk[], notes: string[]): ProjectJdkStatus {
  return {
    requiredMajor: requirement.major,
    requiredRaw: requirement.raw,
    resolvedHome: home,
    runtimeName: runtimeName(requirement.major),
    primarySource: requirement.source,
    allSources: [requirement.source],
    status,
    candidates: installed.map(jdk => jdk.label),
    notes
  };
}

function fromHome(home: string, source: ProjectJdkStatus["primarySource"], installed: InstalledJdk[]): ProjectJdkStatus {
  const major = homeMajor(home)?.major || 0;
  return {
    requiredMajor: major || undefined,
    requiredRaw: major ? String(major) : undefined,
    resolvedHome: home,
    runtimeName: major ? runtimeName(major) : undefined,
    primarySource: source,
    allSources: [source],
    status: major ? "resolved" : "degraded",
    candidates: installed.map(jdk => jdk.label),
    notes: major ? [] : ["Could not infer Java major from override path."]
  };
}

let installedJdksCache: { key: string; value: InstalledJdk[] } | undefined;

export function warmupInstalledJdks(): Promise<InstalledJdk[]> {
  const key = installedJdksCacheKey();
  if (installedJdksCache?.key === key) {
    return Promise.resolve(installedJdksCache.value);
  }
  return discoverInstalledJdksAsync().then(value => {
    if (installedJdksCache?.key === key) return installedJdksCache.value;
    installedJdksCache = { key, value };
    return value;
  });
}

export function resetInstalledJdksCacheForTests(): void {
  installedJdksCache = undefined;
}

function listInstalledJdks(): InstalledJdk[] {
  const key = installedJdksCacheKey();
  if (installedJdksCache?.key === key) {
    return installedJdksCache.value;
  }
  const value = discoverInstalledJdks();
  installedJdksCache = { key, value };
  return value;
}

function installedJdksCacheKey(): string {
  return process.env.JAVA_HOME ?? "";
}

function discoverInstalledJdks(): InstalledJdk[] {
  return collectJdkHomes()
    .map(home => homeMajor(home))
    .filter((value): value is InstalledJdk => value !== undefined)
    .sort((a, b) => a.major - b.major);
}

async function discoverInstalledJdksAsync(): Promise<InstalledJdk[]> {
  const installed: InstalledJdk[] = [];
  for (const home of collectJdkHomes()) {
    const resolved = await homeMajorAsync(home);
    if (resolved) installed.push(resolved);
  }
  return installed.sort((a, b) => a.major - b.major);
}

function collectJdkHomes(): string[] {
  const homes = new Set<string>();
  for (const dir of [path.join(homedir(), ".sdkman", "candidates", "java"), "/Library/Java/JavaVirtualMachines"]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const candidate = dir.includes(".sdkman") ? path.join(dir, entry) : path.join(dir, entry, "Contents", "Home");
      if (existsSync(path.join(candidate, "bin", "java"))) {
        homes.add(candidate);
      }
    }
  }
  const javaHomeOutput = spawnSync("/usr/libexec/java_home", ["-V"], { encoding: "utf8", timeout: 2000 });
  for (const match of `${javaHomeOutput.stdout}\n${javaHomeOutput.stderr}`.matchAll(/(\/[^\n]+\/Contents\/Home)/g)) {
    homes.add(match[1]!);
  }
  if (process.env.JAVA_HOME) {
    homes.add(process.env.JAVA_HOME);
  }
  return [...homes];
}

/**
 * Version detection without launching a JVM. macOS system JDKs live at
 * `<container>.jdk/Contents/Home`, so basename parsing sees only "Home" and the
 * old code fell through to a synchronous `java -version` per JDK (up to 2s each,
 * x86_64 JDKs under Rosetta reliably hit the timeout). On a machine with many
 * system JDKs that froze the daemon event loop for ~15s per cold discovery.
 * The `release` file ships with every JDK 8+ and answers in microseconds.
 */
function majorFromHomeCheap(home: string): number | undefined {
  const fromLabel = parseMajor(path.basename(home));
  if (fromLabel) return fromLabel;
  const release = readIfExists(path.join(home, "release"));
  const fromRelease = parseMajor(release?.match(/JAVA_VERSION="([^"]+)"/)?.[1] || "");
  if (fromRelease) return fromRelease;
  if (home.endsWith(path.join("Contents", "Home"))) {
    const container = path.basename(path.dirname(path.dirname(home)));
    const fromContainer = parseMajor(container);
    if (fromContainer) return fromContainer;
  }
  return undefined;
}

function homeMajor(home: string): InstalledJdk | undefined {
  if (!home || !existsSync(home)) return undefined;
  const cheap = majorFromHomeCheap(home);
  if (cheap) return { major: cheap, home, label: `${cheap}:${home}` };
  const javaBin = path.join(home, "bin", "java");
  const spawned = existsSync(javaBin)
    ? spawnSync(javaBin, ["-version"], { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" })
    : undefined;
  const major = parseMajor(spawned?.stderr) || parseMajor(spawned?.stdout);
  return major ? { major, home, label: `${major}:${home}` } : undefined;
}

async function homeMajorAsync(home: string): Promise<InstalledJdk | undefined> {
  if (!home || !existsSync(home)) return undefined;
  const cheap = majorFromHomeCheap(home);
  if (cheap) return { major: cheap, home, label: `${cheap}:${home}` };
  const javaBin = path.join(home, "bin", "java");
  if (!existsSync(javaBin)) return undefined;
  const spawned = await spawnJavaVersion(javaBin);
  const major = parseMajor(spawned?.stderr) || parseMajor(spawned?.stdout);
  return major ? { major, home, label: `${major}:${home}` } : undefined;
}

function spawnJavaVersion(javaBin: string): Promise<{ stdout: string; stderr: string } | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: { stdout: string; stderr: string } | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(javaBin, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.stdout?.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr?.on("data", chunk => stderr.push(chunk as Buffer));
    child.once("error", () => finish(undefined));
    child.once("close", () => finish({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

function parseMajor(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const version = value.match(/(\d+)(?:\.(\d+))?/)?.[0];
  if (!version) return undefined;
  const [first, second] = version.split(".").map(Number);
  return first === 1 && second ? second : first;
}

function runtimeName(major: number): string {
  return major === 8 ? "JavaSE-1.8" : `JavaSE-${major}`;
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function envAlias(alias: string): string {
  return alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
