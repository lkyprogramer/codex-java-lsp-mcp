// input: One method range, optional source, and obligation-related names.
// output: Statement slices that stay inside the method. Uncertain → whole method.
// pos: JIN N4-01. Conservative: no type-header padding; no camelCase fragment match.
import { estimateSpanBytes } from "./token-estimator.js";
import { mergeSpans, type CodeSpan } from "./evidence-bundle.js";

export type SliceCallSite = {
  line: number;
  name: string;
};

export type SliceMethod = {
  name: string;
  startLine: number;
  endLine: number;
  bodyStartLine?: number;
  callSites?: SliceCallSite[];
};

export type SliceRequest = {
  method: SliceMethod;
  source?: string;
  relatedNames?: string[];
  includeText?: boolean;
};

const CONTEXT_PAD = 2;
const LARGE_METHOD_LINES = 80;
const LARGE_METHOD_WINDOW = 40;

function clamp(line: number, start: number, end: number): number {
  return Math.min(end, Math.max(start, line));
}

function wholeLexeme(line: string, name: string): boolean {
  if (!name) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?:[^A-Za-z0-9_]|$)`).test(line);
  }
  return line.includes(name);
}

function spanFor(start: number, end: number, method: SliceMethod, source: string | undefined, includeText: boolean): CodeSpan {
  const s = clamp(start, method.startLine, method.endLine);
  const e = clamp(end, method.startLine, method.endLine);
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  const text = includeText && source
    ? source.split(/\r?\n/).slice(lo - 1, hi).join("\n")
    : undefined;
  return {
    start: lo,
    end: hi,
    bytes: estimateSpanBytes(lo, hi, source),
    ...(text === undefined ? {} : { text })
  };
}

export function sliceMethod(request: SliceRequest): CodeSpan[] {
  const method = request.method;
  const start = method.startLine;
  const end = Math.max(start, method.endLine);
  const bounded: SliceMethod = { ...method, startLine: start, endLine: end };
  const names = [...new Set((request.relatedNames ?? []).filter(name => name.length > 1))];
  const signatureEnd = clamp(method.bodyStartLine ?? start, start, end);
  const signature = spanFor(start, signatureEnd, bounded, request.source, request.includeText === true);
  const bodyLines = end - Math.max(start, signatureEnd);
  const hits: number[] = [];
  for (const site of method.callSites ?? []) {
    if (names.length === 0 || names.some(name => name === site.name || wholeLexeme(site.name, name))) {
      if (site.line >= start && site.line <= end) hits.push(site.line);
    }
  }
  if (request.source && names.length > 0) {
    const lines = request.source.split(/\r?\n/);
    for (let line = Math.max(start, signatureEnd); line <= end; line += 1) {
      const text = lines[line - 1] ?? "";
      if (names.some(name => wholeLexeme(text, name))) hits.push(line);
    }
  }
  const uniqueHits = [...new Set(hits)].sort((left, right) => left - right);
  if (uniqueHits.length === 0) {
    if (bodyLines + 1 <= LARGE_METHOD_LINES) {
      return [spanFor(start, end, bounded, request.source, request.includeText === true)];
    }
    const windowEnd = clamp(start + LARGE_METHOD_WINDOW - 1, start, end);
    return mergeSpans([
      spanFor(start, windowEnd, bounded, request.source, request.includeText === true)
    ]);
  }
  const windows = uniqueHits.map(line => spanFor(line - CONTEXT_PAD, line + CONTEXT_PAD, bounded, request.source, request.includeText === true));
  return mergeSpans([signature, ...windows]);
}

export function spansStayInsideMethod(spans: CodeSpan[], method: Pick<SliceMethod, "startLine" | "endLine">): boolean {
  return spans.every(span => span.start >= method.startLine && span.end <= method.endLine && span.start <= span.end);
}
