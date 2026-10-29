import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";

const require = createRequire(import.meta.url);

// Build markers checked at the repo root and at every detected module
// directory. JDK pin files (.sdkmanrc, .java-version, .mvn/jvm.config) are
// intentionally omitted: they only affect JDT/Maven JVM selection, not
// tree-sitter facts or layout. A parser/extractor code fix invalidates the
// AST cache via extractorVersion (below), not via this list.
export const BUILD_MARKER_RELATIVE_PATHS: readonly string[] = [
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml"
];

// Bumped whenever ast-extractor.ts's fact shape changes in a way that isn't
// already covered by a schemaVersion bump. Do not put gitSha in extractorVersion:
// a telemetry/runtime install must not discard every repo's JavaIndex snapshot.
// 3: duplicate FQNs resolve by module/source-set visibility or stay
// AMBIGUOUS (R05) - refs/edges written by revision 2 bound the lowest id.
// The SQLite index records it in meta and is dropped/rebuilt on mismatch
// (schema.ts schemaVersionsMatch), like a schema version.
// Revision 4: type/method facts carry nameRange, the declaration name the
// discovery locator points at (range starts at the first annotation).
// Revision 5: local types/compact record constructors and concrete/super call resolution.
// Revision 6: parameter arrays count declaration/type brackets once, annotated
// varargs retain their element type, and method keys use the v3 namespace.
export const JAVA_FACTS_REVISION = 6;

// Parser + facts revision only. tree-sitter version changes and JAVA_FACTS_REVISION
// bumps still invalidate snapshots; daemon gitSha does not.
export function computeExtractorVersion(): string {
  const treeSitterVersion = (require("tree-sitter/package.json") as { version: string }).version;
  const treeSitterJavaVersion = (require("tree-sitter-java/package.json") as { version: string }).version;
  return `schema-3|facts-${JAVA_FACTS_REVISION}|tree-sitter-${treeSitterVersion}|tree-sitter-java-${treeSitterJavaVersion}`;
}

/**
 * Hashes sorted `relativePath + contentHash` entries for every detected
 * root/module build file that exists, plus sorted source and resource roots
 * and the layout kind/profile - independent of file mtime and of filesystem
 * enumeration order (both are normalized away by sorting before hashing), so
 * only content and repo shape can change the result.
 */
export async function computeBuildFingerprintEntries(repoRoot: string, layout: LayoutContext): Promise<string[]> {
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
      } catch (error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
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
  return entries;
}

export async function computeBuildFingerprint(repoRoot: string, layout: LayoutContext): Promise<string> {
  const entries = await computeBuildFingerprintEntries(repoRoot, layout);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
