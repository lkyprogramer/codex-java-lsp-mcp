// input: JavaIndex CALLS/CONSTRUCTS/METHOD_REFERENCE static edges plus inheritance.
// output: JIN call kinds with CALLED_BY materialized by the store. Dispatch is a conservative closed set.
// pos: N2a-01. No pointer analysis; ambiguous overloads emit no edge.
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts, StaticEdge } from "../java-index/index-types.js";
import type { FactsReader } from "../java-index/facts-reader.js";
import type { KnowledgeGraphStore } from "./graph-reader.js";
import { knowledgeEdgeId } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";

const CALL_STATIC_KINDS = new Set(["CALLS", "CONSTRUCTS", "METHOD_REFERENCE"]);
const MAX_DISPATCH = 16;

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
  const hits: JavaMethodFacts[] = [];
  for (const methodId of type.methodIds) {
    const method = store.methodsById.get(methodId);
    if (method && method.name === name && arityOf(method) === arity) hits.push(method);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

// Declaration text may spell the same parameter as String or java.lang.String.
// Compare resolved identities; unresolved parameters remain possible overrides
// rather than turning an uncertain runtime target into CALLS_EXACT.
function possibleOverride(base: JavaMethodFacts, candidate: JavaMethodFacts): boolean {
  return base.parameters.every((parameter, index) => {
    const other = candidate.parameters[index];
    if (!other) return false;
    const type = parameter.type;
    const target = other.type;
    if (type.arrayDepth + Number(parameter.varargs) !== target.arrayDepth + Number(other.varargs)) return false;
    const identity = (ref: typeof type): string | undefined => {
      if (ref.resolution.state === "RESOLVED_REPO") return `repo:${ref.resolution.typeId}`;
      if (ref.resolution.state === "EXTERNAL") return `external:${ref.resolution.qualifiedName}`;
      if (/^(?:boolean|byte|short|int|long|char|float|double)$/.test(ref.simpleName)) return `primitive:${ref.simpleName}`;
      return undefined;
    };
    const left = identity(type);
    const right = identity(target);
    return left === undefined || right === undefined || left === right;
  });
}

function push(
  graph: KnowledgeGraphStore,
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
  graph: KnowledgeGraphStore,
  bundle: JavaFileBundle,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  const ownerFile = bundle.file.relativePath;
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
    const sourceMethod = store.methodsById.get(staticEdge.fromId);
    const explicitSuper = sourceMethod?.callSites.some(site => site.receiverText === "super"
      && site.name === callee?.name
      && site.range.start.line === staticEdge.range?.start.line
      && site.range.start.column === staticEdge.range?.start.column) === true;
    const dispatchable = callee && ownerType && !explicitSuper && !ownerType.modifiers.includes("final")
      && !callee.constructor && !callee.modifiers.some(modifier => ["final", "private", "static"].includes(modifier));
    const implementers = dispatchable ? store.implementers(ownerType.typeId, MAX_DISPATCH) : [];
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
