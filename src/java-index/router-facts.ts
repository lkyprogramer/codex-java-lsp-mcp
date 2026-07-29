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

export type JavaSourceFacts = {
  absolutePath: string;
  path?: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  packageName?: string;
  typeName?: string;
  typeId?: string;
  kind?: "class" | "interface" | "record" | "enum" | "annotation";
  implementsTypes: string[];
  extendsType?: string;
  referencedTypes: string[];
  imports: string[];
  wildcardImports: string[];
  annotations: string[];
  methods: JavaMethodFact[];
  factSource: "javaIndex" | "fallback";
  parseState?: "COMPLETE" | "RECOVERED" | "FAILED";
  confirmedAt?: string;
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
    typeId: primary?.typeId,
    kind: primary?.kind,
    implementsTypes: primary?.implements.map(typeRefName).filter(Boolean) || [],
    extendsType: primary?.extends.map(typeRefName).find(Boolean),
    referencedTypes,
    imports: bundle.file.imports.filter(item => !item.wildcard).map(item => item.qualifiedName),
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
    typeId: type?.typeId,
    kind: type?.kind,
    implementsTypes: type?.implements.map(typeRefName).filter(Boolean) || [],
    extendsType: type?.extends.map(typeRefName).find(Boolean),
    referencedTypes: unique([
      ...(type?.extends.map(typeRefName) || []),
      ...(type?.implements.map(typeRefName) || []),
      ...(anchor.method ? methodReferencedTypes(anchor.method) : [])
    ].filter(Boolean)),
    imports: anchor.file.imports.filter(item => !item.wildcard).map(item => item.qualifiedName),
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
    const typeName = typeRefName(parameter.type);
    if (!typeName || isNoiseType(typeName)) continue;
    relations.push({
      kind: "parameter",
      typeName,
      name: parameter.name,
      line: parameter.range.start.line,
      confidence: "high",
      source: "ast"
    });
  }
  if (method.returnType) {
    const typeName = typeRefName(method.returnType);
    if (typeName && !isNoiseType(typeName)) {
      relations.push({
        kind: "return",
        typeName,
        line: method.returnType.range?.start.line ?? method.range.start.line,
        confidence: "high",
        source: "ast"
      });
    }
  }
  for (const call of method.callSites) {
    const typeName = call.receiverDeclaredType
      ? typeRefName(call.receiverDeclaredType)
      : undefined;
    if (!typeName || isNoiseType(typeName)) continue;
    relations.push({
      kind: "local-receiver",
      typeName,
      name: call.name,
      line: call.range.start.line,
      confidence: "medium",
      source: "ast"
    });
  }
  for (const local of method.localTypes) {
    const typeName = typeRefName(local);
    if (!typeName || isNoiseType(typeName)) continue;
    relations.push({
      kind: "local-receiver",
      typeName,
      line: local.range?.start.line ?? method.range.start.line,
      confidence: "medium",
      source: "ast"
    });
  }
  return relations;
}

function methodReferencedTypes(method: JavaMethodFacts): string[] {
  return unique([
    ...method.parameters.map(parameter => typeRefName(parameter.type)),
    method.returnType ? typeRefName(method.returnType) : "",
    ...method.throws.map(typeRefName),
    ...method.localTypes.map(typeRefName),
    ...method.callSites.flatMap(call => [
      call.receiverDeclaredType ? typeRefName(call.receiverDeclaredType) : "",
      ...call.argumentTypeHints.map(typeRefName)
    ])
  ].filter(Boolean));
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
