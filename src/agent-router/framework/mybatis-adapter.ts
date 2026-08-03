// input: FrameworkAdapterContext (bounded FrameworkIndexView + request-scoped anchors/candidates/budget).
// output: EvidenceSignal/CandidateFile pairs linking Java MyBatis mapper interfaces to their
//         mapper XML resources by namespace/statement-id/parameter-and-result-type name match.
// pos: Task 28 Slice D. buildMarkerPaths/frameworkSeedFiles/isMethodAnchor/rankableMethodsFor/
//      resolveTargets below mirror spring-adapter.ts's own private helpers of the same name -
//      duplicated, not imported, so each framework pack stays an independently removable unit;
//      read them as "same generic policy", not as an intentional divergence from Spring's version.
//      Deliberately has no mybatis-annotations.ts sibling: plan Step 7's third isActive()
//      criterion ("Java type has @Mapper") is subsumed by the repo-level
//      repositoryFactMarkers() prefix scan below (org.apache.ibatis./org.mybatis.), which is
//      strictly cheaper and already covers the @MapperScan-without-per-type-annotation case; a
//      per-type @Mapper check would add a module with no other caller, since namespace-exact-match
//      (an authoritative, stronger signal) already gates which interfaces earn evidence.
import path from "node:path";
import type { CandidateFile } from "../../agent-types.js";
import { classifyPath } from "../../repo-layout.js";
import { breakdown, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import {
  MAX_DECLARATION_IDS_PER_CALL,
  MAX_FRAMEWORK_MYBATIS_NAMESPACES,
  type FrameworkDeclarations,
  type FrameworkFileFacts,
  type FrameworkIndexView,
  type FrameworkMethodDeclaration,
  type FrameworkTypeDeclaration
} from "../../java-index/framework-index-view.js";
import type { MyBatisMapperResourceFacts } from "../../java-index/mybatis-types.js";
import { frameworkFactsForFiles, hasStaticStructureEvidence, type FrameworkAdapter, type FrameworkAdapterContext, type FrameworkCollectResult } from "./adapter.js";

export const MYBATIS_ADAPTER_ID = "mybatis";
export const MYBATIS_ADAPTER_VERSION = "1";

const BUILD_MARKER_NAMES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const MYBATIS_DEPENDENCY_PATTERN = /org\.mybatis|mybatis-spring/;

const MYBATIS_NAMESPACE_WEIGHT = 100;
const MYBATIS_STATEMENT_METHOD_WEIGHT = 110;
const MYBATIS_PARAMETER_TYPE_WEIGHT = 75;
const MYBATIS_RESULT_TYPE_WEIGHT = 80;
const MYBATIS_RESULT_MAP_WEIGHT = 85;
const EXACT_MATCH_CONFIDENCE = 0.98;
const RESOLVED_TYPE_CONFIDENCE = 0.95;

type MyBatisEvidenceKind =
  | "MYBATIS_NAMESPACE"
  | "MYBATIS_STATEMENT_METHOD"
  | "MYBATIS_PARAMETER_TYPE"
  | "MYBATIS_RESULT_TYPE"
  | "MYBATIS_RESULT_MAP";

/** Evidence whose target file is already known - a namespace/statement match against a resource, or a type-kind match once declarationsById has resolved its raw XML text to a repo file. */
type ResolvedEvidence = {
  kind: MyBatisEvidenceKind;
  sourceFile: string;
  targetAbsolutePath: string;
  weight: number;
  confidence: number;
  detail: string;
};

/** A raw XML type-name string still needing declarationsById resolution against the Java graph. */
type PendingTypeEvidence = {
  kind: "MYBATIS_PARAMETER_TYPE" | "MYBATIS_RESULT_TYPE" | "MYBATIS_RESULT_MAP";
  sourceFile: string;
  targetId: string;
  weight: number;
  confidence: number;
  detail: string;
};

type TypeContext = {
  absolutePath: string;
  type: FrameworkTypeDeclaration;
  methods: FrameworkMethodDeclaration[];
};

// mirrors spring-adapter.ts's frameworkSeedFiles - which files earlier providers
// already surfaced as worth spending JavaIndex-facts-fetching effort on.
function frameworkSeedFiles(context: FrameworkAdapterContext): Set<string> {
  const seeds = new Set(context.anchors.map(anchor => anchor.absolutePath));
  for (const candidate of context.staticEvidence) {
    if (hasStaticStructureEvidence(candidate)) {
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
  if ([...buildMarkers.values()].some(content => MYBATIS_DEPENDENCY_PATTERN.test(content))) return true;
  if (context.budget.expired()) return false;
  const factMarkers = await context.frameworkIndex.repositoryFactMarkers({
    importPrefixes: ["org.apache.ibatis.", "org.mybatis."],
    annotationPrefixes: ["org.apache.ibatis.", "org.mybatis."]
  });
  if (factMarkers.importPrefixFound || factMarkers.annotationPrefixFound) return true;
  // A partial index cannot prove that MyBatis is absent. Running a bounded pack
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

/** A dot-qualified name is the only shape MyBatis XML parameterType/resultType/resultMap-type text can safely be treated as a fully-qualified Java type - built-in aliases ("string", "long", "map") and bare simple names are never guessed at. */
function qualifiedTypeId(rawText: string | undefined): string | undefined {
  if (!rawText || !rawText.includes(".")) return undefined;
  return `type:${rawText}`;
}

function crossNamespaceResultMapReference(resultMap: string): { namespace: string; id: string } | undefined {
  const separator = resultMap.lastIndexOf(".");
  if (separator <= 0 || separator === resultMap.length - 1) return undefined;
  return { namespace: resultMap.slice(0, separator), id: resultMap.slice(separator + 1) };
}

async function collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult> {
  const startedAt = Date.now();
  const status = await context.frameworkIndex.frameworkStatus();
  const completeness: EvidenceCompleteness = status.coverage === "complete" ? "COMPLETE" : status.coverage === "degraded" ? "UNKNOWN" : "PARTIAL";
  const diagnostics: string[] = [];
  let timedOut = context.budget.expired();
  let limited = false;

  const seeds = frameworkSeedFiles(context);
  const candidateFiles = context.candidateFiles.filter(candidate => seeds.has(candidate));
  const facts: FrameworkFileFacts[] = timedOut ? [] : await frameworkFactsForFiles(context, candidateFiles);
  if (!timedOut && context.budget.expired()) timedOut = true;

  const typeContexts: TypeContext[] = [];
  if (!timedOut) {
    for (const factsForFile of facts) {
      if (context.budget.expired()) {
        timedOut = true;
        diagnostics.push("mybatis adapter: deadline exhausted while preparing framework facts");
        break;
      }
      const absolutePath = path.resolve(context.repoRoot, factsForFile.relativePath);
      // MyBatis mapper proxies are always interfaces, never classes - a structural
      // fact of the framework, not a guess.
      for (const type of factsForFile.types) {
        if (type.kind !== "interface" || !type.fqn) continue;
        typeContexts.push({
          absolutePath,
          type,
          methods: factsForFile.methods.filter(method => method.ownerTypeId === type.typeId)
        });
      }
    }
  }

  const namespaceCandidates = [...new Set(typeContexts.map(typeContext => typeContext.type.fqn!))];
  if (namespaceCandidates.length > MAX_FRAMEWORK_MYBATIS_NAMESPACES) {
    limited = true;
    diagnostics.push(`mybatis adapter: namespace lookup capped at ${MAX_FRAMEWORK_MYBATIS_NAMESPACES} candidate mapper interfaces`);
  }
  const resourceByNamespace: Map<string, MyBatisMapperResourceFacts> = timedOut
    ? new Map()
    : await context.frameworkIndex.myBatisResourcesByNamespaces(namespaceCandidates.slice(0, MAX_FRAMEWORK_MYBATIS_NAMESPACES));
  if (!timedOut && context.budget.expired()) timedOut = true;

  const externalResultMapNamespaces = new Set<string>();
  for (const resource of resourceByNamespace.values()) {
    for (const statement of resource.statements) {
      if (!statement.resultMap || resource.resultMaps.some(resultMap => resultMap.id === statement.resultMap)) continue;
      const reference = crossNamespaceResultMapReference(statement.resultMap);
      if (reference) externalResultMapNamespaces.add(reference.namespace);
    }
  }
  if (!timedOut && externalResultMapNamespaces.size > 0) {
    if (externalResultMapNamespaces.size > MAX_FRAMEWORK_MYBATIS_NAMESPACES) {
      limited = true;
      diagnostics.push(`mybatis adapter: cross-namespace resultMap lookup capped at ${MAX_FRAMEWORK_MYBATIS_NAMESPACES} namespaces`);
    }
    const externalResources = await context.frameworkIndex.myBatisResourcesByNamespaces(
      [...externalResultMapNamespaces].slice(0, MAX_FRAMEWORK_MYBATIS_NAMESPACES)
    );
    for (const [namespace, resource] of externalResources) resourceByNamespace.set(namespace, resource);
    if (context.budget.expired()) timedOut = true;
  }

  const resolvedEvidence: ResolvedEvidence[] = [];
  const pendingTypeTargets: PendingTypeEvidence[] = [];

  for (const typeContext of typeContexts) {
    if (timedOut || context.budget.expired()) {
      timedOut = true;
      break;
    }
    const resource = resourceByNamespace.get(typeContext.type.fqn!);
    if (!resource) continue;
    const resourceAbsolutePath = path.resolve(context.repoRoot, resource.relativePath);
    resolvedEvidence.push({
      kind: "MYBATIS_NAMESPACE",
      sourceFile: typeContext.absolutePath,
      targetAbsolutePath: resourceAbsolutePath,
      weight: MYBATIS_NAMESPACE_WEIGHT,
      confidence: EXACT_MATCH_CONFIDENCE,
      detail: `${typeContext.type.simpleName} mapper namespace ${resource.namespace}`
    });

    const methodsByName = new Map<string, FrameworkMethodDeclaration[]>();
    for (const method of typeContext.methods) {
      const list = methodsByName.get(method.name);
      if (list) list.push(method);
      else methodsByName.set(method.name, [method]);
    }
    // Ambiguity (overloaded methods sharing a statement id) is a structural
    // property of the interface's own signatures, so it is checked against
    // every declared method - never narrowed to the currently anchored subset.
    const rankableMethodIds = new Set(rankableMethodsFor(context, typeContext.absolutePath, typeContext.methods).map(method => method.methodId));

    for (const statement of resource.statements) {
      const matches = methodsByName.get(statement.id) ?? [];
      if (matches.length === 1 && rankableMethodIds.has(matches[0]!.methodId)) {
        resolvedEvidence.push({
          kind: "MYBATIS_STATEMENT_METHOD",
          sourceFile: typeContext.absolutePath,
          targetAbsolutePath: resourceAbsolutePath,
          weight: MYBATIS_STATEMENT_METHOD_WEIGHT,
          confidence: EXACT_MATCH_CONFIDENCE,
          detail: `${typeContext.type.simpleName}.${statement.id}() statement`
        });
      }

      // Type-kind evidence is tied to the statement/resource itself, not to a
      // specific overloaded method - emitted unconditionally, independent of
      // the ambiguity/rankability check above.
      const parameterTypeId = qualifiedTypeId(statement.parameterType);
      if (parameterTypeId) {
        pendingTypeTargets.push({ kind: "MYBATIS_PARAMETER_TYPE", sourceFile: resourceAbsolutePath, targetId: parameterTypeId, weight: MYBATIS_PARAMETER_TYPE_WEIGHT, confidence: RESOLVED_TYPE_CONFIDENCE, detail: `${resource.namespace}.${statement.id} parameterType` });
      }
      const resultTypeId = qualifiedTypeId(statement.resultType);
      if (resultTypeId) {
        pendingTypeTargets.push({ kind: "MYBATIS_RESULT_TYPE", sourceFile: resourceAbsolutePath, targetId: resultTypeId, weight: MYBATIS_RESULT_TYPE_WEIGHT, confidence: RESOLVED_TYPE_CONFIDENCE, detail: `${resource.namespace}.${statement.id} resultType` });
      }
      if (statement.resultMap) {
        const localResultMap = resource.resultMaps.find(candidate => candidate.id === statement.resultMap);
        const externalReference = localResultMap ? undefined : crossNamespaceResultMapReference(statement.resultMap);
        // A qualified reference is accepted only when its exact namespace was
        // indexed and the target mapper declares the exact resultMap id.
        const resultMapFact = localResultMap
          ?? (externalReference
            ? resourceByNamespace.get(externalReference.namespace)?.resultMaps.find(candidate => candidate.id === externalReference.id)
            : undefined);
        const resultMapTypeId = qualifiedTypeId(resultMapFact?.type);
        if (resultMapTypeId) {
          pendingTypeTargets.push({ kind: "MYBATIS_RESULT_MAP", sourceFile: resourceAbsolutePath, targetId: resultMapTypeId, weight: MYBATIS_RESULT_MAP_WEIGHT, confidence: RESOLVED_TYPE_CONFIDENCE, detail: `${resource.namespace}.${statement.id} resultMap ${statement.resultMap}` });
        }
      }
    }
  }

  const targetIds = [...new Set(pendingTypeTargets.map(item => item.targetId))];
  const resolved = timedOut || targetIds.length === 0
    ? { declarations: { types: [], methods: [], fields: [], missingIds: [], truncated: false }, timedOut }
    : await resolveTargets(context.frameworkIndex, targetIds, context);
  timedOut = timedOut || resolved.timedOut;
  const relativePathByTypeId = new Map(resolved.declarations.types.map(type => [type.typeId, type.relativePath]));
  for (const item of pendingTypeTargets) {
    const relativePath = relativePathByTypeId.get(item.targetId);
    if (!relativePath) continue;
    resolvedEvidence.push({
      kind: item.kind,
      sourceFile: item.sourceFile,
      targetAbsolutePath: path.resolve(context.repoRoot, relativePath),
      weight: item.weight,
      confidence: item.confidence,
      detail: item.detail
    });
  }

  const evidence: EvidenceSignal[] = [];
  const candidates = new Map<string, CandidateFile>();
  const anchorId = context.anchors[0]?.id ?? "A1";
  let signalSeq = 0;
  for (const item of resolvedEvidence) {
    signalSeq += 1;
    evidence.push({
      signalId: `${MYBATIS_ADAPTER_ID}:${signalSeq}`,
      candidateFile: item.targetAbsolutePath,
      anchorId,
      kind: item.kind,
      family: "FRAMEWORK",
      provenance: "FRAMEWORK_INFERRED",
      confidence: item.confidence,
      completeness,
      weight: item.weight,
      sourceFile: item.sourceFile,
      positions: [],
      providerId: MYBATIS_ADAPTER_ID,
      providerVersion: MYBATIS_ADAPTER_VERSION,
      generation: context.generation,
      detail: item.detail
    });
    mergeCandidate(candidates, mybatisCandidate(context.repoRoot, item.targetAbsolutePath, item.weight * item.confidence, item.kind));
  }

  if (resolved.declarations.truncated) diagnostics.push(`mybatis adapter: declarationsById truncated while resolving ${targetIds.length} evidence targets`);
  if (timedOut) diagnostics.push("mybatis adapter: deadline exhausted before all bounded framework work completed");

  return {
    outcome: {
      providerId: MYBATIS_ADAPTER_ID,
      providerVersion: MYBATIS_ADAPTER_VERSION,
      evidence,
      candidates: [...candidates.values()],
      completion: timedOut ? "PARTIAL_TIMEOUT" : limited || resolved.declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata: {},
    diagnostics
  };
}

function mybatisCandidate(repoRoot: string, absolutePath: string, score: number, kind: MyBatisEvidenceKind): CandidateFile {
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
    scoreBreakdown: [breakdown(`evidence.${kind}`, "policy", score, `MyBatis ${kind}`)]
  };
}

export const mybatisAdapter: FrameworkAdapter = { id: MYBATIS_ADAPTER_ID, version: MYBATIS_ADAPTER_VERSION, isActive, collect };
