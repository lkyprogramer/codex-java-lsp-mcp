import type { ContextContract } from "../context-engine/context-contract.js";
import type {
  AnchorFacts,
  IndexedReadRange,
  IndexedReadRangeResult,
  IndexedReference,
  JavaAnnotationFact,
  JavaCallSiteFact,
  JavaCallSiteKind,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaImportFact,
  JavaIndexStatus,
  JavaIndexHeapSplit,
  JavaIndexSnapshotStatus,
  JavaMethodFacts,
  JavaParseState,
  JavaSourceSet,
  JavaTypeFacts,
  JavaTypeKind,
  JavaTypeLookupResult,
  JavaTypeParameterFact,
  JavaTypeRef,
  MyBatisResourceCoverage,
  SourcePosition,
  SourceRange,
  SourceRootCoverage,
  StaticEdge,
  StaticEdgeKind,
  StaticEdgeResolutionKind,
  TypeResolutionStrategy,
  WorktreeSeedStatus
} from "./index-types.js";

import type { MyBatisMapperResourceFacts, MyBatisResultMapFact, MyBatisStatementFact, MyBatisStatementKind } from "./mybatis-types.js";
import type { EntityHit, EntityKind, EntityLayer } from "./entity-search.js";

/**
 * Worker CLOSE may join one already-started atomic snapshot write. Keep the
 * client return grace above that worker soft budget. When the grace expires,
 * close() unrefs the worker but keeps its CLOSE promise alive; only the late
 * ACK (or a definite worker exit) permits final termination.
 */
export const JAVA_INDEX_CLOSE_FLUSH_BUDGET_MS = 2000;
export const JAVA_INDEX_CLOSE_GRACE_MS = JAVA_INDEX_CLOSE_FLUSH_BUDGET_MS + 500;

/** Worker-thread-safe subset of WorktreeIdentity: plain strings/booleans, never the live identity cache. */
export type JavaIndexWorktreeIdentity = {
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  isLinkedWorktree: boolean;
};

/** Explicit request-origin marker for the single primary impact anchor. */
export type JavaIndexRefreshPriority = "ACTIVE_ANCHOR";

type JavaIndexRequestOperation =
  | {
      id: number;
      type: "OPEN";
      repoRoot: string;
      cacheDir: string;
      generation: number;
      /** Absent => the worker never attempts a machine-level sweep lease and always runs sweeps unslotted. */
      leaseRoot?: string;
      worktree?: JavaIndexWorktreeIdentity;
      /** Absent => the worker never attempts a sibling-worktree snapshot seed (Task 21a), even with no own snapshot. */
      siblingCacheBase?: string;
    }
  | {
      id: number;
      type: "REFRESH";
      generation: number;
      changed: string[];
      deleted: string[];
      priority?: JavaIndexRefreshPriority;
    }
  | { id: number; type: "REFRESH_RESOURCES"; generation: number; paths: string[] }
  | { id: number; type: "RECONCILE"; generation: number }
  | { id: number; type: "QUERY_ANCHOR"; file: string; line: number; column: number }
  | { id: number; type: "QUERY_TYPE"; typeText: string; scopeFile?: string }
  | { id: number; type: "QUERY_TYPES"; queries: Array<{ typeText: string; scopeFile?: string }> }
  | { id: number; type: "QUERY_IMPLEMENTERS"; typeId: string; limit: number }
  | { id: number; type: "QUERY_TYPE_REFERENCERS"; typeId: string; edgeKinds: StaticEdgeKind[]; limit: number }
  | { id: number; type: "QUERY_CALLERS"; methodId: string; limit: number }
  | { id: number; type: "QUERY_CALLEES"; methodId: string; limit: number }
  | { id: number; type: "QUERY_CALLEES_BATCH"; methodIds: string[]; limit: number }
  | { id: number; type: "QUERY_METHODS_WITH_PARAMETER_TYPES"; typeIds: string[]; limit: number }
  | { id: number; type: "QUERY_FILES"; files: string[] }
  | { id: number; type: "QUERY_READ_RANGES"; requests: Array<{ file: string; positions: SourcePosition[] }> }
  | { id: number; type: "QUERY_MYBATIS_RESOURCE"; relativePath: string }
  | { id: number; type: "QUERY_MYBATIS_RESOURCES_BY_NAMESPACE"; namespaces: string[] }
  | { id: number; type: "QUERY_REPOSITORY_FACT_MARKERS"; importPrefixes: string[]; annotationPrefixes: string[] }
  | { id: number; type: "QUERY_ENTITY_SEARCH"; task: string; limit?: number }
  | { id: number; type: "QUERY_GRAPH_DIGEST" }
  | { id: number; type: "QUERY_GRAPH_REACHABLE"; fromRelativePath: string; maxHops: number }
  | {
      id: number;
      type: "QUERY_CONTEXT_GRAPH";
      fromRelativePath: string;
      intent: string;
      mode?: "search" | "navigate";
      direction?: "callers" | "callees";
      closure?: "persistence" | "framework";
      maxHops?: number;
      maxExpansions?: number;
      tokenBudget?: number;
      taskText?: string;
      profile?: string;
      plan?: boolean;
      includeSource?: boolean;
      anchorLine?: number;
      anchorColumn?: number;
      sessionId?: string;
      generation?: number;
      repoHash?: string;
    }
  | { id: number; type: "STATUS" }
  | { id: number; type: "FLUSH" }
  | { id: number; type: "HIBERNATE" }
  | { id: number; type: "CLOSE" };

/** Optional request-local timing flag; absent keeps the legacy worker envelope byte-for-byte lean. */
export type JavaIndexRequest = JavaIndexRequestOperation & { telemetry?: true; rootId?: string };

export type JavaIndexCommand = JavaIndexRequestOperation extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export type JavaIndexWorkerTiming = {
  /** Outstanding foreground commands, including an active command, observed at enqueue. */
  queueDepthAtEnqueue: number;
  /** Worker-local enqueue-to-dequeue duration. */
  queueMs: number;
  /** Worker-local dequeue-to-response duration. */
  processingMs: number;
};

export type JavaIndexResponse =
  | { id: number; ok: true; value: unknown; timing?: JavaIndexWorkerTiming }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string }; timing?: JavaIndexWorkerTiming };

export type JavaIndexValueValidator<T> = (value: unknown) => T;

// --- generic guards --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function validateStringArray(value: unknown): string[] {
  if (!isStringArray(value)) invalid("string[]", "expected an array of strings");
  return value;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function invalid(context: string, detail: string): never {
  throw new Error(`invalid ${context}: ${detail}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(context, "expected an object");
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) invalid(context, "expected an array");
  return value as unknown[];
}

function optional<T>(
  value: unknown,
  context: string,
  validate: (value: unknown, context: string) => T
): T | undefined {
  if (value === undefined) return undefined;
  return validate(value, context);
}

// Spreads to nothing when the value is absent, rather than an explicit
// `key: undefined` own property — so a validated object's key set matches
// what a JSON-serialized snapshot round-trip would produce (JSON.stringify
// drops undefined-valued keys), instead of only matching objects freshly
// received from the worker.
function withOptional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

// --- envelope ---------------------------------------------------------------

export function isJavaIndexResponse(value: unknown): value is JavaIndexResponse {
  if (!isRecord(value)) return false;
  if (!isNumber(value.id)) return false;
  if (value.timing !== undefined && !isJavaIndexWorkerTiming(value.timing)) return false;
  if (value.ok === true) return "value" in value;
  if (value.ok === false) {
    const error = value.error;
    return isRecord(error) && isString(error.code) && isString(error.message);
  }
  return false;
}

function isJavaIndexWorkerTiming(value: unknown): value is JavaIndexWorkerTiming {
  return isRecord(value)
    && isNumber(value.queueDepthAtEnqueue)
    && Number.isInteger(value.queueDepthAtEnqueue)
    && value.queueDepthAtEnqueue >= 0
    && isNumber(value.queueMs)
    && value.queueMs >= 0
    && isNumber(value.processingMs)
    && value.processingMs >= 0;
}

// --- shared fact validators --------------------------------------------------

function validateSourcePosition(value: unknown, context: string): SourcePosition {
  const source = record(value, context);
  if (!isNumber(source.line) || !isNumber(source.column)) {
    invalid(context, "expected {line, column} numbers");
  }
  return { line: source.line as number, column: source.column as number };
}

function validateSourceRange(value: unknown, context: string): SourceRange {
  const source = record(value, context);
  return {
    start: validateSourcePosition(source.start, `${context}.start`),
    end: validateSourcePosition(source.end, `${context}.end`)
  };
}

const TYPE_RESOLUTION_STRATEGIES = [
  "QUALIFIED",
  "EXPLICIT_IMPORT",
  "ENCLOSING_TYPE",
  "SAME_PACKAGE",
  "JAVA_LANG",
  "WILDCARD_IMPORT",
  "REPO_UNIQUE_SIMPLE_NAME"
] as const satisfies readonly TypeResolutionStrategy[];

const EXTERNAL_TYPE_STRATEGIES = ["QUALIFIED", "EXPLICIT_IMPORT", "JAVA_LANG"] as const;

function validateTypeRefResolution(value: unknown, context: string): JavaTypeRef["resolution"] {
  const source = record(value, context);
  if (!isString(source.state)) invalid(context, "expected resolution.state");
  switch (source.state) {
    case "RESOLVED_REPO": {
      if (!isString(source.typeId)) invalid(context, "RESOLVED_REPO.typeId");
      if (!isOneOf(source.strategy, TYPE_RESOLUTION_STRATEGIES)) invalid(context, "RESOLVED_REPO.strategy");
      return { state: "RESOLVED_REPO", typeId: source.typeId, strategy: source.strategy };
    }
    case "EXTERNAL": {
      if (!isString(source.qualifiedName)) invalid(context, "EXTERNAL.qualifiedName");
      if (!isOneOf(source.strategy, EXTERNAL_TYPE_STRATEGIES)) invalid(context, "EXTERNAL.strategy");
      return { state: "EXTERNAL", qualifiedName: source.qualifiedName, strategy: source.strategy };
    }
    case "TYPE_VARIABLE": {
      if (!isString(source.name)) invalid(context, "TYPE_VARIABLE.name");
      return { state: "TYPE_VARIABLE", name: source.name };
    }
    case "AMBIGUOUS": {
      if (!isStringArray(source.candidates)) invalid(context, "AMBIGUOUS.candidates");
      return { state: "AMBIGUOUS", candidates: source.candidates };
    }
    case "UNRESOLVED":
      return { state: "UNRESOLVED" };
    default:
      return invalid(context, `unknown resolution state ${String(source.state)}`);
  }
}

function validateJavaTypeRef(value: unknown, context: string): JavaTypeRef {
  const source = record(value, context);
  if (!isString(source.text)) invalid(context, "text");
  if (!isString(source.simpleName)) invalid(context, "simpleName");
  if (!isNumber(source.arrayDepth)) invalid(context, "arrayDepth");
  const typeArguments = array(source.typeArguments, `${context}.typeArguments`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.typeArguments[${index}]`));
  const wildcard = source.wildcard === undefined
    ? undefined
    : isOneOf(source.wildcard, ["extends", "super", "unbounded"] as const)
      ? source.wildcard
      : invalid(context, "wildcard");
  const qualifiedName = optional(source.qualifiedName, `${context}.qualifiedName`, isAssertString);
  const range = optional(source.range, `${context}.range`, validateSourceRange);
  return {
    text: source.text,
    simpleName: source.simpleName,
    ...withOptional("qualifiedName", qualifiedName),
    typeArguments,
    arrayDepth: source.arrayDepth,
    ...withOptional("wildcard", wildcard),
    resolution: validateTypeRefResolution(source.resolution, `${context}.resolution`),
    ...withOptional("range", range)
  };
}

function isAssertString(value: unknown, context: string): string {
  if (!isString(value)) invalid(context, "expected a string");
  return value;
}

function isAssertNumber(value: unknown, context: string): number {
  if (!isNumber(value)) invalid(context, "expected a number");
  return value;
}

function validateJavaTypeParameterFact(value: unknown, context: string): JavaTypeParameterFact {
  const source = record(value, context);
  if (!isString(source.name)) invalid(context, "name");
  const bounds = array(source.bounds, `${context}.bounds`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.bounds[${index}]`));
  return {
    name: source.name,
    bounds,
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

function validateJavaAnnotationFact(value: unknown, context: string): JavaAnnotationFact {
  const source = record(value, context);
  if (!isString(source.name)) invalid(context, "name");
  return {
    name: source.name,
    ...withOptional("qualifiedName", optional(source.qualifiedName, `${context}.qualifiedName`, isAssertString)),
    ...withOptional("argumentsText", optional(source.argumentsText, `${context}.argumentsText`, isAssertString)),
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

const JAVA_CALL_SITE_KINDS: readonly JavaCallSiteKind[] = [
  "METHOD_INVOCATION",
  "CONSTRUCTOR_INVOCATION",
  "METHOD_REFERENCE"
];

function validateJavaCallSiteFact(value: unknown, context: string): JavaCallSiteFact {
  const source = record(value, context);
  if (!isOneOf(source.kind, JAVA_CALL_SITE_KINDS)) invalid(context, "kind");
  if (!isString(source.name)) invalid(context, "name");
  if (!isNumber(source.arity)) invalid(context, "arity");
  const argumentTypeHints = array(source.argumentTypeHints, `${context}.argumentTypeHints`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.argumentTypeHints[${index}]`));
  return {
    kind: source.kind,
    name: source.name,
    ...withOptional("receiverText", optional(source.receiverText, `${context}.receiverText`, isAssertString)),
    ...withOptional("receiverDeclaredType", optional(
      source.receiverDeclaredType,
      `${context}.receiverDeclaredType`,
      validateJavaTypeRef
    )),
    arity: source.arity,
    argumentTypeHints,
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

function validateJavaImportFact(value: unknown, context: string): JavaImportFact {
  const source = record(value, context);
  if (!isString(source.qualifiedName)) invalid(context, "qualifiedName");
  if (!isBoolean(source.wildcard)) invalid(context, "wildcard");
  if (!isBoolean(source.static)) invalid(context, "static");
  return {
    qualifiedName: source.qualifiedName,
    wildcard: source.wildcard,
    static: source.static,
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

function validateJavaFieldFacts(value: unknown, context: string): JavaFieldFacts {
  const source = record(value, context);
  if (!isString(source.fieldId)) invalid(context, "fieldId");
  if (!isString(source.ownerTypeId)) invalid(context, "ownerTypeId");
  if (!isString(source.name)) invalid(context, "name");
  if (!isStringArray(source.modifiers)) invalid(context, "modifiers");
  const annotations = array(source.annotations, `${context}.annotations`)
    .map((entry, index) => validateJavaAnnotationFact(entry, `${context}.annotations[${index}]`));
  return {
    fieldId: source.fieldId,
    ownerTypeId: source.ownerTypeId,
    name: source.name,
    type: validateJavaTypeRef(source.type, `${context}.type`),
    modifiers: source.modifiers,
    annotations,
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

function validateJavaMethodParameter(
  value: unknown,
  context: string
): { name: string; type: JavaTypeRef; varargs: boolean; annotations: JavaAnnotationFact[]; range: SourceRange } {
  const source = record(value, context);
  if (!isString(source.name)) invalid(context, "name");
  if (!isBoolean(source.varargs)) invalid(context, "varargs");
  const annotations = array(source.annotations, `${context}.annotations`)
    .map((entry, index) => validateJavaAnnotationFact(entry, `${context}.annotations[${index}]`));
  return {
    name: source.name,
    type: validateJavaTypeRef(source.type, `${context}.type`),
    varargs: source.varargs,
    annotations,
    range: validateSourceRange(source.range, `${context}.range`)
  };
}

function validateJavaMethodFacts(value: unknown, context: string): JavaMethodFacts {
  const source = record(value, context);
  if (!isString(source.methodId)) invalid(context, "methodId");
  if (!isString(source.ownerTypeId)) invalid(context, "ownerTypeId");
  if (!isString(source.name)) invalid(context, "name");
  if (!isBoolean(source.constructor)) invalid(context, "constructor");
  if (!isString(source.signatureKey)) invalid(context, "signatureKey");
  if (!isStringArray(source.modifiers)) invalid(context, "modifiers");
  const annotations = array(source.annotations, `${context}.annotations`)
    .map((entry, index) => validateJavaAnnotationFact(entry, `${context}.annotations[${index}]`));
  const typeParameters = array(source.typeParameters, `${context}.typeParameters`)
    .map((entry, index) => validateJavaTypeParameterFact(entry, `${context}.typeParameters[${index}]`));
  const parameters = array(source.parameters, `${context}.parameters`)
    .map((entry, index) => validateJavaMethodParameter(entry, `${context}.parameters[${index}]`));
  const throwsTypes = array(source.throws, `${context}.throws`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.throws[${index}]`));
  const callSites = array(source.callSites, `${context}.callSites`)
    .map((entry, index) => validateJavaCallSiteFact(entry, `${context}.callSites[${index}]`));
  const localTypes = array(source.localTypes, `${context}.localTypes`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.localTypes[${index}]`));
  return {
    methodId: source.methodId,
    ownerTypeId: source.ownerTypeId,
    name: source.name,
    constructor: source.constructor,
    signatureKey: source.signatureKey,
    range: validateSourceRange(source.range, `${context}.range`),
    ...withOptional("bodyRange", optional(source.bodyRange, `${context}.bodyRange`, validateSourceRange)),
    modifiers: source.modifiers,
    annotations,
    typeParameters,
    ...withOptional("returnType", optional(source.returnType, `${context}.returnType`, validateJavaTypeRef)),
    parameters,
    throws: throwsTypes,
    callSites,
    localTypes
  };
}

const JAVA_TYPE_KINDS: readonly JavaTypeKind[] = ["class", "interface", "record", "enum", "annotation"];

function validateJavaTypeFacts(value: unknown, context: string): JavaTypeFacts {
  const source = record(value, context);
  if (!isString(source.typeId)) invalid(context, "typeId");
  if (!isString(source.simpleName)) invalid(context, "simpleName");
  if (!isOneOf(source.kind, JAVA_TYPE_KINDS)) invalid(context, "kind");
  if (!isString(source.fileId)) invalid(context, "fileId");
  if (!isStringArray(source.modifiers)) invalid(context, "modifiers");
  if (!isStringArray(source.fieldIds)) invalid(context, "fieldIds");
  if (!isStringArray(source.methodIds)) invalid(context, "methodIds");
  if (!isNumber(source.confidence)) invalid(context, "confidence");
  const annotations = array(source.annotations, `${context}.annotations`)
    .map((entry, index) => validateJavaAnnotationFact(entry, `${context}.annotations[${index}]`));
  const typeParameters = array(source.typeParameters, `${context}.typeParameters`)
    .map((entry, index) => validateJavaTypeParameterFact(entry, `${context}.typeParameters[${index}]`));
  const extendsTypes = array(source.extends, `${context}.extends`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.extends[${index}]`));
  const implementsTypes = array(source.implements, `${context}.implements`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.implements[${index}]`));
  const permitsTypes = array(source.permits, `${context}.permits`)
    .map((entry, index) => validateJavaTypeRef(entry, `${context}.permits[${index}]`));
  return {
    typeId: source.typeId,
    ...withOptional("fqn", optional(source.fqn, `${context}.fqn`, isAssertString)),
    simpleName: source.simpleName,
    kind: source.kind,
    fileId: source.fileId,
    ...withOptional("enclosingTypeId", optional(source.enclosingTypeId, `${context}.enclosingTypeId`, isAssertString)),
    range: validateSourceRange(source.range, `${context}.range`),
    modifiers: source.modifiers,
    annotations,
    typeParameters,
    extends: extendsTypes,
    implements: implementsTypes,
    permits: permitsTypes,
    fieldIds: source.fieldIds,
    methodIds: source.methodIds,
    confidence: source.confidence
  };
}

const JAVA_SOURCE_SETS: readonly JavaSourceSet[] = ["main", "test", "generated", "unknown"];
const JAVA_PARSE_STATES: readonly JavaParseState[] = ["COMPLETE", "RECOVERED", "FAILED"];

function validateJavaFileFacts(value: unknown, context: string): JavaFileFacts {
  const source = record(value, context);
  if (!isString(source.fileId)) invalid(context, "fileId");
  if (!isString(source.relativePath)) invalid(context, "relativePath");
  if (!isString(source.sourceRoot)) invalid(context, "sourceRoot");
  if (!isString(source.module)) invalid(context, "module");
  if (!isOneOf(source.sourceSet, JAVA_SOURCE_SETS)) invalid(context, "sourceSet");
  if (!isString(source.packageName)) invalid(context, "packageName");
  if (!isStringArray(source.topLevelTypeIds)) invalid(context, "topLevelTypeIds");
  if (!isStringArray(source.allTypeIds)) invalid(context, "allTypeIds");
  if (!isString(source.contentHash)) invalid(context, "contentHash");
  if (!isNumber(source.size)) invalid(context, "size");
  if (!isNumber(source.mtimeMs)) invalid(context, "mtimeMs");
  const ctimeMs = optional(source.ctimeMs, `${context}.ctimeMs`, isAssertNumber);
  if (!isOneOf(source.parseState, JAVA_PARSE_STATES)) invalid(context, "parseState");
  if (!isNumber(source.parseErrorCount)) invalid(context, "parseErrorCount");
  if (!isNumber(source.generation)) invalid(context, "generation");
  const imports = array(source.imports, `${context}.imports`)
    .map((entry, index) => validateJavaImportFact(entry, `${context}.imports[${index}]`));
  return {
    fileId: source.fileId,
    relativePath: source.relativePath,
    sourceRoot: source.sourceRoot,
    module: source.module,
    sourceSet: source.sourceSet,
    packageName: source.packageName,
    imports,
    topLevelTypeIds: source.topLevelTypeIds,
    allTypeIds: source.allTypeIds,
    contentHash: source.contentHash,
    size: source.size,
    mtimeMs: source.mtimeMs,
    ...withOptional("ctimeMs", ctimeMs),
    parseState: source.parseState,
    parseErrorCount: source.parseErrorCount,
    generation: source.generation
  };
}

const STATIC_EDGE_KINDS: readonly StaticEdgeKind[] = [
  "DECLARES",
  "EXTENDS",
  "IMPLEMENTS",
  "PERMITS",
  "IMPORTS",
  "FIELD_TYPE",
  "PARAM_TYPE",
  "RETURN_TYPE",
  "THROWS_TYPE",
  "LOCAL_TYPE",
  "CALLS",
  "CONSTRUCTS",
  "METHOD_REFERENCE",
  "ANNOTATED_WITH"
];

const STATIC_EDGE_RESOLUTION_KINDS: readonly StaticEdgeResolutionKind[] = [
  "AST_EXPLICIT",
  "TYPE_REFERENCE",
  "SAME_OWNER_NAME_ARITY",
  "DECLARED_RECEIVER_NAME_ARITY",
  "SUPER_CHAIN_NAME_ARITY",
  "CONSTRUCTOR_TYPE",
  "METHOD_REFERENCE_OWNER"
];

function validateStaticEdge(value: unknown, context: string): StaticEdge {
  const source = record(value, context);
  if (!isString(source.edgeId)) invalid(context, "edgeId");
  if (!isString(source.fromId)) invalid(context, "fromId");
  if (!isString(source.toId)) invalid(context, "toId");
  if (!isOneOf(source.kind, STATIC_EDGE_KINDS)) invalid(context, "kind");
  if (!isNumber(source.confidence)) invalid(context, "confidence");
  if (!isString(source.sourceFile)) invalid(context, "sourceFile");
  if (!isNumber(source.generation)) invalid(context, "generation");
  const resolutionSource = record(source.resolution, `${context}.resolution`);
  if (!isOneOf(resolutionSource.kind, STATIC_EDGE_RESOLUTION_KINDS)) invalid(context, "resolution.kind");
  const typeStrategy = optional(
    resolutionSource.typeStrategy,
    `${context}.resolution.typeStrategy`,
    (typeStrategyValue, typeStrategyContext) => {
      if (!isOneOf(typeStrategyValue, TYPE_RESOLUTION_STRATEGIES)) invalid(typeStrategyContext, "typeStrategy");
      return typeStrategyValue;
    }
  );
  return {
    edgeId: source.edgeId,
    fromId: source.fromId,
    toId: source.toId,
    kind: source.kind,
    confidence: source.confidence,
    ...withOptional("range", optional(source.range, `${context}.range`, validateSourceRange)),
    sourceFile: source.sourceFile,
    generation: source.generation,
    resolution: { kind: resolutionSource.kind, ...withOptional("typeStrategy", typeStrategy) }
  };
}

const SOURCE_ROOT_STATES = ["UNKNOWN", "BUILDING", "COMPLETE", "DEGRADED"] as const;

function validateSourceRootCoverage(value: unknown, context: string): SourceRootCoverage {
  const source = record(value, context);
  if (!isString(source.root)) invalid(context, "root");
  if (!isNumber(source.generation)) invalid(context, "generation");
  if (!isOneOf(source.state, SOURCE_ROOT_STATES)) invalid(context, "state");
  if (!isNumber(source.discoveredFiles)) invalid(context, "discoveredFiles");
  if (!isNumber(source.indexedFiles)) invalid(context, "indexedFiles");
  if (!isNumber(source.failedFiles)) invalid(context, "failedFiles");
  if (!isNumber(source.recoveredFiles)) invalid(context, "recoveredFiles");
  if (!isString(source.extractorVersion)) invalid(context, "extractorVersion");
  return {
    root: source.root,
    generation: source.generation,
    state: source.state,
    discoveredFiles: source.discoveredFiles,
    indexedFiles: source.indexedFiles,
    failedFiles: source.failedFiles,
    recoveredFiles: source.recoveredFiles,
    extractorVersion: source.extractorVersion,
    ...withOptional("completedAt", optional(source.completedAt, `${context}.completedAt`, isAssertString))
  };
}

function validateMyBatisResourceCoverage(value: unknown, context: string): MyBatisResourceCoverage {
  const source = record(value, context);
  if (!isString(source.root)) invalid(context, "root");
  if (!isNumber(source.generation)) invalid(context, "generation");
  const states = ["UNKNOWN", "BUILDING", "COMPLETE", "DEGRADED"] as const;
  if (!isOneOf(source.state, states)) invalid(context, "state");
  if (!isNumber(source.discoveredFiles)) invalid(context, "discoveredFiles");
  if (!isNumber(source.indexedFiles)) invalid(context, "indexedFiles");
  if (!isNumber(source.failedFiles)) invalid(context, "failedFiles");
  return {
    root: source.root,
    generation: source.generation,
    state: source.state,
    discoveredFiles: source.discoveredFiles,
    indexedFiles: source.indexedFiles,
    failedFiles: source.failedFiles
  };
}

function validateJavaFileBundle(value: unknown, context: string): JavaFileBundle {
  const source = record(value, context);
  const types = array(source.types, `${context}.types`)
    .map((entry, index) => validateJavaTypeFacts(entry, `${context}.types[${index}]`));
  const fields = array(source.fields, `${context}.fields`)
    .map((entry, index) => validateJavaFieldFacts(entry, `${context}.fields[${index}]`));
  const methods = array(source.methods, `${context}.methods`)
    .map((entry, index) => validateJavaMethodFacts(entry, `${context}.methods[${index}]`));
  const edges = array(source.edges, `${context}.edges`)
    .map((entry, index) => validateStaticEdge(entry, `${context}.edges[${index}]`));
  return {
    file: validateJavaFileFacts(source.file, `${context}.file`),
    types,
    fields,
    methods,
    edges
  };
}

const WORKTREE_SEED_COMPLETIONS = ["NOT_ATTEMPTED", "SEEDED_DEGRADED", "RECONCILED_COMPLETE", "NO_VALID_SOURCE", "FAILED"] as const;

function validateWorktreeSeedStatus(value: unknown, context: string): WorktreeSeedStatus {
  const source = record(value, context);
  if (!isBoolean(source.attempted)) invalid(context, "attempted");
  if (!isNumber(source.reusedFiles)) invalid(context, "reusedFiles");
  if (!isNumber(source.dirtyFiles)) invalid(context, "dirtyFiles");
  if (!isNumber(source.relinkFiles)) invalid(context, "relinkFiles");
  if (!isNumber(source.droppedCrossFileEdges)) invalid(context, "droppedCrossFileEdges");
  if (!isNumber(source.droppedFrameworkEdges)) invalid(context, "droppedFrameworkEdges");
  if (!isNumber(source.manifestValidationMs)) invalid(context, "manifestValidationMs");
  if (!isNumber(source.deltaParsedFiles)) invalid(context, "deltaParsedFiles");
  if (!isNumber(source.reusedResources)) invalid(context, "reusedResources");
  if (!isNumber(source.dirtyResources)) invalid(context, "dirtyResources");
  if (!isNumber(source.cacheDirsScanned)) invalid(context, "cacheDirsScanned");
  if (!isNumber(source.eligibleSnapshots)) invalid(context, "eligibleSnapshots");
  if (!isNumber(source.candidateDecompressMs)) invalid(context, "candidateDecompressMs");
  if (!isNumber(source.initialManifestScanMs)) invalid(context, "initialManifestScanMs");
  if (!isNumber(source.finalManifestScanMs)) invalid(context, "finalManifestScanMs");
  if (!isOneOf(source.completion, WORKTREE_SEED_COMPLETIONS)) invalid(context, "completion");
  return {
    attempted: source.attempted,
    ...withOptional("sourceRepoHash", optional(source.sourceRepoHash, `${context}.sourceRepoHash`, isAssertString)),
    reusedFiles: source.reusedFiles,
    dirtyFiles: source.dirtyFiles,
    relinkFiles: source.relinkFiles,
    droppedCrossFileEdges: source.droppedCrossFileEdges,
    droppedFrameworkEdges: source.droppedFrameworkEdges,
    manifestValidationMs: source.manifestValidationMs,
    deltaParsedFiles: source.deltaParsedFiles,
    reusedResources: source.reusedResources,
    dirtyResources: source.dirtyResources,
    cacheDirsScanned: source.cacheDirsScanned,
    eligibleSnapshots: source.eligibleSnapshots,
    ...withOptional("fingerprintMatched", optional(source.fingerprintMatched, `${context}.fingerprintMatched`, (value, valueContext) => {
      if (!isBoolean(value)) invalid(valueContext, "expected a boolean");
      return value;
    })),
    ...withOptional("metaMissing", optional(source.metaMissing, `${context}.metaMissing`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    ...withOptional("selfSkip", optional(source.selfSkip, `${context}.selfSkip`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    ...withOptional("familyMismatch", optional(source.familyMismatch, `${context}.familyMismatch`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    ...withOptional("identityMismatch", optional(source.identityMismatch, `${context}.identityMismatch`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    ...withOptional("coverageIncomplete", optional(source.coverageIncomplete, `${context}.coverageIncomplete`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    candidateDecompressMs: source.candidateDecompressMs,
    initialManifestScanMs: source.initialManifestScanMs,
    finalManifestScanMs: source.finalManifestScanMs,
    completion: source.completion
  };
}

function validateSnapshotStatus(value: unknown, context: string): JavaIndexSnapshotStatus {
  const source = record(value, context);
  if (!isOneOf(source.state, ["EMPTY", "PENDING", "DURABLE", "FAILED"] as const)) invalid(context, "state");
  const durableGeneration = optional(source.durableGeneration, `${context}.durableGeneration`, (item, itemContext) => {
    if (!isNumber(item)) invalid(itemContext, "expected a number");
    return item;
  });
  const durableManifestFingerprint = optional(
    source.durableManifestFingerprint,
    `${context}.durableManifestFingerprint`,
    isAssertString
  );
  const failure = optional(source.failure, `${context}.failure`, (item, itemContext) => {
    if (!isOneOf(item, ["MANIFEST_CHANGED", "WRITE_FAILED"] as const)) invalid(itemContext, "unsupported failure");
    return item;
  });
  const hasDurableGeneration = durableGeneration !== undefined;
  const hasDurableManifest = durableManifestFingerprint !== undefined;
  if (hasDurableGeneration !== hasDurableManifest) invalid(context, "durable identity must be complete");
  if (source.state === "EMPTY") {
    if (hasDurableGeneration || failure !== undefined) invalid(context, "EMPTY cannot carry durable/failure state");
    return { state: "EMPTY" };
  }
  if (source.state === "DURABLE") {
    if (durableGeneration === undefined || durableManifestFingerprint === undefined || failure !== undefined) {
      invalid(context, "DURABLE requires identity and no failure");
    }
    return {
      state: "DURABLE",
      durableGeneration,
      durableManifestFingerprint
    };
  }
  if (source.state === "FAILED") {
    if (failure === undefined) invalid(context, "FAILED requires failure");
    return {
      state: "FAILED",
      ...withOptional("durableGeneration", durableGeneration),
      ...withOptional("durableManifestFingerprint", durableManifestFingerprint),
      failure
    };
  }
  if (failure !== undefined) invalid(context, "PENDING cannot carry failure");
  return {
    state: "PENDING",
    ...withOptional("durableGeneration", durableGeneration),
    ...withOptional("durableManifestFingerprint", durableManifestFingerprint)
  };
}

// --- exported command-specific validators ------------------------------------

export function validateJavaIndexStatus(value: unknown): JavaIndexStatus {
  const context = "JavaIndexStatus";
  const source = record(value, context);
  const states = ["NEW", "OPENING", "READY", "DEGRADED", "CLOSED"] as const;
  if (!isOneOf(source.state, states)) invalid(context, "state");
  if (!isNumber(source.indexedGeneration)) invalid(context, "indexedGeneration");
  if (!isNumber(source.files)) invalid(context, "files");
  if (!isNumber(source.types)) invalid(context, "types");
  if (!isNumber(source.methods)) invalid(context, "methods");
  if (!isNumber(source.edges)) invalid(context, "edges");
  if (!isNumber(source.snapshotBytes)) invalid(context, "snapshotBytes");
  if (!isNumber(source.pendingForeground)) invalid(context, "pendingForeground");
  if (!isNumber(source.pendingBackground)) invalid(context, "pendingBackground");
  const snapshotVerificationPending = optional(
    source.snapshotVerificationPending,
    `${context}.snapshotVerificationPending`,
    (pending, pendingContext) => {
      if (!isBoolean(pending)) invalid(pendingContext, "expected a boolean");
      return pending;
    }
  );
  const coverage = array(source.coverage, `${context}.coverage`)
    .map((entry, index) => validateSourceRootCoverage(entry, `${context}.coverage[${index}]`));
  const resourceCoverage = array(source.resourceCoverage, `${context}.resourceCoverage`)
    .map((entry, index) => validateMyBatisResourceCoverage(entry, `${context}.resourceCoverage[${index}]`));
  return {
    state: source.state,
    indexedGeneration: source.indexedGeneration,
    files: source.files,
    types: source.types,
    methods: source.methods,
    edges: source.edges,
    snapshotBytes: source.snapshotBytes,
    ...withOptional("snapshot", optional(source.snapshot, `${context}.snapshot`, validateSnapshotStatus)),
    pendingForeground: source.pendingForeground,
    pendingBackground: source.pendingBackground,
    ...withOptional("snapshotVerificationPending", snapshotVerificationPending),
    coverage,
    resourceCoverage,
    ...withOptional("lastError", optional(source.lastError, `${context}.lastError`, isAssertString)),
    ...withOptional("worktreeSeed", optional(source.worktreeSeed, `${context}.worktreeSeed`, validateWorktreeSeedStatus)),
    ...withOptional("hibernated", optional(source.hibernated, `${context}.hibernated`, (value, valueContext) => {
      if (!isBoolean(value)) invalid(valueContext, "expected a boolean");
      return value;
    })),
    ...withOptional("factsHydrated", optional(source.factsHydrated, `${context}.factsHydrated`, (value, valueContext) => {
      if (!isBoolean(value)) invalid(valueContext, "expected a boolean");
      return value;
    })),
    ...withOptional("heapUsedBytes", optional(source.heapUsedBytes, `${context}.heapUsedBytes`, (value, valueContext) => {
      if (!isNumber(value)) invalid(valueContext, "expected a number");
      return value;
    })),
    ...withOptional("heapSplit", optional(source.heapSplit, `${context}.heapSplit`, validateHeapSplit))
  };
}

function validateHeapSplit(value: unknown, context: string): JavaIndexHeapSplit {
  const source = record(value, context);
  if (!isNumber(source.heapUsedMb)) invalid(context, "heapUsedMb");
  if (!isNumber(source.rssMb)) invalid(context, "rssMb");
  if (!isNumber(source.poolBundles)) invalid(context, "poolBundles");
  if (!isNumber(source.familyRootCount)) invalid(context, "familyRootCount");
  if (!isNumber(source.thisRootFiles)) invalid(context, "thisRootFiles");
  if (!isNumber(source.thisRootOverlayFiles)) invalid(context, "thisRootOverlayFiles");
  if (!isBoolean(source.graphSynced)) invalid(context, "graphSynced");
  return {
    heapUsedMb: source.heapUsedMb,
    rssMb: source.rssMb,
    poolBundles: source.poolBundles,
    familyRootCount: source.familyRootCount,
    thisRootFiles: source.thisRootFiles,
    thisRootOverlayFiles: source.thisRootOverlayFiles,
    graphSynced: source.graphSynced
  };
}

export function validateAnchorFacts(value: unknown): AnchorFacts | undefined {
  if (value === undefined || value === null) return undefined;
  const context = "AnchorFacts";
  const source = record(value, context);
  const symbolKinds = ["TYPE", "METHOD", "CONSTRUCTOR", "FIELD", "FILE"] as const;
  if (!isString(source.symbolId)) invalid(context, "symbolId");
  if (!isOneOf(source.symbolKind, symbolKinds)) invalid(context, "symbolKind");
  if (!isString(source.symbolName)) invalid(context, "symbolName");
  if (!isOneOf(source.coverage, SOURCE_ROOT_STATES)) invalid(context, "coverage");
  if (!isNumber(source.confidence)) invalid(context, "confidence");
  return {
    file: validateJavaFileFacts(source.file, `${context}.file`),
    symbolId: source.symbolId,
    symbolKind: source.symbolKind,
    symbolName: source.symbolName,
    range: validateSourceRange(source.range, `${context}.range`),
    ...withOptional("type", optional(source.type, `${context}.type`, validateJavaTypeFacts)),
    ...withOptional("method", optional(source.method, `${context}.method`, validateJavaMethodFacts)),
    ...withOptional("field", optional(source.field, `${context}.field`, validateJavaFieldFacts)),
    coverage: source.coverage,
    confidence: source.confidence
  };
}

export function validateTypeLookup(value: unknown): JavaTypeLookupResult {
  const context = "JavaTypeLookupResult";
  const source = record(value, context);
  if (!isString(source.state)) invalid(context, "state");
  switch (source.state) {
    case "RESOLVED":
      return { state: "RESOLVED", type: validateJavaTypeFacts(source.type, `${context}.type`) };
    case "AMBIGUOUS": {
      const candidates = array(source.candidates, `${context}.candidates`)
        .map((entry, index) => validateJavaTypeFacts(entry, `${context}.candidates[${index}]`));
      return { state: "AMBIGUOUS", candidates };
    }
    case "UNRESOLVED": {
      const coverageStates = ["COMPLETE", "PARTIAL", "DEGRADED"] as const;
      if (!isOneOf(source.coverage, coverageStates)) invalid(context, "coverage");
      return { state: "UNRESOLVED", coverage: source.coverage };
    }
    default:
      return invalid(context, `unknown state ${String(source.state)}`);
  }
}

export function validateTypeLookupArray(value: unknown): JavaTypeLookupResult[] {
  const context = "JavaTypeLookupResult[]";
  return array(value, context).map((entry, index) => validateTypeLookup(entry));
}

export function validateTypeFactsArray(value: unknown): JavaTypeFacts[] {
  const context = "JavaTypeFacts[]";
  return array(value, context).map((entry, index) => validateJavaTypeFacts(entry, `${context}[${index}]`));
}

export function validateIndexedReferenceArray(value: unknown): IndexedReference[] {
  const context = "IndexedReference[]";
  return array(value, context).map((entry, index) => {
    const entryContext = `${context}[${index}]`;
    const source = record(entry, entryContext);
    if (!isString(source.sourceId)) invalid(entryContext, "sourceId");
    if (!isString(source.targetId)) invalid(entryContext, "targetId");
    if (!isString(source.sourceFile)) invalid(entryContext, "sourceFile");
    if (!isString(source.sourceModule)) invalid(entryContext, "sourceModule");
    if (!isOneOf(source.sourceSet, JAVA_SOURCE_SETS)) invalid(entryContext, "sourceSet");
    if (!isOneOf(source.kind, STATIC_EDGE_KINDS)) invalid(entryContext, "kind");
    if (!isNumber(source.confidence)) invalid(entryContext, "confidence");
    if (!isNumber(source.generation)) invalid(entryContext, "generation");
    return {
      sourceId: source.sourceId,
      targetId: source.targetId,
      sourceFile: source.sourceFile,
      sourceModule: source.sourceModule,
      sourceSet: source.sourceSet,
      kind: source.kind,
      confidence: source.confidence,
      ...withOptional("range", optional(source.range, `${entryContext}.range`, validateSourceRange)),
      generation: source.generation
    };
  });
}

export type IndexedReferenceBatch = Array<{ methodId: string; callees: IndexedReference[] }>;

export function validateIndexedReferenceBatch(value: unknown): IndexedReferenceBatch {
  return array(value, "IndexedReferenceBatch").map((entry, index) => {
    const source = record(entry, `IndexedReferenceBatch[${index}]`);
    if (!isString(source.methodId)) invalid(`IndexedReferenceBatch[${index}]`, "methodId");
    return {
      methodId: source.methodId,
      callees: validateIndexedReferenceArray(source.callees)
    };
  });
}

const ENTITY_KINDS = ["type", "method"] as const;
const ENTITY_LAYERS = ["FQN", "SIMPLE_NAME", "BM25_IDENTIFIER", "CHUNK"] as const;

export type GraphDigest = {
  digest: string;
  generation: number;
  nodes: number;
  edges: number;
  heapUsedBytes?: number;
  rssBytes?: number;
  childColdPeakRssBytes?: number;
  parentColdIncrementBytes?: number;
};

export function validateGraphDigest(value: unknown): GraphDigest {
  const context = "GraphDigest";
  const source = record(value, context);
  if (!isString(source.digest)) invalid(context, "digest");
  if (!isNumber(source.generation)) invalid(context, "generation");
  if (!isNumber(source.nodes)) invalid(context, "nodes");
  if (!isNumber(source.edges)) invalid(context, "edges");
  return {
    digest: source.digest,
    generation: source.generation,
    nodes: source.nodes,
    edges: source.edges,
    ...(isNumber(source.heapUsedBytes) ? { heapUsedBytes: source.heapUsedBytes } : {}),
    ...(isNumber(source.rssBytes) ? { rssBytes: source.rssBytes } : {}),
    ...(isNumber(source.childColdPeakRssBytes) ? { childColdPeakRssBytes: source.childColdPeakRssBytes } : {}),
    ...(isNumber(source.parentColdIncrementBytes) ? { parentColdIncrementBytes: source.parentColdIncrementBytes } : {})
  };
}

export type GraphReachable = {
  files: string[];
  hops: Record<string, number>;
};

export function validateGraphReachable(value: unknown): GraphReachable {
  const context = "GraphReachable";
  const source = record(value, context);
  const files = array(source.files, `${context}.files`).map((entry, index) => {
    if (!isString(entry)) invalid(`${context}.files`, String(index));
    return entry;
  });
  const hopsSource = record(source.hops, `${context}.hops`);
  const hops: Record<string, number> = {};
  for (const [path, hop] of Object.entries(hopsSource)) {
    if (!isNumber(hop)) invalid(`${context}.hops`, path);
    hops[path] = hop;
  }
  return { files, hops };
}

export type ContextGraphResult = {
  resolvedIntent: string;
  coverage: "COMPLETE" | "PARTIAL";
  bundles: Array<{
    path: string;
    hops: number;
    estimatedTokens: number;
    provingPath: Array<{ kind: string; fromId: string; toId: string }>;
    closedObligations: string[];
  }>;
  unresolved: Array<{ id: string; role: string }>;
  metrics: { expansions: number; hops: number; estimatedTokens: number };
  contract?: ContextContract;
};

export function validateContextGraphResult(value: unknown): ContextGraphResult {
  const context = "ContextGraphResult";
  const source = record(value, context);
  if (!isString(source.resolvedIntent)) invalid(context, "resolvedIntent");
  if (source.coverage !== "COMPLETE" && source.coverage !== "PARTIAL") invalid(context, "coverage");
  const bundles = array(source.bundles, `${context}.bundles`).map((entry, index) => {
    const item = record(entry, `${context}.bundles[${index}]`);
    if (!isString(item.path) || !isNumber(item.hops) || !isNumber(item.estimatedTokens)) invalid(`${context}.bundles`, String(index));
    const provingPath = array(item.provingPath, `${context}.bundles[${index}].provingPath`).map((step, stepIndex) => {
      const edge = record(step, `${context}.bundles[${index}].provingPath[${stepIndex}]`);
      if (!isString(edge.kind) || !isString(edge.fromId) || !isString(edge.toId)) invalid(`${context}.bundles[${index}].provingPath`, String(stepIndex));
      return { kind: edge.kind, fromId: edge.fromId, toId: edge.toId };
    });
    const closedObligations = array(item.closedObligations, `${context}.bundles[${index}].closedObligations`).map(value => {
      if (!isString(value)) invalid(`${context}.bundles[${index}].closedObligations`, "entry");
      return value;
    });
    return {
      path: item.path,
      hops: item.hops,
      estimatedTokens: item.estimatedTokens,
      provingPath,
      closedObligations
    };
  });
  const unresolved = array(source.unresolved, `${context}.unresolved`).map((entry, index) => {
    const item = record(entry, `${context}.unresolved[${index}]`);
    if (!isString(item.id) || !isString(item.role)) invalid(`${context}.unresolved`, String(index));
    return { id: item.id, role: item.role };
  });
  const metrics = record(source.metrics, `${context}.metrics`);
  if (!isNumber(metrics.expansions) || !isNumber(metrics.hops) || !isNumber(metrics.estimatedTokens)) invalid(context, "metrics");
  return {
    resolvedIntent: source.resolvedIntent,
    coverage: source.coverage,
    bundles,
    unresolved,
    metrics: { expansions: metrics.expansions, hops: metrics.hops, estimatedTokens: metrics.estimatedTokens },
    ...(source.contract ? { contract: source.contract as ContextContract } : {})
  };
}

export function validateEntitySearchHits(value: unknown): EntityHit[] {
  const context = "EntityHit[]";
  return array(value, context).map((entry, index) => {
    const entryContext = `${context}[${index}]`;
    const source = record(entry, entryContext);
    if (!isString(source.entityId)) invalid(entryContext, "entityId");
    if (!isOneOf(source.kind, ENTITY_KINDS)) invalid(entryContext, "kind");
    if (!isString(source.fqn)) invalid(entryContext, "fqn");
    if (!isString(source.simpleName)) invalid(entryContext, "simpleName");
    if (!isString(source.relativePath)) invalid(entryContext, "relativePath");
    if (!isOneOf(source.layer, ENTITY_LAYERS)) invalid(entryContext, "layer");
    if (!isNumber(source.score)) invalid(entryContext, "score");
    return {
      entityId: source.entityId,
      kind: source.kind as EntityKind,
      fqn: source.fqn,
      simpleName: source.simpleName,
      relativePath: source.relativePath,
      layer: source.layer as EntityLayer,
      score: source.score
    };
  });
}

export function validateRepositoryFactMarkers(value: unknown): { importPrefixFound: boolean; annotationPrefixFound: boolean } {
  const source = record(value, "RepositoryFactMarkers");
  if (!isBoolean(source.importPrefixFound)) invalid("RepositoryFactMarkers", "importPrefixFound");
  if (!isBoolean(source.annotationPrefixFound)) invalid("RepositoryFactMarkers", "annotationPrefixFound");
  return { importPrefixFound: source.importPrefixFound, annotationPrefixFound: source.annotationPrefixFound };
}

export function validateFileBundleArray(value: unknown): JavaFileBundle[] {
  const context = "JavaFileBundle[]";
  return array(value, context).map((entry, index) => validateJavaFileBundle(entry, `${context}[${index}]`));
}

const INDEXED_READ_RANGE_KINDS = ["method", "type", "xml-statement", "xml-resultMap", "fallback"] as const;

function validateIndexedReadRange(value: unknown, context: string): IndexedReadRange {
  const source = record(value, context);
  if (!isNumber(source.startLine) || !isNumber(source.endLine) || source.startLine < 1 || source.endLine < source.startLine) {
    invalid(context, "expected an inclusive positive line range");
  }
  if (!isOneOf(source.kind, INDEXED_READ_RANGE_KINDS)) invalid(context, "kind");
  const range = validateSourceRange(source.range, `${context}.range`);
  if (!validCanonicalSourceRange(range)) {
    invalid(context, "range must use positive integer 1-based coordinates with an exclusive end");
  }
  const kinds = optional(source.kinds, `${context}.kinds`, (item, itemContext) =>
    array(item, itemContext).map((kind, index) => {
      if (!isOneOf(kind, INDEXED_READ_RANGE_KINDS)) invalid(`${itemContext}[${index}]`, "kind");
      return kind;
    }));
  if (!isNumber(source.estimatedBytes) || source.estimatedBytes < 0) invalid(context, "estimatedBytes");
  return {
    startLine: source.startLine,
    endLine: source.endLine,
    range,
    kind: source.kind,
    ...withOptional("kinds", kinds),
    estimatedBytes: source.estimatedBytes
  };
}

function validCanonicalSourceRange(range: SourceRange): boolean {
  const positions = [range.start, range.end];
  if (!positions.every(position => Number.isInteger(position.line)
    && Number.isInteger(position.column)
    && position.line >= 1
    && position.column >= 1)) return false;
  return range.start.line < range.end.line
    || (range.start.line === range.end.line && range.start.column < range.end.column);
}

export function validateIndexedReadRangeResults(value: unknown): IndexedReadRangeResult[] {
  return array(value, "IndexedReadRangeResult[]").map((entry, index) => {
    const context = `IndexedReadRangeResult[${index}]`;
    const source = record(entry, context);
    if (!isString(source.file)) invalid(context, "file");
    const extremeMethod = optional(source.extremeMethod, `${context}.extremeMethod`, (item, itemContext) => {
      if (!isBoolean(item)) invalid(itemContext, "expected boolean");
      return item;
    });
    return {
      file: source.file,
      ranges: array(source.ranges, `${context}.ranges`).map((range, rangeIndex) =>
        validateIndexedReadRange(range, `${context}.ranges[${rangeIndex}]`)),
      ...withOptional("extremeMethod", extremeMethod)
    };
  });
}

const MYBATIS_STATEMENT_KINDS = ["select", "insert", "update", "delete"] as const satisfies readonly MyBatisStatementKind[];

function validateMyBatisStatementFact(value: unknown, context: string): MyBatisStatementFact {
  const source = record(value, context);
  if (!isString(source.statementId)) invalid(context, "statementId");
  if (!isString(source.namespace)) invalid(context, "namespace");
  if (!isString(source.id)) invalid(context, "id");
  if (!isOneOf(source.kind, MYBATIS_STATEMENT_KINDS)) invalid(context, "kind");
  return {
    statementId: source.statementId,
    namespace: source.namespace,
    id: source.id,
    kind: source.kind,
    ...withOptional("parameterType", optional(source.parameterType, `${context}.parameterType`, v => isString(v) ? v : invalid(context, "parameterType"))),
    ...withOptional("resultType", optional(source.resultType, `${context}.resultType`, v => isString(v) ? v : invalid(context, "resultType"))),
    ...withOptional("resultMap", optional(source.resultMap, `${context}.resultMap`, v => isString(v) ? v : invalid(context, "resultMap"))),
    ...withOptional("range", optional(source.range, `${context}.range`, validateSourceRange))
  };
}

function validateMyBatisResultMapFact(value: unknown, context: string): MyBatisResultMapFact {
  const source = record(value, context);
  if (!isString(source.resultMapId)) invalid(context, "resultMapId");
  if (!isString(source.namespace)) invalid(context, "namespace");
  if (!isString(source.id)) invalid(context, "id");
  return {
    resultMapId: source.resultMapId,
    namespace: source.namespace,
    id: source.id,
    ...withOptional("type", optional(source.type, `${context}.type`, v => isString(v) ? v : invalid(context, "type"))),
    ...withOptional("range", optional(source.range, `${context}.range`, validateSourceRange))
  };
}

export function validateMyBatisMapperResourceFacts(value: unknown): MyBatisMapperResourceFacts | undefined {
  if (value === undefined || value === null) return undefined;
  const context = "MyBatisMapperResourceFacts";
  const source = record(value, context);
  if (!isString(source.resourceId)) invalid(context, "resourceId");
  if (!isString(source.relativePath)) invalid(context, "relativePath");
  if (!isString(source.namespace)) invalid(context, "namespace");
  if (!isString(source.contentHash)) invalid(context, "contentHash");
  if (!isNumber(source.generation)) invalid(context, "generation");
  if (!isOneOf(source.parseState, ["COMPLETE", "FAILED"] as const)) invalid(context, "parseState");
  const statements = array(source.statements, `${context}.statements`)
    .map((entry, index) => validateMyBatisStatementFact(entry, `${context}.statements[${index}]`));
  const resultMaps = array(source.resultMaps, `${context}.resultMaps`)
    .map((entry, index) => validateMyBatisResultMapFact(entry, `${context}.resultMaps[${index}]`));
  const includes = array(source.includes, `${context}.includes`).map((entry, index) => {
    const includeSource = record(entry, `${context}.includes[${index}]`);
    if (!isString(includeSource.fromStatementId)) invalid(`${context}.includes[${index}]`, "fromStatementId");
    if (!isString(includeSource.refid)) invalid(`${context}.includes[${index}]`, "refid");
    return { fromStatementId: includeSource.fromStatementId, refid: includeSource.refid };
  });
  return {
    resourceId: source.resourceId,
    relativePath: source.relativePath,
    namespace: source.namespace,
    statements,
    resultMaps,
    includes,
    contentHash: source.contentHash,
    generation: source.generation,
    parseState: source.parseState
  };
}

export type MyBatisResourceByNamespaceBatch = Array<{ namespace: string; resource?: MyBatisMapperResourceFacts }>;

export function validateMyBatisResourceByNamespaceBatch(value: unknown): MyBatisResourceByNamespaceBatch {
  return array(value, "MyBatisResourceByNamespaceBatch").map((entry, index) => {
    const context = `MyBatisResourceByNamespaceBatch[${index}]`;
    const source = record(entry, context);
    if (!isString(source.namespace)) invalid(context, "namespace");
    const resource = validateMyBatisMapperResourceFacts(source.resource);
    return resource ? { namespace: source.namespace, resource } : { namespace: source.namespace };
  });
}
