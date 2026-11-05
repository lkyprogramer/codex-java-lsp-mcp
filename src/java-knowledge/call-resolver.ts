// input: JavaIndex CALLS/CONSTRUCTS/METHOD_REFERENCE static edges plus inheritance.
// output: JIN call kinds with CALLED_BY materialized by the store. Dispatch is a conservative closed set.
// pos: N2a-01. No pointer analysis; ambiguous overloads emit no edge.
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts, StaticEdge } from "../java-index/index-types.js";
import type { FactsReader } from "../java-index/facts-reader.js";
import type { GraphSink } from "./graph-fragment.js";
import { knowledgeEdgeId } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";

const CALL_STATIC_KINDS = new Set(["CALLS", "CONSTRUCTS", "METHOD_REFERENCE"]);
/** Implementers per virtual call receiving DISPATCHES_TO, by typeId order. */
export const MAX_DISPATCH = 16;

function arityOf(method: JavaMethodFacts): number {
  return method.parameters.length;
}

function isVirtualOwner(type: JavaTypeFacts, method: JavaMethodFacts | undefined): boolean {
  if (type.modifiers.includes("final") || method?.constructor
    || method?.modifiers.some(modifier => ["final", "private", "static"].includes(modifier))) return false;
  if (type.kind === "interface") return true;
  if (type.modifiers.includes("abstract")) return true;
  if (method?.modifiers.includes("abstract")) return true;
  return false;
}

function matchingMethod(type: JavaTypeFacts, name: string, arity: number, store: FactsReader): JavaMethodFacts | undefined {
  const hits = (store.methodsNamed?.(type.typeId, name) ?? store.methodsOfOwner(type.typeId)).filter(method => method.name === name && arityOf(method) === arity);
  return hits.length === 1 ? hits[0] : undefined;
}

// Declaration text may spell the same parameter as String or java.lang.String.
// Compare resolved identities; unresolved parameters remain possible overrides
// rather than turning an uncertain runtime target into CALLS_EXACT.
function possibleOverride(base: JavaMethodFacts, candidate: JavaMethodFacts): boolean {
  return base.parameters.every((parameter, index) => {
    const other = candidate.parameters[index];
    if (!other) return false;
    if (dimensionsOf(parameter) !== dimensionsOf(other)) return false;
    const left = identity(parameter.type);
    const right = identity(other.type);
    return left === undefined || right === undefined || left === right;
  });
}

const dimensionsOf = (parameter: JavaMethodFacts["parameters"][number]): number => parameter.type.arrayDepth + Number(parameter.varargs);

function identity(ref: JavaMethodFacts["parameters"][number]["type"]): string | undefined {
  if (ref.resolution.state === "RESOLVED_REPO") return `repo:${ref.resolution.typeId}`;
  if (ref.resolution.state === "EXTERNAL") return `external:${ref.resolution.qualifiedName}`;
  if (/^(?:boolean|byte|short|int|long|char|float|double)$/.test(ref.simpleName)) return `primitive:${ref.simpleName}`;
  return undefined;
}

/** Everything addCallEdges reads from a callee or implementer method: a
 * caller's call kind and DISPATCHES_TO set can only move with this. */
export function dispatchMethodShape(method: JavaMethodFacts): string {
  return JSON.stringify([method.name, method.constructor, [...method.modifiers].sort(),
    method.parameters.map(parameter => [identity(parameter.type) ?? null, dimensionsOf(parameter)])]);
}

/** Everything addCallEdges reads from a callee's owner type. */
export function dispatchTypeShape(type: JavaTypeFacts): string {
  return JSON.stringify([type.kind, [...type.modifiers].sort()]);
}

function push(
  graph: GraphSink,
  kind: EdgeKind,
  fromId: string,
  toId: string,
  generation: number,
  ownerFile: string
): void {
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind, fromId, toId, ordinal: 0 }),
    kind,
    fromId,
    toId,
    sourceFile: ownerFile,
    generation
  }, ownerFile);
}

export function addCallEdges(
  graph: GraphSink,
  bundle: JavaFileBundle,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  const ownerFile = bundle.file.relativePath;
  // One file's calls share few owners; each owner's implementer set is read once.
  const dispatchSets = new Map<string, JavaTypeFacts[]>();
  const dispatchSet = (typeId: string): JavaTypeFacts[] => {
    let found = dispatchSets.get(typeId);
    if (!found) {
      found = store.implementers(typeId, Number.POSITIVE_INFINITY).sort((a, b) => a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0).slice(0, MAX_DISPATCH);
      dispatchSets.set(typeId, found);
    }
    return found;
  };
  // `super.name(...)` call sites of each source method, by name and position.
  const superSites = new Map<string, Set<string>>();
  const superSitesOf = (methodId: string): Set<string> => {
    let found = superSites.get(methodId);
    if (!found) {
      found = new Set((store.methodsById.get(methodId)?.callSites ?? []).filter(site => site.receiverText === "super")
        .map(site => `${site.name}@${site.range.start.line}:${site.range.start.column}`));
      superSites.set(methodId, found);
    }
    return found;
  };
  for (const staticEdge of bundle.edges) {
    if (!CALL_STATIC_KINDS.has(staticEdge.kind)) continue;
    const fromId = resolve(staticEdge.fromId);
    const toId = resolve(staticEdge.toId);
    if (!fromId || !toId) continue;
    if (staticEdge.kind === "CONSTRUCTS") {
      push(graph, "CONSTRUCTS", fromId, toId, generation, ownerFile);
      continue;
    }
    if (staticEdge.kind === "METHOD_REFERENCE") {
      push(graph, "METHOD_REFERENCE", fromId, toId, generation, ownerFile);
      continue;
    }
    const callee = store.methodsById.get(staticEdge.toId);
    const ownerType = callee ? store.typesById.get(callee.ownerTypeId) : undefined;
    // The declaration target is statically known, but a concrete receiver
    // can dispatch to a known overriding subtype. Keep the existing bounded
    // closed-set analysis; do not invent runtime bindings for unknown types.
    const explicitSuper = callee !== undefined
      && superSitesOf(staticEdge.fromId).has(`${callee.name}@${staticEdge.range?.start.line}:${staticEdge.range?.start.column}`);
    const dispatchable = callee && ownerType && !explicitSuper && !ownerType.modifiers.includes("final")
      && !callee.constructor && !callee.modifiers.some(modifier => ["final", "private", "static"].includes(modifier));
    // The bounded set is chosen by identity, not location: which implementers
    // receive DISPATCHES_TO then depends only on the implementer set, so a
    // delta that does not change that set cannot change the choice.
    const implementers = dispatchable ? dispatchSet(ownerType.typeId) : [];
    const overrides = implementers.flatMap(type => {
      const method = matchingMethod(type, callee!.name, arityOf(callee!), store);
      return method && possibleOverride(callee!, method)
        && !method.modifiers.some(modifier => ["private", "static"].includes(modifier)) ? [method] : [];
    });
    if (!callee || !ownerType || !dispatchable || (!isVirtualOwner(ownerType, callee) && overrides.length === 0)) {
      push(graph, "CALLS_EXACT", fromId, toId, generation, ownerFile);
      continue;
    }
    push(graph, "CALLS_VIRTUAL", fromId, toId, generation, ownerFile);
    for (const implMethod of overrides) {
      const implId = resolve(implMethod.methodId);
      if (!implId || implId === toId) continue;
      push(graph, "DISPATCHES_TO", toId, implId, generation, ownerFile);
    }
  }
}

export function callEdgesFromStatic(edge: StaticEdge): boolean {
  return CALL_STATIC_KINDS.has(edge.kind);
}
