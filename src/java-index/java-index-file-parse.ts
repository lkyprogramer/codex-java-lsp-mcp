import { signatureText } from "./declaration-signature.js";
import { captureSource, type SourceCapture } from "./source-capture.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";
import { classifyPath, normalizeRepoFile } from "../repo-layout.js";
import { extractFromParsedTree, type ExtractJavaInput } from "./ast-extractor.js";
import type { JavaFileBundle, JavaSourceSet } from "./index-types.js";
import type { JavaParserBackend } from "./java-parser-backend.js";
import { refreshParseTree, type ParseTreeCache } from "./builder/parse-cache.js";

export type JavaSourceLayout = {
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: JavaSourceSet;
};

/**
 * Prefers a layout-probe source root over classifyPath's synthesized module
 * prefix. The two disagree for modules/X and apps/X layouts; coverage and
 * discovery must key the same physical directory with one string.
 */
export function deriveJavaSourceLayout(
  repoRoot: string,
  inputPath: string,
  layout?: Pick<LayoutContext, "sourceRoots">
): JavaSourceLayout {
  const absolutePath = normalizeRepoFile(repoRoot, inputPath);
  const context = classifyPath(repoRoot, absolutePath);
  const relativePath = (context.relativePath ?? path.relative(repoRoot, absolutePath))
    .split(path.sep)
    .join("/");
  const module = context.module && context.module !== "." ? context.module : "";
  const sourceSet: JavaSourceSet = context.sourceSet === "main" || context.sourceSet === "test"
    ? context.sourceSet
    : "unknown";
  const sourceRoot = resolveSourceRoot(relativePath, module, context.sourceSet, layout);
  return { absolutePath, relativePath, sourceRoot, module, sourceSet };
}

export function resolveSourceRoot(
  relativePath: string,
  module: string,
  rawSourceSet: string | undefined,
  layout?: Pick<LayoutContext, "sourceRoots">
): string {
  if (layout) {
    const match = layout.sourceRoots.find(root =>
      relativePath === root.relativePath || relativePath.startsWith(`${root.relativePath}/`)
    );
    if (match) return match.relativePath;
  }
  return rawSourceSet ? [module, "src", rawSourceSet, "java"].filter(Boolean).join("/") : "";
}

export async function resolvedPathWithinRepo(
  absolutePath: string,
  resolvedRepoRoot: string
): Promise<string | undefined> {
  const resolvedFile = await realpath(absolutePath);
  const relative = path.relative(resolvedRepoRoot, resolvedFile);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolvedFile;
}

/** Read + AST extract only. Caller owns the live store write. */
export async function parseJavaSourceFile(args: {
  repoRoot: string;
  resolvedRepoRoot: string;
  inputPath: string;
  generation: number;
  backend: JavaParserBackend;
  cache: ParseTreeCache;
  layout?: Pick<LayoutContext, "sourceRoots">;
  capture?: SourceCapture;
}): Promise<JavaFileBundle> {
  const { absolutePath, relativePath, sourceRoot, module, sourceSet } = deriveJavaSourceLayout(
    args.repoRoot,
    args.inputPath,
    args.layout
  );
  let capture = args.capture;
  if (capture) {
    if (capture.repoRoot !== args.resolvedRepoRoot || capture.inputPath !== absolutePath) throw new Error("Captured source binding mismatch");
  } else {
    const readablePath = await resolvedPathWithinRepo(absolutePath, args.resolvedRepoRoot);
    if (!readablePath) throw new Error(`Java source resolves outside repo root: ${args.inputPath}`);
    capture = await captureSource(args.resolvedRepoRoot, absolutePath);
  }
  const { bytes, contentHash } = capture;
  const content = bytes.toString("utf8");
  const { tree } = refreshParseTree(args.cache, args.backend, relativePath, content);
  const input: ExtractJavaInput = {
    repoRoot: args.repoRoot,
    absolutePath,
    relativePath,
    sourceRoot,
    module,
    sourceSet,
    content,
    size: bytes.length,
    contentHash,
    generation: args.generation
  };
  const extracted = extractFromParsedTree(input, tree);
  const sourceLines=content.split(/\r?\n/);
  for (const type of extracted.types) type.capturedSignature = signatureText(sourceLines, type.range.start.line, type.range.end.line);
  for (const method of extracted.methods) {
    method.capturedSignature = signatureText(sourceLines, method.range.start.line, method.bodyRange?.start.line ?? method.range.end.line);
  }
  return {
    ...extracted,
    edges: [],
    ...(capture.observed ? { observed: capture.observed } : {})
  };
}
