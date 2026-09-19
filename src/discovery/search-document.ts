// input: One parsed Java bundle, the file content (for signature slices) and
//         the MyBatis resources whose namespace belongs to this bundle.
// output: Source-linked search documents (signature / direct comment /
//         framework key) with inclusive line ranges and the file content hash
//         they were derived from.
// pos: T05 - Java search text must come from source, not from invented
//         business summaries; secret VALUES are never indexed (safe keys only).
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts } from "../java-index/index-types.js";
import type { MyBatisMapperResourceFacts } from "../java-index/mybatis-types.js";
import { tokenize } from "../java-index/entity-scoring.js";

export type SearchDocumentSourceKind = "signature" | "comment" | "framework-key";

export interface SearchDocument {
  documentId: string;
  declarationId: string;
  path: string;
  contentHash: string;
  representationVersion: 1;
  sourceKind: SearchDocumentSourceKind;
  startLine: number;
  endLine: number;
  normalizedText: string;
}

export const SEARCH_DOCUMENT_REPRESENTATION_VERSION = 1;

export function searchDocumentId(d: Omit<SearchDocument, "documentId">): string {
  return [d.declarationId, d.sourceKind, d.startLine, d.endLine, d.contentHash, d.representationVersion].join("|");
}

type DocInput = Omit<SearchDocument, "documentId" | "normalizedText"> & { text: string };

function finish(input: DocInput): SearchDocument {
  const { text, ...rest } = input;
  const base = { ...rest, normalizedText: redactSecretLiterals(text) };
  return { ...base, documentId: searchDocumentId(base) };
}

const SIGNATURE_MAX_LINES = 5;
const SIGNATURE_MAX_CHARS = 300;

function lineAt(content: string, line: number, maxChars: number): string {
  const lines = content.split(/\r\n|\n|\r/);
  const text = lines[line - 1] ?? "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function signatureText(content: string | undefined, startLine: number, endLine: number): string {
  if (!content) return "";
  const last = Math.min(endLine, startLine + SIGNATURE_MAX_LINES - 1);
  const lines: string[] = [];
  for (let line = startLine; line <= last; line += 1) lines.push(lineAt(content, line, SIGNATURE_MAX_CHARS));
  return lines.join(" ").trim();
}

// Secret-looking keys may be indexed by KEY NAME only; their values must never
// enter a document, summary, or vector input. Route/path-like values are safe.
const SECRET_KEY_PATTERN = /secret|token|password|passwd|credential|api[_-]?key|authorization/i;
const SAFE_VALUE_PATTERN = /^["']?\/[\x21-\x7e]{0,128}["']?$/;

function looksLikeSecretValue(value: string): boolean {
  if (SAFE_VALUE_PATTERN.test(value)) return false;
  return SECRET_KEY_PATTERN.test(value) ||
    (value.length > 32 && /^[\p{L}][$\p{L}\d._-]*$/u.test(value));
}

/** String literals whose values look like credentials are redacted in every
 *  document text, so a secret can never be retrieved, embedded, or echoed -
 *  including inside raw signature lines that carry annotation arguments. */
export function redactSecretLiterals(text: string): string {
  return text.replace(/"([^"]{1,200})"/g, (literal, value: string) =>
    looksLikeSecretValue(value) ? '"<value-redacted>"' : literal
  );
}

function frameworkKeyText(annotationName: string, argumentsText: string | undefined): string {
  if (!argumentsText) return `@${annotationName}`;
  const value = argumentsText.trim().replace(/^["']|["']$/g, "");
  const isSecret = SECRET_KEY_PATTERN.test(annotationName) || looksLikeSecretValue(value) || !SAFE_VALUE_PATTERN.test(value);
  if (isSecret) {
    // Key only: the value may identify a deployment credential and must not
    // be retrievable, embedded, or echoed.
    return `@${annotationName} <value-redacted>`;
  }
  return `@${annotationName} ${value}`;
}

const ROUTE_ANNOTATIONS = new Set([
  "RequestMapping", "GetMapping", "PostMapping", "PutMapping", "PatchMapping", "DeleteMapping",
  "FeignClient", "Mapper", "WebServiceRoute", "MessageMapping"
]);

type DocBuilderArgs = {
  bundle: JavaFileBundle;
  content?: string;
  myBatisResources?: readonly MyBatisMapperResourceFacts[];
};

export function buildSearchDocuments(args: DocBuilderArgs): SearchDocument[] {
  const { bundle, content, myBatisResources = [] } = args;
  const { file } = bundle;
  const docs: SearchDocument[] = [];
  const push = (input: DocInput): void => {
    if (input.text.trim().length === 0) return;
    docs.push(finish(input));
  };
  const base: Pick<SearchDocument, "path" | "contentHash" | "representationVersion"> = {
    path: file.relativePath,
    contentHash: file.contentHash,
    representationVersion: SEARCH_DOCUMENT_REPRESENTATION_VERSION
  };

  const methodByOwnerAndName = new Map<string, JavaMethodFacts[]>();
  for (const method of bundle.methods) {
    const bucket = methodByOwnerAndName.get(`${method.ownerTypeId}#${method.name}`) ?? [];
    bucket.push(method);
    methodByOwnerAndName.set(`${method.ownerTypeId}#${method.name}`, bucket);
  }

  for (const type of bundle.types) {
    const signature = signatureText(content, type.range.start.line, type.range.end.line);
    if (signature) {
      push({ ...base, declarationId: type.typeId, sourceKind: "signature", startLine: type.range.start.line, endLine: type.range.start.line, text: signature });
    }
    if (type.leadingComments) {
      for (const comment of type.leadingComments) {
        push({ ...base, declarationId: type.typeId, sourceKind: "comment", startLine: comment.startLine, endLine: comment.endLine, text: comment.text });
      }
    }
    for (const annotation of type.annotations) {
      if (!ROUTE_ANNOTATIONS.has(annotation.name) || !annotation.argumentsText) continue;
      push({
        ...base,
        declarationId: type.typeId,
        sourceKind: "framework-key",
        startLine: annotation.range.start.line,
        endLine: annotation.range.end.line,
        text: frameworkKeyText(annotation.name, annotation.argumentsText)
      });
    }
    // MyBatis mapper statements bind to the same-named interface method, so a
    // namespace+statement query resolves to the Java declaration, not to the
    // XML file alone.
    if (type.fqn) {
      for (const resource of myBatisResources) {
        if (resource.namespace !== type.fqn) continue;
        for (const statement of resource.statements) {
          const methods = methodByOwnerAndName.get(`${type.typeId}#${statement.id}`) ?? [];
          for (const method of methods) {
            const range = statement.range ?? method.range;
            push({
              ...base,
              declarationId: method.methodId,
              sourceKind: "framework-key",
              startLine: range.start.line,
              endLine: range.end.line,
              text: `mybatis ${statement.kind} ${resource.namespace}.${statement.statementId}`
            });
          }
        }
      }
    }
  }

  for (const method of bundle.methods) {
    const bodyStart = method.bodyRange?.start.line ?? method.range.end.line;
    const endLine = Math.min(bodyStart, method.range.start.line + SIGNATURE_MAX_LINES - 1);
    const signature = signatureText(content, method.range.start.line, endLine);
    if (signature) {
      push({ ...base, declarationId: method.methodId, sourceKind: "signature", startLine: method.range.start.line, endLine, text: signature });
    }
    if (method.leadingComments) {
      for (const comment of method.leadingComments) {
        push({ ...base, declarationId: method.methodId, sourceKind: "comment", startLine: comment.startLine, endLine: comment.endLine, text: comment.text });
      }
    }
  }

  return docs;
}

// Indexing vocabulary for one document: the query side tokenizes with the same
// function (whole identifiers plus camel/snake splits; CJK runs plus bigrams),
// so both sides share one normalization.
export function documentTokens(normalizedText: string): string[] {
  return tokenize(normalizedText);
}