// input: Anchors, existing candidate paths, and JavaIndex type/reference facts.
// output: Evidence-native type-reference and implementation signals without additive CandidateFile scoring.
// pos: Async type-reference collector for AgentRouter (V3.2-14).
import path from "node:path";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { FactsForFileItem, JavaSourceFacts } from "../java-index/router-facts.js";
import type { ImpactOptions, ResolvedAnchor, RouterPosition } from "../agent-types.js";
import type { EvidenceSignal } from "./evidence.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import {
  calleeNamesFromRelations,
  isSpringBootApplicationType,
  matchesAny,
  positionFromFacts,
  sameSourceModule,
  selectPreferredImplementers,
  simpleTypeName,
  unique
} from "./candidate-helpers.js";

export type TypeReferenceMetrics = {
  scannedPatterns: number;
  addedCandidates: number;
  skippedExisting: number;
  elapsedMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheMissElapsedMs: number;
  indexHits: number;
  indexMisses: number;
};

export type CollectTypeReferenceSignalsInput = {
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: Pick<ImpactOptions, "taskKeywords">;
  readonly metrics: TypeReferenceMetrics;
  readonly javaIndex: RouterIndex;
  readonly budget?: DeadlineBudget;
  readonly generation?: number;
  readonly existingCandidatePaths: readonly string[];
  readonly providerId: string;
  readonly providerVersion: string;
  readonly nextSignalId: () => string;
};

export type TypeReferenceSignalResult = {
  readonly evidence: readonly EvidenceSignal[];
  readonly failedAnchorIds: readonly string[];
  readonly cancelledAnchorIds: readonly string[];
  readonly deadlineExceededAnchorIds: readonly string[];
  readonly partialAnchorIds: readonly string[];
  readonly degradedReasons: readonly string[];
};

type TypeReferenceAnchorPlan = {
  readonly anchor: ResolvedAnchor;
  readonly referenceTypeName: string;
};

type TypeReferenceSignalDraft = Omit<EvidenceSignal, "signalId">;

type TypeReferenceOutcome = {
  readonly failedAnchorIds: Set<string>;
  readonly cancelledAnchorIds: Set<string>;
  readonly deadlineExceededAnchorIds: Set<string>;
  readonly partialAnchorIds: Set<string>;
  readonly degradedReasons: string[];
};

const REFERENCE_SPEC = {
  kind: "REFERENCE",
  weight: 55,
  confidence: 0.8,
  reason: "typeReference",
  verifiedBy: "typeReference"
} as const;

const IMPLEMENTATION_SPEC = {
  kind: "IMPLEMENTS",
  weight: 70,
  confidence: 0.9,
  reason: "typeGraph:implementation-lookup",
  verifiedBy: "typeGraph"
} as const;

const BOOT_APPLICATION_SPEC = {
  kind: "SPRING_BOOT_APPLICATION",
  weight: 90,
  confidence: 0.85,
  reason: "SPRING_BOOT_APPLICATION",
  verifiedBy: "typeGraph"
} as const;

const SPRING_BOOT_APPLICATION_TYPE_ID = "external:org.springframework.boot.autoconfigure.SpringBootApplication";

export async function collectTypeReferenceSignals(
  input: CollectTypeReferenceSignalsInput
): Promise<TypeReferenceSignalResult> {
  const plans = input.anchors
    .filter(shouldUseTypeReference)
    .map(anchor => ({
      anchor,
      referenceTypeName: anchor.className || path.basename(anchor.absolutePath, ".java")
    } satisfies TypeReferenceAnchorPlan));
  const outcome = newTypeReferenceOutcome();
  if (input.budget?.expired()) {
    for (const plan of plans) recordBudgetDeadline(outcome, plan.anchor.id);
    return materializeResult([], outcome);
  }
  const anchorFacts = await loadAnchorFacts(input, plans, outcome);
  const knownPaths = new Set(input.existingCandidatePaths);
  const evidence: EvidenceSignal[] = [];

  if (terminalOutcome(outcome)) return materializeResult(evidence, outcome);

  for (const plan of plans) {
    if (input.budget?.expired()) {
      recordBudgetDeadline(outcome, plan.anchor.id);
      break;
    }
    const facts = anchorFacts.get(plan.anchor.id);
    if (!facts) continue;
    const drafts = new Map<string, TypeReferenceSignalDraft>();
    const pathOrder = new Map<string, number>();
    for (const candidatePath of input.existingCandidatePaths) {
      if (!pathOrder.has(candidatePath)) pathOrder.set(candidatePath, pathOrder.size);
    }

    let directReferences: readonly JavaSourceFacts[] = [];
    try {
      directReferences = await input.javaIndex.findTypeReferences(plan.referenceTypeName, 20, {
        typeId: facts.typeId,
        hydrate: false
      });
      input.metrics.scannedPatterns += 1;
    } catch (error) {
      recordOperationFailure(outcome, plan.anchor.id, "direct reference lookup", error);
      if (terminalOutcome(outcome)) {
        evidence.push(...materializeDrafts(input, drafts, pathOrder));
        break;
      }
    }
    for (const reference of directReferences) {
      recordCandidateMetric(input.metrics, knownPaths, reference.absolutePath);
      rememberPath(pathOrder, reference.absolutePath);
      recordReferenceDraft(input, drafts, plan.anchor, reference.absolutePath, [{ line: 1, column: 1 }]);
    }

    const methodFact = methodAtFromFacts(facts, plan.anchor.line);
    const methodTypes = methodFact
      ? unique([...methodFact.relations.map(relation => relation.typeName), ...methodFact.referencedTypes])
      : [];
    const referencedTypes = unique([
      ...methodTypes,
      ...facts.referencedTypes,
      ...facts.imports.filter(imported => matchesAny(simpleTypeName(imported), input.options.taskKeywords))
    ]);
    reinforceImportedCandidates(input, plan.anchor, referencedTypes, pathOrder, drafts);
    if (referencedTypes.length === 0) {
      evidence.push(...materializeDrafts(input, drafts, pathOrder));
      continue;
    }

    input.metrics.scannedPatterns += 1;
    if (input.budget?.expired()) {
      recordBudgetDeadline(outcome, plan.anchor.id);
      evidence.push(...materializeDrafts(input, drafts, pathOrder));
      break;
    }
    let definitions: readonly JavaSourceFacts[] = [];
    try {
      definitions = await input.javaIndex.findTypeDefinitions(referencedTypes, 20, false);
    } catch (error) {
      recordOperationFailure(outcome, plan.anchor.id, "definition lookup", error);
      evidence.push(...materializeDrafts(input, drafts, pathOrder));
      if (terminalOutcome(outcome)) break;
      continue;
    }
    let stopAfterPlan = false;
    const preferredImplementers: JavaSourceFacts[] = [];
    for (const definition of definitions) {
      if (definition.absolutePath === plan.anchor.absolutePath) continue;
      recordCandidateMetric(input.metrics, knownPaths, definition.absolutePath);
      rememberPath(pathOrder, definition.absolutePath);
      recordReferenceDraft(
        input,
        drafts,
        plan.anchor,
        definition.absolutePath,
        [{ line: 1, column: 1 }]
      );
      if (definition.kind !== "interface" || !definition.typeName) continue;
      const qualifiedTypeName = definition.packageName
        ? `${definition.packageName}.${definition.typeName}`
        : definition.typeName;
      if (input.budget?.expired()) {
        recordBudgetDeadline(outcome, plan.anchor.id);
        stopAfterPlan = true;
        break;
      }
      try {
        const preferred = selectPreferredImplementers(await input.javaIndex.findImplementers(
          qualifiedTypeName,
          8,
          plan.anchor.absolutePath,
          { typeId: definition.typeId, hydrate: true }
        ));
        preferredImplementers.push(...preferred);
        for (const implementation of preferred) {
          rememberPath(pathOrder, implementation.absolutePath);
          recordImplementationDraft(
            input,
            drafts,
            plan.anchor,
            implementation.absolutePath,
            [positionFromFacts(implementation, {
              methodName: methodFact?.name ?? plan.anchor.methodName,
              typeName: definition.typeName,
              calleeNames: calleeNamesFromRelations(methodFact?.relations)
            })]
          );
          knownPaths.add(implementation.absolutePath);
        }
      } catch (error) {
        recordOperationFailure(outcome, plan.anchor.id, "implementer lookup", error);
        if (terminalOutcome(outcome)) {
          stopAfterPlan = true;
          break;
        }
      }
    }
    if (!stopAfterPlan && !input.budget?.expired() && needsAnchorBootApplication(facts, preferredImplementers)) {
      try {
        const application = await discoverAnchorBootApplication(input, facts);
        if (application) {
          recordCandidateMetric(input.metrics, knownPaths, application.absolutePath);
          rememberPath(pathOrder, application.absolutePath);
          recordBootApplicationDraft(input, drafts, plan.anchor, application);
          knownPaths.add(application.absolutePath);
        }
      } catch (error) {
        recordOperationFailure(outcome, plan.anchor.id, "boot application lookup", error);
        if (terminalOutcome(outcome)) stopAfterPlan = true;
      }
    }
    evidence.push(...materializeDrafts(input, drafts, pathOrder));
    if (stopAfterPlan) break;
  }

  return materializeResult(evidence, outcome);
}

function materializeResult(
  evidence: readonly EvidenceSignal[],
  outcome: TypeReferenceOutcome
): TypeReferenceSignalResult {
  return {
    evidence,
    failedAnchorIds: [...outcome.failedAnchorIds],
    cancelledAnchorIds: [...outcome.cancelledAnchorIds],
    deadlineExceededAnchorIds: [...outcome.deadlineExceededAnchorIds],
    partialAnchorIds: [...outcome.partialAnchorIds],
    degradedReasons: unique(outcome.degradedReasons)
  };
}

function terminalOutcome(outcome: TypeReferenceOutcome): boolean {
  return outcome.cancelledAnchorIds.size > 0 || outcome.deadlineExceededAnchorIds.size > 0;
}

function recordBudgetDeadline(outcome: TypeReferenceOutcome, anchorId: string): void {
  outcome.deadlineExceededAnchorIds.add(anchorId);
  outcome.degradedReasons.push(`typeReference ${anchorId} request budget exhausted`);
}

async function loadAnchorFacts(
  input: CollectTypeReferenceSignalsInput,
  plans: readonly TypeReferenceAnchorPlan[],
  outcome: TypeReferenceOutcome
): Promise<Map<string, JavaSourceFacts>> {
  const factsByAnchor = new Map<string, JavaSourceFacts>();
  if (plans.length === 0) return factsByAnchor;
  if (input.budget?.expired()) {
    for (const plan of plans) recordBudgetDeadline(outcome, plan.anchor.id);
    return factsByAnchor;
  }
  if (input.javaIndex.factsForFiles) {
    try {
      const result = await input.javaIndex.factsForFiles(plans.map(plan => plan.anchor.absolutePath), input.generation);
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index]!;
        const item = result.items[index];
        if (item?.state === "FOUND") {
          factsByAnchor.set(plan.anchor.id, item.facts);
        } else {
          recordFactsItemOutcome(outcome, plan.anchor.id, item);
        }
      }
      return factsByAnchor;
    } catch (error) {
      for (const plan of plans) recordOperationFailure(outcome, plan.anchor.id, "facts batch", error);
      return factsByAnchor;
    }
  }
  for (const plan of plans) {
    if (input.budget?.expired()) {
      recordBudgetDeadline(outcome, plan.anchor.id);
      break;
    }
    try {
      factsByAnchor.set(plan.anchor.id, await input.javaIndex.factsFor(plan.anchor.absolutePath, input.generation));
    } catch (error) {
      recordOperationFailure(outcome, plan.anchor.id, "anchor facts", error);
    }
  }
  return factsByAnchor;
}

function newTypeReferenceOutcome(): TypeReferenceOutcome {
  return {
    failedAnchorIds: new Set(),
    cancelledAnchorIds: new Set(),
    deadlineExceededAnchorIds: new Set(),
    partialAnchorIds: new Set(),
    degradedReasons: []
  };
}

function recordFactsItemOutcome(
  outcome: TypeReferenceOutcome,
  anchorId: string,
  item: FactsForFileItem | undefined
): void {
  const reason = item?.state === "DEGRADED"
    ? item.reason
    : item?.state === "MISSING"
      ? item.reason
      : "INDEX_INCOMPLETE";
  if (reason === "DEADLINE_EXCEEDED") outcome.deadlineExceededAnchorIds.add(anchorId);
  else if (reason === "CANCELLED") outcome.cancelledAnchorIds.add(anchorId);
  else if (reason === "QUERY_FAILED") outcome.failedAnchorIds.add(anchorId);
  else outcome.partialAnchorIds.add(anchorId);
  outcome.degradedReasons.push(`typeReference ${anchorId} ${reason}`);
}

function recordOperationFailure(
  outcome: TypeReferenceOutcome,
  anchorId: string,
  operation: string,
  error: unknown
): void {
  if (error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED") {
    outcome.deadlineExceededAnchorIds.add(anchorId);
  } else if (error instanceof JavaIntelligenceError && error.code === "CANCELLED") {
    outcome.cancelledAnchorIds.add(anchorId);
  } else {
    outcome.failedAnchorIds.add(anchorId);
  }
  const reason = error instanceof JavaIntelligenceError ? error.code : "QUERY_FAILED";
  outcome.degradedReasons.push(`typeReference ${anchorId} ${operation} ${reason}`);
}

function methodAtFromFacts(facts: JavaSourceFacts, line: number) {
  return [...facts.methods]
    .filter(method => method.line <= line && line <= method.endLine)
    .sort((left, right) => right.line - left.line)[0]
    ?? [...facts.methods]
      .filter(method => method.line <= line)
      .sort((left, right) => right.line - left.line)[0];
}

function reinforceImportedCandidates(
  input: CollectTypeReferenceSignalsInput,
  anchor: ResolvedAnchor,
  referencedTypes: readonly string[],
  pathOrder: ReadonlyMap<string, number>,
  drafts: Map<string, TypeReferenceSignalDraft>
): void {
  const importedPaths = referencedTypes
    .filter(typeName => typeName.includes("."))
    .map(typeName => `${typeName.replace(/\./g, "/")}.java`);
  if (importedPaths.length === 0) return;
  for (const candidatePath of pathOrder.keys()) {
    const normalized = candidatePath.replace(/\\/g, "/");
    if (importedPaths.some(suffix => normalized.endsWith(suffix))) {
      recordReferenceDraft(input, drafts, anchor, candidatePath, []);
    }
  }
}

function recordReferenceDraft(
  input: CollectTypeReferenceSignalsInput,
  drafts: Map<string, TypeReferenceSignalDraft>,
  anchor: ResolvedAnchor,
  candidateFile: string,
  positions: RouterPosition[],
  weight: number = REFERENCE_SPEC.weight
): void {
  recordDraft(drafts, {
    candidateFile,
    anchorId: anchor.id,
    kind: REFERENCE_SPEC.kind,
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: REFERENCE_SPEC.confidence,
    completeness: "COMPLETE",
    weight,
    sourceFile: anchor.absolutePath,
    positions,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    generation: input.generation ?? 0,
    detail: REFERENCE_SPEC.reason,
    candidateMetadata: {
      categories: ["semantic"],
      reasons: [REFERENCE_SPEC.reason],
      verifiedBy: [REFERENCE_SPEC.verifiedBy],
      matchCount: 0
    }
  });
}

function needsAnchorBootApplication(
  anchorFacts: JavaSourceFacts,
  implementers: readonly JavaSourceFacts[]
): boolean {
  return implementers.some(implementation => !sameSourceModule(anchorFacts, implementation));
}

function pickAnchorBootApplication(
  candidates: readonly JavaSourceFacts[],
  anchorFacts: JavaSourceFacts
): JavaSourceFacts | undefined {
  const matches = candidates.filter(candidate =>
    isSpringBootApplicationType(candidate) && sameSourceModule(anchorFacts, candidate));
  if (matches.length === 0) return undefined;
  return matches.find(candidate => (candidate.typeName ?? "").endsWith("Application")) ?? matches[0];
}

async function discoverAnchorBootApplication(
  input: CollectTypeReferenceSignalsInput,
  anchorFacts: JavaSourceFacts
): Promise<JavaSourceFacts | undefined> {
  const options = { typeId: SPRING_BOOT_APPLICATION_TYPE_ID, hydrate: true } as const;
  const annotated = pickAnchorBootApplication(
    await input.javaIndex.findTypeReferences("SpringBootApplication", 8, options),
    anchorFacts
  );
  if (annotated) return annotated;
  return pickAnchorBootApplication(
    await input.javaIndex.findImporters("SpringBootApplication", 8, options),
    anchorFacts
  );
}

function recordBootApplicationDraft(
  input: CollectTypeReferenceSignalsInput,
  drafts: Map<string, TypeReferenceSignalDraft>,
  anchor: ResolvedAnchor,
  application: JavaSourceFacts
): void {
  recordDraft(drafts, {
    candidateFile: application.absolutePath,
    anchorId: anchor.id,
    kind: BOOT_APPLICATION_SPEC.kind,
    family: "FRAMEWORK",
    provenance: "AST_RESOLVED",
    confidence: BOOT_APPLICATION_SPEC.confidence,
    completeness: "COMPLETE",
    weight: BOOT_APPLICATION_SPEC.weight,
    sourceFile: application.absolutePath,
    positions: [positionFromFacts(application)],
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    generation: input.generation ?? 0,
    detail: BOOT_APPLICATION_SPEC.reason,
    candidateMetadata: {
      categories: ["framework"],
      reasons: [BOOT_APPLICATION_SPEC.reason],
      verifiedBy: [BOOT_APPLICATION_SPEC.verifiedBy],
      matchCount: 0
    }
  });
}

function recordImplementationDraft(
  input: CollectTypeReferenceSignalsInput,
  drafts: Map<string, TypeReferenceSignalDraft>,
  anchor: ResolvedAnchor,
  candidateFile: string,
  positions: RouterPosition[]
): void {
  recordDraft(drafts, {
    candidateFile,
    anchorId: anchor.id,
    kind: IMPLEMENTATION_SPEC.kind,
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: IMPLEMENTATION_SPEC.confidence,
    completeness: "COMPLETE",
    weight: IMPLEMENTATION_SPEC.weight,
    sourceFile: candidateFile,
    positions,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    generation: input.generation ?? 0,
    detail: IMPLEMENTATION_SPEC.reason,
    candidateMetadata: {
      categories: ["semantic"],
      reasons: [IMPLEMENTATION_SPEC.reason],
      verifiedBy: [IMPLEMENTATION_SPEC.verifiedBy],
      matchCount: 0
    }
  });
}

function recordDraft(drafts: Map<string, TypeReferenceSignalDraft>, draft: TypeReferenceSignalDraft): void {
  const key = `${draft.anchorId}\0${draft.candidateFile}\0${draft.kind}\0${draft.sourceFile}`;
  const existing = drafts.get(key);
  if (!existing) {
    drafts.set(key, draft);
    return;
  }
  if (draft.weight > existing.weight || (existing.positions.length === 0 && draft.positions.length > 0)) {
    drafts.set(key, {
      ...(draft.weight > existing.weight ? draft : existing),
      positions: existing.positions.length > 0 ? existing.positions : [...draft.positions],
      weight: Math.max(existing.weight, draft.weight)
    });
  }
}

function materializeDrafts(
  input: CollectTypeReferenceSignalsInput,
  drafts: ReadonlyMap<string, TypeReferenceSignalDraft>,
  pathOrder: ReadonlyMap<string, number>
): EvidenceSignal[] {
  return [...drafts.values()]
    .sort((left, right) => (pathOrder.get(left.candidateFile) ?? Number.MAX_SAFE_INTEGER)
      - (pathOrder.get(right.candidateFile) ?? Number.MAX_SAFE_INTEGER))
    .map(draft => ({ ...draft, signalId: input.nextSignalId() }));
}

function recordCandidateMetric(metrics: TypeReferenceMetrics, knownPaths: Set<string>, candidateFile: string): void {
  if (knownPaths.has(candidateFile)) metrics.skippedExisting += 1;
  else {
    knownPaths.add(candidateFile);
    metrics.addedCandidates += 1;
  }
}

function rememberPath(pathOrder: Map<string, number>, candidateFile: string): void {
  if (!pathOrder.has(candidateFile)) pathOrder.set(candidateFile, pathOrder.size);
}

function shouldUseTypeReference(anchor: ResolvedAnchor): boolean {
  return new Set(["controller", "service", "repository", "dto", "port"]).has(anchor.profile);
}
