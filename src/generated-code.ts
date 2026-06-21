// input: Java build files and local dependency caches.
// output: Lombok/APT status for JDT LS settings and diagnostics authority.
// pos: Lightweight generated-code detector; no source-wide scan.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type GeneratedCodeStatus = {
  lombok: {
    detected: boolean;
    agentEnabled: boolean;
    jar?: string;
    status: "enabled" | "missing-agent" | "disabled" | "not-detected";
  };
  annotationProcessing: {
    detectedProcessors: string[];
    enabled: boolean;
    source: "auto" | "alias-override" | "not-detected";
  };
  generatedCodeSemantics: "ok" | "incomplete" | "disabled" | "not-detected";
};

export function detectGeneratedCode(repoRoot: string): GeneratedCodeStatus {
  const text = buildFiles(repoRoot).map(file => readFileSync(file, "utf8")).join("\n");
  const processors = [
    /lombok/i.test(text) ? "lombok" : undefined,
    /mapstruct/i.test(text) ? "mapstruct" : undefined,
    /auto[-.]?value/i.test(text) ? "auto-value" : undefined,
    /dagger/i.test(text) ? "dagger" : undefined
  ].filter((value): value is string => Boolean(value));
  const lombokDetected = processors.includes("lombok");
  const lombokJar = lombokDetected ? resolveLombokJar(text) : undefined;
  const annotationProcessingEnabled = processors.length > 0;
  const lombokStatus = !lombokDetected
    ? "not-detected"
    : lombokJar
      ? "enabled"
      : "missing-agent";
  return {
    lombok: {
      detected: lombokDetected,
      agentEnabled: Boolean(lombokJar),
      jar: lombokJar,
      status: lombokStatus
    },
    annotationProcessing: {
      detectedProcessors: processors,
      enabled: annotationProcessingEnabled,
      source: annotationProcessingEnabled ? "auto" : "not-detected"
    },
    generatedCodeSemantics: processors.length === 0 ? "not-detected" : lombokDetected && !lombokJar ? "incomplete" : "ok"
  };
}

function buildFiles(repoRoot: string): string[] {
  const names = [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle/libs.versions.toml"
  ];
  return names.map(name => path.join(repoRoot, name)).filter(existsSync);
}

function resolveLombokJar(buildText: string): string | undefined {
  if (process.env.JAVA_LSP_LOMBOK_JAR && existsSync(process.env.JAVA_LSP_LOMBOK_JAR)) {
    return process.env.JAVA_LSP_LOMBOK_JAR;
  }
  const version = buildText.match(/org\.projectlombok:lombok:([A-Za-z0-9_.-]+)/)?.[1]
    || buildText.match(/<artifactId>\s*lombok\s*<\/artifactId>[\s\S]{0,200}<version>\s*([^<]+)\s*<\/version>/)?.[1]
    || buildText.match(/lombokVersion\s*=\s*["']([^"']+)["']/)?.[1];
  return version ? findMavenLombok(version) || findGradleLombok(version) : findLatestLombok();
}

function findMavenLombok(version: string): string | undefined {
  const file = path.join(homedir(), ".m2", "repository", "org", "projectlombok", "lombok", version, `lombok-${version}.jar`);
  return existsSync(file) ? file : undefined;
}

function findGradleLombok(version: string): string | undefined {
  const dir = path.join(homedir(), ".gradle", "caches", "modules-2", "files-2.1", "org.projectlombok", "lombok", version);
  return findJar(dir);
}

function findLatestLombok(): string | undefined {
  const m2 = path.join(homedir(), ".m2", "repository", "org", "projectlombok", "lombok");
  if (existsSync(m2)) {
    const versions = readdirSync(m2).filter(isVersionLike).sort(compareVersionsDesc);
    for (const version of versions) {
      const jar = findMavenLombok(version);
      if (jar) return jar;
    }
  }
  const gradle = path.join(homedir(), ".gradle", "caches", "modules-2", "files-2.1", "org.projectlombok", "lombok");
  if (!existsSync(gradle)) return undefined;
  for (const version of readdirSync(gradle).filter(isVersionLike).sort(compareVersionsDesc)) {
    const jar = findGradleLombok(version);
    if (jar) return jar;
  }
  return undefined;
}

function isVersionLike(value: string): boolean {
  return /^\d+(?:\.\d+){1,3}(?:[-.][A-Za-z0-9]+)?$/.test(value);
}

export function compareVersionsDesc(a: string, b: string): number {
  const aa = a.split(/[.-]/).map(part => Number.parseInt(part, 10)).map(value => Number.isNaN(value) ? 0 : value);
  const bb = b.split(/[.-]/).map(part => Number.parseInt(part, 10)).map(value => Number.isNaN(value) ? 0 : value);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const diff = (bb[i] || 0) - (aa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findJar(dir: string): string | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (file.endsWith(".jar") && path.basename(file).startsWith("lombok-")) return file;
    if (statSync(file).isDirectory()) {
      const found = findJar(file);
      if (found) return found;
    }
  }
  return undefined;
}
