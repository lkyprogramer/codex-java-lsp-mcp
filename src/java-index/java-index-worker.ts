import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { classifyPath, normalizeRepoFile } from "../repo-layout.js";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { extractFromParsedTree, type ExtractJavaInput } from "./ast-extractor.js";
import { ParseTreeCache, refreshParseTree } from "./parse-tree-cache.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { JavaNameResolver, buildTypeRegistryView, type TypeRegistryView } from "./name-resolver.js";
import type { JavaFileBundle, JavaIndexStatus, JavaSourceSet, JavaTypeLookupResult } from "./index-types.js";
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";

let status: JavaIndexStatus = {
  state: "NEW",
  indexedGeneration: 0,
  files: 0,
  types: 0,
  methods: 0,
  edges: 0,
  snapshotBytes: 0,
  pendingForeground: 0,
  pendingBackground: 0,
  coverage: []
};

let repoRoot = "";
let backend: JavaParserBackend | undefined;
let cache: ParseTreeCache | undefined;
// Task 19 (JavaIndexStore) replaces this temporary in-memory map with the
// real O(1) query structure; this task only needs REFRESH to produce and
// hold facts somewhere.
const filesByRelativePath = new Map<string, JavaFileBundle>();
// A single unreadable/unparsable file must not fail the whole REFRESH batch
// (its previous cached state, if any, is left untouched), but a silently
// swallowed failure is worse than a surfaced one: Task 20 owns proper
// per-file coverage/failedFiles accounting, but until then the most recent
// failure is surfaced here rather than only in a comment.
let lastRefreshError: string | undefined;

const commandQueue: JavaIndexRequest[] = [];
let draining = false;

function respond(response: JavaIndexResponse): void {
  parentPort?.postMessage(response);
}

function unresolvedTypeLookup(): JavaTypeLookupResult {
  // No query index is implemented yet (Task 19+); DEGRADED is the honest
  // coverage state for a worker that has not built one.
  return { state: "UNRESOLVED", coverage: "DEGRADED" };
}

// Provisional: reuses the repo's existing Maven/Gradle module + sourceSet
// classifier (src/repo-layout.ts) rather than inventing a parallel one. A
// real source-set/module classifier tied to build-file parsing is a later
// task's concern; this is enough to populate JavaFileFacts today.
function deriveSourceLayout(
  inputPath: string
): { absolutePath: string; relativePath: string; sourceRoot: string; module: string; sourceSet: JavaSourceSet } {
  // normalizeRepoFile resolves a relative-or-absolute path against repoRoot
  // and throws if it escapes the repo; classifyPath's own path.relative
  // silently resolves a relative input against process.cwd() instead, which
  // would return an empty context.relativePath for any caller that passes a
  // repo-relative path (as opposed to absolute).
  const absolutePath = normalizeRepoFile(repoRoot, inputPath);
  const context = classifyPath(repoRoot, absolutePath);
  const relativePath = (context.relativePath ?? path.relative(repoRoot, absolutePath))
    .split(path.sep)
    .join("/");
  const module = context.module && context.module !== "." ? context.module : "";
  const sourceSet: JavaSourceSet = context.sourceSet === "main" || context.sourceSet === "test"
    ? context.sourceSet
    : "unknown";
  const sourceRoot = context.sourceSet
    ? [module, "src", context.sourceSet, "java"].filter(Boolean).join("/")
    : "";
  return { absolutePath, relativePath, sourceRoot, module, sourceSet };
}

function summarizeFiles(): Pick<JavaIndexStatus, "files" | "types" | "methods" | "edges"> {
  let types = 0;
  let methods = 0;
  let edges = 0;
  for (const bundle of filesByRelativePath.values()) {
    types += bundle.types.length;
    methods += bundle.methods.length;
    edges += bundle.edges.length;
  }
  return { files: filesByRelativePath.size, types, methods, edges };
}

async function refreshFile(inputPath: string, generation: number): Promise<string> {
  if (!backend || !cache) throw new Error("refreshFile called before OPEN");
  const { absolutePath, relativePath, sourceRoot, module, sourceSet } = deriveSourceLayout(inputPath);
  const [content, stats] = await Promise.all([
    readFile(absolutePath, "utf8"),
    stat(absolutePath)
  ]);
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const { tree } = refreshParseTree(cache, backend, relativePath, content);
  const input: ExtractJavaInput = {
    repoRoot,
    absolutePath,
    relativePath,
    sourceRoot,
    module,
    sourceSet,
    content,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    contentHash,
    generation
  };
  filesByRelativePath.set(relativePath, { ...extractFromParsedTree(input, tree), edges: [] });
  return relativePath;
}

// Repo-wide registry rebuilt from whatever REFRESH has produced so far.
// O(repo size) per call - acceptable for this task's "narrow" worker wiring
// per Task 18; Task 20's incremental sweep owns making this bounded.
function rebuildRegistry(): TypeRegistryView {
  const bundles = [...filesByRelativePath.values()];
  return buildTypeRegistryView(bundles.flatMap(b => b.types), bundles.flatMap(b => b.methods));
}

// Resolves one file's refs against the registry as it stands (including any
// other files touched earlier in the same REFRESH batch) and rebuilds its
// static edges. Does not re-resolve *other*, already-indexed files whose
// prior REPO_UNIQUE_SIMPLE_NAME fallback a new type might now make
// ambiguous - that reverse-dependency re-resolution is deferred to whichever
// task owns the refresh pipeline's incremental rebuild (Task 19/20), per
// Task 17's own Step 6 deferral.
function resolveAndBuildEdges(relativePath: string): void {
  const raw = filesByRelativePath.get(relativePath);
  if (!raw) return;
  const registryBeforeResolve = rebuildRegistry();
  const resolver = new JavaNameResolver(registryBeforeResolve);
  const resolved = resolveFileRefs(raw, resolver, registryBeforeResolve);
  // Store the resolved (still edge-less) facts before rebuilding the
  // registry again: buildStaticEdges' super-chain/receiver lookups need
  // *this* file's own supertype refs to carry their resolution, which only
  // the post-resolve registry reflects.
  filesByRelativePath.set(relativePath, { ...resolved, edges: [] });
  const edges = buildStaticEdges(resolved, rebuildRegistry(), resolver);
  filesByRelativePath.set(relativePath, { ...resolved, edges });
}

// After a delete, other files' *already-built* edges can be left pointing at
// a type/method id that no longer exists in the registry (Task 18 Step 7:
// "Incoming edges from other files become unresolved and those files enter
// dependency rebuild set"). Unlike the simple-name-collision case, this
// can't be retrofitted once bundles are handed to Task 19's store - the
// stale edges would already be baked in - so it is handled here rather than
// deferred alongside it.
function findFilesWithDanglingEdges(registry: TypeRegistryView): string[] {
  const validMethodIds = new Set<string>();
  for (const methods of registry.methodsByOwnerTypeId.values()) {
    for (const method of methods) validMethodIds.add(method.methodId);
  }
  const affected: string[] = [];
  for (const [relativePath, bundle] of filesByRelativePath) {
    const hasDanglingEdge = bundle.edges.some(edge => {
      if (edge.toId.startsWith("external:")) return false;
      if (edge.toId.startsWith("type:") || edge.toId.startsWith("type-local:")) return !registry.byId.has(edge.toId);
      if (edge.toId.startsWith("method:")) return !validMethodIds.has(edge.toId);
      return false;
    });
    if (hasDanglingEdge) affected.push(relativePath);
  }
  return affected;
}

async function handle(request: JavaIndexRequest): Promise<void> {
  try {
    switch (request.type) {
      case "OPEN": {
        repoRoot = request.repoRoot;
        backend = await createJavaParserBackend();
        cache = new ParseTreeCache();
        status = { ...status, state: "READY", indexedGeneration: request.generation };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "STATUS": {
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "CLOSE": {
        status = { ...status, state: "CLOSED" };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "REFRESH": {
        const touched = new Set<string>();
        for (const inputPath of request.changed) {
          try {
            touched.add(await refreshFile(inputPath, request.generation));
          } catch (error) {
            lastRefreshError = `failed to refresh ${inputPath}: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        let deletedAny = false;
        for (const inputPath of request.deleted) {
          try {
            const { relativePath } = deriveSourceLayout(inputPath);
            cache?.delete(relativePath);
            deletedAny = filesByRelativePath.delete(relativePath) || deletedAny;
          } catch (error) {
            lastRefreshError = `failed to delete ${inputPath}: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        if (deletedAny) {
          for (const relativePath of findFilesWithDanglingEdges(rebuildRegistry())) touched.add(relativePath);
        }
        for (const relativePath of touched) {
          try {
            resolveAndBuildEdges(relativePath);
          } catch (error) {
            lastRefreshError = `failed to resolve ${relativePath}: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        status = {
          ...status,
          indexedGeneration: request.generation,
          ...summarizeFiles(),
          ...(lastRefreshError ? { lastError: lastRefreshError } : {})
        };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "RECONCILE": {
        status = { ...status, indexedGeneration: request.generation, ...summarizeFiles() };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "FLUSH": {
        status = { ...status, ...summarizeFiles() };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "QUERY_ANCHOR": {
        respond({ id: request.id, ok: true, value: undefined });
        return;
      }
      case "QUERY_TYPE": {
        respond({ id: request.id, ok: true, value: unresolvedTypeLookup() });
        return;
      }
      case "QUERY_IMPLEMENTERS":
      case "QUERY_TYPE_REFERENCERS":
      case "QUERY_CALLERS":
      case "QUERY_CALLEES": {
        respond({ id: request.id, ok: true, value: [] });
        return;
      }
      case "QUERY_FILES": {
        const bundles = request.files
          .map(inputPath => {
            try {
              return filesByRelativePath.get(deriveSourceLayout(inputPath).relativePath);
            } catch {
              // Outside repoRoot or otherwise unresolvable: no facts for it,
              // same as a path that was never refreshed.
              return undefined;
            }
          })
          .filter((bundle): bundle is JavaFileBundle => bundle !== undefined);
        respond({ id: request.id, ok: true, value: bundles });
        return;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`unhandled command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: {
        code: "WORKER_UNHANDLED",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (commandQueue.length > 0) {
      const next = commandQueue.shift();
      if (next) await handle(next);
    }
  } finally {
    draining = false;
  }
}

parentPort?.on("message", (request: JavaIndexRequest) => {
  commandQueue.push(request);
  void drain();
});
