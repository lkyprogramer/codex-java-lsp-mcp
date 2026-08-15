// input: JavaFileBundle / AnchorFacts from JavaIndex V2.
// output: Router-facing source facts used by ranking and candidate collectors.
// pos: Compatibility mapping between AST index facts and AgentRouter shapes.
import path from "node:path";
import { classifyPath } from "../repo-layout.js";
import type {
  AnchorFacts,
  JavaFileBundle,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeRef
} from "./index-types.js";

export type MethodRelationKind = "parameter" | "return" | "local-receiver" | "field-receiver";

export type MethodRelationFact = {
  kind: MethodRelationKind;
  typeName: string;
  /** Stable resolved repository type identity when Tree-sitter resolution is exact. */
  typeId?: string;
  name?: string;
  line: number;
  confidence: "high" | "medium" | "low";
  source: "ast";
};

export type JavaMethodFact = {
  name: string;
  line: number;
  endLine: number;
  referencedTypes: string[];
  relations: MethodRelationFact[];
  methodId?: string;
  parseFailed?: boolean;
};

/** A direct declaration type with its resolved repository identity when known. */
export type JavaTypeReferenceFact = {
  typeName: string;
  qualifiedName?: string;
  typeId?: string;
};

export type JavaSourceFacts = {
  absolutePath: string;
  path?: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  packageName?: string;
  typeName?: string;
  /** Canonical declaration FQN when the index returned a typed declaration. */
  qualifiedName?: string;
  typeId?: string;
  kind?: "class" | "interface" | "record" | "enum" | "annotation";
  implementsTypes: string[];
  extendsType?: string;
  /** Direct field types, including repository-resolved generic arguments. */
  fieldTypes?: JavaTypeReferenceFact[];
  referencedTypes: string[];
  imports: string[];
  wildcardImports: string[];
  annotations: string[];
  methods: JavaMethodFact[];
  factSource: "javaIndex" | "fallback";
  parseState?: "COMPLETE" | "RECOVERED" | "FAILED";
  confirmedAt?: string;
};

export const MAX_FACTS_FOR_FILES = 70;

export type FactsForFileMissingReason = "FILE_NOT_FOUND";

export type FactsForFileDegradedReason =
  | "INVALID_PATH"
  | "LIMIT_EXCEEDED"
  | "GENERATION_MISMATCH"
  | "INDEX_INCOMPLETE"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "QUERY_FAILED";

export type FactsForFileItem =
  | {
      inputFile: string;
      absolutePath: string;
      state: "FOUND";
      facts: JavaSourceFacts;
    }
  | {
      inputFile: string;
      absolutePath?: string;
      state: "MISSING";
      reason: FactsForFileMissingReason;
    }
  | {
      inputFile: string;
      absolutePath?: string;
      state: "DEGRADED";
      reason: FactsForFileDegradedReason;
      detail?: string;
    };

/**
 * Order-preserving, bounded source-fact batch. COMPLETE deliberately means
 * every requested item has an authoritative JavaIndex fact; callers never
 * have to infer completeness from an empty bundle or a fallback projection.
 */
export type FactsForFilesResult = {
  generation: number;
  completion: "COMPLETE" | "PARTIAL";
  truncated: boolean;
  items: FactsForFileItem[];
};

export function bundleToSourceFacts(repoRoot: string, bundle: JavaFileBundle): JavaSourceFacts {
  const absolutePath = path.resolve(repoRoot, bundle.file.relativePath);
  const layout = classifyPath(repoRoot, absolutePath);
  const primary = primaryType(bundle.types);
  const methods = bundle.methods
    .filter(method => !primary || method.ownerTypeId === primary.typeId || bundle.types.some(type => type.typeId === method.ownerTypeId))
    .map(methodToFact);
  const referencedTypes = unique([
    ...bundle.fields.map(field => typeRefName(field.type)),
    ...bundle.methods.flatMap(method => methodReferencedTypes(method)),
    ...bundle.types.flatMap(type => [
      ...type.extends.map(typeRefName),
      ...type.implements.map(typeRefName)
    ])
  ].filter(Boolean));

  return {
    absolutePath,
    path: layout.relativePath || bundle.file.relativePath,
    module: layout.module || bundle.file.module,
    layer: layout.layer,
    sourceSet: layout.sourceSet || bundle.file.sourceSet,
    packageName: bundle.file.packageName || undefined,
    typeName: primary?.simpleName,
    qualifiedName: primary?.fqn,
    typeId: primary?.typeId,
    kind: primary?.kind,
    implementsTypes: primary?.implements.map(typeRefName).filter(Boolean) || [],
    extendsType: primary?.extends.map(typeRefName).find(Boolean),
    fieldTypes: uniqueTypeReferences(bundle.fields.flatMap(field => flattenTypeRefs(field.type))),
    referencedTypes,
    imports: bundle.file.imports.filter(item => !item.static && !item.wildcard).map(item => item.qualifiedName),
    wildcardImports: bundle.file.imports.filter(item => item.wildcard).map(item => item.qualifiedName.replace(/\.\*$/, "")),
    annotations: (primary?.annotations || []).map(item => item.name),
    methods,
    factSource: "javaIndex",
    parseState: bundle.file.parseState
  };
}

export function anchorToSourceFacts(repoRoot: string, anchor: AnchorFacts): JavaSourceFacts {
  const absolutePath = path.resolve(repoRoot, anchor.file.relativePath);
  const layout = classifyPath(repoRoot, absolutePath);
  const type = anchor.type;
  const methods = anchor.method
    ? [methodToFact(anchor.method)]
    : [];
  return {
    absolutePath,
    path: layout.relativePath || anchor.file.relativePath,
    module: layout.module || anchor.file.module,
    layer: layout.layer,
    sourceSet: layout.sourceSet || anchor.file.sourceSet,
    packageName: anchor.file.packageName || undefined,
    typeName: type?.simpleName || (anchor.symbolKind === "TYPE" ? anchor.symbolName : undefined),
    qualifiedName: type?.fqn,
    typeId: type?.typeId,
    kind: type?.kind,
    implementsTypes: type?.implements.map(typeRefName).filter(Boolean) || [],
    extendsType: type?.extends.map(typeRefName).find(Boolean),
    referencedTypes: unique([
      ...(type?.extends.map(typeRefName) || []),
      ...(type?.implements.map(typeRefName) || []),
      ...(anchor.method ? methodReferencedTypes(anchor.method) : [])
    ].filter(Boolean)),
    imports: anchor.file.imports.filter(item => !item.static && !item.wildcard).map(item => item.qualifiedName),
    wildcardImports: anchor.file.imports.filter(item => item.wildcard).map(item => item.qualifiedName.replace(/\.\*$/, "")),
    annotations: (type?.annotations || []).map(item => item.name),
    methods,
    factSource: "javaIndex",
    parseState: anchor.file.parseState
  };
}

export function typeFactsToSourceFacts(
  repoRoot: string,
  type: JavaTypeFacts,
  bundle?: JavaFileBundle
): JavaSourceFacts {
  if (bundle) {
    const facts = bundleToSourceFacts(repoRoot, bundle);
    return {
      ...facts,
      typeName: type.simpleName,
      qualifiedName: type.fqn,
      typeId: type.typeId,
      kind: type.kind,
      implementsTypes: type.implements.map(typeRefName).filter(Boolean),
      extendsType: type.extends.map(typeRefName).find(Boolean),
      annotations: type.annotations.map(item => item.name),
      methods: bundle.methods
        .filter(method => method.ownerTypeId === type.typeId)
        .map(methodToFact)
    };
  }
  const absolutePath = path.resolve(repoRoot, type.fileId.includes("/") ? type.fileId : guessPathFromType(type));
  const layout = classifyPath(repoRoot, absolutePath);
  return {
    absolutePath,
    path: layout.relativePath,
    module: layout.module,
    layer: layout.layer,
    sourceSet: layout.sourceSet,
    typeName: type.simpleName,
    qualifiedName: type.fqn,
    typeId: type.typeId,
    kind: type.kind,
    implementsTypes: type.implements.map(typeRefName).filter(Boolean),
    extendsType: type.extends.map(typeRefName).find(Boolean),
    referencedTypes: unique([
      ...type.extends.map(typeRefName),
      ...type.implements.map(typeRefName)
    ].filter(Boolean)),
    imports: [],
    wildcardImports: [],
    annotations: type.annotations.map(item => item.name),
    methods: [],
    factSource: "javaIndex"
  };
}

export function methodToFact(method: JavaMethodFacts): JavaMethodFact {
  const endLine = method.bodyRange?.end.line
    ?? method.range.end.line;
  return {
    name: method.name,
    line: method.range.start.line,
    endLine,
    referencedTypes: methodReferencedTypes(method),
    relations: methodRelations(method),
    methodId: method.methodId
  };
}

export function fallbackSourceFacts(repoRoot: string, absolutePath: string, symbolName?: string): JavaSourceFacts {
  const layout = classifyPath(repoRoot, absolutePath);
  const typeName = symbolName || path.basename(absolutePath, ".java");
  return {
    absolutePath,
    path: layout.relativePath,
    module: layout.module,
    layer: layout.layer,
    sourceSet: layout.sourceSet,
    typeName,
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods: [],
    factSource: "fallback",
    parseState: "FAILED"
  };
}

function methodRelations(method: JavaMethodFacts): MethodRelationFact[] {
  const relations: MethodRelationFact[] = [];
  for (const parameter of method.parameters) {
    for (const ref of flattenTypeRefs(parameter.type)) {
      const relationType = methodRelationType(ref);
      const typeName = relationType?.typeName;
      if (!typeName || isNoiseType(typeName)) continue;
      relations.push({
        kind: "parameter",
        ...relationType,
        name: parameter.name,
        line: parameter.range.start.line,
        confidence: "high",
        source: "ast"
      });
    }
  }
  if (method.returnType) {
    for (const ref of flattenTypeRefs(method.returnType)) {
      const relationType = methodRelationType(ref);
      const typeName = relationType?.typeName;
      if (typeName && !isNoiseType(typeName)) {
        relations.push({
          kind: "return",
          ...relationType,
          line: method.returnType.range?.start.line ?? method.range.start.line,
          confidence: "high",
          source: "ast"
        });
      }
    }
  }
  for (const call of method.callSites) {
    const relationType = call.receiverDeclaredType
      ? methodRelationType(call.receiverDeclaredType)
      : undefined;
    const typeName = relationType?.typeName;
    if (!typeName || isNoiseType(typeName)) continue;
    relations.push({
      kind: "local-receiver",
      ...relationType,
      name: call.name,
      line: call.range.start.line,
      confidence: "medium",
      source: "ast"
    });
  }
  for (const local of method.localTypes) {
    const relationType = methodRelationType(local);
    const typeName = relationType?.typeName;
    if (!typeName || isNoiseType(typeName)) continue;
    relations.push({
      kind: "local-receiver",
      ...relationType,
      line: local.range?.start.line ?? method.range.start.line,
      confidence: "medium",
      source: "ast"
    });
  }
  return relations;
}

function methodRelationType(ref: JavaTypeRef): Pick<MethodRelationFact, "typeName" | "typeId"> | undefined {
  const typeName = typeRefName(ref);
  if (!typeName) return undefined;
  return {
    typeName,
    ...(ref.resolution.state === "RESOLVED_REPO" ? { typeId: ref.resolution.typeId } : {})
  };
}

function uniqueTypeReferences(refs: readonly JavaTypeRef[]): JavaTypeReferenceFact[] {
  const values = new Map<string, JavaTypeReferenceFact>();
  for (const ref of refs) {
    const typeName = typeRefName(ref);
    if (!typeName) continue;
    const reference: JavaTypeReferenceFact = {
      typeName,
      ...(ref.qualifiedName ? { qualifiedName: ref.qualifiedName } : {}),
      ...(ref.resolution.state === "RESOLVED_REPO" ? { typeId: ref.resolution.typeId } : {})
    };
    values.set(reference.typeId ?? reference.qualifiedName ?? reference.typeName, reference);
  }
  return [...values.values()];
}

function methodReferencedTypes(method: JavaMethodFacts): string[] {
  return unique([
    ...method.parameters.flatMap(parameter => flattenTypeRefs(parameter.type).map(typeRefName)),
    ...(method.returnType ? flattenTypeRefs(method.returnType).map(typeRefName) : []),
    ...method.throws.flatMap(ref => flattenTypeRefs(ref).map(typeRefName)),
    ...method.localTypes.flatMap(ref => flattenTypeRefs(ref).map(typeRefName)),
    ...method.callSites.flatMap(call => [
      ...(call.receiverDeclaredType ? flattenTypeRefs(call.receiverDeclaredType).map(typeRefName) : []),
      ...call.argumentTypeHints.flatMap(ref => flattenTypeRefs(ref).map(typeRefName))
    ])
  ].filter(Boolean));
}

/**
 * Generic arguments are part of a Java signature's resolved type graph.  For
 * example, `ApiResponse<ConfirmResponse>` has an external wrapper but a
 * repository-resolved return collaborator.  Preserve both so consumers can
 * bind by stable type id rather than falling back to a simple-name guess.
 */
function flattenTypeRefs(ref: JavaTypeRef): JavaTypeRef[] {
  return [ref, ...ref.typeArguments.flatMap(flattenTypeRefs)];
}

function primaryType(types: readonly JavaTypeFacts[]): JavaTypeFacts | undefined {
  const topLevel = types.filter(type => !type.enclosingTypeId);
  return topLevel[0] || types[0];
}

function typeRefName(ref: JavaTypeRef | undefined): string {
  if (!ref) return "";
  return ref.simpleName || ref.qualifiedName || ref.text.replace(/<.*>/, "").trim();
}

function guessPathFromType(type: JavaTypeFacts): string {
  // fileId is stable and root-independent; prefer relativePath when callers supply a bundle.
  return type.fileId;
}

function isNoiseType(name: string): boolean {
  return new Set([
    "String", "Integer", "Long", "Boolean", "Double", "Float", "Short", "Byte", "Character",
    "BigDecimal", "BigInteger", "List", "Map", "Set", "Collection", "Optional", "Date",
    "LocalDate", "LocalDateTime", "Page", "Pageable", "Object", "void", "Void"
  ]).has(name);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
