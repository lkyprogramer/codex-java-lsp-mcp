export type MethodRelationKind = "parameter" | "return" | "local-receiver" | "field-receiver";

export type MethodRelationFact = {
  kind: MethodRelationKind;
  typeName: string;
  name?: string;
  line: number;
  confidence: "high" | "medium" | "low";
  source: "regex-fallback";
};

type MethodRelationInput = {
  lines: string[];
  methodName: string;
  startIndex: number;
  endLine: number;
  selfType?: string;
};

type ReturnRelationInput = {
  signature: string;
  methodName: string;
  startIndex: number;
  selfType?: string;
};

type FieldReceiverInput = {
  allLines: string[];
  methodLines: string[];
  startIndex: number;
  selfType?: string;
};

const NON_DOMAIN_TYPES = new Set([
  "String",
  "Integer",
  "Long",
  "Boolean",
  "Double",
  "Float",
  "Short",
  "Byte",
  "Character",
  "BigDecimal",
  "BigInteger",
  "List",
  "Map",
  "Set",
  "Collection",
  "Optional",
  "Date",
  "LocalDate",
  "LocalDateTime",
  "Page",
  "Pageable"
]);

export function parseMethodRelations(input: MethodRelationInput): MethodRelationFact[] {
  const methodLines = input.lines.slice(input.startIndex, input.endLine);
  const signature = methodSignature(methodLines);
  return [
    ...parameterRelations(signature, input.startIndex),
    ...returnRelations({ signature, methodName: input.methodName, startIndex: input.startIndex, selfType: input.selfType }),
    ...localReceiverRelations(methodLines, input.startIndex, input.selfType),
    ...fieldReceiverRelations({ allLines: input.lines, methodLines, startIndex: input.startIndex, selfType: input.selfType })
  ];
}

function methodSignature(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const code = stripLineComment(line).trim();
    if (code.length === 0 || code.startsWith("@")) {
      continue;
    }
    parts.push(code);
    if (code.includes("{")) {
      break;
    }
  }
  return parts.join(" ").replace(/\{.*/, "").trim();
}

function parameterRelations(signature: string, startIndex: number): MethodRelationFact[] {
  const parameterList = signature.match(/\((.*)\)/)?.[1];
  if (!parameterList) {
    return [];
  }
  return parameterList
    .split(",")
    .map(parameter => parseTypedName(parameter))
    .filter((typedName): typedName is { typeName: string; name: string } => typedName !== undefined)
    .filter(typedName => isDomainType(typedName.typeName, undefined))
    .map(typedName => ({
      kind: "parameter",
      typeName: typedName.typeName,
      name: typedName.name,
      line: startIndex + 1,
      confidence: "high",
      source: "regex-fallback"
    }));
}

function returnRelations(input: ReturnRelationInput): MethodRelationFact[] {
  const { signature, methodName, startIndex, selfType } = input;
  const beforeParameters = signature.slice(0, signature.indexOf("(")).trim();
  const tokens = beforeParameters
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(token => token.length > 0 && !isModifier(token));
  const methodIndex = tokens.lastIndexOf(methodName);
  if (methodIndex <= 0) {
    return [];
  }
  const typeName = normalizeTypeName(tokens[methodIndex - 1]);
  if (!isDomainType(typeName, selfType)) {
    return [];
  }
  return [{ kind: "return", typeName, line: startIndex + 1, confidence: "high", source: "regex-fallback" }];
}

function localReceiverRelations(lines: string[], startIndex: number, selfType: string | undefined): MethodRelationFact[] {
  const relations: MethodRelationFact[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripLineComment(lines[index]).trim();
    const typedName = parseTypedName(code.replace(/=.*/, "").replace(/;.*/, ""));
    if (!typedName || !isDomainType(typedName.typeName, selfType)) {
      continue;
    }
    if (!usesReceiver(lines, typedName.name)) {
      continue;
    }
    relations.push({
      kind: "local-receiver",
      typeName: typedName.typeName,
      name: typedName.name,
      line: startIndex + index + 1,
      confidence: "medium",
      source: "regex-fallback"
    });
  }
  return relations;
}

function fieldReceiverRelations(input: FieldReceiverInput): MethodRelationFact[] {
  const { allLines, methodLines, startIndex, selfType } = input;
  const relations: MethodRelationFact[] = [];
  for (const field of fieldTypes(allLines, selfType)) {
    const useIndex = methodLines.findIndex(line => new RegExp(String.raw`\b${escapeRegex(field.name)}\s*\.`).test(stripLineComment(line)));
    if (useIndex < 0) {
      continue;
    }
    relations.push({
      kind: "field-receiver",
      typeName: field.typeName,
      name: field.name,
      line: startIndex + useIndex + 1,
      confidence: "medium",
      source: "regex-fallback"
    });
  }
  return relations;
}

function fieldTypes(lines: string[], selfType: string | undefined): Array<{ typeName: string; name: string }> {
  const fields: Array<{ typeName: string; name: string }> = [];
  let depth = 0;
  for (const line of lines) {
    const code = stripLineComment(line).trim();
    if (depth === 1 && code.endsWith(";") && !code.includes("(")) {
      const typedName = parseTypedName(code.replace(/=.*/, "").replace(/;.*/, ""));
      if (typedName && isDomainType(typedName.typeName, selfType)) {
        fields.push(typedName);
      }
    }
    depth += braceDelta(code);
  }
  return fields;
}

function parseTypedName(value: string): { typeName: string; name: string } | undefined {
  const tokens = value
    .replace(/@\w+(?:\([^)]*\))?/g, " ")
    .replace(/\bfinal\b/g, " ")
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0 && !isModifier(token));
  if (tokens.length < 2) {
    return undefined;
  }
  const name = tokens[tokens.length - 1].replace(/\[\]$/, "");
  const typeName = normalizeTypeName(tokens[tokens.length - 2]);
  if (!/^[a-z][A-Za-z0-9_]*$/.test(name) || !/^[A-Z][A-Za-z0-9_]*$/.test(typeName)) {
    return undefined;
  }
  return { typeName, name };
}

function normalizeTypeName(value: string): string {
  const trimmed = value.replace(/\[\]$/, "").replace(/<.*$/, "").trim();
  return trimmed.slice(trimmed.lastIndexOf(".") + 1);
}

function isDomainType(typeName: string, selfType: string | undefined): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(typeName) && typeName !== selfType && !NON_DOMAIN_TYPES.has(typeName);
}

function usesReceiver(lines: string[], name: string): boolean {
  const pattern = new RegExp(String.raw`\b${escapeRegex(name)}\s*\.`);
  return lines.some(line => pattern.test(stripLineComment(line)));
}

function isModifier(value: string): boolean {
  return new Set(["public", "private", "protected", "static", "final", "synchronized", "abstract", "default", "native", "volatile", "transient"]).has(value);
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function braceDelta(line: string): number {
  return (line.match(/\{/g) || []).length - (line.match(/}/g) || []).length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
