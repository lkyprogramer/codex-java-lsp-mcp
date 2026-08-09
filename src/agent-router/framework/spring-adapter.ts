import path from "node:path";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import {
  MAX_FRAMEWORK_CALLEE_METHODS,
  type FrameworkCallees,
  type FrameworkFileFacts,
  type FrameworkMethodDeclaration,
  type FrameworkTypeDeclaration,
  type FrameworkTypeRef
} from "../../java-index/framework-index-view.js";
import type { SourceRange } from "../../runtime/source-range.js";
import type { TypeResolutionStrategy } from "../../java-index/index-types.js";
import { frameworkEvidenceOriginIds, frameworkFactsForFiles, type FrameworkAdapter, type FrameworkAdapterContext, type FrameworkCollectResult } from "./adapter.js";
import {
  frameworkBuildMarkerPaths,
  frameworkRepositoryFactMarkers,
  frameworkRepositoryMarkers,
  frameworkSeedFiles,
  frameworkStatus,
  rankableFrameworkMethods,
  resolveFrameworkTargets
} from "./shared.js";
import {
  hasAnnotation,
  isController,
  isStereotype,
  normalizeSpringAnnotations,
  SPRING_APPLICATION_EVENT_PUBLISHER_FQN,
  SPRING_AUTOWIRED_FQN,
  SPRING_BEAN_FQN,
  SPRING_EVENT_LISTENER_FQN,
  SPRING_REQUEST_BODY_FQN,
  SPRING_TRANSACTIONAL_FQN
} from "./spring-annotations.js";
import { composeEndpointFact, mappingOf, type SpringEndpointFact } from "./spring-endpoint.js";

export const SPRING_ADAPTER_ID = "spring";
export const SPRING_ADAPTER_VERSION = "3";

const BUILD_MARKER_NAMES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const SPRING_DEPENDENCY_PATTERN = /org\.springframework|spring-boot/;
const SPRING_INJECTION_WEIGHT = 90;
const SPRING_CALL_PATH_WEIGHT = 100;
const SPRING_REQUEST_BODY_WEIGHT = 70;
const SPRING_RESPONSE_TYPE_WEIGHT = 70;
const SPRING_PUBLISHES_EVENT_WEIGHT = 85;
const SPRING_CONSUMES_EVENT_WEIGHT = 85;
const SPRING_EVENT_LISTENER_WEIGHT = 85;
const SPRING_BEAN_PRODUCES_WEIGHT = 75;
const SPRING_BEAN_DEPENDS_ON_WEIGHT = 75;
const CALLEES_LIMIT = 80;
const EVENT_LISTENER_LIMIT = 32;

export type SpringAdapterMetadata = {
  endpoints: SpringEndpointFact[];
  transactionalMethodIds: string[];
};

const FALLBACK_STRATEGY_CONFIDENCE: Partial<Record<TypeResolutionStrategy, number>> = {
  WILDCARD_IMPORT: 0.82,
  REPO_UNIQUE_SIMPLE_NAME: 0.75
};
const RESOLVED_TYPE_BASE_CONFIDENCE = 0.95;
const RESPONSE_WRAPPERS = new Set([
  "org.springframework.http.ResponseEntity",
  "java.util.List",
  "java.util.Set",
  "java.util.Collection",
  "org.springframework.data.domain.Page",
  "org.springframework.data.domain.Slice"
]);

type SpringEvidenceKind =
  | "SPRING_INJECTION"
  | "SPRING_CALL_PATH"
  | "SPRING_REQUEST_BODY"
  | "SPRING_RESPONSE_TYPE"
  | "SPRING_PUBLISHES_EVENT"
  | "SPRING_CONSUMES_EVENT"
  | "SPRING_EVENT_LISTENER"
  | "SPRING_BEAN_PRODUCES"
  | "SPRING_BEAN_DEPENDS_ON";

type PendingEvidence = {
  kind: SpringEvidenceKind;
  sourceFile: string;
  targetId: string;
  weight: number;
  confidence: number;
  detail: string;
  sourceRange?: SourceRange;
};

type TypeContext = {
  facts: FrameworkFileFacts;
  absolutePath: string;
  type: FrameworkTypeDeclaration;
  methods: FrameworkMethodDeclaration[];
  rankableMethods: FrameworkMethodDeclaration[];
  fields: FrameworkFileFacts["fields"];
  typeAnnotations: ReturnType<typeof normalizeSpringAnnotations>;
  stereotype: boolean;
  controller: boolean;
};

function typeRefConfidence(type: FrameworkTypeRef, resolvedBaseConfidence: number): number {
  const fallback = type.strategy ? FALLBACK_STRATEGY_CONFIDENCE[type.strategy] : undefined;
  return fallback !== undefined ? fallback * 0.95 : resolvedBaseConfidence;
}

async function isActive(context: FrameworkAdapterContext): Promise<boolean> {
  if (context.budget.expired()) return false;
  const buildMarkers = await frameworkRepositoryMarkers(context, frameworkBuildMarkerPaths(context, BUILD_MARKER_NAMES));
  if ([...buildMarkers.values()].some(content => SPRING_DEPENDENCY_PATTERN.test(content))) return true;
  if (context.budget.expired()) return false;
  const factMarkers = await frameworkRepositoryFactMarkers(context, {
    importPrefixes: ["org.springframework."],
    annotationPrefixes: ["org.springframework."]
  });
  if (factMarkers.importPrefixFound || factMarkers.annotationPrefixFound) return true;
  // A partial index cannot prove that Spring is absent. Running a bounded pack
  // is safe; treating the absence as definitive would not be.
  const status = await frameworkStatus(context);
  return status.coverage !== "complete";
}

function annotationsOf(facts: FrameworkFileFacts, annotations: Parameters<typeof normalizeSpringAnnotations>[0]) {
  return normalizeSpringAnnotations(annotations, facts.imports, facts.coverage);
}

function injectingConstructorOf(
  ownMethods: readonly FrameworkMethodDeclaration[],
  facts: FrameworkFileFacts
): FrameworkMethodDeclaration | undefined {
  const constructors = ownMethods.filter(method => method.constructor);
  const autowired = constructors.filter(constructor => hasAnnotation(annotationsOf(facts, constructor.annotations), SPRING_AUTOWIRED_FQN));
  if (autowired.length === 1) return autowired[0];
  if (autowired.length === 0 && constructors.length === 1) return constructors[0];
  return undefined;
}

function injectionReceivers(typeContext: TypeContext): Map<string, FrameworkTypeRef> {
  const receivers = new Map<string, FrameworkTypeRef>();
  const constructor = injectingConstructorOf(typeContext.methods, typeContext.facts);
  for (const parameter of constructor?.parameters ?? []) receivers.set(parameter.name, parameter.type);
  for (const field of typeContext.fields) {
    if (hasAnnotation(annotationsOf(typeContext.facts, field.annotations), SPRING_AUTOWIRED_FQN)) {
      receivers.set(field.name, field.type);
    }
  }
  return receivers;
}

function receiverName(receiverText: string | undefined): string | undefined {
  if (!receiverText) return undefined;
  const parts = receiverText.split(".");
  const last = parts[parts.length - 1];
  return last && /^[A-Za-z_$][\w$]*$/.test(last) ? last : undefined;
}

function sameRange(left: SourceRange | undefined, right: SourceRange): boolean {
  return left !== undefined
    && left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.line === right.end.line
    && left.end.column === right.end.column;
}

function candidateType(type: FrameworkTypeRef | undefined): FrameworkTypeRef | undefined {
  if (!type?.resolvedFqn) return undefined;
  if (RESPONSE_WRAPPERS.has(type.resolvedFqn) && type.typeArguments.length === 1) {
    return candidateType(type.typeArguments[0]);
  }
  return type;
}

async function collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult> {
  const startedAt = Date.now();
  const status = await frameworkStatus(context);
  const completeness: EvidenceCompleteness = status.coverage === "complete" ? "COMPLETE" : status.coverage === "degraded" ? "UNKNOWN" : "PARTIAL";
  const pending: PendingEvidence[] = [];
  const endpoints: SpringEndpointFact[] = [];
  const transactionalMethodIds: string[] = [];
  const diagnostics: string[] = [];
  let timedOut = context.budget.expired();
  let limited = false;
  let anyCalleesTruncated = false;

  const seeds = frameworkSeedFiles(context);
  const candidateFiles = context.candidateFiles.filter(candidate => seeds.has(candidate));
  const facts = timedOut ? [] : await frameworkFactsForFiles(context, candidateFiles);
  if (!timedOut && context.budget.expired()) timedOut = true;
  const typeContexts: TypeContext[] = [];
  if (!timedOut) {
    for (const factsForFile of facts) {
      if (context.budget.expired()) {
        timedOut = true;
        diagnostics.push("spring adapter: deadline exhausted while preparing framework facts");
        break;
      }
      const absolutePath = path.resolve(context.repoRoot, factsForFile.relativePath);
      for (const type of factsForFile.types) {
        const typeAnnotations = annotationsOf(factsForFile, type.annotations);
        const methods = factsForFile.methods.filter(method => method.ownerTypeId === type.typeId);
        typeContexts.push({
          facts: factsForFile,
          absolutePath,
          type,
          methods,
          rankableMethods: rankableFrameworkMethods(context, absolutePath, methods),
          fields: factsForFile.fields.filter(field => field.ownerTypeId === type.typeId),
          typeAnnotations,
          stereotype: isStereotype(typeAnnotations),
          controller: isController(typeAnnotations)
        });
      }
    }
  }

  const callMethodIds = typeContexts.filter(type => type.stereotype).flatMap(type => type.rankableMethods.map(method => method.methodId));
  if (callMethodIds.length > MAX_FRAMEWORK_CALLEE_METHODS) {
    limited = true;
    diagnostics.push(`spring adapter: callee analysis capped at ${MAX_FRAMEWORK_CALLEE_METHODS} Spring methods`);
  }
  const calleesByMethod: Map<string, FrameworkCallees> = timedOut
    ? new Map()
    : await context.frameworkIndex.resolvedCalleesFor(callMethodIds.slice(0, MAX_FRAMEWORK_CALLEE_METHODS), CALLEES_LIMIT);
  if (!timedOut && context.budget.expired()) timedOut = true;

  const publishedEvents = new Map<string, Array<{ sourceFile: string; sourceRange: SourceRange }>>();
  for (const typeContext of typeContexts) {
    if (timedOut || context.budget.expired()) {
      timedOut = true;
      break;
    }
    const { facts: factsForFile, absolutePath, type, methods, rankableMethods, fields, typeAnnotations, stereotype, controller } = typeContext;
    const classMapping = mappingOf(typeAnnotations);
    const receivers = stereotype ? injectionReceivers(typeContext) : new Map<string, FrameworkTypeRef>();
    const typeTransactional = hasAnnotation(typeAnnotations, SPRING_TRANSACTIONAL_FQN);

    if (stereotype) {
      const constructor = injectingConstructorOf(methods, factsForFile);
      for (const parameter of constructor?.parameters ?? []) {
        if (!parameter.type.resolvedFqn) continue;
        pending.push({ kind: "SPRING_INJECTION", sourceFile: absolutePath, sourceRange: constructor!.range, targetId: `type:${parameter.type.resolvedFqn}`, weight: SPRING_INJECTION_WEIGHT, confidence: typeRefConfidence(parameter.type, 0.97), detail: `${type.simpleName} constructor parameter` });
      }
      for (const field of fields) {
        if (!hasAnnotation(annotationsOf(factsForFile, field.annotations), SPRING_AUTOWIRED_FQN) || !field.type.resolvedFqn) continue;
        pending.push({ kind: "SPRING_INJECTION", sourceFile: absolutePath, targetId: `type:${field.type.resolvedFqn}`, weight: SPRING_INJECTION_WEIGHT, confidence: typeRefConfidence(field.type, 0.95), detail: `${type.simpleName}.${field.name} (@Autowired field)` });
      }
    }

    for (const method of rankableMethods) {
      if (timedOut || context.budget.expired()) {
        timedOut = true;
        break;
      }
      const methodAnnotations = annotationsOf(factsForFile, method.annotations);
      const methodMapping = controller ? mappingOf(methodAnnotations) : undefined;
      if (methodMapping) {
        endpoints.push(composeEndpointFact(method.methodId, classMapping, methodMapping));
        const responseType = candidateType(method.returnType);
        if (responseType?.resolvedFqn) {
          pending.push({ kind: "SPRING_RESPONSE_TYPE", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${responseType.resolvedFqn}`, weight: SPRING_RESPONSE_TYPE_WEIGHT, confidence: typeRefConfidence(responseType, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `${type.simpleName}.${method.name}() response type` });
        }
        const requestBody = method.parameters.find(parameter => hasAnnotation(annotationsOf(factsForFile, parameter.annotations), SPRING_REQUEST_BODY_FQN));
        if (requestBody?.type.resolvedFqn) {
          pending.push({ kind: "SPRING_REQUEST_BODY", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${requestBody.type.resolvedFqn}`, weight: SPRING_REQUEST_BODY_WEIGHT, confidence: typeRefConfidence(requestBody.type, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `${type.simpleName}.${method.name}() @RequestBody` });
        }
      }

      if (typeTransactional || hasAnnotation(methodAnnotations, SPRING_TRANSACTIONAL_FQN)) transactionalMethodIds.push(method.methodId);
      if (hasAnnotation(methodAnnotations, SPRING_BEAN_FQN)) {
        const beanType = candidateType(method.returnType);
        if (beanType?.resolvedFqn) {
          pending.push({ kind: "SPRING_BEAN_PRODUCES", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${beanType.resolvedFqn}`, weight: SPRING_BEAN_PRODUCES_WEIGHT, confidence: typeRefConfidence(beanType, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `@Bean ${type.simpleName}.${method.name}()` });
        }
        for (const parameter of method.parameters) {
          if (!parameter.type.resolvedFqn) continue;
          pending.push({ kind: "SPRING_BEAN_DEPENDS_ON", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${parameter.type.resolvedFqn}`, weight: SPRING_BEAN_DEPENDS_ON_WEIGHT, confidence: typeRefConfidence(parameter.type, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `@Bean ${type.simpleName}.${method.name}() parameter` });
        }
      }
      if (hasAnnotation(methodAnnotations, SPRING_EVENT_LISTENER_FQN)) {
        const eventType = method.parameters[0]?.type;
        if (eventType?.resolvedFqn) {
          pending.push({ kind: "SPRING_CONSUMES_EVENT", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${eventType.resolvedFqn}`, weight: SPRING_CONSUMES_EVENT_WEIGHT, confidence: typeRefConfidence(eventType, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `${type.simpleName}.${method.name}() consumes event` });
        }
      }

      if (!stereotype) continue;
      const calleeResult = calleesByMethod.get(method.methodId) ?? { callees: [], truncated: false };
      anyCalleesTruncated = anyCalleesTruncated || calleeResult.truncated;
      for (const callSite of method.callSites) {
        if (callSite.kind !== "METHOD_INVOCATION") continue;
        const receiver = receivers.get(receiverName(callSite.receiverText) ?? "");
        if (!receiver?.resolvedFqn || callSite.receiverDeclaredType?.resolvedFqn !== receiver.resolvedFqn) continue;
        const matchingCalls = calleeResult.callees.filter(edge => edge.kind === "CALLS" && sameRange(edge.range, callSite.range));
        if (matchingCalls.length === 1 && !calleeResult.truncated) {
          pending.push({ kind: "SPRING_CALL_PATH", sourceFile: absolutePath, sourceRange: method.range, targetId: matchingCalls[0]!.targetId, weight: SPRING_CALL_PATH_WEIGHT, confidence: matchingCalls[0]!.confidence, detail: `${type.simpleName}.${method.name}() injected call path` });
        }
        if (callSite.name !== "publishEvent" || callSite.arity !== 1 || receiver.resolvedFqn !== SPRING_APPLICATION_EVENT_PUBLISHER_FQN) continue;
        const eventType = callSite.argumentTypeHints[0];
        if (!eventType?.resolvedFqn) continue;
        pending.push({ kind: "SPRING_PUBLISHES_EVENT", sourceFile: absolutePath, sourceRange: method.range, targetId: `type:${eventType.resolvedFqn}`, weight: SPRING_PUBLISHES_EVENT_WEIGHT, confidence: typeRefConfidence(eventType, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `${type.simpleName}.${method.name}() publishes event` });
        const publishers = publishedEvents.get(eventType.resolvedFqn) ?? [];
        publishers.push({ sourceFile: absolutePath, sourceRange: method.range });
        publishedEvents.set(eventType.resolvedFqn, publishers);
      }
    }
  }

  if (!timedOut && publishedEvents.size > 0) {
    const listeners = await context.frameworkIndex.methodsWithParameterTypes([...publishedEvents.keys()].slice(0, EVENT_LISTENER_LIMIT), EVENT_LISTENER_LIMIT);
    if (context.budget.expired()) timedOut = true;
    // methodsWithParameterTypes returns a narrow declaration so the generic
    // view need not leak every file's imports. A valid wildcard annotation is
    // only exact after the owning file's COMPLETE import facts are present;
    // hydrate those listener files together rather than treating an unresolved
    // short name as absence (or issuing one IPC request per listener).
    const listenerFacts = timedOut
      ? []
      : await frameworkFactsForFiles(context, listeners.map(listener => path.resolve(context.repoRoot, listener.relativePath)));
    if (!timedOut && context.budget.expired()) timedOut = true;
    const listenerByMethodId = new Map(
      listenerFacts.flatMap(factsForFile => factsForFile.methods.map(method => [method.methodId, { method, factsForFile }] as const))
    );
    for (const listener of listeners) {
      if (timedOut || context.budget.expired()) {
        timedOut = true;
        break;
      }
      const hydrated = listenerByMethodId.get(listener.methodId);
      const annotationFacts = hydrated ? annotationsOf(hydrated.factsForFile, hydrated.method.annotations) : listener.annotations;
      const eventType = listener.parameters[0]?.type;
      if (!eventType?.resolvedFqn || !publishedEvents.has(eventType.resolvedFqn) || !hasAnnotation(annotationFacts, SPRING_EVENT_LISTENER_FQN)) continue;
      for (const published of publishedEvents.get(eventType.resolvedFqn) ?? []) {
        pending.push({ kind: "SPRING_EVENT_LISTENER", sourceFile: published.sourceFile, sourceRange: published.sourceRange, targetId: listener.methodId, weight: SPRING_EVENT_LISTENER_WEIGHT, confidence: typeRefConfidence(eventType, RESOLVED_TYPE_BASE_CONFIDENCE), detail: `listener for ${eventType.resolvedFqn}` });
      }
    }
  }

  const targetIds = [...new Set(pending.map(item => item.targetId))];
  const resolved = timedOut
    ? { declarations: { types: [], methods: [], fields: [], missingIds: [], truncated: false }, timedOut: true }
    : await resolveFrameworkTargets(context, targetIds);
  timedOut = timedOut || resolved.timedOut;
  const relativePathById = new Map<string, string>();
  for (const type of resolved.declarations.types) relativePathById.set(type.typeId, type.relativePath);
  for (const method of resolved.declarations.methods) relativePathById.set(method.methodId, method.relativePath);

  const evidence: EvidenceSignal[] = [];
  let signalSeq = 0;
  for (const item of pending) {
    const relativePath = relativePathById.get(item.targetId);
    if (!relativePath) continue;
    const targetAbsolutePath = path.resolve(context.repoRoot, relativePath);
    for (const anchorId of frameworkEvidenceOriginIds(context, item.sourceFile, item.sourceRange)) {
      signalSeq += 1;
      evidence.push({
        signalId: `${SPRING_ADAPTER_ID}:${signalSeq}`,
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
        providerId: SPRING_ADAPTER_ID,
        providerVersion: SPRING_ADAPTER_VERSION,
        generation: context.generation,
        detail: item.detail,
        candidateMetadata: { categories: ["framework"], reasons: [item.kind], verifiedBy: [item.kind], matchCount: 0 }
      });
    }
  }

  if (resolved.declarations.truncated) diagnostics.push(`spring adapter: declarationsById truncated while resolving ${targetIds.length} evidence targets`);
  if (anyCalleesTruncated) diagnostics.push("spring adapter: resolvedCallees truncated for at least one Spring-managed method");
  if (timedOut) diagnostics.push("spring adapter: deadline exhausted before all bounded framework work completed");
  return {
    outcome: {
      providerId: SPRING_ADAPTER_ID,
      providerVersion: SPRING_ADAPTER_VERSION,
      evidence,
      completion: timedOut ? "PARTIAL_TIMEOUT" : limited || resolved.declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata: { endpoints, transactionalMethodIds: [...new Set(transactionalMethodIds)] },
    diagnostics
  };
}

export const springAdapter: FrameworkAdapter = { id: SPRING_ADAPTER_ID, version: SPRING_ADAPTER_VERSION, isActive, collect };
