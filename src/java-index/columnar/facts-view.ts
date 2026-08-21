// input: Columnar edges plus remaining object facts.
// output: Public StaticEdge / IndexedReference shapes identical to today's store.
// pos: M1 compatibility materialize-on-read. Request-scoped objects are not cached here.
import type {
  JavaAnnotationFact,
  JavaCallSiteFact,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaImportFact,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeParameterFact,
  JavaTypeRef,
  SourceRange
} from "../index-types.js";
import type { RangePool } from "./range-pool.js";
import type { StringTable } from "./string-table.js";

export function internStrings(table: StringTable, value: string | undefined): string | undefined {
  return value === undefined ? undefined : table.interned(value);
}

export function internRange(pool: RangePool, range: SourceRange | undefined): SourceRange | undefined {
  return range ? pool.internObject(range) : undefined;
}

export function internTypeRef(table: StringTable, pool: RangePool, ref: JavaTypeRef): JavaTypeRef {
  ref.text = table.interned(ref.text);
  ref.simpleName = table.interned(ref.simpleName);
  if (ref.qualifiedName !== undefined) ref.qualifiedName = table.interned(ref.qualifiedName);
  if (ref.range) ref.range = pool.internObject(ref.range);
  for (const argument of ref.typeArguments) internTypeRef(table, pool, argument);
  internResolution(table, ref.resolution);
  return ref;
}

export function internFileBundle(table: StringTable, pool: RangePool, bundle: JavaFileBundle): void {
  internFile(table, pool, bundle.file);
  for (const type of bundle.types) internType(table, pool, type);
  for (const field of bundle.fields) internField(table, pool, field);
  for (const method of bundle.methods) internMethod(table, pool, method);
}

export function internFile(table: StringTable, pool: RangePool, file: JavaFileFacts): void {
  file.fileId = table.interned(file.fileId);
  file.relativePath = table.interned(file.relativePath);
  file.sourceRoot = table.interned(file.sourceRoot);
  file.module = table.interned(file.module);
  file.packageName = table.interned(file.packageName);
  file.contentHash = table.interned(file.contentHash);
  file.sourceSet = table.interned(file.sourceSet) as JavaFileFacts["sourceSet"];
  file.parseState = table.interned(file.parseState) as JavaFileFacts["parseState"];
  file.topLevelTypeIds = file.topLevelTypeIds.map(id => table.interned(id));
  file.allTypeIds = file.allTypeIds.map(id => table.interned(id));
  for (const item of file.imports) internImport(table, pool, item);
}

export function internType(table: StringTable, pool: RangePool, type: JavaTypeFacts): void {
  type.typeId = table.interned(type.typeId);
  if (type.fqn !== undefined) type.fqn = table.interned(type.fqn);
  type.simpleName = table.interned(type.simpleName);
  type.kind = table.interned(type.kind) as JavaTypeFacts["kind"];
  type.fileId = table.interned(type.fileId);
  if (type.enclosingTypeId !== undefined) type.enclosingTypeId = table.interned(type.enclosingTypeId);
  type.range = pool.internObject(type.range);
  type.modifiers = type.modifiers.map(item => table.interned(item));
  type.fieldIds = type.fieldIds.map(id => table.interned(id));
  type.methodIds = type.methodIds.map(id => table.interned(id));
  for (const item of type.annotations) internAnnotation(table, pool, item);
  for (const item of type.typeParameters) internTypeParameter(table, pool, item);
  for (const item of type.extends) internTypeRef(table, pool, item);
  for (const item of type.implements) internTypeRef(table, pool, item);
  for (const item of type.permits) internTypeRef(table, pool, item);
}

export function internField(table: StringTable, pool: RangePool, field: JavaFieldFacts): void {
  field.fieldId = table.interned(field.fieldId);
  field.ownerTypeId = table.interned(field.ownerTypeId);
  field.name = table.interned(field.name);
  internTypeRef(table, pool, field.type);
  field.modifiers = field.modifiers.map(item => table.interned(item));
  field.range = pool.internObject(field.range);
  for (const item of field.annotations) internAnnotation(table, pool, item);
}

export function internMethod(table: StringTable, pool: RangePool, method: JavaMethodFacts): void {
  method.methodId = table.interned(method.methodId);
  method.ownerTypeId = table.interned(method.ownerTypeId);
  method.name = table.interned(method.name);
  method.signatureKey = table.interned(method.signatureKey);
  method.range = pool.internObject(method.range);
  if (method.bodyRange) method.bodyRange = pool.internObject(method.bodyRange);
  method.modifiers = method.modifiers.map(item => table.interned(item));
  for (const item of method.annotations) internAnnotation(table, pool, item);
  for (const item of method.typeParameters) internTypeParameter(table, pool, item);
  if (method.returnType) internTypeRef(table, pool, method.returnType);
  for (const parameter of method.parameters) {
    parameter.name = table.interned(parameter.name);
    internTypeRef(table, pool, parameter.type);
    parameter.range = pool.internObject(parameter.range);
    for (const item of parameter.annotations) internAnnotation(table, pool, item);
  }
  for (const item of method.throws) internTypeRef(table, pool, item);
  for (const item of method.callSites) internCallSite(table, pool, item);
  for (const item of method.localTypes) internTypeRef(table, pool, item);
}

function internImport(table: StringTable, pool: RangePool, item: JavaImportFact): void {
  item.qualifiedName = table.interned(item.qualifiedName);
  item.range = pool.internObject(item.range);
}

function internAnnotation(table: StringTable, pool: RangePool, item: JavaAnnotationFact): void {
  item.name = table.interned(item.name);
  if (item.qualifiedName !== undefined) item.qualifiedName = table.interned(item.qualifiedName);
  if (item.argumentsText !== undefined) item.argumentsText = table.interned(item.argumentsText);
  item.range = pool.internObject(item.range);
}

function internTypeParameter(table: StringTable, pool: RangePool, item: JavaTypeParameterFact): void {
  item.name = table.interned(item.name);
  item.range = pool.internObject(item.range);
  for (const bound of item.bounds) internTypeRef(table, pool, bound);
}

function internCallSite(table: StringTable, pool: RangePool, item: JavaCallSiteFact): void {
  item.kind = table.interned(item.kind) as JavaCallSiteFact["kind"];
  item.name = table.interned(item.name);
  if (item.receiverText !== undefined) item.receiverText = table.interned(item.receiverText);
  if (item.receiverDeclaredType) internTypeRef(table, pool, item.receiverDeclaredType);
  item.range = pool.internObject(item.range);
  for (const hint of item.argumentTypeHints) internTypeRef(table, pool, hint);
}

function internResolution(table: StringTable, resolution: JavaTypeRef["resolution"]): void {
  if (resolution.state === "RESOLVED_REPO") {
    resolution.typeId = table.interned(resolution.typeId);
    return;
  }
  if (resolution.state === "EXTERNAL") {
    resolution.qualifiedName = table.interned(resolution.qualifiedName);
    return;
  }
  if (resolution.state === "TYPE_VARIABLE") {
    resolution.name = table.interned(resolution.name);
    return;
  }
  if (resolution.state === "AMBIGUOUS") {
    resolution.candidates = resolution.candidates.map(candidate => table.interned(candidate));
  }
}
