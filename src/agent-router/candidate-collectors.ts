import path from "node:path";
import { classifyPath } from "../repo-layout.js";
import type { EdgeStore, SemanticEdgeKind } from "../edge-store.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { JavaSourceFacts, SourceIndex } from "../source-index.js";
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
  readonly sourceIndex: SourceIndex;
  readonly routingPolicy: RoutingPolicy;
};

type CollectImportGraphInput = CollectCandidatesInput & {
  readonly metrics: ImportGraphMetrics;
};

type CollectPersistedSemanticInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly repoRoot: string;
  readonly routingPolicy: RoutingPolicy;
  readonly edgeStore: EdgeStore;
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

export function collectTypeGraphCandidates(input: CollectCandidatesInput): void {
  const { candidates, anchors, options, sourceIndex, routingPolicy } = input;
  for (const anchor of anchors) {
    if (!shouldUseTypeGraph(anchor)) {
      continue;
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    for (const facts of sourceIndex.findImplementers(typeName).slice(0, 20)) {
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 70, "typeGraph");
      mergeCandidate(candidates, candidate);
    }
  }
}

export function collectImportGraphCandidates(input: CollectImportGraphInput): void {
  const { candidates, anchors, options, sourceIndex, routingPolicy, metrics } = input;
  if (options.semanticPolicy === "required") {
    return;
  }
  for (const anchor of anchors) {
    let anchorFacts: JavaSourceFacts;
    try {
      anchorFacts = sourceIndex.factsFor(anchor.absolutePath);
    } catch {
      continue;
    }
    metrics.scannedAnchors += 1;
    const localImports = projectLocalImports(anchorFacts.imports, anchorFacts.packageName);
    for (const facts of sourceIndex.findTypeDefinitions(localImports).slice(0, 40)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      if (candidates.has(facts.absolutePath)) {
        metrics.skippedExisting += 1;
        continue;
      }
      mergeCandidate(candidates, candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 65, "importGraph"));
      metrics.addedCandidates += 1;
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    const importerLookupName = anchorFacts.packageName ? `${anchorFacts.packageName}.${typeName}` : typeName;
    for (const facts of sourceIndex.findImporters(importerLookupName).slice(0, 20)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      if (candidates.has(facts.absolutePath)) {
        metrics.skippedExisting += 1;
        continue;
      }
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 20, "importGraph");
      candidate.reasons = ["importGraph:reverse"];
      mergeCandidate(candidates, candidate);
      metrics.addedCandidates += 1;
    }
  }
}

export function collectPersistedSemanticCandidates(input: CollectPersistedSemanticInput): void {
  const { candidates, anchors, options, repoRoot, routingPolicy, edgeStore, metrics } = input;
  if (options.semanticPolicy === "required") {
    return;
  }
  for (const anchor of anchors) {
    const seenEdges = new Set<string>();
    let uniqueEdges = 0;
    for (const edge of edgeStore.edgesFor(anchor.absolutePath)) {
      metrics.edgesSeen += 1;
      const edgeKey = `${edge.kind}\0${edge.to}`;
      if (seenEdges.has(edgeKey)) {
        continue;
      }
      seenEdges.add(edgeKey);
      if (edge.to === anchor.absolutePath) {
        continue;
      }
      if (uniqueEdges >= 40) {
        break;
      }
      const context = classifyPath(repoRoot, edge.to);
      const score = scoreBase(routingPolicy, "semantic", context, anchor, options) + persistedEdgeScoreBonus(edge.kind);
      mergeCandidate(candidates, {
        absolutePath: edge.to,
        path: context.relativePath,
        module: context.module,
        layer: context.layer,
        sourceSet: context.sourceSet,
        score,
        matchCount: 0,
        positions: [{ line: edge.line, column: edge.column }],
        categories: ["semantic"],
        reasons: [`persisted-${edge.kind}`],
        confidence: "high",
        verifiedBy: [`persisted-${edge.kind}`],
        scoreBreakdown: [breakdown(`semantic.persisted-${edge.kind}`, "semantic-seed", score, `persisted ${edge.kind} edge`)]
      });
      metrics.addedCandidates += 1;
      uniqueEdges += 1;
    }
  }
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

function persistedEdgeScoreBonus(kind: SemanticEdgeKind): number {
  if (kind === "implementation") {
    return 90;
  }
  if (kind === "typeHierarchy") {
    return 70;
  }
  return 10;
}
