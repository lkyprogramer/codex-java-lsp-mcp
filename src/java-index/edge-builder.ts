import type { ExtractedJavaFile } from "./ast-extractor.js";
import type {
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeRef,
  StaticEdge,
  StaticEdgeKind,
  StaticEdgeResolutionKind,
  TypeResolutionStrategy
} from "./index-types.js";
import type { SourceRange } from "../runtime/source-range.js";
import { javaEdgeId } from "./stable-id.js";
import { JavaNameResolver, type JavaResolutionContext, type TypeRegistryView } from "./name-resolver.js";

// Confidence keys on strategy name, not resolution state - EXTERNAL/QUALIFIED
// and RESOLVED_REPO/QUALIFIED both read the same QUALIFIED entry. JAVA_LANG
// is only ever reached via EXTERNAL, kept in the same table for one lookup.
const STRATEGY_CONFIDENCE: Record<TypeResolutionStrategy, number> = {
  QUALIFIED: 0.98,
  EXPLICIT_IMPORT: 0.98,
  SAME_PACKAGE: 0.98,
  ENCLOSING_TYPE: 0.98,
  JAVA_LANG: 0.98,
  WILDCARD_IMPORT: 0.82,
  REPO_UNIQUE_SIMPLE_NAME: 0.75
};

// Outermost-first ancestor chain via enclosingTypeId, matching
// JavaResolutionContext.enclosingTypeIds' documented ordering.
function ancestorChain(startTypeId: string | undefined, byId: ReadonlyMap<string, JavaTypeFacts>): string[] {
  const chain: string[] = [];
  let current = startTypeId;
  while (current) {
    chain.push(current);
    current = byId.get(current)?.enclosingTypeId;
  }
  return chain.reverse();
}

function baseContext(bundle: ExtractedJavaFile, enclosingTypeIds: string[], typeParameterNames: ReadonlySet<string>): JavaResolutionContext {
  return {
    packageName: bundle.file.packageName,
    imports: bundle.file.imports,
    enclosingTypeIds,
    typeParameterNames
  };
}

// A type's own extends/implements/permits/annotations are declared before
// the type pushes itself onto ast-extractor's enclosing stack (see
// extractType), so they resolve against the *parent* chain, not including
// the type itself; members (fields/methods/nested refs) resolve including it.
function ownScopeContext(bundle: ExtractedJavaFile, type: JavaTypeFacts, byId: ReadonlyMap<string, JavaTypeFacts>): JavaResolutionContext {
  return baseContext(bundle, ancestorChain(type.enclosingTypeId, byId), new Set(type.typeParameters.map(p => p.name)));
}

function memberScopeContext(bundle: ExtractedJavaFile, type: JavaTypeFacts, byId: ReadonlyMap<string, JavaTypeFacts>): JavaResolutionContext {
  return baseContext(bundle, ancestorChain(type.typeId, byId), new Set(type.typeParameters.map(p => p.name)));
}

function withMethodTypeParameters(context: JavaResolutionContext, method: JavaMethodFacts): JavaResolutionContext {
  if (method.typeParameters.length === 0) return context;
  return {
    ...context,
    typeParameterNames: new Set([...context.typeParameterNames, ...method.typeParameters.map(p => p.name)])
  };
}

// Resolves every JavaTypeRef-bearing fact in a file against the repo-wide
// registry. Must run before buildStaticEdges, which consumes already
// resolved facts and does no resolution of its own (aside from names that
// were never stored as a JavaTypeRef in the first place: annotations and
// constructor/method-reference type names, resolved on the fly there).
// Precondition: `registry` must already include `bundle`'s own types (both
// real call sites build the registry from the full file set, this bundle
// included) - ancestorChain walks registry.byId directly rather than
// merging in a redundant copy of the bundle's own types.
export function resolveFileRefs(
  bundle: ExtractedJavaFile,
  resolver: JavaNameResolver,
  registry: TypeRegistryView
): ExtractedJavaFile {
  const typesById = new Map(bundle.types.map(t => [t.typeId, t]));

  const resolvedTypes = bundle.types.map(type => {
    const ctx = ownScopeContext(bundle, type, registry.byId);
    return {
      ...type,
      extends: type.extends.map(ref => resolver.resolveTypeRef(ref, ctx)),
      implements: type.implements.map(ref => resolver.resolveTypeRef(ref, ctx)),
      permits: type.permits.map(ref => resolver.resolveTypeRef(ref, ctx))
    };
  });

  const resolvedFields = bundle.fields.map(field => {
    const owner = typesById.get(field.ownerTypeId);
    const ctx = owner ? memberScopeContext(bundle, owner, registry.byId) : baseContext(bundle, [], new Set());
    return { ...field, type: resolver.resolveTypeRef(field.type, ctx) };
  });

  const resolvedMethods = bundle.methods.map(method => {
    const owner = typesById.get(method.ownerTypeId);
    const ownerCtx = owner ? memberScopeContext(bundle, owner, registry.byId) : baseContext(bundle, [], new Set());
    const ctx = withMethodTypeParameters(ownerCtx, method);
    return {
      ...method,
      ...(method.returnType ? { returnType: resolver.resolveTypeRef(method.returnType, ctx) } : {}),
      parameters: method.parameters.map(p => ({ ...p, type: resolver.resolveTypeRef(p.type, ctx) })),
      throws: method.throws.map(ref => resolver.resolveTypeRef(ref, ctx)),
      localTypes: method.localTypes.map(ref => resolver.resolveTypeRef(ref, ctx)),
      callSites: method.callSites.map(callSite => ({
        ...callSite,
        ...(callSite.receiverDeclaredType
          ? { receiverDeclaredType: resolver.resolveTypeRef(callSite.receiverDeclaredType, ctx) }
          : {}),
        argumentTypeHints: callSite.argumentTypeHints.map(ref => resolver.resolveTypeRef(ref, ctx))
      }))
    };
  });

  return { file: bundle.file, types: resolvedTypes, fields: resolvedFields, methods: resolvedMethods };
}

type EdgeTarget = { toId: string; confidence: number; typeStrategy: TypeResolutionStrategy };

// The single AMBIGUOUS/UNRESOLVED guard: per architecture V3 §9.8, "any
// AMBIGUOUS result produces no exact static edge", and the same applies to
// UNRESOLVED/TYPE_VARIABLE (no target to point an edge at). EXTERNAL still
// produces an edge, to a non-repo "external:" node - useful for
// annotation/framework metadata even though it is never a readPlan
// candidate (architecture V3 §9.8).
function repoEdgeTarget(ref: JavaTypeRef): EdgeTarget | undefined {
  if (ref.resolution.state === "RESOLVED_REPO") {
    return { toId: ref.resolution.typeId, confidence: STRATEGY_CONFIDENCE[ref.resolution.strategy], typeStrategy: ref.resolution.strategy };
  }
  if (ref.resolution.state === "EXTERNAL") {
    return {
      toId: `external:${ref.resolution.qualifiedName}`,
      confidence: STRATEGY_CONFIDENCE[ref.resolution.strategy],
      typeStrategy: ref.resolution.strategy
    };
  }
  return undefined;
}

function arityOf(method: JavaMethodFacts): number {
  return method.parameters.length;
}

// Walks extends/implements (only RESOLVED_REPO links; EXTERNAL/AMBIGUOUS
// supertypes terminate that branch) depth-first, closest ancestor first.
// `visited` is shared across the whole walk (not per-branch) both to guard
// against a cycle in a partially-indexed repo and to skip re-examining a
// supertype reached via a second path (e.g. a diamond, D implements X, Y,
// both extending Base) - since Base's candidate set for a given name+arity
// is the same regardless of which branch reached it first, re-checking it
// via the other branch can only repeat work, never change the answer.
function walkSuperChain(
  type: JavaTypeFacts,
  name: string,
  arity: number,
  registry: TypeRegistryView,
  visited: Set<string>
): { method: JavaMethodFacts; typeStrategy: TypeResolutionStrategy } | undefined {
  for (const ref of [...type.extends, ...type.implements]) {
    if (ref.resolution.state !== "RESOLVED_REPO") continue;
    const superTypeId = ref.resolution.typeId;
    if (visited.has(superTypeId)) continue;
    visited.add(superTypeId);

    const candidates = (registry.methodsByOwnerTypeId.get(superTypeId) ?? []).filter(
      m => m.name === name && arityOf(m) === arity
    );
    if (candidates.length === 1) {
      return { method: candidates[0]!, typeStrategy: ref.resolution.strategy };
    }
    if (candidates.length > 1) continue; // ambiguous at this level; do not pick arbitrarily, do not descend further on this branch

    const superType = registry.byId.get(superTypeId);
    if (superType) {
      const deeper = walkSuperChain(superType, name, arity, registry, visited);
      if (deeper) return deeper;
    }
  }
  return undefined;
}

type CallEdgeResolution = {
  toId: string;
  kind: Extract<StaticEdgeKind, "CALLS" | "CONSTRUCTS" | "METHOD_REFERENCE">;
  confidence: number;
  resolutionKind: StaticEdgeResolutionKind;
  typeStrategy?: TypeResolutionStrategy;
};

function resolveCallSite(
  callSite: JavaMethodFacts["callSites"][number],
  method: JavaMethodFacts,
  methodContext: JavaResolutionContext,
  registry: TypeRegistryView,
  resolver: JavaNameResolver
): CallEdgeResolution | undefined {
  if (callSite.kind === "CONSTRUCTOR_INVOCATION") {
    const target = repoEdgeTarget(resolver.resolveTypeText(callSite.name, methodContext));
    if (!target) return undefined;
    return { toId: target.toId, kind: "CONSTRUCTS", confidence: target.confidence, resolutionKind: "CONSTRUCTOR_TYPE", typeStrategy: target.typeStrategy };
  }

  if (callSite.kind === "METHOD_REFERENCE") {
    // `this`/`super`/explicit-type-name receivers are unresolved at the
    // AST-extraction layer (Task 16 scope); without a receiver type there is
    // no owner to look the method up on.
    if (!callSite.receiverDeclaredType || callSite.receiverDeclaredType.resolution.state !== "RESOLVED_REPO") return undefined;
    const ownerTypeId = callSite.receiverDeclaredType.resolution.typeId;
    const ownerStrategy = callSite.receiverDeclaredType.resolution.strategy;
    const candidates = (registry.methodsByOwnerTypeId.get(ownerTypeId) ?? []).filter(m => m.name === callSite.name);
    if (candidates.length !== 1) return undefined;
    return {
      toId: candidates[0]!.methodId,
      kind: "METHOD_REFERENCE",
      confidence: STRATEGY_CONFIDENCE[ownerStrategy] * 0.9,
      resolutionKind: "METHOD_REFERENCE_OWNER",
      typeStrategy: ownerStrategy
    };
  }

  // METHOD_INVOCATION
  if (callSite.receiverDeclaredType) {
    if (callSite.receiverDeclaredType.resolution.state !== "RESOLVED_REPO") return undefined;
    const ownerTypeId = callSite.receiverDeclaredType.resolution.typeId;
    const ownerStrategy = callSite.receiverDeclaredType.resolution.strategy;
    const candidates = (registry.methodsByOwnerTypeId.get(ownerTypeId) ?? []).filter(
      m => m.name === callSite.name && arityOf(m) === callSite.arity
    );
    if (candidates.length !== 1) return undefined;
    const receiverConfidence = STRATEGY_CONFIDENCE[ownerStrategy];
    // A cleanly resolved receiver (explicit import/same package/enclosing/
    // qualified/java.lang) yields the flat "unique receiver declared type
    // call" confidence; a receiver only found via a wildcard-import or
    // repo-unique-simple-name fallback carries that lower confidence
    // through instead, per architecture V3 Task 18 Step 5's
    // "wildcard/global-fallback receiver: resolution confidence x 0.90".
    const confidence = ownerStrategy === "WILDCARD_IMPORT" || ownerStrategy === "REPO_UNIQUE_SIMPLE_NAME"
      ? receiverConfidence * 0.9
      : 0.9;
    return { toId: candidates[0]!.methodId, kind: "CALLS", confidence, resolutionKind: "DECLARED_RECEIVER_NAME_ARITY", typeStrategy: ownerStrategy };
  }

  // Unqualified call: same owner first, per architecture's priority order.
  const sameOwnerCandidates = (registry.methodsByOwnerTypeId.get(method.ownerTypeId) ?? []).filter(
    m => m.name === callSite.name && arityOf(m) === callSite.arity
  );
  if (sameOwnerCandidates.length === 1) {
    return { toId: sameOwnerCandidates[0]!.methodId, kind: "CALLS", confidence: 0.92, resolutionKind: "SAME_OWNER_NAME_ARITY" };
  }
  if (sameOwnerCandidates.length > 1) return undefined; // ambiguous overload in the same owner - never pick arbitrarily

  const ownerType = registry.byId.get(method.ownerTypeId);
  if (!ownerType) return undefined;
  const superMatch = walkSuperChain(ownerType, callSite.name, callSite.arity, registry, new Set([method.ownerTypeId]));
  if (!superMatch) return undefined;
  return {
    toId: superMatch.method.methodId,
    kind: "CALLS",
    confidence: 0.85,
    resolutionKind: "SUPER_CHAIN_NAME_ARITY",
    typeStrategy: superMatch.typeStrategy
  };
}

// Precondition: `registry` must already include `bundle`'s own types (same
// contract as resolveFileRefs - both real call sites build the registry from
// the full file set, this bundle included).
export function buildStaticEdges(
  bundle: ExtractedJavaFile,
  registry: TypeRegistryView,
  resolver: JavaNameResolver
): StaticEdge[] {
  const edges: StaticEdge[] = [];
  const sourceFile = bundle.file.relativePath;
  const generation = bundle.file.generation;
  const typesById = new Map(bundle.types.map(t => [t.typeId, t]));

  function pushEdge(
    fromId: string,
    toId: string,
    kind: StaticEdgeKind,
    confidence: number,
    range: SourceRange | undefined,
    resolutionKind: StaticEdgeResolutionKind,
    typeStrategy?: TypeResolutionStrategy
  ): void {
    edges.push({
      edgeId: javaEdgeId({ kind, fromId, toId, range }),
      fromId,
      toId,
      kind,
      confidence,
      ...(range ? { range } : {}),
      sourceFile,
      generation,
      resolution: { kind: resolutionKind, ...(typeStrategy ? { typeStrategy } : {}) }
    });
  }

  function annotationEdges(fromId: string, annotations: JavaTypeFacts["annotations"], context: JavaResolutionContext): void {
    for (const annotation of annotations) {
      const ref = resolver.resolveTypeText(annotation.qualifiedName ?? annotation.name, context);
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(fromId, target.toId, "ANNOTATED_WITH", target.confidence, annotation.range, "TYPE_REFERENCE", target.typeStrategy);
    }
  }

  for (const type of bundle.types) {
    const ownCtx = ownScopeContext(bundle, type, registry.byId);
    for (const ref of type.extends) {
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(type.typeId, target.toId, "EXTENDS", target.confidence, ref.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    for (const ref of type.implements) {
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(type.typeId, target.toId, "IMPLEMENTS", target.confidence, ref.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    for (const ref of type.permits) {
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(type.typeId, target.toId, "PERMITS", target.confidence, ref.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    annotationEdges(type.typeId, type.annotations, ownCtx);
  }

  for (const imp of bundle.file.imports) {
    if (imp.wildcard || imp.static) continue; // not a single-type reference
    const target = repoEdgeTarget(
      resolver.resolveTypeText(imp.qualifiedName, baseContext(bundle, [], new Set()))
    );
    if (target) pushEdge(bundle.file.fileId, target.toId, "IMPORTS", target.confidence, imp.range, "AST_EXPLICIT", target.typeStrategy);
  }

  for (const field of bundle.fields) {
    const target = repoEdgeTarget(field.type);
    if (target) pushEdge(field.fieldId, target.toId, "FIELD_TYPE", target.confidence, field.type.range, "TYPE_REFERENCE", target.typeStrategy);
    const owner = typesById.get(field.ownerTypeId);
    const ctx = owner ? memberScopeContext(bundle, owner, registry.byId) : baseContext(bundle, [], new Set());
    annotationEdges(field.fieldId, field.annotations, ctx);
  }

  for (const method of bundle.methods) {
    const owner = typesById.get(method.ownerTypeId);
    const ownerCtx = owner ? memberScopeContext(bundle, owner, registry.byId) : baseContext(bundle, [], new Set());
    const methodCtx = withMethodTypeParameters(ownerCtx, method);

    if (method.returnType) {
      const target = repoEdgeTarget(method.returnType);
      if (target) pushEdge(method.methodId, target.toId, "RETURN_TYPE", target.confidence, method.returnType.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    for (const param of method.parameters) {
      const target = repoEdgeTarget(param.type);
      if (target) pushEdge(method.methodId, target.toId, "PARAM_TYPE", target.confidence, param.type.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    for (const ref of method.throws) {
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(method.methodId, target.toId, "THROWS_TYPE", target.confidence, ref.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    for (const ref of method.localTypes) {
      const target = repoEdgeTarget(ref);
      if (target) pushEdge(method.methodId, target.toId, "LOCAL_TYPE", target.confidence, ref.range, "TYPE_REFERENCE", target.typeStrategy);
    }
    annotationEdges(method.methodId, method.annotations, methodCtx);

    for (const callSite of method.callSites) {
      const resolved = resolveCallSite(callSite, method, methodCtx, registry, resolver);
      if (resolved) {
        pushEdge(method.methodId, resolved.toId, resolved.kind, resolved.confidence, callSite.range, resolved.resolutionKind, resolved.typeStrategy);
      }
    }
  }

  return edges;
}
