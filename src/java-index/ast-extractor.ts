import type { JavaParserBackend, JavaSyntaxNode, JavaSyntaxTree } from "./java-parser-backend.js";
import type {
  JavaAnnotationFact,
  JavaCallSiteFact,
  JavaFieldFacts,
  JavaFileFacts,
  JavaImportFact,
  JavaMethodFacts,
  JavaParseState,
  JavaSourceSet,
  JavaTypeFacts,
  JavaTypeKind,
  JavaTypeParameterFact,
  JavaTypeRef
} from "./index-types.js";
import type { SourceRange } from "../runtime/source-range.js";
import { javaFieldId, javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

export type ExtractJavaInput = {
  repoRoot: string;
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: JavaSourceSet;
  content: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  generation: number;
};

export type ExtractedJavaFile = {
  file: JavaFileFacts;
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
};

const TYPE_DECL_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "record_declaration",
  "enum_declaration",
  "annotation_type_declaration"
]);

type EnclosingFrame = { typeId: string; fqn?: string };

type ExtractContext = {
  input: ExtractJavaInput;
  source: string;
  packageName: string;
  imports: JavaImportFact[];
  topLevelTypeIds: string[];
  allTypeIds: string[];
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  enclosing: EnclosingFrame[];
};

type Scope = Map<string, JavaTypeRef>;

export function extractJavaFile(input: ExtractJavaInput, backend: JavaParserBackend): ExtractedJavaFile {
  const tree = backend.parse(input.content);
  return extractFromParsedTree(input, tree);
}

export function extractFromParsedTree(input: ExtractJavaInput, tree: JavaSyntaxTree): ExtractedJavaFile {
  const context: ExtractContext = {
    input,
    source: input.content,
    packageName: "",
    imports: [],
    topLevelTypeIds: [],
    allTypeIds: [],
    types: [],
    fields: [],
    methods: [],
    enclosing: []
  };

  const root = tree.rootNode;
  for (const child of root.namedChildren) visitCompilationUnit(child, context);

  // countErrorNodes should already catch every ERROR/MISSING node, but a
  // non-COMPLETE parse must never persist parseErrorCount: 0 - that would be
  // an incoherent fact if some other tree-sitter recovery mechanism sets
  // hasError without producing either node kind.
  const errorCount = Math.max(countErrorNodes(root), root.hasError ? 1 : 0);
  const parseState: JavaParseState = !root.hasError
    ? "COMPLETE"
    : context.topLevelTypeIds.length > 0
      ? "RECOVERED"
      : "FAILED";

  const file: JavaFileFacts = {
    fileId: javaFileId(input.relativePath),
    relativePath: input.relativePath,
    sourceRoot: input.sourceRoot,
    module: input.module,
    sourceSet: input.sourceSet,
    packageName: context.packageName,
    imports: context.imports,
    topLevelTypeIds: context.topLevelTypeIds,
    allTypeIds: context.allTypeIds,
    contentHash: input.contentHash,
    size: input.size,
    mtimeMs: input.mtimeMs,
    parseState,
    parseErrorCount: errorCount,
    generation: input.generation
  };

  return { file, types: context.types, fields: context.fields, methods: context.methods };
}

function visitCompilationUnit(node: JavaSyntaxNode, context: ExtractContext): void {
  switch (node.type) {
    case "package_declaration": {
      const nameNode = node.namedChildren[0];
      if (nameNode) context.packageName = textOf(nameNode, context.source);
      return;
    }
    case "import_declaration":
      context.imports.push(buildImport(node, context.source));
      return;
    case "class_declaration":
    case "interface_declaration":
    case "record_declaration":
    case "enum_declaration":
    case "annotation_type_declaration": {
      const typeFacts = extractType(node, context, false);
      context.topLevelTypeIds.push(typeFacts.typeId);
      return;
    }
    default:
      for (const child of node.namedChildren) visitCompilationUnit(child, context);
  }
}

function extractType(node: JavaSyntaxNode, context: ExtractContext, isLocal: boolean): JavaTypeFacts {
  const modifiersNode = findChildOfType(node, "modifiers");
  const nameNode = node.childForFieldName("name");
  const simpleName = nameNode ? textOf(nameNode, context.source) : "";
  const range = rangeOf(node);
  const parent = context.enclosing[context.enclosing.length - 1];
  const fqn = isLocal
    ? undefined
    : parent?.fqn
      ? `${parent.fqn}$${simpleName}`
      : `${context.packageName}.${simpleName}`;

  const typeId = javaTypeId({ fqn, relativePath: context.input.relativePath, range });
  const typeParametersNode = node.childForFieldName("type_parameters");
  const interfacesNode = node.childForFieldName("interfaces");
  const permitsNode = node.childForFieldName("permits");
  const bodyNode = node.childForFieldName("body");

  const fieldIds: string[] = [];
  const methodIds: string[] = [];

  const typeFacts: JavaTypeFacts = {
    typeId,
    ...(fqn !== undefined ? { fqn } : {}),
    simpleName,
    kind: typeKindOf(node.type),
    fileId: javaFileId(context.input.relativePath),
    ...(parent ? { enclosingTypeId: parent.typeId } : {}),
    range,
    modifiers: extractModifiers(modifiersNode),
    annotations: extractAnnotations(modifiersNode, context.source),
    typeParameters: typeParametersNode
      ? typeParametersNode.namedChildren.map(p => buildTypeParameter(p, context.source))
      : [],
    extends: extractExtends(node, context.source),
    implements: extractInterfaceList(interfacesNode, context.source),
    permits: extractInterfaceList(permitsNode, context.source),
    fieldIds,
    methodIds,
    confidence: node.hasError ? 0.5 : 1
  };

  context.types.push(typeFacts);
  context.allTypeIds.push(typeId);
  context.enclosing.push({ typeId, fqn });

  if (bodyNode) {
    const memberNodes = bodyNode.namedChildren;
    // Pass 1: fields first, so pass 2's methods can see every sibling field
    // regardless of source order (Java allows a method to reference a field
    // declared later in the same type).
    for (const member of memberNodes) {
      if (member.type === "field_declaration") {
        for (const field of buildFields(member, context, typeId)) {
          context.fields.push(field);
          fieldIds.push(field.fieldId);
        }
      }
    }
    if (node.type === "record_declaration") {
      for (const field of buildRecordComponentFields(node, context, typeId)) {
        context.fields.push(field);
        fieldIds.push(field.fieldId);
      }
    }
    // Pass 2: methods/constructors (call sites can now resolve sibling
    // field receivers) and nested member types.
    for (const member of memberNodes) {
      if (member.type === "method_declaration" || member.type === "constructor_declaration") {
        const method = buildMethod(member, context, typeId);
        context.methods.push(method);
        methodIds.push(method.methodId);
      } else if (TYPE_DECL_TYPES.has(member.type)) {
        extractType(member, context, false);
      } else if (member.type === "enum_body_declarations") {
        for (const enumMember of member.namedChildren) {
          if (enumMember.type === "method_declaration" || enumMember.type === "constructor_declaration") {
            const method = buildMethod(enumMember, context, typeId);
            context.methods.push(method);
            methodIds.push(method.methodId);
          } else if (TYPE_DECL_TYPES.has(enumMember.type)) {
            extractType(enumMember, context, false);
          }
        }
      }
    }
  }

  context.enclosing.pop();
  return typeFacts;
}

function typeKindOf(nodeType: string): JavaTypeKind {
  switch (nodeType) {
    case "interface_declaration":
      return "interface";
    case "record_declaration":
      return "record";
    case "enum_declaration":
      return "enum";
    case "annotation_type_declaration":
      return "annotation";
    default:
      return "class";
  }
}

function extractExtends(node: JavaSyntaxNode, source: string): JavaTypeRef[] {
  const superclassNode = node.childForFieldName("superclass");
  if (superclassNode) {
    const typeNode = superclassNode.namedChildren[0];
    return typeNode ? [buildTypeRef(typeNode, source)] : [];
  }
  // interface_declaration's "extends B, C" clause is a positional
  // extends_interfaces node (not a field), distinct from superclass/interfaces.
  const extendsInterfacesNode = findChildOfType(node, "extends_interfaces");
  if (extendsInterfacesNode) {
    const typeListNode = findChildOfType(extendsInterfacesNode, "type_list") ?? extendsInterfacesNode;
    return typeListNode.namedChildren.map(t => buildTypeRef(t, source));
  }
  return [];
}

function extractInterfaceList(wrapperNode: JavaSyntaxNode | undefined | null, source: string): JavaTypeRef[] {
  if (!wrapperNode) return [];
  const typeListNode = findChildOfType(wrapperNode, "type_list") ?? wrapperNode;
  return typeListNode.namedChildren.map(t => buildTypeRef(t, source));
}

function buildImport(node: JavaSyntaxNode, source: string): JavaImportFact {
  const isStatic = node.children.some(c => c.type === "static");
  const wildcard = node.namedChildren.some(c => c.type === "asterisk");
  const pathNode = node.namedChildren.find(c => c.type === "scoped_identifier" || c.type === "identifier");
  return {
    qualifiedName: pathNode ? textOf(pathNode, source) : "",
    wildcard,
    static: isStatic,
    range: rangeOf(node)
  };
}

function buildFields(node: JavaSyntaxNode, context: ExtractContext, ownerTypeId: string): JavaFieldFacts[] {
  const modifiersNode = findChildOfType(node, "modifiers");
  const typeNode = node.childForFieldName("type");
  const baseType = typeNode ? buildTypeRef(typeNode, context.source) : unknownTypeRef(rangeOf(node));
  const modifiers = extractModifiers(modifiersNode);
  const annotations = extractAnnotations(modifiersNode, context.source);
  const range = rangeOf(node);

  return node.namedChildren
    .filter(c => c.type === "variable_declarator")
    .map(decl => {
      const nameNode = decl.childForFieldName("name") ?? decl.namedChildren[0];
      const name = nameNode ? textOf(nameNode, context.source) : "";
      const dimsNode = decl.childForFieldName("dimensions");
      const extraDepth = dimsNode ? countBrackets(textOf(dimsNode, context.source)) : 0;
      const type: JavaTypeRef = extraDepth > 0
        ? { ...baseType, arrayDepth: baseType.arrayDepth + extraDepth }
        : baseType;
      return {
        fieldId: javaFieldId(ownerTypeId, name),
        ownerTypeId,
        name,
        type,
        modifiers,
        annotations,
        range
      };
    });
}

function buildRecordComponentFields(
  recordNode: JavaSyntaxNode,
  context: ExtractContext,
  ownerTypeId: string
): JavaFieldFacts[] {
  const paramsNode = recordNode.childForFieldName("parameters");
  if (!paramsNode) return [];
  return paramsNode.namedChildren
    .filter(p => p.type === "formal_parameter")
    .map(param => {
      const typeNode = param.childForFieldName("type");
      const nameNode = param.childForFieldName("name");
      const name = nameNode ? textOf(nameNode, context.source) : "";
      const type = typeNode ? buildTypeRef(typeNode, context.source) : unknownTypeRef(rangeOf(param));
      return {
        fieldId: javaFieldId(ownerTypeId, name),
        ownerTypeId,
        name,
        type,
        modifiers: ["private", "final"],
        annotations: [],
        range: rangeOf(param)
      };
    });
}

function buildMethod(node: JavaSyntaxNode, context: ExtractContext, ownerTypeId: string): JavaMethodFacts {
  const isConstructor = node.type === "constructor_declaration";
  const modifiersNode = findChildOfType(node, "modifiers");
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? textOf(nameNode, context.source) : "<init>";
  const typeParametersNode = node.childForFieldName("type_parameters");
  const typeNode = node.childForFieldName("type");
  const parametersNode = node.childForFieldName("parameters");
  const throwsNode = findChildOfType(node, "throws");
  const bodyNode = node.childForFieldName("body");

  const parameters = parametersNode
    ? parametersNode.namedChildren
        .filter(p => p.type === "formal_parameter" || p.type === "spread_parameter")
        .map(p => buildParameter(p, context.source))
    : [];
  const varargs = parameters.length > 0 && parameters[parameters.length - 1]!.varargs;
  const signatureKey = erasedSignatureKey({
    name: isConstructor ? "<init>" : name,
    parameterTypeTexts: parameters.map(p => erasedTypeText(p.type)),
    varargs
  });
  const methodId = javaMethodId(ownerTypeId, signatureKey);
  const returnType = !isConstructor && typeNode && typeNode.type !== "void_type"
    ? buildTypeRef(typeNode, context.source)
    : undefined;

  const callSites: JavaCallSiteFact[] = [];
  const localTypes: JavaTypeRef[] = [];
  if (bodyNode) {
    const scope: Scope = new Map();
    for (const parameter of parameters) scope.set(parameter.name, parameter.type);
    for (const field of context.fields) {
      if (field.ownerTypeId === ownerTypeId) scope.set(field.name, field.type);
    }
    collectCallSites(bodyNode, context, scope, callSites, localTypes);
  }

  return {
    methodId,
    ownerTypeId,
    name,
    constructor: isConstructor,
    signatureKey,
    range: rangeOf(node),
    ...(bodyNode ? { bodyRange: rangeOf(bodyNode) } : {}),
    modifiers: extractModifiers(modifiersNode),
    annotations: extractAnnotations(modifiersNode, context.source),
    typeParameters: typeParametersNode
      ? typeParametersNode.namedChildren.map(p => buildTypeParameter(p, context.source))
      : [],
    ...(returnType ? { returnType } : {}),
    parameters,
    throws: throwsNode ? throwsNode.namedChildren.map(t => buildTypeRef(t, context.source)) : [],
    callSites,
    localTypes
  };
}

function buildParameter(
  node: JavaSyntaxNode,
  source: string
): { name: string; type: JavaTypeRef; varargs: boolean; range: SourceRange } {
  if (node.type === "spread_parameter") {
    const typeNode = node.namedChildren[0];
    const declaratorNode = findChildOfType(node, "variable_declarator");
    const nameNode = declaratorNode?.childForFieldName("name") ?? declaratorNode?.namedChildren[0];
    const name = nameNode ? textOf(nameNode, source) : "";
    const elementType = typeNode ? buildTypeRef(typeNode, source) : unknownTypeRef(rangeOf(node));
    return {
      name,
      type: { ...elementType, arrayDepth: elementType.arrayDepth + 1 },
      varargs: true,
      range: rangeOf(node)
    };
  }
  const typeNode = node.childForFieldName("type");
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? textOf(nameNode, source) : "";
  const type = typeNode ? buildTypeRef(typeNode, source) : unknownTypeRef(rangeOf(node));
  return { name, type, varargs: false, range: rangeOf(node) };
}

function erasedTypeText(type: JavaTypeRef): string {
  const base = type.text.split("<")[0]!.trim();
  return `${base}${"[]".repeat(type.arrayDepth)}`;
}

function erasedSignatureKey(input: { name: string; parameterTypeTexts: string[]; varargs: boolean }): string {
  return `${input.name}(${input.parameterTypeTexts.join(",")})`;
}

function buildTypeParameter(node: JavaSyntaxNode, source: string): JavaTypeParameterFact {
  const nameNode = node.namedChildren[0];
  const name = nameNode ? textOf(nameNode, source) : textOf(node, source);
  const boundNode = findChildOfType(node, "type_bound");
  const bounds = boundNode ? boundNode.namedChildren.map(b => buildTypeRef(b, source)) : [];
  return { name, bounds, range: rangeOf(node) };
}

function buildTypeRef(node: JavaSyntaxNode, source: string): JavaTypeRef {
  switch (node.type) {
    case "type_identifier":
    case "identifier": {
      const text = textOf(node, source);
      return baseRef(text, text, [], 0, rangeOf(node));
    }
    case "scoped_type_identifier": {
      const text = textOf(node, source);
      return baseRef(text, simpleNameOf(text), [], 0, rangeOf(node));
    }
    case "generic_type": {
      const [baseNode, argsNode] = node.namedChildren;
      if (!baseNode) {
        const text = textOf(node, source);
        return baseRef(text, simpleNameOf(text), [], 0, rangeOf(node));
      }
      const base = buildTypeRef(baseNode, source);
      const typeArguments = argsNode
        ? argsNode.namedChildren.map(child => buildTypeRef(child, source))
        : [];
      return { ...base, text: textOf(node, source), typeArguments, range: rangeOf(node) };
    }
    case "array_type": {
      const elementNode = node.namedChildren[0];
      const dimensionsNode = node.namedChildren[1];
      const element = elementNode
        ? buildTypeRef(elementNode, source)
        : baseRef(textOf(node, source), textOf(node, source), [], 0, rangeOf(node));
      const extraDepth = dimensionsNode ? countBrackets(textOf(dimensionsNode, source)) : 1;
      return {
        ...element,
        text: textOf(node, source),
        arrayDepth: element.arrayDepth + extraDepth,
        range: rangeOf(node)
      };
    }
    case "wildcard": {
      const boundNode = node.namedChildren[0];
      const hasSuper = node.children.some(c => c.type === "super");
      const hasExtends = node.children.some(c => c.type === "extends");
      const base = boundNode ? buildTypeRef(boundNode, source) : baseRef("?", "?", [], 0, rangeOf(node));
      return {
        ...base,
        text: textOf(node, source),
        wildcard: hasSuper ? "super" : hasExtends ? "extends" : "unbounded",
        range: rangeOf(node)
      };
    }
    case "integral_type":
    case "floating_point_type":
    case "boolean_type": {
      const text = textOf(node, source);
      return baseRef(text, text, [], 0, rangeOf(node));
    }
    default: {
      const text = textOf(node, source);
      return baseRef(text, simpleNameOf(text), [], 0, rangeOf(node));
    }
  }
}

function baseRef(
  text: string,
  simpleName: string,
  typeArguments: JavaTypeRef[],
  arrayDepth: number,
  range: SourceRange
): JavaTypeRef {
  return { text, simpleName, typeArguments, arrayDepth, resolution: { state: "UNRESOLVED" }, range };
}

function unknownTypeRef(range: SourceRange): JavaTypeRef {
  return baseRef("", "", [], 0, range);
}

function collectCallSites(
  node: JavaSyntaxNode,
  context: ExtractContext,
  scope: Scope,
  callSites: JavaCallSiteFact[],
  localTypes: JavaTypeRef[]
): void {
  switch (node.type) {
    case "local_variable_declaration": {
      const typeNode = node.childForFieldName("type");
      const type = typeNode ? buildTypeRef(typeNode, context.source) : undefined;
      if (type && !localTypes.some(existing => existing.text === type.text)) {
        localTypes.push(type);
      }
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const name = nameNode ? textOf(nameNode, context.source) : undefined;
        if (name && type) scope.set(name, type);
        const valueNode = decl.childForFieldName("value");
        if (valueNode) collectCallSites(valueNode, context, scope, callSites, localTypes);
      }
      return;
    }
    case "method_invocation": {
      const nameNode = node.childForFieldName("name");
      const objectNode = node.childForFieldName("object");
      const argsNode = node.childForFieldName("arguments");
      const receiverDeclaredType = objectNode ? receiverTypeOf(objectNode, scope, context) : undefined;
      callSites.push({
        kind: "METHOD_INVOCATION",
        name: nameNode ? textOf(nameNode, context.source) : "",
        ...(objectNode ? { receiverText: textOf(objectNode, context.source) } : {}),
        ...(receiverDeclaredType ? { receiverDeclaredType } : {}),
        arity: argsNode ? argsNode.namedChildren.length : 0,
        argumentTypeHints: [],
        range: rangeOf(node)
      });
      if (objectNode) collectCallSites(objectNode, context, scope, callSites, localTypes);
      if (argsNode) for (const arg of argsNode.namedChildren) collectCallSites(arg, context, scope, callSites, localTypes);
      return;
    }
    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      const argsNode = node.childForFieldName("arguments");
      callSites.push({
        kind: "CONSTRUCTOR_INVOCATION",
        name: typeNode ? simpleNameOf(textOf(typeNode, context.source)) : "",
        arity: argsNode ? argsNode.namedChildren.length : 0,
        argumentTypeHints: [],
        range: rangeOf(node)
      });
      if (argsNode) for (const arg of argsNode.namedChildren) collectCallSites(arg, context, scope, callSites, localTypes);
      return;
    }
    case "method_reference": {
      const children = node.namedChildren;
      const objectNode = children[0];
      const nameNode = children[children.length - 1];
      const receiverDeclaredType = objectNode ? receiverTypeOf(objectNode, scope, context) : undefined;
      callSites.push({
        kind: "METHOD_REFERENCE",
        name: nameNode ? textOf(nameNode, context.source) : "",
        ...(objectNode ? { receiverText: textOf(objectNode, context.source) } : {}),
        ...(receiverDeclaredType ? { receiverDeclaredType } : {}),
        arity: 0,
        argumentTypeHints: [],
        range: rangeOf(node)
      });
      return;
    }
    default:
      for (const child of node.namedChildren) collectCallSites(child, context, scope, callSites, localTypes);
  }
}

// Covers parameter, field and local-variable receivers per Task 16 Step 7.
// `this`/`super`/explicit-type-name receivers are left unresolved here and
// are a Task 17 (name resolver) concern, not an AST-extraction concern.
function receiverTypeOf(node: JavaSyntaxNode, scope: Scope, context: ExtractContext): JavaTypeRef | undefined {
  if (node.type !== "identifier") return undefined;
  return scope.get(textOf(node, context.source));
}

function countErrorNodes(node: JavaSyntaxNode): number {
  let count = node.type === "ERROR" || node.isMissing ? 1 : 0;
  for (const child of node.children) count += countErrorNodes(child);
  return count;
}

function extractModifiers(modifiersNode: JavaSyntaxNode | undefined): string[] {
  if (!modifiersNode) return [];
  return modifiersNode.children.filter(c => !c.isNamed).map(c => c.type);
}

function extractAnnotations(modifiersNode: JavaSyntaxNode | undefined, source: string): JavaAnnotationFact[] {
  if (!modifiersNode) return [];
  return modifiersNode.namedChildren
    .filter(c => c.type === "marker_annotation" || c.type === "annotation")
    .map(c => buildAnnotation(c, source));
}

function buildAnnotation(node: JavaSyntaxNode, source: string): JavaAnnotationFact {
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? textOf(nameNode, source) : textOf(node, source).replace(/^@/, "");
  const argsNode = node.childForFieldName("arguments");
  return {
    name: simpleNameOf(name),
    ...(name.includes(".") ? { qualifiedName: name } : {}),
    ...(argsNode ? { argumentsText: textOf(argsNode, source) } : {}),
    range: rangeOf(node)
  };
}

function findChildOfType(node: JavaSyntaxNode, type: string): JavaSyntaxNode | undefined {
  return node.namedChildren.find(c => c.type === type);
}

function countBrackets(text: string): number {
  return (text.match(/\[/g) ?? []).length;
}

function simpleNameOf(dotted: string): string {
  const index = dotted.lastIndexOf(".");
  return index === -1 ? dotted : dotted.slice(index + 1);
}

function textOf(node: JavaSyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function rangeOf(node: JavaSyntaxNode): SourceRange {
  return {
    start: { line: node.startPosition.row + 1, column: node.startPosition.column + 1 },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column + 1 }
  };
}
