// input: FrameworkAdapterContext (bounded FrameworkIndexView + request-scoped anchors/candidates/budget).
// output: EvidenceSignal/CandidateFile pairs linking a @Mapper interface's mapping methods to their
//         source/target types, and @Mapper(uses = ...) to the mapper classes it delegates to.
// pos: Task 29 commit 2a/2b. buildMarkerPaths/frameworkSeedFiles/resolveTargets below mirror
//      spring-adapter.ts's own private helpers of the same name - duplicated, not imported, so
//      each framework pack stays an independently removable unit (same choice mybatis-adapter.ts
//      already made). MAPSTRUCT_USES is the one kind needing a technique no other pack uses:
//      FrameworkAnnotation.argumentsText is raw, unparsed source text (confirmed via a real-worker
//      probe before writing the regex: `"(uses = AddressMapper.class)"` /
//      `"(uses = {AddressMapper.class, ContactMapper.class})"`, parens included). A dotted capture
//      is already qualified; a bare simple name is resolved via the file's own explicit import or
//      a same-package guess, then verified through the same declarationsById batch as SOURCE/TARGET -
//      an unresolved candidate produces no evidence, never a guess.
import path from "node:path";
import type { CandidateFile } from "../../agent-types.js";
import { classifyPath } from "../../repo-layout.js";
import { breakdown, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import {
  MAX_DECLARATION_IDS_PER_CALL,
  type FrameworkAnnotation,
  type FrameworkDeclarations,
  type FrameworkFileFacts,
  type FrameworkImport,
  type FrameworkIndexView
} from "../../java-index/framework-index-view.js";
import type { FrameworkAdapter, FrameworkAdapterContext, FrameworkCollectResult } from "./adapter.js";

export const MAPSTRUCT_ADAPTER_ID = "mapstruct";
export const MAPSTRUCT_ADAPTER_VERSION = "1";

const BUILD_MARKER_NAMES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const MAPSTRUCT_DEPENDENCY_PATTERN = /org\.mapstruct/;
const MAPSTRUCT_MAPPER_FQN = "org.mapstruct.Mapper";
const MAPSTRUCT_MAPPING_TARGET_FQN = "org.mapstruct.MappingTarget";

const MAPSTRUCT_SOURCE_WEIGHT = 75;
const MAPSTRUCT_TARGET_WEIGHT = 80;
const MAPSTRUCT_USES_WEIGHT = 70;
const CONFIDENCE = 0.95;

const CLASS_LITERAL_PATTERN = /([\w.]+)\.class/g;

type MapStructEvidenceKind = "MAPSTRUCT_SOURCE" | "MAPSTRUCT_TARGET" | "MAPSTRUCT_USES";

type PendingEvidence = {
  kind: MapStructEvidenceKind;
  sourceFile: string;
  targetId: string;
  weight: number;
  detail: string;
};

function hasAnnotation(annotations: readonly FrameworkAnnotation[], fqn: string): boolean {
  return annotations.some(a => a.resolvedFqn === fqn);
}

/**
 * `@Mapper(uses = ...)`'s class literals, resolved to candidate "type:<fqn>"
 * ids - never guessed past what the file's own imports/package prove. A
 * dotted capture (e.g. "demo.mappers.AddressMapper") is already qualified.
 * A bare simple name resolves via an explicit (non-wildcard) import match,
 * else falls back to the annotated type's own package - the same-package
 * assumption a bare reference makes in real Java source. Wildcard imports
 * are not consulted (unlike normalizeSpringAnnotations' annotation-name
 * resolution): a `uses=` class literal is a plain type reference, and the
 * existing resolver already leaves an ambiguous wildcard candidate
 * unresolved elsewhere in this codebase rather than guessing.
 */
function usesClassLiteralTargetIds(annotation: FrameworkAnnotation, facts: FrameworkFileFacts): string[] {
  const text = annotation.argumentsText;
  if (!text) return [];
  const explicitImports = facts.imports.filter((imp): imp is FrameworkImport => !imp.wildcard && !imp.static);
  const targetIds: string[] = [];
  for (const match of text.matchAll(CLASS_LITERAL_PATTERN)) {
    const captured = match[1]!;
    if (captured.includes(".")) {
      targetIds.push(`type:${captured}`);
      continue;
    }
    const explicitImport = explicitImports.find(imp => imp.qualifiedName.endsWith(`.${captured}`) || imp.qualifiedName === captured);
    if (explicitImport) {
      targetIds.push(`type:${explicitImport.qualifiedName}`);
    } else if (facts.packageName) {
      targetIds.push(`type:${facts.packageName}.${captured}`);
    } else {
      targetIds.push(`type:${captured}`);
    }
  }
  return targetIds;
}

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
  if ([...buildMarkers.values()].some(content => MAPSTRUCT_DEPENDENCY_PATTERN.test(content))) return true;
  if (context.budget.expired()) return false;
  const factMarkers = await context.frameworkIndex.repositoryFactMarkers({
    importPrefixes: ["org.mapstruct."],
    annotationPrefixes: ["org.mapstruct."]
  });
  if (factMarkers.importPrefixFound || factMarkers.annotationPrefixFound) return true;
  // A partial index cannot prove that MapStruct is absent. Running a bounded pack
  // is safe; treating the absence as definitive would not be.
  const status = await context.frameworkIndex.frameworkStatus();
  return status.coverage !== "complete";
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
        diagnostics.push("mapstruct adapter: deadline exhausted while preparing framework facts");
        break;
      }
      const absolutePath = path.resolve(context.repoRoot, factsForFile.relativePath);
      for (const type of factsForFile.types) {
        const mapperAnnotation = type.annotations.find(a => a.resolvedFqn === MAPSTRUCT_MAPPER_FQN);
        if (!mapperAnnotation) continue;
        for (const targetId of usesClassLiteralTargetIds(mapperAnnotation, factsForFile)) {
          pending.push({
            kind: "MAPSTRUCT_USES",
            sourceFile: absolutePath,
            targetId,
            weight: MAPSTRUCT_USES_WEIGHT,
            detail: `${type.simpleName} @Mapper(uses = ...)`
          });
        }
        for (const method of factsForFile.methods) {
          if (method.ownerTypeId !== type.typeId) continue;
          for (const parameter of method.parameters) {
            if (!parameter.type.resolvedFqn) continue;
            const kind: MapStructEvidenceKind = hasAnnotation(parameter.annotations, MAPSTRUCT_MAPPING_TARGET_FQN)
              ? "MAPSTRUCT_TARGET"
              : "MAPSTRUCT_SOURCE";
            pending.push({
              kind,
              sourceFile: absolutePath,
              targetId: `type:${parameter.type.resolvedFqn}`,
              weight: kind === "MAPSTRUCT_TARGET" ? MAPSTRUCT_TARGET_WEIGHT : MAPSTRUCT_SOURCE_WEIGHT,
              detail: `${type.simpleName}.${method.name}(${parameter.name})`
            });
          }
          if (method.returnType?.resolvedFqn) {
            pending.push({
              kind: "MAPSTRUCT_TARGET",
              sourceFile: absolutePath,
              targetId: `type:${method.returnType.resolvedFqn}`,
              weight: MAPSTRUCT_TARGET_WEIGHT,
              detail: `${type.simpleName}.${method.name}() return type`
            });
          }
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
      signalId: `${MAPSTRUCT_ADAPTER_ID}:${signalSeq}`,
      candidateFile: targetAbsolutePath,
      anchorId,
      kind: item.kind,
      family: "FRAMEWORK",
      provenance: "FRAMEWORK_INFERRED",
      confidence: CONFIDENCE,
      completeness,
      weight: item.weight,
      sourceFile: item.sourceFile,
      positions: [],
      providerId: MAPSTRUCT_ADAPTER_ID,
      providerVersion: MAPSTRUCT_ADAPTER_VERSION,
      generation: context.generation,
      detail: item.detail
    });
    mergeCandidate(candidates, mapstructCandidate(context.repoRoot, targetAbsolutePath, item.weight * CONFIDENCE, item.kind));
  }

  if (resolved.declarations.truncated) diagnostics.push(`mapstruct adapter: declarationsById truncated while resolving ${targetIds.length} evidence targets`);
  if (timedOut) diagnostics.push("mapstruct adapter: deadline exhausted before all bounded framework work completed");

  return {
    outcome: {
      providerId: MAPSTRUCT_ADAPTER_ID,
      providerVersion: MAPSTRUCT_ADAPTER_VERSION,
      evidence,
      candidates: [...candidates.values()],
      completion: timedOut ? "PARTIAL_TIMEOUT" : resolved.declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata: {},
    diagnostics
  };
}

function mapstructCandidate(repoRoot: string, absolutePath: string, score: number, kind: MapStructEvidenceKind): CandidateFile {
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
    scoreBreakdown: [breakdown(`evidence.${kind}`, "policy", score, `MapStruct ${kind}`)]
  };
}

export const mapstructAdapter: FrameworkAdapter = { id: MAPSTRUCT_ADAPTER_ID, version: MAPSTRUCT_ADAPTER_VERSION, isActive, collect };
