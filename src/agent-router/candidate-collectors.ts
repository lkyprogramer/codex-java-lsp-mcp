// input: Anchors, JavaIndex facts, routing policy, and the persisted SemanticEdgeStoreV2.
// output: Candidate map mutations for type graph, import graph, and persisted semantic edges.
// pos: Static candidate collectors for AgentRouter (Task 22: async JavaIndex V2; Task 33
//      moved collectPersistedSemanticCandidates onto the versioned semantic edge snapshot).
import path from "node:path";
import { classifyPath } from "../repo-layout.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import type { PersistedSemanticEdgeRelation, SemanticEdgeStoreV2 } from "../semantic-edge-store.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  breakdown,
  candidateFromFacts,
  mergeCandidate,
  scoreBase
} from "./candidate-helpers.js";

export type ImportGraphMetrics = {
  scannedAnchors: number;
  addedCandidates: number;
  skippedExisting: number;
  elapsedMs: number;
};

type CollectCandidatesInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly generation?: number;
};

type CollectImportGraphInput = CollectCandidatesInput & {
  readonly metrics: ImportGraphMetrics;
};

type CollectPersistedSemanticInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly candidateMapForAnchor?: (anchor: ResolvedAnchor) => Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly repoRoot: string;
  readonly routingPolicy: RoutingPolicy;
  readonly javaIndex: RouterIndex;
  readonly edgeStoreV2: SemanticEdgeStoreV2;
  readonly generation: number;
  readonly metrics: { edgesSeen: number; addedCandidates: number };
};

export function candidateFromAnchor(anchor: ResolvedAnchor): CandidateFile {
  return {
    absolutePath: anchor.absolutePath,
    path: anchor.path,
    module: anchor.module,
    layer: anchor.layer,
    sourceSet: anchor.sourceSet,
    score: 1000,
    matchCount: 0,
    positions: [{ line: anchor.line, column: anchor.column }],
    categories: ["target"],
    reasons: ["target"],
    confidence: "high",
    verifiedBy: ["anchor"],
    scoreBreakdown: [breakdown("anchor.target", "anchor", 1000, "anchor symbol and local behavior")]
  };
}

/**
 * Returns exactly the implementation facts merged into `candidates`.  The
 * provider needs that identity for a bounded, exact second hop; deriving it
 * later from score/reason deltas is lossy when providers share candidates.
 */
export async function collectTypeGraphCandidates(input: CollectCandidatesInput): Promise<JavaSourceFacts[]> {
  const { candidates, anchors, options, javaIndex, routingPolicy, generation } = input;
  const implementations: JavaSourceFacts[] = [];
  for (const anchor of anchors) {
    if (!shouldUseTypeGraph(anchor)) {
      continue;
    }
    let isInterface = anchor.profile === "port";
    let anchorTypeId: string | undefined;
    try {
      const anchorFacts = await javaIndex.factsFor(anchor.absolutePath, generation);
      isInterface = anchorFacts.kind === "interface";
      anchorTypeId = anchorFacts.typeId;
    } catch {
      // A failed fact read must not prevent the ordinary type lookup; it only
      // means this candidate cannot claim the stronger implementation reason.
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    for (const facts of (await javaIndex.findImplementers(
      typeName,
      20,
      anchor.absolutePath,
      { typeId: anchorTypeId, hydrate: true }
    ))) {
      implementations.push(facts);
      const candidate = candidateFromFacts(
        facts,
        scoreBase(routingPolicy, "semantic", facts, anchor, options) + 70,
        "typeGraph",
        { methodName: anchor.methodName, typeName: anchor.className }
      );
      if (isInterface) {
        candidate.reasons = ["typeGraph:implementation-lookup"];
      }
      mergeCandidate(candidates, candidate);
    }
  }
  return implementations;
}

export async function collectImportGraphCandidates(input: CollectImportGraphInput): Promise<void> {
  const { candidates, anchors, options, javaIndex, routingPolicy, metrics, generation } = input;
  if (options.semanticPolicy === "required") {
    return;
  }
  for (const anchor of anchors) {
    let anchorFacts: JavaSourceFacts;
    try {
      anchorFacts = await javaIndex.factsFor(anchor.absolutePath, generation);
    } catch {
      continue;
    }
    metrics.scannedAnchors += 1;
    const localImports = projectLocalImports(anchorFacts.imports, anchorFacts.packageName);
    const positionHint = { methodName: anchor.methodName, typeName: anchor.className };
    for (const facts of await javaIndex.findTypeDefinitions(localImports, 40, true)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      const alreadyCandidate = candidates.has(facts.absolutePath);
      if (alreadyCandidate) {
        metrics.skippedExisting += 1;
      }
      mergeCandidate(
        candidates,
        candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 65, "importGraph", positionHint)
      );
      if (!alreadyCandidate) {
        metrics.addedCandidates += 1;
      }
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    const importerLookupName = anchorFacts.packageName ? `${anchorFacts.packageName}.${typeName}` : typeName;
    for (const facts of await javaIndex.findImporters(importerLookupName, 20, {
      typeId: anchorFacts.typeId,
      hydrate: true
    })) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      const alreadyCandidate = candidates.has(facts.absolutePath);
      if (alreadyCandidate) {
        metrics.skippedExisting += 1;
      }
      const candidate = candidateFromFacts(
        facts,
        scoreBase(routingPolicy, "semantic", facts, anchor, options) + 20,
        "importGraph",
        positionHint
      );
      candidate.reasons = ["importGraph:reverse"];
      mergeCandidate(candidates, candidate);
      if (!alreadyCandidate) {
        metrics.addedCandidates += 1;
      }
    }
  }
}

export async function collectPersistedSemanticCandidates(
  input: CollectPersistedSemanticInput
): Promise<{ failedAnchors: string[] }> {
  const { candidates, anchors, options, repoRoot, routingPolicy, javaIndex, edgeStoreV2, generation, metrics } = input;
  if (options.semanticPolicy === "required") {
    return { failedAnchors: [] };
  }
  const failedAnchors: string[] = [];
  for (const anchor of anchors) {
    const anchorCandidates = input.candidateMapForAnchor?.(anchor) ?? candidates;
    let anchorSymbol: { symbolId: string } | undefined;
    try {
      anchorSymbol = await javaIndex.queryAnchor(anchor.absolutePath, anchor.line, anchor.column);
    } catch {
      failedAnchors.push(anchor.id);
      continue;
    }
    if (!anchorSymbol) {
      continue;
    }
    const seenEdges = new Set<string>();
    let uniqueEdges = 0;
    for (const edge of edgeStoreV2.findFrom(anchorSymbol.symbolId, generation)) {
      metrics.edgesSeen += 1;
      const kind = persistedRelationToKind(edge.relation);
      if (!kind) {
        continue;
      }
      const edgeKey = `${kind}\0${edge.targetFile}`;
      if (seenEdges.has(edgeKey)) {
        continue;
      }
      seenEdges.add(edgeKey);
      if (edge.targetFile === anchor.absolutePath) {
        continue;
      }
      if (uniqueEdges >= 40) {
        break;
      }
      const context = classifyPath(repoRoot, edge.targetFile);
      const score = scoreBase(routingPolicy, "semantic", context, anchor, options) + persistedEdgeScoreBonus(kind);
      // Edges written before targetRanges was added to the dual-write (Task
      // 33 read-cutover) still carry an empty array; this rebuildable cache
      // just falls back to {1,1} for those until they age out or are rewritten.
      const range = edge.targetRanges[0]?.start ?? { line: 1, column: 1 };
      mergeCandidate(anchorCandidates, {
        absolutePath: edge.targetFile,
        path: context.relativePath,
        module: context.module,
        layer: context.layer,
        sourceSet: context.sourceSet,
        score,
        matchCount: 0,
        positions: [{ line: range.line, column: range.column }],
        categories: ["semantic"],
        reasons: [`persisted-${kind}`],
        confidence: "high",
        verifiedBy: [`persisted-${kind}`],
        scoreBreakdown: [breakdown(`semantic.persisted-${kind}`, "semantic-seed", score, `persisted ${kind} edge`)]
      });
      metrics.addedCandidates += 1;
      uniqueEdges += 1;
    }
  }
  return { failedAnchors };
}

function shouldUseTypeGraph(anchor: ResolvedAnchor): boolean {
  return anchor.kind === "interface" || new Set(["port", "repository", "service"]).has(anchor.profile);
}

function projectLocalImports(imports: string[], packageName: string | undefined): string[] {
  if (!packageName) {
    return [];
  }
  const segments = packageName.split(".");
  const prefixLength = segments.length >= 3 ? 2 : 1;
  const prefix = segments.slice(0, prefixLength).join(".");
  return imports.filter(value => value.startsWith(`${prefix}.`));
}

type PersistedEdgeKind = "reference" | "implementation" | "typeHierarchy";

function persistedRelationToKind(relation: PersistedSemanticEdgeRelation): PersistedEdgeKind | undefined {
  if (relation === "JDT_REFERENCE") {
    return "reference";
  }
  if (relation === "JDT_IMPLEMENTATION") {
    return "implementation";
  }
  if (relation === "JDT_TYPE_HIERARCHY") {
    return "typeHierarchy";
  }
  return undefined;
}

function persistedEdgeScoreBonus(kind: PersistedEdgeKind): number {
  if (kind === "implementation") {
    return 90;
  }
  if (kind === "typeHierarchy") {
    return 70;
  }
  return 10;
}
