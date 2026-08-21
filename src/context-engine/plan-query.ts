// input: Graph search result, JavaIndex-like path facts, token budget.
// output: Planned ContextContract. One worker-side planning step after QUERY_CONTEXT_GRAPH search.
// pos: JIN N4-02/03 planner. N5 java_context calls QUERY_CONTEXT_GRAPH plan=true.
import type { EdgeKind } from "../java-knowledge/edge-kinds.js";
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
const HOP2_TYPE_CAP = 8;

const NOISE_CALL_NAMES = new Set([
  "stream", "map", "filter", "collect", "toList", "toArray", "of", "get", "isEmpty",
  "equals", "hashCode", "toString", "orElse", "orElseGet", "orElseThrow", "findFirst",
  "findAny", "forEach", "iterator", "count", "min", "max", "distinct", "sorted", "limit",
  "skip", "anyMatch", "allMatch", "noneMatch", "reduce", "flatMap", "peek", "add", "put",
  "contains", "size", "length", "getClass"
]);

function neighborhoodCallName(name: string, receiverText?: string): boolean {
  if (name.length < 3 || NOISE_CALL_NAMES.has(name)) return false;
  if (/^(findById|save|insert|update|delete|count|exists)$|^(findBy|listBy|countBy|existsBy|deleteBy)[A-Z]/.test(name)) return false;
  if (receiverText && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(receiverText)) return false;
  return true;
}

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

function importBySimpleName(bundle: JavaFileBundle): Map<string, string> {
  const imports = new Map<string, string>();
  for (const item of bundle.file.imports) {
    if (item.wildcard) continue;
    const simple = item.qualifiedName.split(".").pop();
    if (simple) imports.set(simple, item.qualifiedName);
  }
  return imports;
}

function typeModule(store: JavaIndexStore | undefined, bundle: JavaFileBundle, ref: JavaTypeRef | undefined): string | undefined {
  if (!store || !ref) return undefined;
  const ids = [...resolvedRepoTypeIds(ref)];
  if (ids.length === 0) {
    const imported = importBySimpleName(bundle).get(ref.simpleName);
    const id = imported ? typeIdByFqn(store, imported) : undefined;
    if (id) ids.push(id);
  }
  for (const id of ids) {
    const type = store.typesById.get(id);
    if (!type) continue;
    return store.filesByPath.get(relativePathOfFileId(type.fileId))?.module;
  }
  return undefined;
}

function hop0Methods(bundle: JavaFileBundle, anchorLine: number, store?: JavaIndexStore): JavaMethodFacts[] {
  const containing = bundle.methods.filter(method => methodContainsLine(method, anchorLine));
  if (containing.length === 0) return [];
  const owners = new Set(containing.map(method => method.ownerTypeId));
  const keep = new Map<string, JavaMethodFacts>();
  for (const method of containing) keep.set(method.methodId, method);
  const oneLevelNames = new Set(
    containing.flatMap(method => method.callSites.filter(site => neighborhoodCallName(site.name, site.receiverText)).map(site => site.name))
  );
  const extras = bundle.methods.filter(method => owners.has(method.ownerTypeId) && !keep.has(method.methodId) && oneLevelNames.has(method.name));
  const fieldOf = (method: JavaMethodFacts, site: JavaMethodFacts["callSites"][number]) =>
    bundle.fields.find(field => field.name === site.receiverText && owners.has(field.ownerTypeId));
  const hasFieldCall = (method: JavaMethodFacts) => method.callSites.some(site =>
    neighborhoodCallName(site.name, site.receiverText)
    && Boolean(site.receiverText)
    && Boolean(fieldOf(method, site))
  );
  const hasCrossModuleFieldCall = (method: JavaMethodFacts) => method.callSites.some(site => {
    if (!neighborhoodCallName(site.name, site.receiverText) || !site.receiverText) return false;
    const field = fieldOf(method, site);
    if (!field) return false;
    const module = typeModule(store, bundle, field.type);
    return Boolean(module && bundle.file.module && module !== bundle.file.module);
  });
  extras.sort((left, right) => Number(hasCrossModuleFieldCall(right)) - Number(hasCrossModuleFieldCall(left))
    || Number(hasFieldCall(right)) - Number(hasFieldCall(left))
    || Math.abs(left.range.start.line - anchorLine) - Math.abs(right.range.start.line - anchorLine)
    || left.range.start.line - right.range.start.line);
  const extraCap = Math.min(HOP0_METHOD_CAP, containing.length + 2);
  for (const method of extras) {
    if (keep.size >= extraCap) break;
    keep.set(method.methodId, method);
  }
  return [...keep.values()];
}

function sameFileCallees(bundle: JavaFileBundle, selected: JavaMethodFacts[]): JavaMethodFacts[] {
  if (selected.length === 0) return [];
  const keep = new Map(selected.map(method => [method.methodId, method]));
  const owners = new Set(selected.map(method => method.ownerTypeId));
  const names = new Set(
    selected.flatMap(method => method.callSites.filter(site => neighborhoodCallName(site.name, site.receiverText)).map(site => site.name))
  );
  const extras = bundle.methods.filter(method => owners.has(method.ownerTypeId) && !keep.has(method.methodId) && names.has(method.name));
  extras.sort((left, right) => (right.range.end.line - right.range.start.line) - (left.range.end.line - left.range.start.line)
    || left.range.start.line - right.range.start.line);
  for (const method of extras) {
    if (keep.size >= selected.length + 1) break;
    keep.set(method.methodId, method);
  }
  return [...keep.values()];
}

function methodsFromStore(store: JavaIndexStore, path: string, graph: KnowledgeGraphStore, provingIds: Set<string>, anchorLine?: number): SliceMethod[] {
  const bundle = store.files([path])[0];
  if (!bundle) return [];
  const wantedMethods = new Set<string>();
  const named = new Set<string>();
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (node?.javaIndexId && node.relativePath === path) {
      if (node.kind === "METHOD" || node.kind === "CONSTRUCTOR") wantedMethods.add(node.javaIndexId);
    }
    const parts = id.split("#");
    if (parts[2] && parts.length >= 3) named.add(parts[2]);
  }
  const selected = bundle.methods.filter(method => wantedMethods.has(method.methodId) || named.has(method.name));
  if (selected.length > 0) return sameFileCallees(bundle, selected).map(toSlice);
  if (anchorLine) return hop0Methods(bundle, anchorLine, store).map(toSlice);
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
const DISCOVERY_NEIGHBOR_KINDS = new Set([
  "IMPLEMENTS",
  "EXTENDS",
  "MYBATIS_METHOD_BINDS_STATEMENT",
  "MYBATIS_STATEMENT_USES_ENTITY",
  "REPOSITORY_MANAGES_ENTITY",
  "JPA_RELATION"
]);
type DiscoverySeed = { hops: 1 | 2; kind: DiscoveryKind; names: string[] };

function kindRank(kind: DiscoveryKind): number {
  if (kind === "CALLS_EXACT") return 0;
  if (kind === "CALLS_VIRTUAL") return 1;
  if (kind === "IMPLEMENTS") return 2;
  if (kind === "EXTENDS") return 3;
  return 4;
}

function seedType(seeds: Map<string, DiscoverySeed>, typeId: string, hops: 1 | 2, kind: DiscoveryKind, name?: string): void {
  const previous = seeds.get(typeId);
  if (!previous || hops < previous.hops) {
    seeds.set(typeId, { hops, kind, names: name ? [name] : [] });
    return;
  }
  if (hops > previous.hops) return;
  if (kindRank(kind) < kindRank(previous.kind)) previous.kind = kind;
  if (name && !previous.names.includes(name)) previous.names.push(name);
}

function mentionRef(
  store: JavaIndexStore,
  importBySimple: Map<string, string>,
  seeds: Map<string, DiscoverySeed>,
  ref: JavaTypeRef | undefined,
  hops: 1 | 2,
  kind: DiscoveryKind,
  name?: string,
  looseSimple = kind === "IMPORTS"
): void {
  for (const id of resolvedRepoTypeIds(ref)) seedType(seeds, id, hops, kind, name);
  for (const simple of simpleNamesOfRef(ref)) {
    const imported = importBySimple.get(simple);
    const id = (imported ? typeIdByFqn(store, imported) : undefined)
      ?? (looseSimple ? uniqueTypeIdBySimpleName(store, simple) : undefined);
    if (id) seedType(seeds, id, hops, kind, name);
  }
}

function collectAnchorSeeds(store: JavaIndexStore, bundle: JavaFileBundle, anchorLine: number): Map<string, DiscoverySeed> {
  const containing = bundle.methods.filter(method => methodContainsLine(method, anchorLine));
  const hop0 = hop0Methods(bundle, anchorLine, store);
  const owners = new Set(containing.map(method => method.ownerTypeId));
  const seeds = new Map<string, DiscoverySeed>();
  for (const owner of owners) seedType(seeds, owner, 1, "IMPORTS");
  for (const method of containing) seedType(seeds, method.ownerTypeId, 1, "IMPORTS", method.name);
  const importBySimple = importBySimpleName(bundle);
  const mention = (ref: JavaTypeRef | undefined, hops: 1 | 2, kind: DiscoveryKind, name?: string) => {
    mentionRef(store, importBySimple, seeds, ref, hops, kind, name);
  };
  const methodTokens = new Set(containing.flatMap(method => splitIdentifier(method.name)).filter(token => token.length > 3));
  for (const [simple, fqn] of importBySimple) {
    if (!splitIdentifier(simple).some(token => methodTokens.has(token))) continue;
    const id = typeIdByFqn(store, fqn) ?? uniqueTypeIdBySimpleName(store, simple);
    if (id) seedType(seeds, id, 1, "IMPORTS");
  }
  for (const method of containing) {
    mention(method.returnType, 1, "IMPORTS");
    for (const parameter of method.parameters) mention(parameter.type, 1, "IMPORTS");
  }
  const hop0CallNames = new Set(
    hop0.flatMap(method => method.callSites.filter(site => neighborhoodCallName(site.name, site.receiverText)).map(site => site.name))
  );
  for (const method of hop0) {
    for (const site of method.callSites) {
      if (!neighborhoodCallName(site.name, site.receiverText) || !site.receiverText) continue;
      const field = bundle.fields.find(item => item.name === site.receiverText && owners.has(item.ownerTypeId));
      if (field) mentionRef(store, importBySimple, seeds, field.type, 1, "CALLS_EXACT", site.name, false);
    }
  }
  for (const field of bundle.fields) {
    if (!owners.has(field.ownerTypeId)) continue;
    const typeIds = [
      ...resolvedRepoTypeIds(field.type),
      ...simpleNamesOfRef(field.type).flatMap(simple => {
        const imported = importBySimple.get(simple);
        const id = imported ? typeIdByFqn(store, imported) : undefined;
        return id ? [id] : [];
      })
    ];
    for (const typeId of typeIds) {
      for (const name of hop0CallNames) {
        if (store.methodIdsByOwnerAndName.get(`${typeId}#${name}`)?.size) {
          seedType(seeds, typeId, 1, "CALLS_EXACT", name);
        }
      }
    }
  }
  const callNamed = [...seeds.entries()].filter(([, seed]) => seed.kind === "CALLS_EXACT" || seed.kind === "CALLS_VIRTUAL");
  for (const implId of implementerTypeIds(store, seeds.keys())) {
    seedType(seeds, implId, 1, "IMPLEMENTS");
    if (callNamed.length === 0) continue;
    const impl = store.typesById.get(implId);
    if (!impl) continue;
    const implFile = relativePathOfFileId(impl.fileId);
    const refs = [...impl.implements, ...impl.extends];
    for (const [targetId, seed] of callNamed) {
      const target = store.typesById.get(targetId);
      if (target && refs.some(ref => refTargetsType(ref, target, store, implFile))) {
        for (const name of seed.names) seedType(seeds, implId, 1, "IMPLEMENTS", name);
      }
    }
  }
  const callTypeIds = callNamed.map(([typeId]) => typeId).slice(0, HOP2_TYPE_CAP);
  for (const typeId of callTypeIds) {
    const type = store.typesById.get(typeId);
    if (!type) continue;
    const hop1File = store.filesByPath.get(relativePathOfFileId(type.fileId));
    const hop1Imports = new Map<string, string>();
    for (const item of hop1File?.imports ?? []) {
      if (item.wildcard) continue;
      const simple = item.qualifiedName.split(".").pop();
      if (simple) hop1Imports.set(simple, item.qualifiedName);
    }
    const hop1CallNames = new Set<string>();
    for (const methodId of type.methodIds) {
      const method = store.methodsById.get(methodId);
      if (!method || !hop0CallNames.has(method.name)) continue;
      for (const site of method.callSites) {
        if (!neighborhoodCallName(site.name, site.receiverText)) continue;
        hop1CallNames.add(site.name);
        if (!site.receiverText) continue;
        const field = type.fieldIds
          .map(id => store.fieldsById.get(id))
          .find(item => item !== undefined && item.name === site.receiverText && item.ownerTypeId === typeId);
        if (field) mentionRef(store, hop1Imports, seeds, field.type, 2, "CALLS_VIRTUAL", site.name, false);
      }
    }
    for (const fieldId of type.fieldIds) {
      const field = store.fieldsById.get(fieldId);
      if (!field || field.ownerTypeId !== typeId) continue;
      const typeIds = [
        ...resolvedRepoTypeIds(field.type),
        ...simpleNamesOfRef(field.type).flatMap(simple => {
          const imported = hop1Imports.get(simple);
          const id = imported ? typeIdByFqn(store, imported) : undefined;
          return id ? [id] : [];
        })
      ];
      for (const id of typeIds) {
        for (const name of hop1CallNames) {
          if (store.methodIdsByOwnerAndName.get(`${id}#${name}`)?.size) {
            seedType(seeds, id, 2, "CALLS_VIRTUAL", name);
          }
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
  kind: EdgeKind,
  toId: string
): void {
  if (!relativePath || relativePath === startPath) return;
  const step = { kind, fromId: startPath, toId };
  const existing = extra.find(item => item.path === relativePath);
  if (existing) {
    existing.hops = Math.min(existing.hops, hops);
    const named = toId.split("#")[2];
    if (named && !existing.provingPath.some(item => item.toId.split("#")[2] === named && item.kind === kind)) {
      existing.provingPath = [step, ...existing.provingPath];
    }
    known.add(relativePath);
    return;
  }
  extra.push({
    path: relativePath,
    hops,
    estimatedTokens: 48,
    provingPath: [step],
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
    const names = seed.names.length > 0 ? seed.names : [undefined];
    for (const name of names) {
      const toId = name
        ? `${relative}#${type.simpleName}#${name}#n`
        : (typeNodeId ?? typeId);
      addDiscoveryBundle(extra, known, path, relative, seed.hops, seed.kind, toId);
    }
    if (!typeNodeId) continue;
    for (const edge of [...graph.successors(typeNodeId), ...graph.predecessors(typeNodeId)]) {
      if (!DISCOVERY_NEIGHBOR_KINDS.has(edge.kind)) continue;
      const otherId = edge.fromId === typeNodeId ? edge.toId : edge.fromId;
      const other = graph.nodesById.get(otherId);
      if (!other?.relativePath) continue;
      const edgeKind = edge.kind;
      const neighborNames = seed.names.length > 0 && (edgeKind === "IMPLEMENTS" || edgeKind === "EXTENDS")
        ? seed.names
        : [undefined];
      for (const name of neighborNames) {
        const neighborToId = name && other.simpleName
          ? `${other.relativePath}#${other.simpleName}#${name}#n`
          : otherId;
        addDiscoveryBundle(extra, known, path, other.relativePath, seed.hops, edgeKind, neighborToId);
      }
    }
  }
  return extra.length === search.bundles.length ? search : { ...search, bundles: extra };
}

function typeRangesFromStore(store: JavaIndexStore, path: string, graph: KnowledgeGraphStore, provingIds: Set<string>): { start: number; end: number }[] {
  const bundle = store.files([path])[0];
  if (!bundle) return [];
  const wantedTypes = new Set<string>();
  const wantedSimple = new Set<string>();
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (node?.javaIndexId && node.relativePath === path && (node.kind === "TYPE" || node.kind === "JPA_ENTITY")) {
      wantedTypes.add(node.javaIndexId);
    }
    const indexed = store.typesById.get(id);
    if (indexed && relativePathOfFileId(indexed.fileId) === path) wantedTypes.add(indexed.typeId);
    const parts = id.split("#");
    if (parts[0] === path && parts[1]) wantedSimple.add(parts[1]);
  }
  let types = bundle.types.filter(type => wantedTypes.has(type.typeId) || wantedSimple.has(type.simpleName));
  if (types.length === 0) {
    for (const id of provingIds) {
      const node = graph.nodesById.get(id);
      if (node?.relativePath === path && node.simpleName) wantedSimple.add(node.simpleName);
    }
    types = bundle.types.filter(type => wantedTypes.has(type.typeId) || wantedSimple.has(type.simpleName));
  }
  if (types.length === 0) {
    const pathLocal = provingIds.size === 0 || [...provingIds].some(id => {
      const node = graph.nodesById.get(id);
      return node?.relativePath === path;
    });
    if (pathLocal) {
      types = [...bundle.types].sort((left, right) => left.range.start.line - right.range.start.line).slice(0, 1);
    }
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
