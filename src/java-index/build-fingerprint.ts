import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";

const require = createRequire(import.meta.url);

// Build/JDK markers checked at the repo root and at every detected module
// directory. A parser/extractor code fix invalidates the AST cache via
// extractorVersion (below), not via this list - this one only needs to
// notice when the *build itself* (dependencies, JDK, layout) may have
// changed what "correct" extraction even means for this repo.
const BUILD_MARKER_RELATIVE_PATHS = [
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  ".java-version",
  ".sdkmanrc",
  ".mvn/jvm.config"
];

// Bumped whenever ast-extractor.ts's fact shape changes in a way that isn't
// already covered by a schemaVersion bump. Do not put gitSha in extractorVersion:
// a telemetry/runtime install must not discard every repo's JavaIndex snapshot.
const JAVA_FACTS_REVISION = 2;
const LEGACY_EXTRACTOR_CODE_SUFFIX = /\|extractor-code-[0-9a-f]{7,40}$/i;

// Parser + facts revision only. tree-sitter version changes and JAVA_FACTS_REVISION
// bumps still invalidate snapshots; daemon gitSha does not.
export function computeExtractorVersion(): string {
  const treeSitterVersion = (require("tree-sitter/package.json") as { version: string }).version;
  const treeSitterJavaVersion = (require("tree-sitter-java/package.json") as { version: string }).version;
  return `schema-3|facts-${JAVA_FACTS_REVISION}|tree-sitter-${treeSitterVersion}|tree-sitter-java-${treeSitterJavaVersion}`;
}

/** Snapshots written when extractorVersion still ended with extractor-code-<gitSha>. */
export function extractorVersionsCompatible(snapshot: string, expected: string): boolean {
  if (snapshot === expected) return true;
  return snapshot.startsWith(`${expected}|`) && LEGACY_EXTRACTOR_CODE_SUFFIX.test(snapshot.slice(expected.length));
}

/**
 * Hashes sorted `relativePath + contentHash` entries for every detected
 * root/module build file and JDK marker that exists, plus sorted source and
 * resource roots and the layout kind/profile - independent of file mtime and
 * of filesystem enumeration order (both are normalized away by sorting
 * before hashing), so only content and repo shape can change the result.
 */
export async function computeBuildFingerprint(repoRoot: string, layout: LayoutContext): Promise<string> {
  const moduleDirs = new Set<string>([""]);
  for (const sourceRoot of layout.sourceRoots) {
    moduleDirs.add(sourceRoot.module ?? "");
  }
  const entries: string[] = [];
  for (const moduleDir of moduleDirs) {
    for (const marker of BUILD_MARKER_RELATIVE_PATHS) {
      const relativePath = moduleDir ? `${moduleDir}/${marker}` : marker;
      let content: Buffer;
      try {
        content = await readFile(path.join(repoRoot, relativePath));
      } catch {
        continue;
      }
      const contentHash = createHash("sha256").update(content).digest("hex");
      entries.push(`build:${relativePath}:${contentHash}`);
    }
  }
  for (const sourceRoot of layout.sourceRoots) {
    entries.push(`sourceRoot:${sourceRoot.relativePath}:${sourceRoot.module}:${sourceRoot.sourceSet}`);
  }
  for (const resourceRoot of layout.resourceRoots) {
    entries.push(`resourceRoot:${resourceRoot}`);
  }
  entries.push(`layout:${layout.layout}`, `layoutProfile:${layout.layoutProfile}`);
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
