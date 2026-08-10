// input: Anchors and JavaIndex structural facts (implementers, imports, type references).
// output: ProviderOutcome carrying static-structure EvidenceSignal[] and typed candidate metadata.
// pos: Task 24 Step 5 - wraps candidate-collectors.ts/type-reference.ts unchanged behind the evidence contract.
import type { CandidateFile, ResolvedAnchor } from "../../agent-types.js";
import type { RouterIndexStatus } from "../../java-index/router-java-index.js";
import type { JavaSourceFacts } from "../../java-index/router-facts.js";
import type { EvidenceFamily, EvidenceProvenance, EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import {
  collectImportGraphCandidates,
  collectTypeGraphCandidates
} from "../candidate-collectors.js";
import { candidateFromFacts, mergeCandidate, scoreBase } from "../candidate-helpers.js";
import {
  collectTypeReferenceSignals,
  type TypeReferenceSignalResult
} from "../type-reference.js";
import { timed } from "../runtime.js";
import { updateTypeReferenceCacheMetrics } from "../impact-metrics.js";
import { candidateMetadata, nextSignalId, seedZeroStubs } from "./shared.js";

export const STATIC_PROVIDER_ID = "static";
export const STATIC_PROVIDER_VERSION = "1";

type StaticStage = "typeGraph" | "importGraph";

type ImplementationDependencyKind = "FIELD_TYPE" | "IMPLEMENTATION_METHOD_TYPE";

type ImplementationDependency = {
  readonly anchorId: string;
  readonly anchor: ResolvedAnchor;
  readonly sourceFile: string;
  readonly qualifiedTypeName: string;
  readonly kind: ImplementationDependencyKind;
};

const MAX_IMPLEMENTATIONS_PER_ANCHOR = 4;
const MAX_IMPLEMENTATION_DEPENDENCY_TYPES = 24;

/**
 * Mirrors the old per-reason score bonuses (candidate-collectors.ts/type-reference.ts).
 * `importGraph` is the exact JavaIndex declaration lookup; reverse imports remain a
 * weaker relation. Task 25 replaces this transitional mapping with family saturation.
 */
const STATIC_SIGNAL_POLICY: Record<string, { kind: string; family: EvidenceFamily; provenance: EvidenceProvenance; confidence: number; weight: number }> = {
  typeGraph: { kind: "IMPLEMENTS", family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.85, weight: 70 },
  "typeGraph:implementation-lookup": { kind: "IMPLEMENTS", family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.9, weight: 70 },
  importGraph: { kind: "DIRECT_DECLARATION", family: "STATIC_STRUCTURE", provenance: "AST_EXACT", confidence: 0.98, weight: 65 },
  "importGraph:reverse": { kind: "IMPORTED_BY", family: "STATIC_STRUCTURE", provenance: "AST_EXACT", confidence: 0.55, weight: 20 }
};

const STAGE_REASONS: Record<StaticStage, readonly string[]> = {
  typeGraph: ["typeGraph", "typeGraph:implementation-lookup"],
  importGraph: ["importGraph", "importGraph:reverse"]
};

type CandidateSnapshot = {
  score: number;
  matchCount: number;
  positions: number;
  reasons: readonly string[];
  verifiedBy: readonly string[];
};

/**
 * Runs the stages that preceded naming recall in the original shared-map
 * pipeline: persisted edges -> type graph -> import graph -> lexical recall.
 */
export async function collectStaticStructureEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const candidates = seedZeroStubs(input.repoRoot, input.existingCandidatePaths);
  const evidence: EvidenceSignal[] = [];
  const implementationPathsByAnchor = new Map<string, Set<string>>();
  const failedAnchors = new Set<string>();

  await timed(input.phaseMs, "typeGraph", async () => {
    await collectPerAnchor(input, candidates, evidence, failedAnchors, "typeGraph", async anchor => {
      const implementations = await collectTypeGraphCandidates({
        candidates,
        anchors: [anchor],
        options: input.options,
        javaIndex: input.javaIndex,
        routingPolicy: input.routingPolicy,
        generation: input.generation
      });
      // Defer-mode test implementations remain visible as ordinary recall,
      // but must not fan their fixtures/mocks into the main-source core.
      const paths = new Set(implementations
        .filter(implementation => implementation.sourceSet !== "test" || input.options.testReadMode !== "defer")
        .map(implementation => implementation.absolutePath));
      if (paths.size > 0) {
        implementationPathsByAnchor.set(anchor.id, paths);
      }
    });
  });
  await timed(input.phaseMs, "implementationDependencies", async () => {
    for (const anchorId of await collectImplementationDependencies(input, candidates, evidence, implementationPathsByAnchor)) {
      failedAnchors.add(anchorId);
    }
  });
  await timed(input.phaseMs, "importGraph", async () => {
    await collectPerAnchor(input, candidates, evidence, failedAnchors, "importGraph", async anchor => {
      await collectImportGraphCandidates({
        candidates,
        anchors: [anchor],
        options: input.options,
        javaIndex: input.javaIndex,
        routingPolicy: input.routingPolicy,
        metrics: input.metrics.importGraph,
        generation: input.generation
      });
    });
  });

  return outcome(evidence, startedAt, failedAnchors);
}

/**
 * Runs after lexical recall, retaining the old opportunity for an exact type
 * reference to reinforce a candidate naming recall had already discovered.
 */
export async function collectTypeReferenceEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const evidence: EvidenceSignal[] = [];
  let result: TypeReferenceSignalResult | undefined;
  const typeReferenceBefore = input.budget?.expired() ? undefined : await safeRouterStatus(input);
  await timed(input.phaseMs, "typeReference", async () => {
    result = await collectTypeReferenceSignals({
      anchors: input.anchors,
      options: input.options,
      metrics: input.metrics.typeReference,
      javaIndex: input.javaIndex,
      budget: input.budget,
      generation: input.generation,
      existingCandidatePaths: input.existingCandidatePaths,
      providerId: STATIC_PROVIDER_ID,
      providerVersion: STATIC_PROVIDER_VERSION,
      nextSignalId: () => nextSignalId(STATIC_PROVIDER_ID)
    });
    evidence.push(...result.evidence);
  });
  const terminal = input.budget?.expired()
    || (result?.cancelledAnchorIds.length ?? 0) > 0
    || (result?.deadlineExceededAnchorIds.length ?? 0) > 0;
  const typeReferenceAfter = terminal ? undefined : await safeRouterStatus(input);
  if (typeReferenceBefore && typeReferenceAfter) {
    updateTypeReferenceCacheMetrics(input.metrics.typeReference, typeReferenceBefore, typeReferenceAfter);
  }
  return typeReferenceOutcome(evidence, startedAt, result);
}

/**
 * Compatibility entry point for direct provider tests and callers that do not
 * have a separate lexical phase. The production router calls the two phases
 * above around lexical recall to preserve the former shared-map order.
 */
export async function collectStaticEvidence(input: ProviderInput): Promise<ProviderOutcome> {
  const structure = await collectStaticStructureEvidence(input);
  const knownPaths = [...new Set([
    ...input.existingCandidatePaths,
    ...structure.evidence.map(signal => signal.candidateFile)
  ])];
  const references = await collectTypeReferenceEvidence({ ...input, existingCandidatePaths: knownPaths });
  return {
    providerId: STATIC_PROVIDER_ID,
    providerVersion: STATIC_PROVIDER_VERSION,
    evidence: [...structure.evidence, ...references.evidence],
    completion: structure.completion === "COMPLETE" ? references.completion : structure.completion,
    elapsedMs: structure.elapsedMs + references.elapsedMs,
    ...(!structure.degradation && !references.degradation ? {} : {
      degradation: [structure.degradation, references.degradation].filter(Boolean).join("; ")
    })
  };
}

async function collectPerAnchor(
  input: ProviderInput,
  candidates: Map<string, CandidateFile>,
  evidence: EvidenceSignal[],
  failedAnchors: Set<string>,
  stage: StaticStage,
  collect: (anchor: ResolvedAnchor) => Promise<void>
): Promise<void> {
  for (const anchor of input.anchors) {
    const before = snapshotCandidates(candidates);
    try {
      await collect(anchor);
    } catch {
      failedAnchors.add(anchor.id);
    }
    for (const candidate of candidates.values()) {
      const prior = before.get(candidate.absolutePath);
      if (!changedSince(candidate, prior)) {
        continue;
      }
      evidence.push(...evidenceForCandidate(input, candidate, anchor, stage, prior));
    }
  }
}

/**
 * A resolved implementation is the first exact hop from an interface/port
 * method.  Its injected field types and the explicit-import types used by
 * the matching implementation method are a bounded second hop; this lets a
 * repository task reach its mapper/entity chain without filename inference
 * or a workspace-wide reference scan.
 */
async function collectImplementationDependencies(
  input: ProviderInput,
  candidates: Map<string, CandidateFile>,
  evidence: EvidenceSignal[],
  implementationPathsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Set<string>> {
  const dependencies: ImplementationDependency[] = [];
  const failedAnchors = new Set<string>();
  for (const anchor of input.anchors) {
    if (!anchor.methodName || input.budget.expired()) continue;
    const implementationPaths = [...(implementationPathsByAnchor.get(anchor.id) ?? [])]
      .slice(0, MAX_IMPLEMENTATIONS_PER_ANCHOR);
    for (const implementationPath of implementationPaths) {
      if (input.budget.expired()) break;
      let implementation;
      try {
        implementation = await input.javaIndex.factsFor(implementationPath, input.generation);
      } catch {
        failedAnchors.add(anchor.id);
        continue;
      }
      for (const field of implementation.fieldTypes ?? []) {
        if (field.qualifiedName && field.typeId) {
          dependencies.push({
            anchorId: anchor.id,
            anchor,
            sourceFile: implementation.absolutePath,
            qualifiedTypeName: field.qualifiedName,
            kind: "FIELD_TYPE"
          });
        }
      }
      const importsBySimpleName = new Map(implementation.imports.map(imported => [simpleTypeName(imported), imported]));
      for (const method of implementation.methods.filter(method => method.name === anchor.methodName)) {
        for (const typeName of method.referencedTypes) {
          const qualifiedTypeName = importsBySimpleName.get(simpleTypeName(typeName));
          if (!qualifiedTypeName) continue;
          dependencies.push({
            anchorId: anchor.id,
            anchor,
            sourceFile: implementation.absolutePath,
            qualifiedTypeName,
            kind: "IMPLEMENTATION_METHOD_TYPE"
          });
        }
      }
    }
  }
  const bounded = boundedImplementationDependencies(dependencies, input.anchors, MAX_IMPLEMENTATION_DEPENDENCY_TYPES);
  if (bounded.length === 0) return failedAnchors;
  const dependenciesByType = new Map<string, ImplementationDependency[]>();
  for (const dependency of bounded) {
    const values = dependenciesByType.get(dependency.qualifiedTypeName) ?? [];
    values.push(dependency);
    dependenciesByType.set(dependency.qualifiedTypeName, values);
  }
  let definitions: JavaSourceFacts[];
  try {
    definitions = await input.javaIndex.findTypeDefinitions([...dependenciesByType.keys()], MAX_IMPLEMENTATION_DEPENDENCY_TYPES, false);
  } catch {
    for (const dependency of bounded) failedAnchors.add(dependency.anchorId);
    return failedAnchors;
  }
  for (const definition of definitions) {
    const qualifiedTypeName = definition.qualifiedName;
    if (!qualifiedTypeName) continue;
    for (const dependency of dependenciesByType.get(qualifiedTypeName) ?? []) {
      const weight = dependency.kind === "FIELD_TYPE" ? 70 : 65;
      const candidate = candidateFromFacts(
        definition,
        scoreBase(input.routingPolicy, "semantic", definition, dependency.anchor, input.options) + weight,
        dependency.kind === "FIELD_TYPE" ? "implementationField" : "implementationMethodType"
      );
      mergeCandidate(candidates, candidate);
      evidence.push({
        signalId: nextSignalId(STATIC_PROVIDER_ID),
        candidateFile: definition.absolutePath,
        anchorId: dependency.anchorId,
        kind: dependency.kind,
        family: "STATIC_STRUCTURE",
        provenance: "AST_RESOLVED",
        confidence: dependency.kind === "FIELD_TYPE" ? 0.95 : 0.9,
        completeness: "COMPLETE",
        weight,
        sourceFile: dependency.sourceFile,
        positions: candidate.positions,
        providerId: STATIC_PROVIDER_ID,
        providerVersion: STATIC_PROVIDER_VERSION,
        generation: input.generation,
        detail: "resolved implementation dependency",
        candidateMetadata: candidateMetadata(candidate)
      });
    }
  }
  return failedAnchors;
}

function dedupeImplementationDependencies(dependencies: readonly ImplementationDependency[]): ImplementationDependency[] {
  const unique = new Map<string, ImplementationDependency>();
  for (const dependency of dependencies) {
    unique.set(`${dependency.anchorId}\0${dependency.sourceFile}\0${dependency.kind}\0${dependency.qualifiedTypeName}`, dependency);
  }
  return [...unique.values()];
}

function boundedImplementationDependencies(
  dependencies: readonly ImplementationDependency[],
  anchors: readonly ResolvedAnchor[],
  limit: number
): ImplementationDependency[] {
  const byAnchor = new Map<string, ImplementationDependency[]>();
  for (const dependency of dedupeImplementationDependencies(dependencies)) {
    const values = byAnchor.get(dependency.anchorId) ?? [];
    values.push(dependency);
    byAnchor.set(dependency.anchorId, values);
  }
  const anchorIds = [...anchors]
    .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath)
      || left.line - right.line
      || left.column - right.column
      || left.id.localeCompare(right.id))
    .map(anchor => anchor.id);
  const bounded: ImplementationDependency[] = [];
  for (let index = 0; bounded.length < limit; index += 1) {
    let added = false;
    for (const anchorId of anchorIds) {
      const dependency = byAnchor.get(anchorId)?.[index];
      if (dependency) {
        bounded.push(dependency);
        added = true;
        if (bounded.length === limit) break;
      }
    }
    if (!added) break;
  }
  return bounded;
}

function simpleTypeName(value: string): string {
  const normalized = value.replace(/<.*>/, "").replace(/\[\]$/, "");
  return normalized.slice(normalized.lastIndexOf(".") + 1);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function outcome(
  evidence: EvidenceSignal[],
  startedAt: number,
  failedAnchors: ReadonlySet<string>
): ProviderOutcome {
  const failed = [...failedAnchors].sort();
  return {
    providerId: STATIC_PROVIDER_ID,
    providerVersion: STATIC_PROVIDER_VERSION,
    evidence,
    completion: failed.length > 0 ? "FAILED" : "COMPLETE",
    elapsedMs: Date.now() - startedAt,
    ...(failed.length === 0 ? {} : { degradation: `static provider failed for anchors: ${failed.join(", ")}` })
  };
}

function typeReferenceOutcome(
  evidence: EvidenceSignal[],
  startedAt: number,
  result: TypeReferenceSignalResult | undefined
): ProviderOutcome {
  const failed = result?.failedAnchorIds ?? [];
  const cancelled = result?.cancelledAnchorIds ?? [];
  const timedOut = result?.deadlineExceededAnchorIds ?? [];
  const partial = result?.partialAnchorIds ?? [];
  const completion = failed.length > 0
    ? "FAILED"
    : cancelled.length > 0
      ? "CANCELLED"
      : timedOut.length > 0
        ? "PARTIAL_TIMEOUT"
        : partial.length > 0
          ? "PARTIAL_LIMIT"
          : "COMPLETE";
  const degradation = uniqueStrings([
    ...(failed.length === 0 ? [] : [`static provider failed for anchors: ${failed.join(", ")}`]),
    ...(result?.degradedReasons ?? [])
  ]).join("; ");
  return {
    providerId: STATIC_PROVIDER_ID,
    providerVersion: STATIC_PROVIDER_VERSION,
    evidence,
    completion,
    elapsedMs: Date.now() - startedAt,
    ...(degradation ? { degradation } : {})
  };
}

async function safeRouterStatus(input: ProviderInput): Promise<RouterIndexStatus | undefined> {
  try {
    return input.javaIndex.localRouterStatus?.() ?? await input.javaIndex.routerStatus();
  } catch {
    return undefined;
  }
}

function snapshotCandidates(candidates: ReadonlyMap<string, CandidateFile>): Map<string, CandidateSnapshot> {
  return new Map([...candidates].map(([absolutePath, candidate]) => [absolutePath, {
    score: candidate.score,
    matchCount: candidate.matchCount,
    positions: candidate.positions.length,
    reasons: [...candidate.reasons],
    verifiedBy: [...(candidate.verifiedBy || [])]
  }]));
}

function changedSince(candidate: CandidateFile, prior: CandidateSnapshot | undefined): boolean {
  return !prior
    || candidate.score !== prior.score
    || candidate.matchCount !== prior.matchCount
    || candidate.positions.length !== prior.positions
    || candidate.reasons.length !== prior.reasons.length
    || (candidate.verifiedBy || []).length !== prior.verifiedBy.length;
}

function evidenceForCandidate(
  input: ProviderInput,
  candidate: CandidateFile,
  anchor: ResolvedAnchor,
  stage: StaticStage,
  prior: CandidateSnapshot | undefined
): EvidenceSignal[] {
  const allowedReasons = STAGE_REASONS[stage];
  const currentReasons = candidate.reasons.length > 0 ? candidate.reasons : (candidate.verifiedBy ?? []);
  const addedReasons = currentReasons.filter(reason => allowedReasons.includes(reason) && !prior?.reasons.includes(reason));
  // Repeated evidence of the same kind from a second anchor is still a
  // distinct relationship. `anchorId` is part of normalizer identity, so use
  // the stage reason when an earlier anchor already added the same label.
  const reasons = addedReasons.length > 0
    ? addedReasons
    : currentReasons.filter(reason => allowedReasons.includes(reason));
  const seen = new Set<string>();
  const signals: EvidenceSignal[] = [];
  for (const reason of reasons) {
    const policy = STATIC_SIGNAL_POLICY[reason];
    if (!policy || seen.has(reason)) {
      continue;
    }
    seen.add(reason);
    signals.push({
      signalId: nextSignalId(STATIC_PROVIDER_ID),
      candidateFile: candidate.absolutePath,
      anchorId: anchor.id,
      kind: policy.kind,
      family: policy.family,
      provenance: policy.provenance,
      confidence: policy.confidence,
      completeness: "COMPLETE",
      weight: policy.weight,
      // Import declarations start at the request anchor. Retaining that source
      // lets the planner reserve a bounded core slot for the direct edge while
      // keeping structural expansions as ordinary ranking evidence.
      sourceFile: reason === "importGraph"
        ? anchor.absolutePath
        : candidate.absolutePath,
      positions: candidate.positions,
      providerId: STATIC_PROVIDER_ID,
      providerVersion: STATIC_PROVIDER_VERSION,
      generation: input.generation,
      detail: reason,
      candidateMetadata: candidateMetadata(candidate, {
        reasons: [reason],
        verifiedBy: [reason.startsWith("typeGraph") ? "typeGraph" : stage]
      })
    });
  }
  return signals;
}
