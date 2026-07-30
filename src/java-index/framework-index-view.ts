// input: JavaFileBundle (raw facts + static edges) from JavaIndexClient.queryFiles.
// output: Plain-data, framework-agnostic declaration projection with resolved
//         annotation/type FQNs joined in, for adapter packs (Task 27 Slice C/D)
//         to read without touching JavaFileBundle/JavaTypeRef/StaticEdge directly.
// pos: Task 27 Slice B - deliberately has no framework-specific vocabulary
//      (no "spring" anywhere): that belongs to the adapter packs this feeds.
import type { SourceRange } from "../runtime/source-range.js";
import type {
  IndexedReference,
  JavaAnnotationFact,
  JavaCallSiteKind,
  JavaFileBundle,
  JavaSourceSet,
  JavaTypeKind,
  JavaTypeRef,
  StaticEdge,
  TypeResolutionStrategy
} from "./index-types.js";
import { javaParameterId } from "./stable-id.js";

export type FrameworkAnnotation = {
  name: string;
  /**
   * Only set when the name resolved to a RESOLVED_REPO or EXTERNAL target -
   * an ambiguous or unimported annotation has no resolvedFqn and must not be
   * treated as an exact signal by a consumer (per the resolver's existing
   * "no guessing" contract, reused unchanged from Task 17/18 here).
   */
  resolvedFqn?: string;
  argumentsText?: string;
};

export type FrameworkTypeRef = {
  text: string;
  resolvedFqn?: string;
  /** Only set alongside resolvedFqn - a QUALIFIED/EXPLICIT_IMPORT/SAME_PACKAGE/ENCLOSING_TYPE/JAVA_LANG resolution is high-confidence; WILDCARD_IMPORT/REPO_UNIQUE_SIMPLE_NAME is a fallback strategy a consumer may want to discount. */
  strategy?: TypeResolutionStrategy;
};

export type FrameworkParameter = {
  name: string;
  type: FrameworkTypeRef;
  varargs: boolean;
  annotations: FrameworkAnnotation[];
};

export type FrameworkCallSite = {
  kind: JavaCallSiteKind;
  name: string;
  arity: number;
  /** Aligned by index with the call's argument list - see JavaCallSiteFact.argumentTypeHints. */
  argumentTypeHints: FrameworkTypeRef[];
};

export type FrameworkMethodDeclaration = {
  methodId: string;
  ownerTypeId: string;
  /** Repo-relative path of the file this method is declared in - declarationsById's point lookups (e.g. resolvedCallees' targets) have no other way to name the file an EvidenceSignal.candidateFile must point at. */
  relativePath: string;
  name: string;
  constructor: boolean;
  annotations: FrameworkAnnotation[];
  parameters: FrameworkParameter[];
  /** Absent for void methods and constructors - mirrors JavaMethodFacts.returnType's own "no entry for void" convention, so a caller can gate on presence alone. */
  returnType?: FrameworkTypeRef;
  callSites: FrameworkCallSite[];
};

export type FrameworkFieldDeclaration = {
  fieldId: string;
  ownerTypeId: string;
  relativePath: string;
  name: string;
  type: FrameworkTypeRef;
  annotations: FrameworkAnnotation[];
};

export type FrameworkTypeDeclaration = {
  typeId: string;
  fqn?: string;
  relativePath: string;
  simpleName: string;
  kind: JavaTypeKind;
  annotations: FrameworkAnnotation[];
  methodIds: string[];
  fieldIds: string[];
};

export type FrameworkDeclarations = {
  types: FrameworkTypeDeclaration[];
  methods: FrameworkMethodDeclaration[];
  fields: FrameworkFieldDeclaration[];
  /** Ids that were requested but could not be resolved to a declaration. Always empty for frameworkFactsFor's whole-file result. */
  missingIds: string[];
  /**
   * True when declarationsById was asked for more ids than
   * MAX_DECLARATION_IDS allows and the excess were never looked up at all -
   * distinct from missingIds, which means "looked up, not found". Always
   * false for frameworkFactsFor's whole-file result (nothing was capped).
   */
  truncated: boolean;
};

export type FrameworkFileFacts = FrameworkDeclarations & {
  relativePath: string;
  module: string;
  sourceSet: JavaSourceSet;
  /**
   * COMPLETE for a clean parse, PARTIAL for a recovered one, DEGRADED when
   * no facts could be trusted. Derived from this file's own parseState only
   * - it does NOT detect a sibling-worktree-seeded RELINK_ONLY window
   * (index-store.ts's dropOwnedEdges), where this file's own facts parsed
   * cleanly but its cross-file ANNOTATED_WITH edges were dropped pending
   * re-resolution, so every annotation here would join to no edge and look
   * indistinguishable from "genuinely has no resolvable annotation". A
   * caller that needs to trust an absence (not just use a presence) must
   * additionally check the request-level FrameworkIndexStatus.coverage
   * (RouterIndexStatus.coverage's existing root-generation invalidation
   * already covers this window) rather than relying on this field alone.
   */
  coverage: "COMPLETE" | "PARTIAL" | "DEGRADED";
};

export type FrameworkCallees = {
  callees: IndexedReference[];
  /** True when index-store.ts's callees() cap (80) may have hidden further callees - a caller relying on uniqueness (e.g. "exactly one resolved call target") must not trust a positive result when this is true. */
  truncated: boolean;
};

export type FrameworkIndexStatus = {
  coverage: "complete" | "partial" | "degraded";
};

/**
 * Bounded, read-only, framework-agnostic view over JavaIndex facts. Adapter
 * packs (Slice D) read through this instead of RouterIndex/JavaIndexClient
 * directly, so they never see worker/snapshot internals and never issue an
 * unbounded query.
 */
export interface FrameworkIndexView {
  frameworkFactsFor(file: string, generation?: number): Promise<FrameworkFileFacts>;
  declarationsById(ids: readonly string[]): Promise<FrameworkDeclarations>;
  resolvedCallees(methodId: string, limit?: number): Promise<FrameworkCallees>;
  repositoryMarkers(relativePaths: readonly string[]): Promise<Map<string, string>>;
  frameworkStatus(): Promise<FrameworkIndexStatus>;
}

export const CALLEES_LIMIT_DEFAULT = 80;

/** The owning type id embedded in a "type:"/"type-local:" id (itself) or a "field:"/"method:" id (the prefix before its first "#"). undefined for anything else (e.g. a parameter id - declarationsById does not resolve those; parameters are reached via their owning method). */
export function ownerTypeIdOf(id: string): string | undefined {
  if (id.startsWith("type:") || id.startsWith("type-local:")) return id;
  for (const prefix of ["field:", "method:"]) {
    if (!id.startsWith(prefix)) continue;
    const hashIndex = id.indexOf("#");
    if (hashIndex === -1) return undefined;
    // A parameter id (method:<owner>#<sig>#p<N>, see javaParameterId) has a
    // second "#" after the owner/member split - reject rather than resolve
    // to the enclosing method's owner type, since declarationsById only
    // hydrates types/methods/fields, not standalone parameters.
    if (id.indexOf("#", hashIndex + 1) !== -1) return undefined;
    return id.slice(prefix.length, hashIndex);
  }
  return undefined;
}

const TYPE_LOCAL_PATTERN = /^type-local:(.+):(\d+):(\d+)$/;

/** The repo-relative path embedded in a "type-local:<path>:<line>:<col>" id, or undefined for a "type:<fqn>" id (which carries no path - callers resolve those via a name lookup instead). */
export function relativePathOfLocalTypeId(typeId: string): string | undefined {
  const match = TYPE_LOCAL_PATTERN.exec(typeId);
  return match ? match[1] : undefined;
}

/** The bare fqn embedded in a "type:<fqn>" id, or undefined for a "type-local:..." id. */
export function fqnOfTypeId(typeId: string): string | undefined {
  return typeId.startsWith("type:") ? typeId.slice("type:".length) : undefined;
}

function resolvedFqnOfRef(ref: JavaTypeRef): string | undefined {
  if (ref.resolution.state === "EXTERNAL") return ref.resolution.qualifiedName;
  if (ref.resolution.state === "RESOLVED_REPO") return fqnOfTypeId(ref.resolution.typeId);
  return undefined;
}

function strategyOfRef(ref: JavaTypeRef): TypeResolutionStrategy | undefined {
  if (ref.resolution.state === "EXTERNAL" || ref.resolution.state === "RESOLVED_REPO") return ref.resolution.strategy;
  return undefined;
}

function toFrameworkTypeRef(ref: JavaTypeRef): FrameworkTypeRef {
  const resolvedFqn = resolvedFqnOfRef(ref);
  const strategy = strategyOfRef(ref);
  return { text: ref.text, ...(resolvedFqn ? { resolvedFqn } : {}), ...(strategy ? { strategy } : {}) };
}

/** external:<fqn> / type:<fqn> edge targets both resolve to a plain fqn string here - type-local: targets (an annotation type that is itself a local/anonymous declaration) are left unresolved rather than guessed, consistent with the resolver's existing contract. */
function resolvedFqnOfAnnotatedWithTarget(toId: string): string | undefined {
  if (toId.startsWith("external:")) return toId.slice("external:".length);
  return fqnOfTypeId(toId);
}

function rangesEqual(left: SourceRange | undefined, right: SourceRange): boolean {
  return left !== undefined
    && left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.line === right.end.line
    && left.end.column === right.end.column;
}

function toFrameworkAnnotations(
  ownerId: string,
  annotations: readonly JavaAnnotationFact[],
  annotatedWithByFromId: ReadonlyMap<string, StaticEdge[]>
): FrameworkAnnotation[] {
  const edges = annotatedWithByFromId.get(ownerId) ?? [];
  // annotationEdges() pushes at most one ANNOTATED_WITH edge per annotation,
  // skipping unresolvable ones entirely (Task 17/18's "no guessing"
  // contract) - so edge count can be less than annotation count, and a
  // positional index into `edges` would misalign after the first skip. Match
  // by range instead: both sides retain the same annotation AST node's range.
  return annotations.map(annotation => {
    const edge = edges.find(e => rangesEqual(e.range, annotation.range));
    return {
      name: annotation.name,
      ...(edge ? { resolvedFqn: resolvedFqnOfAnnotatedWithTarget(edge.toId) } : {}),
      ...(annotation.argumentsText ? { argumentsText: annotation.argumentsText } : {})
    };
  });
}

function annotatedWithEdgesByFromId(edges: readonly StaticEdge[]): Map<string, StaticEdge[]> {
  const byFromId = new Map<string, StaticEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== "ANNOTATED_WITH") continue;
    const list = byFromId.get(edge.fromId);
    if (list) list.push(edge);
    else byFromId.set(edge.fromId, [edge]);
  }
  return byFromId;
}

/** COMPLETE for a clean parse, PARTIAL for a recovered one (some facts may be missing/wrong), DEGRADED when nothing in this file's facts can be trusted. */
function coverageOfParseState(parseState: "COMPLETE" | "RECOVERED" | "FAILED"): "COMPLETE" | "PARTIAL" | "DEGRADED" {
  if (parseState === "COMPLETE") return "COMPLETE";
  if (parseState === "RECOVERED") return "PARTIAL";
  return "DEGRADED";
}

/**
 * Projects one file's raw bundle into the plain-data declaration shape
 * adapter packs read. Pure and total: every type/method/field in the bundle
 * is included, `missingIds` is always empty (nothing was "requested").
 */
export function bundleToFrameworkFileFacts(bundle: JavaFileBundle): FrameworkFileFacts {
  const declarations = bundleToDeclarations(bundle);
  return {
    ...declarations,
    relativePath: bundle.file.relativePath,
    module: bundle.file.module,
    sourceSet: bundle.file.sourceSet,
    coverage: coverageOfParseState(bundle.file.parseState)
  };
}

/**
 * Same projection as bundleToFrameworkFileFacts, but filtered down to just
 * the requested ids (declarationsById's contract: return exactly what was
 * asked for, not every declaration in whichever files happened to be
 * fetched to answer the request). ids not found in any of the given bundles
 * are reported in missingIds instead of silently omitted.
 */
export function bundlesToRequestedDeclarations(
  bundles: readonly JavaFileBundle[],
  requestedIds: readonly string[]
): FrameworkDeclarations {
  const typesById = new Map<string, FrameworkTypeDeclaration>();
  const methodsById = new Map<string, FrameworkMethodDeclaration>();
  const fieldsById = new Map<string, FrameworkFieldDeclaration>();
  for (const bundle of bundles) {
    const declarations = bundleToDeclarations(bundle);
    for (const type of declarations.types) typesById.set(type.typeId, type);
    for (const method of declarations.methods) methodsById.set(method.methodId, method);
    for (const field of declarations.fields) fieldsById.set(field.fieldId, field);
  }
  const types: FrameworkTypeDeclaration[] = [];
  const methods: FrameworkMethodDeclaration[] = [];
  const fields: FrameworkFieldDeclaration[] = [];
  const missingIds: string[] = [];
  for (const id of requestedIds) {
    const type = typesById.get(id);
    if (type) { types.push(type); continue; }
    const method = methodsById.get(id);
    if (method) { methods.push(method); continue; }
    const field = fieldsById.get(id);
    if (field) { fields.push(field); continue; }
    missingIds.push(id);
  }
  return { types, methods, fields, missingIds, truncated: false };
}

function bundleToDeclarations(bundle: JavaFileBundle): FrameworkDeclarations {
  const relativePath = bundle.file.relativePath;
  const annotatedWithByFromId = annotatedWithEdgesByFromId(bundle.edges);
  return {
    types: bundle.types.map(type => ({
      typeId: type.typeId,
      ...(type.fqn ? { fqn: type.fqn } : {}),
      relativePath,
      simpleName: type.simpleName,
      kind: type.kind,
      annotations: toFrameworkAnnotations(type.typeId, type.annotations, annotatedWithByFromId),
      methodIds: type.methodIds,
      fieldIds: type.fieldIds
    })),
    fields: bundle.fields.map(field => ({
      fieldId: field.fieldId,
      ownerTypeId: field.ownerTypeId,
      relativePath,
      name: field.name,
      type: toFrameworkTypeRef(field.type),
      annotations: toFrameworkAnnotations(field.fieldId, field.annotations, annotatedWithByFromId)
    })),
    methods: bundle.methods.map(method => ({
      methodId: method.methodId,
      ownerTypeId: method.ownerTypeId,
      relativePath,
      name: method.name,
      constructor: method.constructor,
      annotations: toFrameworkAnnotations(method.methodId, method.annotations, annotatedWithByFromId),
      ...(method.returnType ? { returnType: toFrameworkTypeRef(method.returnType) } : {}),
      parameters: method.parameters.map((param, index) => ({
        name: param.name,
        type: toFrameworkTypeRef(param.type),
        varargs: param.varargs,
        annotations: toFrameworkAnnotations(
          javaParameterId(method.methodId, index),
          param.annotations,
          annotatedWithByFromId
        )
      })),
      callSites: method.callSites.map(callSite => ({
        kind: callSite.kind,
        name: callSite.name,
        arity: callSite.arity,
        argumentTypeHints: callSite.argumentTypeHints.map(toFrameworkTypeRef)
      }))
    })),
    missingIds: [],
    truncated: false
  };
}
