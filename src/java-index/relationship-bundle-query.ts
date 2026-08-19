// input: QUERY_RELATIONSHIP_BUNDLE plus the live store.
// output: One store-local relationship payload; per-item gaps stay in the result.
// pos: V5R Phase 1 worker command. Query worker remains the unique store writer.
import type { JavaIndexStore } from "./index-store.js";
import type {
  JavaIndexStatus,
  JavaMethodFacts,
  JavaTypeLookupResult,
  JavaTypeRef
} from "./index-types.js";
import {
  clampRelationshipBundleLimits,
  MAX_RELATIONSHIP_BUNDLE_ANCHORS,
  type RelationshipBundleRequest,
  type RelationshipBundleWorkerValue
} from "./relationship-bundle.js";

type BundleQueryDeps = {
  store?: JavaIndexStore;
  status: JavaIndexStatus;
  deriveSourceLayout(inputPath: string): { relativePath: string };
  queryReadRanges(requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>): Promise<unknown>;
  worstTypeLookupCoverage(generation: number): "COMPLETE" | "PARTIAL" | "DEGRADED";
  unresolvedTypeLookup(): JavaTypeLookupResult;
};

export async function queryRelationshipBundle(
  request: RelationshipBundleRequest,
  deps: BundleQueryDeps
): Promise<RelationshipBundleWorkerValue> {
  const limits = clampRelationshipBundleLimits(request.limits);
  const truncatedAnchors = request.anchors.length > MAX_RELATIONSHIP_BUNDLE_ANCHORS;
  const truncatedCandidates = request.candidateFiles.length > limits.maxCandidateFiles;
  const anchors = request.anchors.slice(0, MAX_RELATIONSHIP_BUNDLE_ANCHORS);
  const candidateFiles = request.candidateFiles.slice(0, limits.maxCandidateFiles);
  const metrics = { parsedFiles: 0, hydratedFiles: 0, cacheHits: 0, queryCount: 1 };

  if (request.generation !== deps.status.indexedGeneration) {
    return {
      generation: request.generation,
      indexedGeneration: deps.status.indexedGeneration,
      stale: true,
      completion: "DEGRADED",
      truncated: truncatedAnchors || truncatedCandidates,
      anchors: anchors.map(anchor => emptyAnchorResult(anchor.anchorId)),
      files: [],
      metrics
    };
  }

  const relativePaths = new Set<string>();
  for (const file of [...anchors.map(anchor => anchor.file), ...candidateFiles]) {
    const relativePath = relativePathOf(file, deps);
    if (relativePath) relativePaths.add(relativePath);
  }

  const outAnchors = anchors.map(anchor => {
    const relativePath = relativePathOf(anchor.file, deps);
    const facts = relativePath ? deps.store?.anchor(relativePath, anchor.line, anchor.column) : undefined;
    const method = facts?.method;
    const methodId = anchor.methodId ?? method?.methodId;
    const ownerTypeId = method?.ownerTypeId ?? facts?.type?.typeId;
    const directCalls = request.needs.directCallees && methodId
      ? deps.store?.callees(methodId, limits.maxCallees + 1) ?? []
      : [];
    const calleeTruncated = directCalls.length > limits.maxCallees;
    const boundedCalls = directCalls.slice(0, limits.maxCallees);
    const implementations = request.needs.implementationOverrides && ownerTypeId
      ? deps.store?.implementers(ownerTypeId, limits.maxImplementations) ?? []
      : [];
    for (const implementation of implementations) {
      relativePaths.add(relativePathOfFileId(implementation.fileId));
    }
    const signatureLookups: JavaTypeLookupResult[] = [];
    if (request.needs.signatureDefinitions && method) {
      for (const typeText of signatureTypeTexts(method).slice(0, limits.maxDefinitions)) {
        const lookup = deps.store
          ? deps.store.typeLookup(typeText, relativePath)
          : deps.unresolvedTypeLookup();
        const value = lookup.state === "UNRESOLVED"
          ? { ...lookup, coverage: deps.worstTypeLookupCoverage(deps.status.indexedGeneration) }
          : lookup;
        signatureLookups.push(value);
        if (value.state === "RESOLVED") relativePaths.add(relativePathOfFileId(value.type.fileId));
      }
    }
    return {
      anchorId: anchor.anchorId,
      ...(methodId ? { methodId } : {}),
      ...(ownerTypeId ? { ownerTypeId } : {}),
      directCalls: boundedCalls,
      implementations,
      signatureLookups,
      calleeTruncated
    };
  });

  const wantFiles = request.needs.anchorFacts || request.needs.candidateFacts || request.needs.frameworkFacts;
  const requestedPaths = [...relativePaths].slice(0, limits.maxCandidateFiles);
  const truncatedFiles = relativePaths.size > limits.maxCandidateFiles;
  const files = wantFiles ? deps.store?.files(requestedPaths) ?? [] : [];
  metrics.parsedFiles = files.length;
  metrics.hydratedFiles = files.length;

  const readRanges = request.needs.readRanges
    ? await deps.queryReadRanges(anchors.map(anchor => ({
      file: anchor.file,
      positions: [{ line: anchor.line, column: anchor.column }]
    })))
    : undefined;

  const truncated = truncatedAnchors || truncatedCandidates || truncatedFiles;
  const missingRequested = wantFiles && files.length < requestedPaths.length;
  return {
    generation: request.generation,
    indexedGeneration: deps.status.indexedGeneration,
    stale: false,
    completion: truncated || missingRequested ? "PARTIAL" : "COMPLETE",
    truncated,
    anchors: outAnchors,
    files,
    ...(readRanges ? { readRanges: readRanges as RelationshipBundleWorkerValue["readRanges"] } : {}),
    metrics
  };
}

function emptyAnchorResult(anchorId: string): RelationshipBundleWorkerValue["anchors"][number] {
  return {
    anchorId,
    directCalls: [],
    implementations: [],
    signatureLookups: [],
    calleeTruncated: false
  };
}

function relativePathOf(inputPath: string, deps: BundleQueryDeps): string | undefined {
  try {
    return deps.deriveSourceLayout(inputPath).relativePath;
  } catch {
    return undefined;
  }
}

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function signatureTypeTexts(method: JavaMethodFacts): string[] {
  const parameters = method.parameters.flatMap(parameter => typeRefTexts(parameter.type, true));
  const returns = method.returnType
    ? typeRefTexts(method.returnType, method.returnType.typeArguments.length === 0)
    : [];
  return [...new Set([...parameters, ...returns])];
}

function typeRefTexts(ref: JavaTypeRef, includeSelf: boolean): string[] {
  const own = includeSelf && repoTypeText(ref) ? [repoTypeText(ref)!] : [];
  return [...own, ...ref.typeArguments.flatMap(argument => typeRefTexts(argument, true))];
}

function repoTypeText(ref: JavaTypeRef): string | undefined {
  if (ref.resolution.state === "RESOLVED_REPO") return ref.qualifiedName ?? ref.text;
  if (ref.qualifiedName) return ref.qualifiedName;
  return undefined;
}
