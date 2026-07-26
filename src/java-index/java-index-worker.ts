import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { classifyPath, normalizeRepoFile } from "../repo-layout.js";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { extractFromParsedTree, type ExtractJavaInput } from "./ast-extractor.js";
import { ParseTreeCache, refreshParseTree } from "./parse-tree-cache.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { JavaIndexStore } from "./index-store.js";
import { JavaNameResolver, buildTypeRegistryView, type TypeRegistryView } from "./name-resolver.js";
import type { JavaIndexStatus, JavaSourceSet, JavaTypeLookupResult } from "./index-types.js";
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
let store: JavaIndexStore | undefined;
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
  if (!store) return { files: 0, types: 0, methods: 0, edges: 0 };
  return {
    files: store.filesByPath.size,
    types: store.typesById.size,
    methods: store.methodsById.size,
    edges: store.edgesById.size
  };
}

async function refreshFile(inputPath: string, generation: number): Promise<string> {
  if (!backend || !cache || !store) throw new Error("refreshFile called before OPEN");
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
  store.replaceFile({ ...extractFromParsedTree(input, tree), edges: [] });
  return relativePath;
}

// Repo-wide registry rebuilt from whatever REFRESH has produced so far.
// O(repo size) per call - acceptable for this task's "narrow" worker wiring
// per Task 18; Task 20's incremental sweep owns making this bounded.
function rebuildRegistry(): TypeRegistryView {
  if (!store) return buildTypeRegistryView([], []);
  return buildTypeRegistryView([...store.typesById.values()], [...store.methodsById.values()]);
}

// Resolves one file's refs against the registry as it stands (including any
// other files touched earlier in the same REFRESH batch) and rebuilds its
// static edges. Does not re-resolve *other*, already-indexed files whose
// prior REPO_UNIQUE_SIMPLE_NAME fallback a new type might now make
// ambiguous - that reverse-dependency re-resolution is deferred to whichever
// task owns the refresh pipeline's incremental rebuild (Task 20), per Task
// 17's own Step 6 deferral.
function resolveAndBuildEdges(relativePath: string): void {
  if (!store) return;
  const raw = store.files([relativePath])[0];
  if (!raw) return;
  const registryBeforeResolve = rebuildRegistry();
  const resolver = new JavaNameResolver(registryBeforeResolve);
  const resolved = resolveFileRefs(raw, resolver, registryBeforeResolve);
  // Store the resolved (still edge-less) facts before rebuilding the
  // registry again: buildStaticEdges' super-chain/receiver lookups need
  // *this* file's own supertype refs to carry their resolution, which only
  // the post-resolve registry reflects.
  store.replaceFile({ ...resolved, edges: [] });
  const edges = buildStaticEdges(resolved, rebuildRegistry(), resolver);
  store.replaceFile({ ...resolved, edges });
}

async function handle(request: JavaIndexRequest): Promise<void> {
  try {
    switch (request.type) {
      case "OPEN": {
        repoRoot = request.repoRoot;
        backend = await createJavaParserBackend();
        cache = new ParseTreeCache();
        store = new JavaIndexStore();
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
        const deletedPaths: string[] = [];
        for (const inputPath of request.deleted) {
          try {
            const { relativePath } = deriveSourceLayout(inputPath);
            cache?.delete(relativePath);
            deletedPaths.push(relativePath);
          } catch (error) {
            lastRefreshError = `failed to delete ${inputPath}: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        if (deletedPaths.length > 0 && store) {
          // The store's own reverse index already knows which surviving
          // files have an edge into a node this delete removes (Task 18
          // Step 7's "incoming edges from other files become unresolved");
          // no separate dangling-edge scan is needed once that index exists.
          // This is a strict equivalent of the Task 18 scan, not a narrower
          // approximation: every edge target (a type: or method: id) is
          // owned by exactly one file, so the only way a target can go
          // stale is for *its* owning file to be deleted - which is exactly
          // what store.removeFiles' owned-node walk computes dependents
          // from. external: targets are never owned by any file and are
          // never removed by a delete, so they never need this treatment.
          for (const dependent of store.removeFiles(deletedPaths)) touched.add(dependent);
        }
        for (const relativePath of touched) {
          try {
            resolveAndBuildEdges(relativePath);
          } catch (error) {
            // The store is left holding refreshFile's raw, unresolved,
            // edge-less bundle for this path (resolveAndBuildEdges' first
            // replaceFile already landed before the failure could occur
            // past that point) - queries against it return UNRESOLVED
            // facts with no edges, indistinguishable from a file that
            // legitimately references nothing. Task 20's per-file
            // coverage/failedFiles accounting is what makes that
            // distinguishable; until then, lastRefreshError is the only
            // signal, so name the file in it explicitly.
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
        // A single bad path must not fail (and DEGRADE) the whole client -
        // same reasoning as QUERY_FILES' per-path try/catch, just for one
        // path instead of a list: an anchor for a file outside the repo or
        // otherwise unresolvable simply has no anchor, not a fatal error.
        let relativePath: string | undefined;
        try {
          relativePath = deriveSourceLayout(request.file).relativePath;
        } catch {
          relativePath = undefined;
        }
        respond({
          id: request.id,
          ok: true,
          value: relativePath ? store?.anchor(relativePath, request.line, request.column) : undefined
        });
        return;
      }
      case "QUERY_TYPE": {
        const scopeFile = request.scopeFile ? deriveSourceLayout(request.scopeFile).relativePath : undefined;
        respond({
          id: request.id,
          ok: true,
          value: store ? store.typeLookup(request.typeText, scopeFile) : unresolvedTypeLookup()
        });
        return;
      }
      case "QUERY_IMPLEMENTERS": {
        respond({ id: request.id, ok: true, value: store?.implementers(request.typeId, request.limit) ?? [] });
        return;
      }
      case "QUERY_TYPE_REFERENCERS": {
        respond({
          id: request.id,
          ok: true,
          value: store?.typeReferencers(request.typeId, new Set(request.edgeKinds), request.limit) ?? []
        });
        return;
      }
      case "QUERY_CALLERS": {
        respond({ id: request.id, ok: true, value: store?.callers(request.methodId, request.limit) ?? [] });
        return;
      }
      case "QUERY_CALLEES": {
        respond({ id: request.id, ok: true, value: store?.callees(request.methodId, request.limit) ?? [] });
        return;
      }
      case "QUERY_FILES": {
        const relativePaths = request.files
          .map(inputPath => {
            try {
              return deriveSourceLayout(inputPath).relativePath;
            } catch {
              // Outside repoRoot or otherwise unresolvable: no facts for it,
              // same as a path that was never refreshed.
              return undefined;
            }
          })
          .filter((relativePath): relativePath is string => relativePath !== undefined);
        respond({ id: request.id, ok: true, value: store?.files(relativePaths) ?? [] });
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
