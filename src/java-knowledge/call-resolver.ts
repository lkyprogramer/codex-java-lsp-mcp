// input: JavaIndex CALLS/CONSTRUCTS/METHOD_REFERENCE static edges plus inheritance.
// output: JIN call kinds with CALLED_BY materialized by the store. Dispatch is a conservative closed set.
// pos: N2a-01. No pointer analysis; ambiguous overloads emit no edge.
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts, StaticEdge } from "../java-index/index-types.js";
import type { JavaIndexStore } from "../java-index/index-store.js";
import type { KnowledgeGraphStore } from "./graph-store.js";
import { knowledgeEdgeId } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";

const CALL_STATIC_KINDS = new Set(["CALLS", "CONSTRUCTS", "METHOD_REFERENCE"]);
const MAX_DISPATCH = 16;

function arityOf(method: JavaMethodFacts): number {
  return method.parameters.length;
}

function isVirtualOwner(type: JavaTypeFacts, method: JavaMethodFacts | undefined): boolean {
  if (type.kind === "interface") return true;
  if (type.modifiers.includes("abstract")) return true;
  if (method?.modifiers.includes("abstract")) return true;
  return false;
}

function matchingMethod(type: JavaTypeFacts, name: string, arity: number, store: JavaIndexStore): JavaMethodFacts | undefined {
  const hits: JavaMethodFacts[] = [];
  for (const methodId of type.methodIds) {
    const method = store.methodsById.get(methodId);
    if (method && method.name === name && arityOf(method) === arity) hits.push(method);
  }
  return hits.length === 1 ? hits[0] : undefined;
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
  store: JavaIndexStore,
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
    if (!callee || !ownerType || !isVirtualOwner(ownerType, callee)) {
      push(graph, "CALLS_EXACT", fromId, toId, generation, ownerFile);
      continue;
    }
    push(graph, "CALLS_VIRTUAL", fromId, toId, generation, ownerFile);
    const implementers = store.implementers(ownerType.typeId, MAX_DISPATCH);
    for (const implementer of implementers) {
      const implMethod = matchingMethod(implementer, callee.name, arityOf(callee), store);
      const implId = implMethod ? resolve(implMethod.methodId) : undefined;
      if (!implId || implId === toId) continue;
      push(graph, "DISPATCHES_TO", toId, implId, generation, ownerFile);
    }
  }
}

export function callEdgesFromStatic(edge: StaticEdge): boolean {
  return CALL_STATIC_KINDS.has(edge.kind);
}
