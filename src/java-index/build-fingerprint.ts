import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { detectLayout, type LayoutContext } from "../layout-probe.js";
import { hasIndexableFiles } from "./manifest.js";
import { sourcePathWithinRoot } from "./source-capture.js";

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
  const activeSources: LayoutContext["sourceRoots"] = [];
  const entries: string[] = [];
  for (const sourceRoot of layout.sourceRoots) {
    if (await hasIndexableFiles(repoRoot, sourceRoot.relativePath, ".java")) activeSources.push(sourceRoot);
  }
  const hasRootSource = activeSources.some(root => root.module === ".");
  for (const moduleDir of layout.moduleBases) {
    // Configuration belongs to the module even when the checkout has no source directory.
    const names: string[] = await readdir(path.join(repoRoot, moduleDir)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const marker of BUILD_MARKER_RELATIVE_PATHS) {
      if (!names.includes(marker.split("/", 1)[0])) continue;
      const relativePath = moduleDir ? `${moduleDir}/${marker}` : marker;
      let content: Buffer;
      try {
        content = await readFile(await sourcePathWithinRoot(repoRoot, path.join(repoRoot, relativePath)));
      } catch (error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
        continue;
      }
      const contentHash = createHash("sha256").update(content).digest("hex");
      entries.push(`build:${relativePath}:${contentHash}`);
      // The previous fingerprint also keyed root markers under "." when root Java sources exist.
      if (moduleDir === "" && hasRootSource) entries.push(`build:./${marker}:${contentHash}`);
    }
  }
  for (const sourceRoot of activeSources) {
    entries.push(`sourceRoot:${sourceRoot.relativePath}:${sourceRoot.module}:${sourceRoot.sourceSet}`);
  }
  for (const resourceRoot of layout.resourceRoots) {
    if (await hasIndexableFiles(repoRoot, resourceRoot, ".xml")) entries.push(`resourceRoot:${resourceRoot}`);
  }
  for (const root of layout.symlinkedRoots ?? []) entries.push(`symlinkedRoot:${root}`);
  entries.push(`layout:${detectLayout(repoRoot, activeSources)}`, `layoutProfile:${layout.layoutProfile}`);
  entries.sort();
  return entries;
}

export async function computeBuildFingerprint(repoRoot: string, layout: LayoutContext): Promise<string> {
  const entries = await computeBuildFingerprintEntries(repoRoot, layout);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * The part of computeBuildFingerprint tree-sitter facts depend on: the layout probe's result (active
 * source roots with their module/source set, resource roots, symlinked roots, layout kind and
 * profile), without build file bytes. The extractor never reads build files, the layout probe reads
 * only marker presence and the root pom's <module> list (which the layout kind reflects), and
 * inter-module dependencies are not modelled (name-resolver). The buildKey keeps the full
 * fingerprint, so a build-file edit still moves it and reaches JDT and the router as a build change;
 * this one only lets the builder take that edit as a delta on its base instead of a full rebuild.
 */
export async function computeInputFingerprints(repoRoot: string, layout: LayoutContext): Promise<{ buildFingerprint: string; layoutFingerprint: string }> {
  // One walk for both: the entries read every module's build files and probe every root for sources.
  const entries = await computeBuildFingerprintEntries(repoRoot, layout);
  const layoutEntries = entries.filter(entry => !entry.startsWith("build:"));
  return {
    buildFingerprint: createHash("sha256").update(entries.join("\n")).digest("hex"),
    layoutFingerprint: createHash("sha256").update([LAYOUT_FINGERPRINT_VERSION, ...layoutEntries].join("\n")).digest("hex")
  };
}

/** Changing what the layout fingerprint covers changes this tag, so an old meta value never matches a new one. */
const LAYOUT_FINGERPRINT_VERSION = "static-index-layout/v1";

/** The meta key a build records the layout fingerprint under; absent in databases built before it existed. */
export const LAYOUT_FINGERPRINT_META = "layoutFingerprint";
/**
 * Deltas applied since the last full build of this database: a full writes 0, each delta its base's + 1
 * (absent in databases built before it existed; a delta on one counts from 0). The owner bounds it.
 */
export const DELTA_DEPTH_META = "deltaDepth";
/** The meta key a full build records computeExtractorVersion() under (a delta keeps its base's). */
export const EXTRACTOR_VERSION_META = "extractorVersion";
