// input: Graph-search file candidates plus per-path method/XML facts.
// output: EvidenceBundle list with statement slices and proving kinds.
// pos: JIN N4-02. Closure is span-level; file merge happens at transport.
import { sliceMethod, type SliceMethod } from "./statement-slicer.js";
import { BYTES_DIV_4, estimateTokens, type Tokenizer } from "./token-estimator.js";
import {
  bundleTokenCost,
  mergeSpans,
  type EvidenceBundle,
  type EvidenceRole,
  type CodeSpan,
  type ProvingStep
} from "./evidence-bundle.js";
import type { GraphSearchResult } from "./graph-search.js";

export type XmlSlice = {
  start: number;
  end: number;
};

export type ClosureFacts = {
  methods: SliceMethod[];
  xml?: XmlSlice[];
  types?: XmlSlice[];
  source?: string;
  simpleNames?: string[];
};

export type ClosureInput = {
  search: GraphSearchResult;
  factsForPath: (path: string) => ClosureFacts;
  tokenizer?: Tokenizer;
  includeSource?: boolean;
  anchorLine?: number;
};

function roleOf(steps: ProvingStep[], hops: number): EvidenceRole {
  if (hops === 0) return "ANCHOR";
  const kinds = steps.map(step => step.kind);
  if (kinds.some(kind => kind.startsWith("MYBATIS") || kind === "JPA_RELATION" || kind === "REPOSITORY_MANAGES_ENTITY" || kind === "SQL_TOUCHES_TABLE")) {
    return "PERSISTENCE";
  }
  if (kinds.some(kind => kind.startsWith("SPRING") || kind === "PUBLISHES_EVENT" || kind === "CONSUMES_EVENT")) {
    return "FRAMEWORK";
  }
  if (kinds.some(kind => kind.startsWith("TEST") || kind === "MOCKS_TYPE" || kind === "USES_FIXTURE")) return "TEST";
  if (kinds.includes("IMPLEMENTS") || kinds.includes("DISPATCHES_TO") || kinds.includes("PERMITS")) return "IMPLEMENTATION";
  if (kinds.includes("CALLED_BY")) return "CALLER";
  if (kinds.some(kind => kind.startsWith("CALLS") || kind === "CONSTRUCTS" || kind === "METHOD_REFERENCE")) return "CALLEE";
  if (kinds.some(kind => kind === "EXTENDS" || kind === "DECLARES" || kind === "IMPORTS")) return "CONTRACT";
  return "DATAFLOW";
}

function relatedNames(steps: ProvingStep[], extra: string[]): string[] {
  const names = [...extra];
  for (const step of steps) {
    for (const id of [step.fromId, step.toId]) {
      const parts = id.split("#");
      if (parts[1]) names.push(parts[1]);
      if (parts[2]) names.push(parts[2]);
    }
  }
  return [...new Set(names.filter(name => name.length > 1))];
}

function xmlSpans(xml: XmlSlice[], source: string | undefined, includeSource: boolean): CodeSpan[] {
  return mergeSpans(xml.map(item => ({
    start: item.start,
    end: Math.max(item.start, item.end),
    bytes: Math.max(1, (Math.max(item.start, item.end) - item.start + 1) * 48),
    ...(includeSource && source
      ? { text: source.split(/\r?\n/).slice(item.start - 1, Math.max(item.start, item.end)).join("\n") }
      : {})
  })));
}

export function closeSearchResult(input: ClosureInput): EvidenceBundle[] {
  const tokenizer = input.tokenizer ?? BYTES_DIV_4;
  const includeSource = input.includeSource === true;
  const anchorCandidate = input.search.bundles.find(item => item.hops === 0);
  const anchorFacts = anchorCandidate ? input.factsForPath(anchorCandidate.path) : { methods: [] as SliceMethod[] };
  const anchorNames = (input.anchorLine
    ? anchorFacts.methods.filter(method => method.startLine <= input.anchorLine! && method.endLine >= input.anchorLine!)
    : anchorFacts.methods).map(method => method.name);
  const bundles: EvidenceBundle[] = [];
  for (const candidate of input.search.bundles) {
    const facts = input.factsForPath(candidate.path);
    const proof = [...new Set(candidate.provingPath.map(step => step.kind))];
    const role = roleOf(candidate.provingPath, candidate.hops);
    const names = relatedNames(candidate.provingPath, [...(facts.simpleNames ?? []), ...anchorNames]);
    const methods = facts.methods;
    const chosen = candidate.hops === 0
      ? methods
      : methods.filter(method => names.some(name => name === method.name));
    const methodSlices: CodeSpan[] = [];
    for (const method of chosen) {
      methodSlices.push(...sliceMethod({
        method,
        source: facts.source,
        relatedNames: [],
        includeText: includeSource
      }));
    }
    const typeFallback = chosen.length === 0 ? (facts.types ?? []) : [];
    const spans = mergeSpans([
      ...methodSlices,
      ...xmlSpans(facts.xml ?? [], facts.source, includeSource),
      ...xmlSpans(typeFallback, facts.source, includeSource)
    ]);
    if (spans.length === 0) {
      if (candidate.hops !== 0) continue;
    }
    const fallback: CodeSpan[] = spans.length > 0
      ? spans
      : [{ start: 1, end: 1, bytes: 48 }];
    const tokenCost = bundleTokenCost(fallback, text => estimateTokens(text, tokenizer));
    bundles.push({
      id: `${candidate.path}#${role}#${candidate.hops}#${fallback.map(span => `${span.start}-${span.end}`).join(",")}`,
      role,
      path: candidate.path,
      proof: proof.slice(0, 6),
      spans: fallback,
      closes: [...new Set(candidate.closedObligations)],
      confidence: Math.max(0.1, 1 - candidate.hops * 0.12),
      tokenCost: Math.max(1, tokenCost),
      latencyCost: candidate.hops,
      hops: candidate.hops,
      provingPath: candidate.provingPath
    });
  }
  return bundles.sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
}
