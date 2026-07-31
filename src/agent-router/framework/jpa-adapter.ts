// input: FrameworkAdapterContext (bounded FrameworkIndexView + request-scoped anchors/candidates/budget).
// output: EvidenceSignal/CandidateFile pairs linking a Spring Data repository to its JPA entity,
//         an entity to its relation-annotated fields' related entities, and a derived-query method
//         back to its owning repository's entity.
// pos: Task 29 commit 3. buildMarkerPaths/frameworkSeedFiles/isMethodAnchor/rankableMethodsFor/
//      resolveTargets below mirror spring-adapter.ts's own private helpers of the same name -
//      duplicated, not imported, so each framework pack stays an independently removable unit.
import path from "node:path";
import type { CandidateFile } from "../../agent-types.js";
import { classifyPath } from "../../repo-layout.js";
import { breakdown, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import {
  MAX_DECLARATION_IDS_PER_CALL,
  type FrameworkDeclarations,
  type FrameworkFileFacts,
  type FrameworkIndexView,
  type FrameworkMethodDeclaration,
  type FrameworkTypeDeclaration,
  type FrameworkTypeRef
} from "../../java-index/framework-index-view.js";
import {
  isEntity,
  isRelationField,
  normalizeJpaAnnotations,
  JPA_REPOSITORY_BASE_FQNS
} from "./jpa-annotations.js";
import type { FrameworkAdapter, FrameworkAdapterContext, FrameworkCollectResult } from "./adapter.js";

export const JPA_ADAPTER_ID = "jpa";
export const JPA_ADAPTER_VERSION = "1";

const BUILD_MARKER_NAMES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const JPA_DEPENDENCY_PATTERN = /jakarta\.persistence|javax\.persistence|spring-data-jpa|spring-boot-starter-data-jpa|hibernate-core/;

const JPA_REPOSITORY_ENTITY_WEIGHT = 100;
const JPA_ENTITY_RELATION_WEIGHT = 85;
const JPA_DERIVED_QUERY_WEIGHT = 55;
const EXACT_CONFIDENCE = 0.98;
const RELATION_CONFIDENCE = 0.95;
// Deliberately lower than every exact-match kind in any pack: a derived-query
// match is a method-name-shape heuristic (Step 2's "conservative... do not
// attempt full Spring Data grammar"), not a resolved reference.
const DERIVED_QUERY_CONFIDENCE = 0.70;

// Step 2: "split known prefixes (find, get, read, exists, count, delete) and
// By; tokens are metadata only" - recognition is a name-shape sniff, never a
// parse of the filter tokens themselves.
const DERIVED_QUERY_PREFIXES = ["find", "get", "read", "exists", "count", "delete"];

type JpaEvidenceKind = "JPA_REPOSITORY_ENTITY" | "JPA_ENTITY_RELATION" | "JPA_DERIVED_QUERY";

type PendingEvidence = {
  kind: JpaEvidenceKind;
  sourceFile: string;
  targetId: string;
  weight: number;
  confidence: number;
  detail: string;
};

// mirrors spring-adapter.ts's frameworkSeedFiles.
function frameworkSeedFiles(context: FrameworkAdapterContext): Set<string> {
  const seeds = new Set(context.anchors.map(anchor => anchor.absolutePath));
  for (const candidate of context.staticEvidence) {
    if ((candidate.familyScores.STATIC_STRUCTURE ?? 0) > 0) {
      seeds.add(candidate.file);
    }
  }
  return seeds;
}

// mirrors spring-adapter.ts's buildMarkerPaths.
function buildMarkerPaths(context: FrameworkAdapterContext): string[] {
  const paths = new Set<string>(BUILD_MARKER_NAMES);
  for (const source of [...context.anchors.map(anchor => anchor.absolutePath), ...context.candidateFiles]) {
    const relative = path.relative(context.repoRoot, source).replace(/\\/g, "/");
    const sourceRootIndex = relative.indexOf("/src/");
    if (sourceRootIndex <= 0) continue;
    const moduleRoot = relative.slice(0, sourceRootIndex);
    for (const marker of BUILD_MARKER_NAMES) paths.add(`${moduleRoot}/${marker}`);
  }
  return [...paths];
}

async function isActive(context: FrameworkAdapterContext): Promise<boolean> {
  if (context.budget.expired()) return false;
  const buildMarkers = await context.frameworkIndex.repositoryMarkers(buildMarkerPaths(context));
  if ([...buildMarkers.values()].some(content => JPA_DEPENDENCY_PATTERN.test(content))) return true;
  if (context.budget.expired()) return false;
  const factMarkers = await context.frameworkIndex.repositoryFactMarkers({
    importPrefixes: ["jakarta.persistence.", "javax.persistence.", "org.springframework.data."],
    annotationPrefixes: ["jakarta.persistence.", "javax.persistence."]
  });
  if (factMarkers.importPrefixFound || factMarkers.annotationPrefixFound) return true;
  // A partial index cannot prove that JPA is absent. Running a bounded pack
  // is safe; treating the absence as definitive would not be.
  const status = await context.frameworkIndex.frameworkStatus();
  return status.coverage !== "complete";
}

// mirrors spring-adapter.ts's isMethodAnchor/rankableMethodsFor.
function isMethodAnchor(anchor: FrameworkAdapterContext["anchors"][number], absolutePath: string): boolean {
  return anchor.absolutePath === absolutePath && anchor.kind.toLowerCase() === "method";
}

function rankableMethodsFor(
  context: FrameworkAdapterContext,
  absolutePath: string,
  methods: readonly FrameworkMethodDeclaration[]
): FrameworkMethodDeclaration[] {
  const methodAnchors = context.anchors.filter(anchor => isMethodAnchor(anchor, absolutePath));
  if (methodAnchors.length === 0) return [...methods];
  return methods.filter(method => methodAnchors.some(anchor =>
    method.range.start.line <= anchor.line && anchor.line <= method.range.end.line));
}

// mirrors spring-adapter.ts's resolveTargets.
async function resolveTargets(
  frameworkIndex: FrameworkIndexView,
  targetIds: readonly string[],
  context: FrameworkAdapterContext
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
    const result = await frameworkIndex.declarationsById(targetIds.slice(offset, offset + MAX_DECLARATION_IDS_PER_CALL));
    types.push(...result.types);
    methods.push(...result.methods);
    fields.push(...result.fields);
    missingIds.push(...result.missingIds);
    truncated = truncated || result.truncated;
  }
  return { declarations: { types, methods, fields, missingIds, truncated }, timedOut: false };
}

/** The entity type argument of a recognized Spring Data repository base (Repository<Entity, Id>'s first argument) - undefined when the type extends/implements none of them, or when that argument is unresolved/ambiguous (Step 2: "ambiguous generic produces no exact repository edge"). */
function repositoryEntityTypeArg(type: FrameworkTypeDeclaration): FrameworkTypeRef | undefined {
  for (const ref of [...type.extends, ...type.implements]) {
    if (ref.resolvedFqn && JPA_REPOSITORY_BASE_FQNS.has(ref.resolvedFqn)) {
      return ref.typeArguments[0];
    }
  }
  return undefined;
}

/** A relation field's related entity is its single generic type argument for a collection-valued relation (List<X>/Set<X>/Collection<X> - @OneToMany/@ManyToMany), or its own type for a single-valued relation (@ManyToOne/@OneToOne). Structural, not annotation-specific: a single-valued relation is never itself generic in real JPA code. */
function relatedEntityRef(fieldType: FrameworkTypeRef): FrameworkTypeRef {
  return fieldType.typeArguments.length === 1 ? fieldType.typeArguments[0]! : fieldType;
}

function isDerivedQueryMethodName(name: string): boolean {
  return DERIVED_QUERY_PREFIXES.some(prefix => {
    if (!name.startsWith(prefix)) return false;
    const rest = name.slice(prefix.length);
    return rest.length === 0 || /^[A-Z]/.test(rest);
  });
}

async function collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult> {
  const startedAt = Date.now();
  const status = await context.frameworkIndex.frameworkStatus();
  const completeness: EvidenceCompleteness = status.coverage === "complete" ? "COMPLETE" : status.coverage === "degraded" ? "UNKNOWN" : "PARTIAL";
  const diagnostics: string[] = [];
  let timedOut = context.budget.expired();

  const seeds = frameworkSeedFiles(context);
  const candidateFiles = context.candidateFiles.filter(candidate => seeds.has(candidate));
  const facts: FrameworkFileFacts[] = timedOut ? [] : await context.frameworkIndex.frameworkFactsForFiles(candidateFiles, context.generation);
  if (!timedOut && context.budget.expired()) timedOut = true;

  const pending: PendingEvidence[] = [];
  if (!timedOut) {
    for (const factsForFile of facts) {
      if (context.budget.expired()) {
        timedOut = true;
        diagnostics.push("jpa adapter: deadline exhausted while preparing framework facts");
        break;
      }
      const absolutePath = path.resolve(context.repoRoot, factsForFile.relativePath);
      for (const type of factsForFile.types) {
        const entityRef = repositoryEntityTypeArg(type);
        if (entityRef?.resolvedFqn) {
          pending.push({
            kind: "JPA_REPOSITORY_ENTITY",
            sourceFile: absolutePath,
            targetId: `type:${entityRef.resolvedFqn}`,
            weight: JPA_REPOSITORY_ENTITY_WEIGHT,
            confidence: EXACT_CONFIDENCE,
            detail: `${type.simpleName} repository entity`
          });
          const methods = factsForFile.methods.filter(method => method.ownerTypeId === type.typeId);
          for (const method of rankableMethodsFor(context, absolutePath, methods)) {
            if (!isDerivedQueryMethodName(method.name)) continue;
            pending.push({
              kind: "JPA_DERIVED_QUERY",
              sourceFile: absolutePath,
              targetId: `type:${entityRef.resolvedFqn}`,
              weight: JPA_DERIVED_QUERY_WEIGHT,
              confidence: DERIVED_QUERY_CONFIDENCE,
              detail: `${type.simpleName}.${method.name}() derived query`
            });
          }
        }

        const typeAnnotations = normalizeJpaAnnotations(type.annotations, factsForFile.imports, factsForFile.coverage);
        if (!isEntity(typeAnnotations)) continue;
        for (const field of factsForFile.fields) {
          if (field.ownerTypeId !== type.typeId) continue;
          const fieldAnnotations = normalizeJpaAnnotations(field.annotations, factsForFile.imports, factsForFile.coverage);
          if (!isRelationField(fieldAnnotations)) continue;
          const related = relatedEntityRef(field.type);
          if (!related.resolvedFqn) continue;
          pending.push({
            kind: "JPA_ENTITY_RELATION",
            sourceFile: absolutePath,
            targetId: `type:${related.resolvedFqn}`,
            weight: JPA_ENTITY_RELATION_WEIGHT,
            confidence: RELATION_CONFIDENCE,
            detail: `${type.simpleName}.${field.name} relation`
          });
        }
      }
    }
  }

  const targetIds = [...new Set(pending.map(item => item.targetId))];
  const resolved = timedOut || targetIds.length === 0
    ? { declarations: { types: [], methods: [], fields: [], missingIds: [], truncated: false }, timedOut }
    : await resolveTargets(context.frameworkIndex, targetIds, context);
  timedOut = timedOut || resolved.timedOut;
  const relativePathByTypeId = new Map(resolved.declarations.types.map(type => [type.typeId, type.relativePath]));

  const evidence: EvidenceSignal[] = [];
  const candidates = new Map<string, CandidateFile>();
  const anchorId = context.anchors[0]?.id ?? "A1";
  let signalSeq = 0;
  for (const item of pending) {
    const relativePath = relativePathByTypeId.get(item.targetId);
    if (!relativePath) continue;
    const targetAbsolutePath = path.resolve(context.repoRoot, relativePath);
    signalSeq += 1;
    evidence.push({
      signalId: `${JPA_ADAPTER_ID}:${signalSeq}`,
      candidateFile: targetAbsolutePath,
      anchorId,
      kind: item.kind,
      family: "FRAMEWORK",
      provenance: "FRAMEWORK_INFERRED",
      confidence: item.confidence,
      completeness,
      weight: item.weight,
      sourceFile: item.sourceFile,
      positions: [],
      providerId: JPA_ADAPTER_ID,
      providerVersion: JPA_ADAPTER_VERSION,
      generation: context.generation,
      detail: item.detail
    });
    mergeCandidate(candidates, jpaCandidate(context.repoRoot, targetAbsolutePath, item.weight * item.confidence, item.kind));
  }

  if (resolved.declarations.truncated) diagnostics.push(`jpa adapter: declarationsById truncated while resolving ${targetIds.length} evidence targets`);
  if (timedOut) diagnostics.push("jpa adapter: deadline exhausted before all bounded framework work completed");

  return {
    outcome: {
      providerId: JPA_ADAPTER_ID,
      providerVersion: JPA_ADAPTER_VERSION,
      evidence,
      candidates: [...candidates.values()],
      completion: timedOut ? "PARTIAL_TIMEOUT" : resolved.declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata: {},
    diagnostics
  };
}

function jpaCandidate(repoRoot: string, absolutePath: string, score: number, kind: JpaEvidenceKind): CandidateFile {
  const context = classifyPath(repoRoot, absolutePath);
  return {
    absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score,
    matchCount: 0,
    positions: [],
    categories: ["framework"],
    reasons: [kind],
    confidence: "high",
    verifiedBy: [kind],
    scoreBreakdown: [breakdown(`evidence.${kind}`, "policy", score, `JPA ${kind}`)]
  };
}

export const jpaAdapter: FrameworkAdapter = { id: JPA_ADAPTER_ID, version: JPA_ADAPTER_VERSION, isActive, collect };
