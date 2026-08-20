// input: Graph search result, JavaIndex-like path facts, token budget.
// output: Planned ContextContract. One worker-side planning step after QUERY_CONTEXT_GRAPH search.
// pos: JIN N4-02/03. Benchmark-only until N5 registers java_context.
import type { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import type { JavaIndexStore } from "../java-index/index-store.js";
import { closeSearchResult, type ClosureFacts } from "./context-closure.js";
import { planEvidenceBundles, DEFAULT_TOKEN_BUDGET } from "./context-planner.js";
import { serializeContext } from "./context-serializer.js";
import { PLANNER_VERSION, StaleSessionError, contextSessions, type ContextContract, type SessionKey } from "./context-contract.js";
import type { SliceMethod } from "./statement-slicer.js";
import type { GraphSearchResult } from "./graph-search.js";
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts, JavaTypeRef } from "../java-index/index-types.js";
import { splitIdentifier } from "../java-index/entity-search.js";

export type PlanQueryInput = {
  graph: KnowledgeGraphStore;
  store?: JavaIndexStore;
  search: GraphSearchResult;
  tokenBudget?: number;
  includeSource?: boolean;
  generation?: number;
  serviceMs?: number;
  anchorLine?: number;
  session?: SessionKey;
};

const HOP0_METHOD_CAP = 8;

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function methodEndLine(method: JavaMethodFacts): number {
  return Math.max(method.range.end.line, method.bodyRange?.end.line ?? method.range.end.line);
}

function methodContainsLine(method: JavaMethodFacts, line: number): boolean {
  return method.range.start.line <= line && methodEndLine(method) >= line;
}

function toSlice(method: JavaMethodFacts): SliceMethod {
  return {
    name: method.name,
    startLine: method.range.start.line,
    endLine: methodEndLine(method),
    bodyStartLine: method.bodyRange?.start.line,
    callSites: method.callSites.map(site => ({ line: site.range.start.line, name: site.name }))
  };
}

function resolvedRepoTypeIds(ref: JavaTypeRef | undefined): string[] {
  if (!ref) return [];
  const ids: string[] = [];
  if (ref.resolution.state === "RESOLVED_REPO") ids.push(ref.resolution.typeId);
  for (const argument of ref.typeArguments) ids.push(...resolvedRepoTypeIds(argument));
  return ids;
}

function hop0Methods(bundle: JavaFileBundle, anchorLine: number): JavaMethodFacts[] {
  const containing = bundle.methods.filter(method => methodContainsLine(method, anchorLine));
  if (containing.length === 0) return [];
  const owners = new Set(containing.map(method => method.ownerTypeId));
  const nearest = bundle.methods
    .filter(method => owners.has(method.ownerTypeId))
    .sort((left, right) => Math.abs(left.range.start.line - anchorLine) - Math.abs(right.range.start.line - anchorLine)
      || left.range.start.line - right.range.start.line);
  const keep = new Map<string, JavaMethodFacts>();
  for (const method of containing) keep.set(method.methodId, method);
  for (const method of nearest) {
    if (keep.size >= HOP0_METHOD_CAP) break;
    keep.set(method.methodId, method);
  }
  return [...keep.values()];
}

function methodsFromStore(store: JavaIndexStore, path: string, graph: KnowledgeGraphStore, provingIds: Set<string>, anchorLine?: number): SliceMethod[] {
  const bundle = store.files([path])[0];
  if (!bundle) return [];
  const wantedMethods = new Set<string>();
  const wantedTypes = new Set<string>();
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (!node?.javaIndexId || node.relativePath !== path) continue;
    if (node.kind === "METHOD" || node.kind === "CONSTRUCTOR") wantedMethods.add(node.javaIndexId);
    if (node.kind === "TYPE" || node.kind === "JPA_ENTITY") wantedTypes.add(node.javaIndexId);
  }
  const matched = bundle.methods.filter(method => wantedMethods.has(method.methodId) || wantedTypes.has(method.ownerTypeId));
  if (matched.length > 0) return matched.map(toSlice);
  const named = new Set<string>();
  for (const id of provingIds) {
    const parts = id.split("#");
    if (parts[2]) named.add(parts[2]);
  }
  if (named.size > 0) {
    const byName = bundle.methods.filter(method => named.has(method.name));
    if (byName.length > 0) return byName.map(toSlice);
  }
  if (anchorLine) return hop0Methods(bundle, anchorLine).map(toSlice);
  return [];
}

export function anchorMethodStartIds(
  graph: KnowledgeGraphStore,
  store: JavaIndexStore | undefined,
  path: string,
  anchorLine: number | undefined
): string[] | undefined {
  if (!store || !anchorLine) return undefined;
  const bundle = store.files([path])[0];
  if (!bundle) return undefined;
  const containing = bundle.methods.filter(method => methodContainsLine(method, anchorLine));
  if (containing.length === 0) return undefined;
  const wanted = new Set<string>();
  for (const method of containing) {
    wanted.add(method.methodId);
    wanted.add(method.ownerTypeId);
  }
  const ids = [...graph.nodesById.entries()]
    .filter(([, node]) => node.relativePath === path && node.javaIndexId !== undefined && wanted.has(node.javaIndexId))
    .map(([id]) => id);
  return ids.length > 0 ? ids : undefined;
}

function simpleNamesOfRef(ref: JavaTypeRef | undefined): string[] {
  if (!ref) return [];
  return [ref.simpleName, ...ref.typeArguments.flatMap(simpleNamesOfRef)].filter(name => name.length > 1);
}

function typeIdByFqn(store: JavaIndexStore, fqn: string): string | undefined {
  return store.typeIdByFqn.get(fqn);
}

function uniqueTypeIdBySimpleName(store: JavaIndexStore, simpleName: string): string | undefined {
  const ids = store.typeIdsBySimpleName.get(simpleName);
  if (!ids || ids.size !== 1) return undefined;
  return [...ids][0];
}

function refTargetsType(ref: JavaTypeRef, target: JavaTypeFacts, store: JavaIndexStore, implementerFile?: string): boolean {
  if (resolvedRepoTypeIds(ref).includes(target.typeId)) return true;
  if (ref.simpleName !== target.simpleName) return false;
  if (target.fqn && ref.qualifiedName === target.fqn) return true;
  if (uniqueTypeIdBySimpleName(store, ref.simpleName) === target.typeId) return true;
  if (!implementerFile || !target.fqn) return false;
  const file = store.filesByPath.get(implementerFile);
  return Boolean(file?.imports.some(item => item.qualifiedName === target.fqn));
}

function implementerTypeIds(store: JavaIndexStore, targetIds: Iterable<string>): string[] {
  const targets = [...targetIds].map(id => store.typesById.get(id)).filter((type): type is JavaTypeFacts => Boolean(type));
  if (targets.length === 0) return [];
  const hits: string[] = [];
  for (const type of store.typesById.values()) {
    const refs = [...type.implements, ...type.extends];
    if (refs.length === 0) continue;
    const implementerFile = relativePathOfFileId(type.fileId);
    if (targets.some(target => refs.some(ref => refTargetsType(ref, target, store, implementerFile)))) hits.push(type.typeId);
  }
  return hits;
}

type DiscoveryKind = "IMPORTS" | "IMPLEMENTS" | "EXTENDS" | "CALLS_EXACT" | "CALLS_VIRTUAL";
type DiscoverySeed = { hops: 1 | 2; kind: DiscoveryKind; names: string[] };

function seedType(seeds: Map<string, DiscoverySeed>, typeId: string, hops: 1 | 2, kind: DiscoveryKind, name?: string): void {
  const previous = seeds.get(typeId);
  if (!previous || hops < previous.hops) {
    seeds.set(typeId, { hops, kind, names: name ? [name] : [] });
    return;
  }
  if (name && !previous.names.includes(name)) previous.names.push(name);
}

function mentionRef(
  store: JavaIndexStore,
  importBySimple: Map<string, string>,
  seeds: Map<string, DiscoverySeed>,
  ref: JavaTypeRef | undefined,
  hops: 1 | 2,
  kind: DiscoveryKind,
  name?: string
): void {
  for (const id of resolvedRepoTypeIds(ref)) seedType(seeds, id, hops, kind, name);
  for (const simple of simpleNamesOfRef(ref)) {
    const imported = importBySimple.get(simple);
    const id = (imported ? typeIdByFqn(store, imported) : undefined) ?? uniqueTypeIdBySimpleName(store, simple);
    if (id) seedType(seeds, id, hops, kind, name);
  }
}

function collectAnchorSeeds(store: JavaIndexStore, bundle: JavaFileBundle, anchorLine: number): Map<string, DiscoverySeed> {
  const hop0 = hop0Methods(bundle, anchorLine);
  const owners = new Set(hop0.map(method => method.ownerTypeId));
  const seeds = new Map<string, DiscoverySeed>();
  for (const owner of owners) seedType(seeds, owner, 1, "IMPORTS");
  const importBySimple = new Map<string, string>();
  for (const item of bundle.file.imports) {
    if (item.wildcard) continue;
    const simple = item.qualifiedName.split(".").pop();
    if (simple) importBySimple.set(simple, item.qualifiedName);
  }
  const mention = (ref: JavaTypeRef | undefined, hops: 1 | 2, kind: DiscoveryKind, name?: string) => {
    mentionRef(store, importBySimple, seeds, ref, hops, kind, name);
  };
  const hop0CallNames = new Set(hop0.flatMap(method => method.callSites.map(site => site.name)));
  const methodTokens = new Set(hop0.flatMap(method => splitIdentifier(method.name)).filter(token => token.length > 2));
  for (const [simple, fqn] of importBySimple) {
    if (!splitIdentifier(simple).some(token => methodTokens.has(token))) continue;
    const id = typeIdByFqn(store, fqn) ?? uniqueTypeIdBySimpleName(store, simple);
    if (id) seedType(seeds, id, 1, "IMPORTS");
  }
  for (const method of hop0) {
    mention(method.returnType, 1, "IMPORTS");
    for (const parameter of method.parameters) mention(parameter.type, 1, "IMPORTS");
    for (const site of method.callSites) {
      mention(site.receiverDeclaredType, 1, "CALLS_EXACT", site.name);
      if (site.receiverText) {
        const field = bundle.fields.find(item => item.name === site.receiverText && owners.has(item.ownerTypeId));
        if (field) mention(field.type, 1, "CALLS_EXACT", site.name);
      }
      for (const ownerId of resolvedRepoTypeIds(site.receiverDeclaredType)) {
        for (const methodId of store.methodIdsByOwnerAndName.get(`${ownerId}#${site.name}`) ?? []) {
          const callee = store.methodsById.get(methodId);
          if (callee) seedType(seeds, callee.ownerTypeId, 1, "CALLS_EXACT", site.name);
        }
      }
    }
  }
  for (const field of bundle.fields) {
    if (!owners.has(field.ownerTypeId)) continue;
    mention(field.type, 1, "IMPORTS");
  }
  const hop1 = [...seeds.keys()];
  for (const id of implementerTypeIds(store, hop1)) seedType(seeds, id, 1, "IMPLEMENTS");
  const hop1AfterImpl = [...seeds.keys()];
  for (const typeId of hop1AfterImpl) {
    const type = store.typesById.get(typeId);
    if (!type) continue;
    const hop1Bundle = store.files([relativePathOfFileId(type.fileId)])[0];
    if (!hop1Bundle) continue;
    const hop1Imports = new Map<string, string>();
    for (const item of hop1Bundle.file.imports) {
      if (item.wildcard) continue;
      const simple = item.qualifiedName.split(".").pop();
      if (simple) hop1Imports.set(simple, item.qualifiedName);
    }
    for (const field of hop1Bundle.fields) {
      if (field.ownerTypeId !== typeId) continue;
      mentionRef(store, hop1Imports, seeds, field.type, 2, "CALLS_VIRTUAL");
    }
    for (const method of hop1Bundle.methods) {
      if (method.ownerTypeId !== typeId || !hop0CallNames.has(method.name)) continue;
      for (const site of method.callSites) {
        mentionRef(store, hop1Imports, seeds, site.receiverDeclaredType, 2, "CALLS_VIRTUAL", site.name);
        if (site.receiverText) {
          const field = hop1Bundle.fields.find(item => item.name === site.receiverText && item.ownerTypeId === typeId);
          if (field) mentionRef(store, hop1Imports, seeds, field.type, 2, "CALLS_VIRTUAL", site.name);
        }
      }
    }
  }
  return seeds;
}

function addDiscoveryBundle(
  extra: GraphSearchResult["bundles"],
  known: Set<string>,
  startPath: string,
  relativePath: string,
  hops: 1 | 2,
  kind: DiscoveryKind,
  toId: string
): void {
  if (!relativePath || relativePath === startPath || known.has(relativePath)) return;
  extra.push({
    path: relativePath,
    hops,
    estimatedTokens: 48,
    provingPath: [{ kind, fromId: startPath, toId }],
    closedObligations: []
  });
  known.add(relativePath);
}

export function attachAnchorSignatureBundles(
  search: GraphSearchResult,
  graph: KnowledgeGraphStore,
  store: JavaIndexStore | undefined,
  path: string,
  anchorLine: number | undefined
): GraphSearchResult {
  if (!store || !anchorLine) return search;
  const bundle = store.files([path])[0];
  if (!bundle) return search;
  const seeds = collectAnchorSeeds(store, bundle, anchorLine);
  const known = new Set(search.bundles.map(item => item.path));
  const extra = [...search.bundles];
  const nodeIdByJavaId = new Map<string, string>();
  for (const [id, node] of graph.nodesById) {
    if (node.javaIndexId) nodeIdByJavaId.set(node.javaIndexId, id);
  }
  for (const [typeId, seed] of seeds) {
    const type = store.typesById.get(typeId);
    if (!type) continue;
    const typeNodeId = nodeIdByJavaId.get(typeId);
    const relative = relativePathOfFileId(type.fileId);
    const toId = seed.names[0]
      ? `${relative}#${type.simpleName}#${seed.names[0]}#n`
      : (typeNodeId ?? typeId);
    addDiscoveryBundle(extra, known, path, relative, seed.hops, seed.kind, toId);
    if (!typeNodeId) continue;
    for (const edge of [...graph.successors(typeNodeId), ...graph.predecessors(typeNodeId)]) {
      if (edge.kind !== "IMPLEMENTS" && edge.kind !== "EXTENDS") continue;
      const otherId = edge.fromId === typeNodeId ? edge.toId : edge.fromId;
      const other = graph.nodesById.get(otherId);
      if (!other?.relativePath) continue;
      addDiscoveryBundle(extra, known, path, other.relativePath, seed.hops, edge.kind === "EXTENDS" ? "EXTENDS" : "IMPLEMENTS", otherId);
    }
  }
  return extra.length === search.bundles.length ? search : { ...search, bundles: extra };
}

function typeRangesFromStore(store: JavaIndexStore, path: string, graph: KnowledgeGraphStore, provingIds: Set<string>): { start: number; end: number }[] {
  const bundle = store.files([path])[0];
  if (!bundle) return [];
  const wantedTypes = new Set<string>();
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (!node?.javaIndexId || node.relativePath !== path) continue;
    if (node.kind === "TYPE" || node.kind === "JPA_ENTITY") wantedTypes.add(node.javaIndexId);
  }
  let types = bundle.types.filter(type => wantedTypes.has(type.typeId));
  if (types.length === 0 && provingIds.size === 0) {
    types = [...bundle.types].sort((left, right) => left.range.start.line - right.range.start.line).slice(0, 1);
  }
  return types.map(type => ({ start: type.range.start.line, end: Math.max(type.range.start.line, type.range.end.line) }));
}

export function factsForStore(graph: KnowledgeGraphStore, store: JavaIndexStore | undefined, path: string, provingIds: Set<string>, anchorLine?: number): ClosureFacts {
  if (!store) return { methods: [] };
  const resource = store.myBatisResource(path);
  const names: string[] = [];
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (node?.simpleName) names.push(node.simpleName);
  }
  const methods = methodsFromStore(store, path, graph, provingIds, anchorLine);
  return {
    methods,
    xml: resource?.statements
      .filter(statement => statement.range)
      .map(statement => ({ start: statement.range!.start.line, end: statement.range!.end.line })),
    types: typeRangesFromStore(store, path, graph, provingIds),
    simpleNames: names
  };
}

export function planContextQuery(input: PlanQueryInput): ContextContract {
  const sessionKey = input.session
    ? { ...input.session, plannerVersion: input.session.plannerVersion || PLANNER_VERSION }
    : undefined;
  if (sessionKey) {
    const existing = contextSessions.lookup(sessionKey);
    if (existing === "STALE") throw new StaleSessionError("STALE_SESSION");
    if (existing) return existing;
  }
  const proving = (path: string) => {
    const candidate = input.search.bundles.find(item => item.path === path);
    const ids = new Set<string>();
    for (const step of candidate?.provingPath ?? []) {
      ids.add(step.fromId);
      ids.add(step.toId);
    }
    return ids;
  };
  const closed = closeSearchResult({
    search: input.search,
    factsForPath: path => factsForStore(input.graph, input.store, path, proving(path), path === input.search.bundles.find(item => item.hops === 0)?.path ? input.anchorLine : undefined),
    includeSource: input.includeSource === true,
    anchorLine: input.anchorLine
  });
  const plan = planEvidenceBundles({
    bundles: closed,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  });
  const contract = serializeContext({
    plan,
    search: input.search,
    includeSource: input.includeSource === true,
    generation: input.generation ?? 0,
    serviceMs: input.serviceMs ?? 0,
    session: input.session
  });
  if (input.session) {
    contextSessions.save({ ...input.session, plannerVersion: input.session.plannerVersion || PLANNER_VERSION }, contract);
  }
  return contract;
}
