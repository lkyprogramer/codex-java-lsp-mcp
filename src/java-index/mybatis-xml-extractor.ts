// input: Raw MyBatis mapper XML text plus the resource's relativePath/contentHash/generation
//        (mirrors ast-extractor.ts's ExtractJavaInput convention - the caller has already hashed
//        and stat'd the file, this module only parses).
// output: MyBatisMapperResourceFacts, or undefined when the file's root element is not literally
//         <mapper> (any other resource XML under src/main/resources - Spring beans.xml, web.xml,
//         etc. - is not a MyBatis concern and is never even attempted).
// pos: Task 28 Slice A. fast-xml-parser has no offset/range API (plan's own note), so
//      locateMapperElementRange re-scans the original UTF-8 text with a small hand-rolled
//      tokenizer purely for source ranges; every fact value itself comes from the real parser.
import { XMLParser } from "fast-xml-parser";
import type { SourcePosition, SourceRange } from "../runtime/source-range.js";
import {
  myBatisResourceId,
  myBatisResultMapId,
  myBatisStatementId,
  type MyBatisMapperResourceFacts,
  type MyBatisResultMapFact,
  type MyBatisStatementFact,
  type MyBatisStatementKind
} from "./mybatis-types.js";

export type ExtractMyBatisInput = {
  relativePath: string;
  content: string;
  contentHash: string;
  generation: number;
};

const STATEMENT_KINDS: readonly MyBatisStatementKind[] = ["select", "insert", "update", "delete"];
const ARRAY_TAGS = new Set(["select", "insert", "update", "delete", "resultMap", "include"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: name => ARRAY_TAGS.has(name)
});

const PROLOG_OR_COMMENT = /<\?xml[^>]*\?>|<!--[\s\S]*?-->/g;

function sniffRootTagName(xml: string): string | undefined {
  return /<\s*([A-Za-z][\w.-]*)/.exec(xml.replace(PROLOG_OR_COMMENT, ""))?.[1];
}

/**
 * The same cheap root-tag check extractMyBatisMapperFacts uses to decide
 * whether a file is its concern at all - exported so a manifest scan (which
 * only needs "does this file count as a resource", not a full parse) can
 * reuse the exact inclusion criterion instead of duplicating it.
 */
export function isMyBatisMapperFile(xml: string): boolean {
  return sniffRootTagName(xml) === "mapper";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value !== undefined ? [value] : [];
}

function attr(record: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = record?.[`@_${name}`];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Only a well-formed root <mapper namespace="..."> is a MyBatis resource.
 * A file that looks like it intends to be one (root tag sniffs as "mapper")
 * but fails to parse or carries no namespace is reported as FAILED so a
 * broken mapper stays visible instead of silently vanishing; a file whose
 * root is something else entirely is not our concern and yields undefined.
 */
export function extractMyBatisMapperFacts(input: ExtractMyBatisInput): MyBatisMapperResourceFacts | undefined {
  if (sniffRootTagName(input.content) !== "mapper") return undefined;
  const resourceId = myBatisResourceId(input.relativePath);
  const failed = (): MyBatisMapperResourceFacts => ({
    resourceId,
    relativePath: input.relativePath,
    namespace: "",
    statements: [],
    resultMaps: [],
    includes: [],
    contentHash: input.contentHash,
    generation: input.generation,
    parseState: "FAILED"
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(input.content);
  } catch {
    return failed();
  }
  const mapper = asRecord(asRecord(parsed)?.mapper);
  const namespace = attr(mapper, "namespace");
  if (!mapper || !namespace) return failed();

  const statements: MyBatisStatementFact[] = [];
  const includes: Array<{ fromStatementId: string; refid: string }> = [];
  for (const kind of STATEMENT_KINDS) {
    for (const node of asArray(mapper[kind])) {
      const record = asRecord(node);
      const id = attr(record, "id");
      if (!record || !id) continue;
      const statementId = myBatisStatementId(namespace, id);
      const parameterType = attr(record, "parameterType");
      const resultType = attr(record, "resultType");
      const resultMap = attr(record, "resultMap");
      const range = locateMapperElementRange(input.content, kind, id);
      statements.push({
        statementId,
        namespace,
        id,
        kind,
        ...(parameterType ? { parameterType } : {}),
        ...(resultType ? { resultType } : {}),
        ...(resultMap ? { resultMap } : {}),
        ...(range ? { range } : {})
      });
      for (const includeNode of asArray(record.include)) {
        const refid = attr(asRecord(includeNode), "refid");
        if (refid) includes.push({ fromStatementId: statementId, refid });
      }
    }
  }

  const resultMaps: MyBatisResultMapFact[] = [];
  for (const node of asArray(mapper.resultMap)) {
    const record = asRecord(node);
    const id = attr(record, "id");
    if (!record || !id) continue;
    const type = attr(record, "type");
    const range = locateMapperElementRange(input.content, "resultMap", id);
    resultMaps.push({
      resultMapId: myBatisResultMapId(namespace, id),
      namespace,
      id,
      ...(type ? { type } : {}),
      ...(range ? { range } : {})
    });
  }

  return {
    resourceId,
    relativePath: input.relativePath,
    namespace,
    statements,
    resultMaps,
    includes,
    contentHash: input.contentHash,
    generation: input.generation,
    parseState: "COMPLETE"
  };
}

type XmlTag = {
  kind: "open" | "close" | "selfclose";
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
};

const TAG_NAME = /^([A-Za-z_][\w:.-]*)/;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function scanToUnquotedGt(xml: string, from: number): number {
  let quote: string | undefined;
  for (let j = from; j < xml.length; j++) {
    const ch = xml[j];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === ">") return j;
  }
  return -1;
}

function parseTag(raw: string, start: number, end: number): XmlTag | undefined {
  const closing = raw.startsWith("</");
  const selfClosing = raw.endsWith("/>");
  const inner = raw.slice(closing ? 2 : 1, raw.length - (selfClosing ? 2 : 1)).trim();
  const name = TAG_NAME.exec(inner)?.[1];
  if (!name) return undefined;
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(inner.slice(name.length)))) {
    attrs[match[1]!] = match[3] !== undefined ? match[3] : match[4] ?? "";
  }
  return { kind: closing ? "close" : selfClosing ? "selfclose" : "open", name, attrs, start, end };
}

/** Tokenizes only real element tags - comments, CDATA sections and processing instructions/DOCTYPE are skipped as opaque spans, never mistaken for tags even when their content contains bare `<`/`>`. */
function tokenizeTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt + 4);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const close = xml.indexOf("?>", lt + 2);
      i = close === -1 ? xml.length : close + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const close = scanToUnquotedGt(xml, lt + 2);
      i = close === -1 ? xml.length : close + 1;
      continue;
    }
    const close = scanToUnquotedGt(xml, lt + 1);
    if (close === -1) break;
    const tag = parseTag(xml.slice(lt, close + 1), lt, close + 1);
    if (tag) tags.push(tag);
    i = close + 1;
  }
  return tags;
}

function offsetToPosition(xml: string, offset: number): SourcePosition {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (xml[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * A range for the unique `<tag id="id">...</tag>` (or self-closing) element,
 * or undefined for zero or more-than-one matches, or an unterminated/
 * mismatched element - never a guessed range. Nesting is tracked generically
 * across every tag name encountered after the match, not just `tag` itself,
 * since MyBatis statement bodies commonly nest `<if>`/`<where>`/`<foreach>`.
 */
export function locateMapperElementRange(
  xml: string,
  tag: MyBatisStatementKind | "resultMap",
  id: string
): SourceRange | undefined {
  const tags = tokenizeTags(xml);
  const matches = tags.filter(t => t.name === tag && t.kind !== "close" && t.attrs.id === id);
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (match.kind === "selfclose") {
    return { start: offsetToPosition(xml, match.start), end: offsetToPosition(xml, match.end) };
  }
  const matchIndex = tags.indexOf(match);
  const stack: string[] = [];
  for (let k = matchIndex; k < tags.length; k++) {
    const t = tags[k]!;
    if (t.kind === "open") {
      stack.push(t.name);
    } else if (t.kind === "close") {
      if (stack.length === 0 || stack[stack.length - 1] !== t.name) return undefined;
      stack.pop();
      if (stack.length === 0) return { start: offsetToPosition(xml, match.start), end: offsetToPosition(xml, t.end) };
    }
  }
  return undefined;
}
