// input: Knowledge graph plus a start file and hop budget.
// output: Repo-relative files reachable by walking successors and predecessors.
// pos: N2a discovery walk. Undirected because CALLED_BY and inject/persistence edges are first-class.
import type { KnowledgeGraphStore } from "./graph-store.js";

function fileOf(graph: KnowledgeGraphStore, nodeId: string): string | undefined {
  const node = graph.nodesById.get(nodeId);
  if (node?.relativePath) return node.relativePath;
  if (node?.kind === "FILE") return node.id;
  return undefined;
}

export function reachableFiles(
  graph: KnowledgeGraphStore,
  startRelativePath: string,
  maxHops: number
): { files: string[]; hops: Record<string, number> } {
  const hops = new Map<string, number>();
  const startNodes: string[] = [];
  for (const [id, node] of graph.nodesById) {
    if (node.relativePath === startRelativePath || id === startRelativePath) startNodes.push(id);
  }
  if (startNodes.length === 0) return { files: [], hops: {} };
  const queue: Array<{ id: string; hop: number }> = startNodes.map(id => ({ id, hop: 0 }));
  const seen = new Set(startNodes);
  hops.set(startRelativePath, 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const path = fileOf(graph, current.id);
    if (path && !hops.has(path)) hops.set(path, current.hop);
    if (current.hop >= maxHops) continue;
    const neighbors = [...graph.successors(current.id), ...graph.predecessors(current.id)];
    for (const edge of neighbors) {
      const nextId = edge.fromId === current.id ? edge.toId : edge.fromId;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      queue.push({ id: nextId, hop: current.hop + 1 });
      const nextPath = fileOf(graph, nextId);
      if (nextPath && !hops.has(nextPath)) hops.set(nextPath, current.hop + 1);
    }
  }
  const files = [...hops.keys()].sort();
  return { files, hops: Object.fromEntries(hops) };
}
