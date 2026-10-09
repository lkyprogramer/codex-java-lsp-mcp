// input: One parsed Java bundle, the file content (for signature slices) and
//         the MyBatis resources whose namespace belongs to this bundle.
// output: Source-linked search documents (signature / direct comment /
//         framework key). The target declaration and the evidence source are
//         separate: a MyBatis statement targets the Java mapper method while
//         its source is the XML path/hash/range the text was read from.
// pos: T05 - Java search text must come from source, not from invented
//         business summaries; secret VALUES are never indexed (safe keys only).
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts } from "../java-index/index-types.js";
import type { MyBatisMapperResourceFacts } from "../java-index/mybatis-types.js";
import { tokenize } from "../java-index/entity-scoring.js";

export type SearchDocumentSourceKind = "signature" | "comment" | "framework-key";

/** Where the document text was read from (1-based inclusive lines). */
export type SearchDocumentSource = {
  relativePath: string;
  contentHash: string;
  startLine: number;
  endLine: number;
};

export interface SearchDocument {
  documentId: string;
  /** Target: the Java declaration a hit on this document resolves to. */
  declarationId: string;
  /** Evidence source; the only provenance a preview may be read from. */
  source: SearchDocumentSource;
  /** v1 flat aliases of `source` (set once from it, never independently). */
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  representationVersion: 2;
  sourceKind: SearchDocumentSourceKind;
  normalizedText: string;
}

export const SEARCH_DOCUMENT_REPRESENTATION_VERSION = 2;

type DocIdentity = Pick<SearchDocument, "declarationId" | "sourceKind" | "source" | "representationVersion">;

/** The id names target, kind, source path/range/hash and representation, so
 *  a source change (XML or Java) is a new document, never an in-place reuse. */
export function searchDocumentId(d: DocIdentity): string {
  const { source } = d;
  return [d.declarationId, d.sourceKind, source.relativePath, source.startLine, source.endLine, source.contentHash, d.representationVersion].join("|");
}

type DocInput = Pick<SearchDocument, "declarationId" | "sourceKind" | "source"> & { text: string };

function finish(input: DocInput): SearchDocument {
  const { text, declarationId, sourceKind, source } = input;
  const identity: DocIdentity = { declarationId, sourceKind, source, representationVersion: SEARCH_DOCUMENT_REPRESENTATION_VERSION };
  return {
    documentId: searchDocumentId(identity),
    declarationId,
    source,
    path: source.relativePath,
    contentHash: source.contentHash,
    startLine: source.startLine,
    endLine: source.endLine,
    representationVersion: SEARCH_DOCUMENT_REPRESENTATION_VERSION,
    sourceKind,
    normalizedText: redactSecretLiterals(text)
  };
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

// A secret-named key directly assigned a literal on the same line:
// `String API_TOKEN = "..."`, `"password": "..."`. Name-based, so it also
// catches short values the value-shape test misses; calls such as
// `tokenizer.split(",")` are not assignments and keep their source text. It
// is a limited rule, not a claim to recognise every secret.
const SECRET_ASSIGNMENT_PATTERN = /(secret|token|password|passwd|credential|api[_-]?key|authorization)[\w.-]*["']?\s*[=:]\s*"/i;

/** Preview-side redaction of one physical source line (terminator kept). */
export function redactPreviewLine(line: string): string {
  const redacted = redactSecretLiterals(line);
  if (!SECRET_ASSIGNMENT_PATTERN.test(redacted)) return redacted;
  return redacted.replace(/"([^"]{1,200})"/g, (literal, value: string) =>
    value === "<value-redacted>" || SAFE_VALUE_PATTERN.test(value) ? literal : '"<value-redacted>"'
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

function methodsByOwnerAndName(bundle: JavaFileBundle): Map<string, JavaMethodFacts[]> {
  const byKey = new Map<string, JavaMethodFacts[]>();
  for (const method of bundle.methods) {
    const bucket = byKey.get(`${method.ownerTypeId}#${method.name}`) ?? [];
    bucket.push(method);
    byKey.set(`${method.ownerTypeId}#${method.name}`, bucket);
  }
  return byKey;
}

// MyBatis mapper statements target the same-named interface method (so a
// namespace+statement query resolves to the Java declaration), but their
// evidence source is the XML element: XML path, XML hash, XML lines. A
// statement without a located element range has no source range and gets no
// document - it is never re-labelled with Java lines.
function pushMyBatisDocuments(
  type: JavaTypeFacts,
  methods: ReadonlyMap<string, JavaMethodFacts[]>,
  resources: readonly MyBatisMapperResourceFacts[],
  push: (input: DocInput) => void
): void {
  if (!type.fqn) return;
  for (const resource of resources) {
    if (resource.namespace !== type.fqn) continue;
    for (const statement of resource.statements) {
      if (!statement.range) continue;
      for (const method of methods.get(`${type.typeId}#${statement.id}`) ?? []) {
        push({
          declarationId: method.methodId,
          sourceKind: "framework-key",
          source: {
            relativePath: resource.relativePath,
            contentHash: resource.contentHash,
            startLine: statement.range.start.line,
            endLine: statement.range.end.line
          },
          text: `mybatis ${statement.kind} ${resource.namespace}.${statement.statementId}`
        });
      }
    }
  }
}

function collector(): { docs: SearchDocument[]; push: (input: DocInput) => void } {
  const docs: SearchDocument[] = [];
  return {
    docs,
    push: input => {
      if (input.text.trim().length === 0) return;
      docs.push(finish(input));
    }
  };
}

/** Only the XML-sourced documents of one Java bundle: used when a mapper XML
 *  changes while the Java file (and its own documents) did not. */
export function buildMyBatisSearchDocuments(args: { bundle: JavaFileBundle; myBatisResources: readonly MyBatisMapperResourceFacts[] }): SearchDocument[] {
  const { docs, push } = collector();
  const methods = methodsByOwnerAndName(args.bundle);
  for (const type of args.bundle.types) pushMyBatisDocuments(type, methods, args.myBatisResources, push);
  return docs;
}

export function buildSearchDocuments(args: DocBuilderArgs): SearchDocument[] {
  const { bundle, content, myBatisResources = [] } = args;
  const { file } = bundle;
  const { docs, push } = collector();
  const java = (startLine: number, endLine: number): SearchDocumentSource => ({
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    startLine,
    endLine
  });
  const methods = methodsByOwnerAndName(bundle);

  for (const type of bundle.types) {
    const signature = signatureText(content, type.range.start.line, type.range.end.line);
    if (signature) {
      push({ declarationId: type.typeId, sourceKind: "signature", source: java(type.range.start.line, type.range.start.line), text: signature });
    }
    if (type.leadingComments) {
      for (const comment of type.leadingComments) {
        push({ declarationId: type.typeId, sourceKind: "comment", source: java(comment.startLine, comment.endLine), text: comment.text });
      }
    }
    for (const annotation of type.annotations) {
      if (!ROUTE_ANNOTATIONS.has(annotation.name) || !annotation.argumentsText) continue;
      push({
        declarationId: type.typeId,
        sourceKind: "framework-key",
        source: java(annotation.range.start.line, annotation.range.end.line),
        text: frameworkKeyText(annotation.name, annotation.argumentsText)
      });
    }
    pushMyBatisDocuments(type, methods, myBatisResources, push);
  }

  for (const method of bundle.methods) {
    const bodyStart = method.bodyRange?.start.line ?? method.range.end.line;
    const endLine = Math.min(bodyStart, method.range.start.line + SIGNATURE_MAX_LINES - 1);
    const signature = signatureText(content, method.range.start.line, endLine);
    if (signature) {
      push({ declarationId: method.methodId, sourceKind: "signature", source: java(method.range.start.line, endLine), text: signature });
    }
    if (method.leadingComments) {
      for (const comment of method.leadingComments) {
        push({ declarationId: method.methodId, sourceKind: "comment", source: java(comment.startLine, comment.endLine), text: comment.text });
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