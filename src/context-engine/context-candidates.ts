// input: Graph-search frontier bundles plus packed evidence paths.
// output: Path-level candidates[] and copy-pasteable next[] for the C1 contract.
// pos: JIN harvest C1. Does not rank, pack, or change graph search.
import type { EvidenceBundleCandidate } from "./graph-search.js";
import type { ContextCandidate, ContextNext } from "./context-contract.js";

export const CANDIDATE_FRONTIER_N = 24;
export const CANDIDATE_WIRE_N = 24;
export const CANDIDATE_FRONTIER_N_MAX = 40;
export const EVIDENCE_FILE_CAP = 3;
/** Hop-2 persistence / name-near files reserved after hop-1 core, so hop-1 holdouts are not displaced. */
export const WIRE_HOP2_SLOTS = 4;
/** Hop-1 CONTRACT reserved so DTOs are not dropped when hop-1 CALLS fill the cap. */
export const WIRE_HOP1_CONTRACT_SLOTS = 4;
const WIRE_NAME_STOP = new Set([
  "service", "impl", "default", "abstract", "base", "manager", "controller",
  "repository", "mapper", "util", "utils", "helper", "common", "config",
  "exception", "error", "handler", "listener", "interceptor", "filter",
  "aspect", "factory", "builder", "properties", "configuration",
  "application", "infrastructure", "persistence", "constant",
  "storage", "gateway", "object", "provider"
]);
const BOILERPLATE_WIRE_PATH = /(?:ErrorCode|ErrorMessage|Constant|CommonResult|CommonsResult|ResultCode)\.java$/i;

export function formatSpanRanges(spans: Array<{ start: number; end: number }> | undefined): string {
  const merged: Array<{ start: number; end: number }> = [];
  const ordered = [...(spans ?? [])]
    .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end))
    .map(span => ({
      start: Math.min(span.start, span.end),
      end: Math.max(span.start, span.end)
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.map(span => `${span.start}-${span.end}`).join(",");
}

export function parseSpanRanges(ranges: string | undefined): Array<{ start: number; end: number }> {
  if (!ranges) return [];
  return ranges.split(",").map(part => {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = Number(endText);
    return { start, end: Number.isFinite(end) ? end : start };
  }).filter(span => Number.isFinite(span.start));
}

export function capEvidenceByFile<T extends { path: string }>(items: T[], cap = EVIDENCE_FILE_CAP): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items ?? []) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

export function symbolFromNodeId(id: string): string {
  const parts = String(id).split("#");
  const type = parts[1] || "";
  const method = parts[2] || "";
  if (type && method) return `${type}.${method}`;
  if (type) return type;
  const base = String(id).split("/").pop() ?? String(id);
  return base.replace(/\.java$/i, "") || String(id);
}

export function candidateRole(bundle: Pick<EvidenceBundleCandidate, "hops" | "provingPath">): string {
  if (bundle.hops === 0) return "ANCHOR";
  const kinds = (bundle.provingPath ?? []).map(step => step.kind);
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

export function candidateReason(bundle: EvidenceBundleCandidate): string {
  const step = bundle.provingPath?.[0];
  if (!step) return bundle.hops === 0 ? "ANCHOR" : "DISCOVERED";
  return `${step.kind}←${symbolFromNodeId(step.fromId)}`;
}

function isTestWirePath(path: string): boolean {
  return path.includes("/src/test/") || path.includes("/test/java/") || /Test\.java$/i.test(path);
}

/** Lower is kept first on the N=24 wire. Hop still leads; proof role beats path order. */
export function wireRank(bundle: Pick<EvidenceBundleCandidate, "hops" | "provingPath" | "path">): number {
  if (bundle.hops === 0) return 0;
  if (isTestWirePath(bundle.path ?? "") || candidateRole(bundle) === "TEST") return 90;
  switch (candidateRole(bundle)) {
    case "PERSISTENCE": return 10;
    case "IMPLEMENTATION": return 12;
    case "CALLEE":
    case "CALLER": return 14;
    case "FRAMEWORK": return 16;
    case "CONTRACT": return 30;
    default: return 40;
  }
}

function compareWire(left: EvidenceBundleCandidate, right: EvidenceBundleCandidate): number {
  return wireRank(left) - wireRank(right) || left.hops - right.hops || left.path.localeCompare(right.path);
}

function isPersistenceProving(bundle: EvidenceBundleCandidate): boolean {
  return candidateRole(bundle) === "PERSISTENCE";
}

function isPersistenceLayout(path: string): boolean {
  return /\/(persistence|mapper|repository|entity)\//i.test(path) || /(?:Mapper|Repository)\.java$/i.test(path);
}

function isHop2WireFocus(bundle: EvidenceBundleCandidate, hop0Tokens: Set<string>): boolean {
  return tokenOverlap(bundle.path, hop0Tokens) > 0 || isPersistenceProving(bundle) || isPersistenceLayout(bundle.path);
}

export function isBoilerplateWirePath(path: string): boolean {
  return BOILERPLATE_WIRE_PATH.test(path);
}

function layoutPrefix(path: string): string {
  const src = path.indexOf("/src/");
  if (src >= 0) return path.slice(0, src);
  if (path === "src" || path.startsWith("src/")) return "src";
  return path.split("/").slice(0, 2).join("/");
}

function pathNameTokens(path: string): Set<string> {
  const base = path.split("/").pop()?.replace(/\.java$/i, "") ?? "";
  return new Set(
    base.split(/(?=[A-Z0-9])/).map(part => part.toLowerCase()).filter(part => part.length > 3 && !WIRE_NAME_STOP.has(part))
  );
}

function tokensOf(paths: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const path of paths) for (const token of pathNameTokens(path)) tokens.add(token);
  return tokens;
}

function tokensMatch(left: string, right: string): boolean {
  if (left === right) return true;
  return left.length > 3 && right.length > 3 && (left.startsWith(right) || right.startsWith(left));
}

function tokenOverlapHits(path: string, tokens: Set<string>): string[] {
  const hits: string[] = [];
  for (const part of pathNameTokens(path)) {
    for (const token of tokens) {
      if (!tokensMatch(part, token)) continue;
      hits.push(part.length >= token.length ? part : token);
      break;
    }
  }
  return hits;
}

function tokenOverlap(path: string, tokens: Set<string>): number {
  return tokenOverlapHits(path, tokens).length;
}

function tokenOverlapLength(path: string, tokens: Set<string>): number {
  return tokenOverlapHits(path, tokens).reduce((sum, token) => sum + token.length, 0);
}

function javaBaseName(path: string): string {
  return path.split("/").pop()?.replace(/\.java$/i, "") ?? "";
}

function companionNames(paths: readonly string[], tokenSet: Set<string> = new Set(), hop0Tokens: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const base = javaBaseName(path);
    if (base.endsWith("Impl") && base.length > 4) names.add(base.slice(0, -4));
    if (base.startsWith("Default") && base.length > 7) names.add(base.slice(7));
    if (base.endsWith("Repository") && base.length > 10) names.add(base.slice(0, -10));
    if ((base.endsWith("ServiceImpl") && base.length > 11)
      || (base.endsWith("Service") && !base.endsWith("ServiceImpl") && base.length > 7)) {
      const stem = base.endsWith("ServiceImpl") ? base.slice(0, -11) : base.slice(0, -7);
      const template = `${stem}Template`;
      const rest = tokensOf(paths.filter(item => item !== path));
      const templateFile = `${template}.java`;
      if (tokenOverlap(templateFile, hop0Tokens) === 0
        && (tokenOverlap(`${base}.java`, rest) > 0 || tokenOverlap(templateFile, rest) > 0)) {
        names.add(template);
      }
    }
    if (base.length > 3 && !/(?:Impl|Service|Repository|Controller|Mapper|Template|DTO|VO|Enum)$/.test(base)) {
      names.add(`${base}Repository`);
    }
  }
  return names;
}

function controllerStems(paths: readonly string[]): string[] {
  return [...new Set(
    paths.map(javaBaseName)
      .filter(base => base.endsWith("Controller") && base.length > 18)
      .map(base => base.slice(0, -10))
      .filter(stem => stem.length > 8)
  )];
}

function fileOfStep(id: string): string {
  return String(id).split("#")[0] ?? "";
}

function provingTouches(bundle: EvidenceBundleCandidate, paths: Set<string>): boolean {
  for (const step of bundle.provingPath ?? []) {
    if (paths.has(fileOfStep(step.fromId)) || paths.has(fileOfStep(step.toId))) return true;
  }
  return false;
}

function isCompanionPath(path: string, companions: Set<string>, stems: readonly string[] = []): boolean {
  return companionRank(path, companions, stems) > 0;
}

function companionRank(path: string, companions: Set<string>, stems: readonly string[] = []): number {
  const base = javaBaseName(path);
  if (companions.has(base) && /Template$/.test(base)) return 3;
  if (companions.has(base) && /(?:Service|Repository)$/.test(base)) return 2;
  if (stems.some(stem => base.startsWith(stem))) return 2;
  if (companions.has(base)) return 1;
  return 0;
}

function exactTokenOverlap(path: string, tokens: Set<string>): number {
  let count = 0;
  for (const part of pathNameTokens(path)) if (tokens.has(part)) count += 1;
  return count;
}

function hop2PickRank(
  bundle: EvidenceBundleCandidate,
  companions: Set<string>,
  stems: readonly string[],
  hop1Paths: Set<string>,
  anchorPrefix: string,
  serviceTokens: Set<string>
): number {
  const named = companionRank(bundle.path, companions, stems);
  if (named === 3) return 3;
  const role = candidateRole(bundle);
  if (layoutPrefix(bundle.path) !== anchorPrefix && provingTouches(bundle, hop1Paths)
    && role === "CALLEE" && !/Controller\.java$/i.test(bundle.path)) {
    return 3;
  }
  if ((isPersistenceProving(bundle) || isPersistenceLayout(bundle.path)) && exactTokenOverlap(bundle.path, serviceTokens) > 0) {
    return 2;
  }
  return named;
}

function compareNearAnchor(
  left: EvidenceBundleCandidate,
  right: EvidenceBundleCandidate,
  hop0Tokens: Set<string>,
  anchorPrefix: string,
  companions?: Set<string>,
  stems: readonly string[] = [],
  pairFirst = false,
  hop2Rank?: (bundle: EvidenceBundleCandidate) => number
): number {
  const rankOf = hop2Rank ?? ((bundle: EvidenceBundleCandidate) => companionRank(bundle.path, companions ?? new Set(), stems));
  const pair = rankOf(right) - rankOf(left);
  if (pairFirst && pair) return pair;
  return tokenOverlap(right.path, hop0Tokens) - tokenOverlap(left.path, hop0Tokens)
    || tokenOverlapLength(right.path, hop0Tokens) - tokenOverlapLength(left.path, hop0Tokens)
    || (!pairFirst ? pair : 0)
    || Number(isPersistenceProving(right) || isPersistenceLayout(right.path))
      - Number(isPersistenceProving(left) || isPersistenceLayout(left.path))
    || Number(/Impl\.java$/i.test(left.path)) - Number(/Impl\.java$/i.test(right.path))
    || Number(layoutPrefix(right.path) === anchorPrefix) - Number(layoutPrefix(left.path) === anchorPrefix)
    || left.hops - right.hops
    || left.path.localeCompare(right.path);
}

export function frontierCandidates(
  bundles: EvidenceBundleCandidate[],
  limit = CANDIDATE_FRONTIER_N
): ContextCandidate[] {
  const byPath = new Map<string, EvidenceBundleCandidate>();
  for (const bundle of bundles ?? []) {
    if (typeof bundle?.path !== "string" || !bundle.path) continue;
    const existing = byPath.get(bundle.path);
    if (!existing || bundle.hops < existing.hops) byPath.set(bundle.path, bundle);
  }
  const cap = Math.min(CANDIDATE_FRONTIER_N_MAX, Math.max(0, limit));
  const hop0: EvidenceBundleCandidate[] = [];
  const hop1: EvidenceBundleCandidate[] = [];
  const hop2: EvidenceBundleCandidate[] = [];
  const tests: EvidenceBundleCandidate[] = [];
  for (const bundle of byPath.values()) {
    if (isTestWirePath(bundle.path) || candidateRole(bundle) === "TEST") tests.push(bundle);
    else if (bundle.hops === 0) hop0.push(bundle);
    else if (bundle.hops === 1) hop1.push(bundle);
    else hop2.push(bundle);
  }
  hop0.sort((left, right) => left.path.localeCompare(right.path));
  const hop0Tokens = tokensOf(hop0.map(item => item.path));
  const anchorPrefix = layoutPrefix(hop0[0]?.path ?? "");
  hop1.sort((left, right) => tokenOverlap(right.path, hop0Tokens) - tokenOverlap(left.path, hop0Tokens) || compareWire(left, right));
  hop2.sort((left, right) => compareNearAnchor(left, right, hop0Tokens, anchorPrefix));
  tests.sort(compareWire);
  const hop1Contract = hop1.filter(bundle => candidateRole(bundle) === "CONTRACT");
  const hop1Core = hop1.filter(bundle => candidateRole(bundle) !== "CONTRACT");
  const hop1ContractFocus = hop1Contract.filter(bundle => !isBoilerplateWirePath(bundle.path));
  const hop2Focus = hop2.filter(bundle => !isBoilerplateWirePath(bundle.path) && isHop2WireFocus(bundle, hop0Tokens));
  const selected: EvidenceBundleCandidate[] = [];
  const used = new Set<string>();
  const push = (items: readonly EvidenceBundleCandidate[]) => {
    for (const item of items) {
      if (selected.length >= cap) return;
      if (used.has(item.path)) continue;
      used.add(item.path);
      selected.push(item);
    }
  };
  push(hop0);
  const hop2Reserve = hop2Focus.length > 0 ? Math.min(WIRE_HOP2_SLOTS, hop2Focus.length, cap - selected.length) : 0;
  const contractReserve = hop1ContractFocus.length > 0
    ? Math.min(WIRE_HOP1_CONTRACT_SLOTS, hop1ContractFocus.length, Math.max(0, cap - selected.length - hop2Reserve))
    : 0;
  const hop1CoreRoom = Math.max(0, cap - selected.length - hop2Reserve - contractReserve);
  push(hop1Core.slice(0, hop1CoreRoom));
  const selectedPaths = selected.map(item => item.path);
  const selectedTokens = tokensOf(selectedPaths);
  const hop1Paths = new Set(selected.filter(item => item.hops === 1).map(item => item.path));
  const serviceTokens = tokensOf(selectedPaths.filter(path => /Service(?:Impl)?\.java$/i.test(path)));
  const companions = companionNames(selectedPaths, selectedTokens, hop0Tokens);
  const stems = controllerStems([...hop0.map(item => item.path), ...selectedPaths]);
  const rankHop2 = (bundle: EvidenceBundleCandidate) => hop2PickRank(bundle, companions, stems, hop1Paths, anchorPrefix, serviceTokens);
  const hop2Near = hop2
    .filter(bundle => !used.has(bundle.path) && !isBoilerplateWirePath(bundle.path)
      && (isHop2WireFocus(bundle, hop0Tokens) || tokenOverlap(bundle.path, selectedTokens) > 0
        || provingTouches(bundle, hop1Paths) || rankHop2(bundle) > 0))
    .sort((left, right) => compareNearAnchor(left, right, selectedTokens, anchorPrefix, companions, stems, true, rankHop2));
  const hop1ContractNear = hop1ContractFocus
    .filter(bundle => !used.has(bundle.path))
    .sort((left, right) => compareNearAnchor(left, right, selectedTokens, anchorPrefix, companions, [], true));
  push(hop2Near.slice(0, hop2Reserve));
  push(hop1ContractNear.slice(0, contractReserve));
  push(hop1Core);
  push(hop1Contract);
  push(hop2Focus);
  push(hop2);
  push(tests);
  return selected.slice(0, cap).map(bundle => ({
    path: bundle.path,
    role: candidateRole(bundle),
    hop: bundle.hops,
    reason: candidateReason(bundle)
  }));
}

export function looksLikePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".java");
}

export function unresolvedWire(items: Array<{ id?: string; path?: string; role: string }>): Array<{ path: string; role: string }> {
  const out: Array<{ path: string; role: string }> = [];
  for (const item of items ?? []) {
    const path = item.path || (item.id && looksLikePath(item.id) ? item.id : "");
    if (!path) continue;
    out.push({ path, role: item.role });
  }
  return out.slice(0, 8);
}

export function nextSteps(input: {
  unresolved: Array<{ id: string; role: string }>;
  candidates: ContextCandidate[];
  evidence: Array<{ path: string }>;
  anchorPath: string;
}): ContextNext[] {
  const packed = new Set((input.evidence ?? []).map(item => item.path));
  const unused = (input.candidates ?? []).filter(item => !packed.has(item.path));
  return (input.unresolved ?? []).slice(0, 8).map((item, index) => {
    const fromId = looksLikePath(item.id) ? item.id : undefined;
    const fallback = unused[index] ?? unused[0];
    const file = fromId ?? fallback?.path ?? input.anchorPath ?? "";
    const cand = (input.candidates ?? []).find(row => row.path === file);
    const direction = cand?.role === "CALLER" ? "callers" as const : cand?.role === "CALLEE" ? "callees" as const : undefined;
    const closure = cand?.role === "PERSISTENCE" ? "persistence" as const : cand?.role === "FRAMEWORK" ? "framework" as const : undefined;
    return {
      action: file && !packed.has(file) ? "navigate" : "expand",
      file,
      line: 1,
      ...(direction ? { direction } : {}),
      ...(closure ? { closure } : {}),
      reason: item.role
    };
  });
}
