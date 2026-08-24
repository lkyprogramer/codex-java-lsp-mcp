import type { JavaImportFact, JavaMethodFacts, JavaTypeFacts, JavaTypeRef, TypeResolutionStrategy } from "./index-types.js";

export type TypeRegistryView = {
  byId: ReadonlyMap<string, JavaTypeFacts>;
  byFqn: ReadonlyMap<string, string>;
  bySimpleName: ReadonlyMap<string, ReadonlySet<string>>;
  nestedByOwnerAndSimpleName: ReadonlyMap<string, string>;
  // Populated for Task 18's bounded call resolution (same-owner/receiver/
  // super-chain method lookup by owner type); Task 17 itself never reads it.
  methodsByOwnerTypeId: { get(ownerTypeId: string): readonly JavaMethodFacts[] | undefined };
};

export function buildTypeRegistryView(
  types: readonly JavaTypeFacts[],
  methods: readonly JavaMethodFacts[] = [],
  methodsOfOwner?: (ownerTypeId: string) => readonly JavaMethodFacts[]
): TypeRegistryView {
  const byId = new Map<string, JavaTypeFacts>();
  const byFqn = new Map<string, string>();
  const bySimpleName = new Map<string, Set<string>>();
  const nestedByOwnerAndSimpleName = new Map<string, string>();

  for (const type of types) {
    byId.set(type.typeId, type);
    if (type.fqn) byFqn.set(type.fqn, type.typeId);

    const bucket = bySimpleName.get(type.simpleName);
    if (bucket) bucket.add(type.typeId);
    else bySimpleName.set(type.simpleName, new Set([type.typeId]));

    if (type.enclosingTypeId) {
      nestedByOwnerAndSimpleName.set(`${type.enclosingTypeId}#${type.simpleName}`, type.typeId);
    }
  }

  const methodsByOwnerTypeId = new Map<string, JavaMethodFacts[]>();
  if (!methodsOfOwner) {
    for (const method of methods) {
      const bucket = methodsByOwnerTypeId.get(method.ownerTypeId);
      if (bucket) bucket.push(method);
      else methodsByOwnerTypeId.set(method.ownerTypeId, [method]);
    }
  }

  return {
    byId,
    byFqn,
    bySimpleName,
    nestedByOwnerAndSimpleName,
    methodsByOwnerTypeId: methodsOfOwner
      ? { get(ownerTypeId: string) { const found = methodsOfOwner(ownerTypeId); return found.length === 0 ? undefined : found; } }
      : methodsByOwnerTypeId
  };
}

export type JavaResolutionContext = {
  packageName: string;
  imports: readonly JavaImportFact[];
  // Outermost first, innermost last - matches ast-extractor's `enclosing` stack.
  enclosingTypeIds: readonly string[];
  // Type-level and current-method-level type parameter names combined by the
  // caller; a method's own <T> must not leak into a sibling method's scope.
  typeParameterNames: ReadonlySet<string>;
};

type ResolveOutcome =
  | { kind: "repo"; typeId: string; strategy: TypeResolutionStrategy }
  | { kind: "external"; qualifiedName: string; strategy: "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" }
  | { kind: "type_variable"; name: string }
  | { kind: "ambiguous"; typeIds: string[] }
  | { kind: "unresolved" };

export type ParsedTypeText = {
  baseName: string;
  typeArguments: string[];
  arrayDepth: number;
  wildcard?: "extends" | "super" | "unbounded";
};

// A small hand-written parser instead of a token regex: Java type syntax
// nests (`Map<String, ? extends User>`), and telling a top-level comma from
// one inside a nested `<...>` needs depth tracking a flat token scan can't
// give you anyway.
export function parseTypeText(rawText: string): ParsedTypeText {
  let text = rawText.trim();
  let wildcard: ParsedTypeText["wildcard"];

  if (text.startsWith("?")) {
    const rest = text.slice(1).trim();
    if (rest.startsWith("extends ")) {
      wildcard = "extends";
      text = rest.slice("extends ".length).trim();
    } else if (rest.startsWith("super ")) {
      wildcard = "super";
      text = rest.slice("super ".length).trim();
    } else {
      wildcard = "unbounded";
      text = rest.trim();
    }
  }

  let arrayDepth = 0;
  while (text.endsWith("[]")) {
    arrayDepth += 1;
    text = text.slice(0, -2).trim();
  }

  let typeArguments: string[] = [];
  const genericStart = text.indexOf("<");
  if (genericStart >= 0 && text.endsWith(">")) {
    typeArguments = splitTopLevel(text.slice(genericStart + 1, -1));
    text = text.slice(0, genericStart).trim();
  }

  return { baseName: text, typeArguments, arrayDepth, wildcard };
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<") depth += 1;
    if (ch === ">") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function simpleNameOf(dotted: string): string {
  const index = dotted.lastIndexOf(".");
  return index >= 0 ? dotted.slice(index + 1) : dotted;
}

// Strips a `?` / `? extends ` / `? super ` wildcard prefix from an
// already-built JavaTypeRef's source text. buildTypeRef spreads the bound
// type's own fields onto the wildcard node, so ref.simpleName is already
// just the bound's simple name, but ref.text is the *whole* wildcard text
// (e.g. "? extends User") - this recovers the dotted base text a wildcard
// ref's bound type was actually written as, for the same "already
// qualified" check every other ref goes through.
function dottedBaseTextOf(ref: JavaTypeRef): string {
  let text = ref.text;
  if (ref.wildcard) {
    text = text.replace(/^\?\s*(?:extends|super)?\s*/, "");
  }
  return text.split("<")[0]!.split("[")[0]!.trim();
}

// Deliberately incomplete: java.lang is small and stable, but this is not
// an exhaustive enumeration of it. A miss here is safe, not silently wrong
// - it falls through to steps 7/8 and, absent a same-named repo type,
// lands on UNRESOLVED rather than a wrong resolution.
const JAVA_LANG_SIMPLE_NAMES = new Set([
  "Object", "String", "StringBuilder", "StringBuffer", "CharSequence",
  "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Character", "Number",
  "Void", "Class", "Enum", "Record",
  "Exception", "RuntimeException", "Error", "Throwable",
  "Iterable", "Comparable", "Runnable", "AutoCloseable", "Cloneable",
  "Override", "Deprecated", "SuppressWarnings", "FunctionalInterface", "SafeVarargs",
  "Math", "System", "Thread"
]);

export class JavaNameResolver {
  constructor(private readonly registry: TypeRegistryView) {}

  resolveTypeText(text: string, context: JavaResolutionContext): JavaTypeRef {
    const parsed = parseTypeText(text);
    const typeArguments = parsed.typeArguments.map(arg => this.resolveTypeText(arg, context));
    const outcome = this.resolveBaseName(parsed.baseName, context);
    return {
      text,
      simpleName: simpleNameOf(parsed.baseName),
      qualifiedName: this.qualifiedNameOf(outcome),
      typeArguments,
      arrayDepth: parsed.arrayDepth,
      ...(parsed.wildcard ? { wildcard: parsed.wildcard } : {}),
      resolution: this.toResolution(outcome)
    };
  }

  // Production entry point: re-resolves an already-built JavaTypeRef (from
  // ast-extractor's buildTypeRef) in place, keying off ref.simpleName/text
  // rather than re-parsing - typeArguments are already structured refs, so
  // they are resolved recursively instead of being re-parsed from text.
  resolveTypeRef(ref: JavaTypeRef, context: JavaResolutionContext): JavaTypeRef {
    const typeArguments = ref.typeArguments.map(arg => this.resolveTypeRef(arg, context));
    const outcome = this.resolveBaseName(dottedBaseTextOf(ref), context);
    return {
      ...ref,
      typeArguments,
      qualifiedName: this.qualifiedNameOf(outcome),
      resolution: this.toResolution(outcome)
    };
  }

  private qualifiedNameOf(outcome: ResolveOutcome): string | undefined {
    if (outcome.kind === "repo") return this.registry.byId.get(outcome.typeId)?.fqn;
    if (outcome.kind === "external") return outcome.qualifiedName;
    return undefined;
  }

  private toResolution(outcome: ResolveOutcome): JavaTypeRef["resolution"] {
    switch (outcome.kind) {
      case "repo":
        return { state: "RESOLVED_REPO", typeId: outcome.typeId, strategy: outcome.strategy };
      case "external":
        return { state: "EXTERNAL", qualifiedName: outcome.qualifiedName, strategy: outcome.strategy };
      case "type_variable":
        return { state: "TYPE_VARIABLE", name: outcome.name };
      case "ambiguous":
        return { state: "AMBIGUOUS", candidates: [...outcome.typeIds].sort() };
      case "unresolved":
        return { state: "UNRESOLVED" };
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled resolve outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // The exact 10-step order from architecture V3 §9.8. Each step is
  // checked in order; the first step that produces any candidate(s) -
  // whether a single unambiguous one or several - ends resolution there.
  // A step producing multiple candidates is immediately AMBIGUOUS; it does
  // not pool with candidates a later step might also find.
  private resolveBaseName(dottedBase: string, context: JavaResolutionContext): ResolveOutcome {
    const simpleName = simpleNameOf(dottedBase);

    // Step 1: type parameter declared in the current method/type scope.
    if (!dottedBase.includes(".") && context.typeParameterNames.has(dottedBase)) {
      return { kind: "type_variable", name: dottedBase };
    }

    // Step 2: source text is already a qualified name.
    if (dottedBase.includes(".")) {
      const exact = this.registry.byFqn.get(dottedBase);
      if (exact) return { kind: "repo", typeId: exact, strategy: "QUALIFIED" };

      // "Outer.Inner" written without a package prefix uses "." between
      // segments, but this repo's FQN convention uses "$" for nesting
      // (stable-id.ts). Retry against the current package before treating
      // it as external. A chain whose *first* segment would itself need
      // resolving through an import or wildcard (rather than being a
      // same-package type) is a known, bounded limitation - it falls
      // through to EXTERNAL below instead of being silently mis-resolved.
      const nestedGuess = context.packageName
        ? `${context.packageName}.${dottedBase.split(".").join("$")}`
        : dottedBase.split(".").join("$");
      const nestedMatch = this.registry.byFqn.get(nestedGuess);
      if (nestedMatch) return { kind: "repo", typeId: nestedMatch, strategy: "QUALIFIED" };

      return { kind: "external", qualifiedName: dottedBase, strategy: "QUALIFIED" };
    }

    // Step 3: current file's explicit (non-wildcard) import. Static
    // imports (of members, not types) never participate in type lookup.
    const explicitImport = context.imports.find(
      imp => !imp.wildcard && !imp.static && simpleNameOf(imp.qualifiedName) === simpleName
    );
    if (explicitImport) {
      const repoTypeId = this.registry.byFqn.get(explicitImport.qualifiedName);
      if (repoTypeId) return { kind: "repo", typeId: repoTypeId, strategy: "EXPLICIT_IMPORT" };
      // A framework/JDK type with no repo source is still EXTERNAL, not
      // UNRESOLVED - useful for annotation/framework metadata and overload
      // hints even though it never becomes a readPlan candidate.
      return { kind: "external", qualifiedName: explicitImport.qualifiedName, strategy: "EXPLICIT_IMPORT" };
    }

    // Step 4: enclosing/nested type, innermost scope first.
    for (let i = context.enclosingTypeIds.length - 1; i >= 0; i -= 1) {
      const ownerId = context.enclosingTypeIds[i]!;
      const owner = this.registry.byId.get(ownerId);
      if (owner && owner.simpleName === simpleName) {
        return { kind: "repo", typeId: ownerId, strategy: "ENCLOSING_TYPE" };
      }
      const nestedId = this.registry.nestedByOwnerAndSimpleName.get(`${ownerId}#${simpleName}`);
      if (nestedId) return { kind: "repo", typeId: nestedId, strategy: "ENCLOSING_TYPE" };
    }

    // Step 5: current package.
    const samePackageFqn = context.packageName ? `${context.packageName}.${simpleName}` : simpleName;
    const samePackageId = this.registry.byFqn.get(samePackageFqn);
    if (samePackageId) return { kind: "repo", typeId: samePackageId, strategy: "SAME_PACKAGE" };

    // Step 6: java.lang.
    if (JAVA_LANG_SIMPLE_NAMES.has(simpleName)) {
      return { kind: "external", qualifiedName: `java.lang.${simpleName}`, strategy: "JAVA_LANG" };
    }

    // Step 7: unique repo candidate among (non-static) wildcard imports.
    const wildcardCandidates = new Set<string>();
    for (const imp of context.imports) {
      if (!imp.wildcard || imp.static) continue;
      const candidateId = this.registry.byFqn.get(`${imp.qualifiedName}.${simpleName}`);
      if (candidateId) wildcardCandidates.add(candidateId);
    }
    if (wildcardCandidates.size === 1) {
      return { kind: "repo", typeId: [...wildcardCandidates][0]!, strategy: "WILDCARD_IMPORT" };
    }
    if (wildcardCandidates.size > 1) {
      return { kind: "ambiguous", typeIds: [...wildcardCandidates] };
    }

    // Step 8: unique repo-global simple name.
    const globalCandidates = this.registry.bySimpleName.get(simpleName);
    if (globalCandidates && globalCandidates.size === 1) {
      return { kind: "repo", typeId: [...globalCandidates][0]!, strategy: "REPO_UNIQUE_SIMPLE_NAME" };
    }
    // Step 9: multiple candidates -> AMBIGUOUS.
    if (globalCandidates && globalCandidates.size > 1) {
      return { kind: "ambiguous", typeIds: [...globalCandidates] };
    }

    // Step 10: no candidates -> UNRESOLVED.
    return { kind: "unresolved" };
  }
}
