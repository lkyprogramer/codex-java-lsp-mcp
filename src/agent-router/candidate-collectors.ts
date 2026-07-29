// input: Anchors, JavaIndex facts, routing policy, and optional JDT edge store.
// output: Candidate map mutations for type graph, import graph, and persisted semantic edges.
// pos: Static candidate collectors for AgentRouter (Task 22: async JavaIndex V2).
import path from "node:path";
import { classifyPath } from "../repo-layout.js";
import type { EdgeStore, SemanticEdgeKind } from "../edge-store.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
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

export async function collectTypeGraphCandidates(input: CollectCandidatesInput): Promise<void> {
  const { candidates, anchors, options, javaIndex, routingPolicy, generation } = input;
  for (const anchor of anchors) {
    if (!shouldUseTypeGraph(anchor)) {
      continue;
    }
    let isInterface = anchor.profile === "port";
    try {
      isInterface = (await javaIndex.factsFor(anchor.absolutePath, generation)).kind === "interface";
    } catch {
      // A failed fact read must not prevent the ordinary type lookup; it only
      // means this candidate cannot claim the stronger implementation reason.
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    for (const facts of (await javaIndex.findImplementers(typeName, 20, anchor.absolutePath))) {
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 70, "typeGraph");
      if (isInterface) {
        candidate.reasons = ["typeGraph:implementation-lookup"];
      }
      mergeCandidate(candidates, candidate);
    }
  }
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
    // Import graph only needs the declaration identity/path to nominate a
    // candidate.  Hydrating every imported file's full AST bundle creates a
    // large worker payload on wide application services without adding any
    // structural signal to this collector.
    for (const facts of await javaIndex.findTypeDefinitions(localImports, 40, false)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      const alreadyCandidate = candidates.has(facts.absolutePath);
      if (alreadyCandidate) {
        metrics.skippedExisting += 1;
      }
      mergeCandidate(candidates, candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 65, "importGraph"));
      if (!alreadyCandidate) {
        metrics.addedCandidates += 1;
      }
    }
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    const importerLookupName = anchorFacts.packageName ? `${anchorFacts.packageName}.${typeName}` : typeName;
    for (const facts of await javaIndex.findImporters(importerLookupName, 20)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      const alreadyCandidate = candidates.has(facts.absolutePath);
      if (alreadyCandidate) {
        metrics.skippedExisting += 1;
      }
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 20, "importGraph");
      candidate.reasons = ["importGraph:reverse"];
      mergeCandidate(candidates, candidate);
      if (!alreadyCandidate) {
        metrics.addedCandidates += 1;
      }
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
