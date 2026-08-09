// input: One request's bounded framework context and framework-agnostic JavaIndex view.
// output: Request-local preflight reuse and pure traversal helpers shared by adapter packs.
// pos: V3.2-10 - removes repeated STATUS/marker queries without merging framework rules.
import path from "node:path";
import {
  MAX_DECLARATION_IDS_PER_CALL,
  type FrameworkDeclarations,
  type FrameworkIndexStatus,
  type FrameworkIndexView,
  type FrameworkMethodDeclaration,
  type FrameworkRepositoryFactMarkers
} from "../../java-index/framework-index-view.js";
import {
  hasStaticStructureEvidence,
  type FrameworkAdapterContext,
  type FrameworkPreflight
} from "./adapter.js";

type FactMarkerInput = {
  importPrefixes: readonly string[];
  annotationPrefixes: readonly string[];
};

export function createFrameworkPreflight(index: FrameworkIndexView): FrameworkPreflight {
  let statusRequest: Promise<FrameworkIndexStatus> | undefined;
  const markerRequests = new Map<string, Promise<Map<string, string>>>();
  const factMarkerRequests = new Map<string, Promise<FrameworkRepositoryFactMarkers>>();
  const diagnosticMessages: string[] = [];
  let statusUnavailable = false;

  return {
    status() {
      if (!statusRequest) {
        statusRequest = index.frameworkStatus().catch(error => {
          statusUnavailable = true;
          diagnosticMessages.push(`framework preflight status unavailable: ${errorMessage(error)}`);
          return { coverage: "degraded" };
        });
      }
      return statusRequest;
    },
    repositoryMarkers(relativePaths) {
      const key = stableKey(relativePaths);
      return memoizeRetryable(markerRequests, key, () => index.repositoryMarkers(relativePaths));
    },
    repositoryFactMarkers(input) {
      const key = `${stableKey(input.importPrefixes)}\0${stableKey(input.annotationPrefixes)}`;
      return memoizeRetryable(factMarkerRequests, key, () => index.repositoryFactMarkers(input));
    },
    statusUnavailable() {
      return statusUnavailable;
    },
    diagnostics() {
      return [...diagnosticMessages];
    }
  };
}

export function frameworkStatus(context: FrameworkAdapterContext): Promise<FrameworkIndexStatus> {
  return context.preflight?.status() ?? context.frameworkIndex.frameworkStatus();
}

export function frameworkRepositoryMarkers(
  context: FrameworkAdapterContext,
  relativePaths: readonly string[]
): Promise<Map<string, string>> {
  return context.preflight?.repositoryMarkers(relativePaths)
    ?? context.frameworkIndex.repositoryMarkers(relativePaths);
}

export function frameworkRepositoryFactMarkers(
  context: FrameworkAdapterContext,
  input: FactMarkerInput
): Promise<FrameworkRepositoryFactMarkers> {
  return context.preflight?.repositoryFactMarkers(input)
    ?? context.frameworkIndex.repositoryFactMarkers(input);
}

export function frameworkSeedFiles(context: FrameworkAdapterContext): Set<string> {
  const seeds = new Set(context.anchors.map(anchor => anchor.absolutePath));
  for (const candidate of context.staticEvidence) {
    if (hasStaticStructureEvidence(candidate)) seeds.add(candidate.file);
  }
  return seeds;
}

export function frameworkBuildMarkerPaths(
  context: FrameworkAdapterContext,
  markerNames: readonly string[]
): string[] {
  const paths = new Set(markerNames);
  for (const source of [...context.anchors.map(anchor => anchor.absolutePath), ...context.candidateFiles]) {
    const relative = path.relative(context.repoRoot, source).replace(/\\/g, "/");
    const sourceRootIndex = relative.indexOf("/src/");
    if (sourceRootIndex <= 0) continue;
    const moduleRoot = relative.slice(0, sourceRootIndex);
    for (const marker of markerNames) paths.add(`${moduleRoot}/${marker}`);
  }
  return [...paths];
}

export function rankableFrameworkMethods(
  context: FrameworkAdapterContext,
  absolutePath: string,
  methods: readonly FrameworkMethodDeclaration[]
): FrameworkMethodDeclaration[] {
  const methodAnchors = context.anchors.filter(anchor =>
    anchor.absolutePath === absolutePath && anchor.kind.toLowerCase() === "method");
  if (methodAnchors.length === 0) return [...methods];
  return methods.filter(method => methodAnchors.some(anchor =>
    method.range.start.line <= anchor.line && anchor.line <= method.range.end.line));
}

export async function resolveFrameworkTargets(
  context: FrameworkAdapterContext,
  targetIds: readonly string[]
): Promise<{ declarations: FrameworkDeclarations; timedOut: boolean }> {
  const types: FrameworkDeclarations["types"] = [];
  const methods: FrameworkDeclarations["methods"] = [];
  const fields: FrameworkDeclarations["fields"] = [];
  const missingIds: string[] = [];
  let truncated = false;
  for (let offset = 0; offset < targetIds.length; offset += MAX_DECLARATION_IDS_PER_CALL) {
    if (context.budget.expired()) {
      return { declarations: { types, methods, fields, missingIds, truncated }, timedOut: true };
    }
    const result = await context.frameworkIndex.declarationsById(
      targetIds.slice(offset, offset + MAX_DECLARATION_IDS_PER_CALL)
    );
    types.push(...result.types);
    methods.push(...result.methods);
    fields.push(...result.fields);
    missingIds.push(...result.missingIds);
    truncated = truncated || result.truncated;
  }
  return { declarations: { types, methods, fields, missingIds, truncated }, timedOut: false };
}

function stableKey(values: readonly string[]): string {
  return [...values].sort().join("\0");
}

function memoizeRetryable<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const request = load();
  cache.set(key, request);
  void request.catch(() => cache.delete(key));
  return request;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
