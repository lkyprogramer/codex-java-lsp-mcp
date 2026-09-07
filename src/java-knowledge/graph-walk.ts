// input: Knowledge graph plus a start file and hop budget.
// output: Repo-relative files reachable by walking successors and predecessors.
// pos: N2a discovery walk. Undirected because CALLED_BY and inject/persistence edges are first-class.
import type { GraphReader } from "./graph-reader.js";

function fileOf(graph: GraphReader, nodeId: string): string | undefined {
  const node = graph.nodesById.get(nodeId);
  if (node?.relativePath) return node.relativePath;
  if (node?.kind === "FILE") return node.id;
  return undefined;
}

export function reachableFiles(
  graph: GraphReader,
  startRelativePath: string,
  maxHops: number
): { files: string[]; hops: Record<string, number> } {
  const hops = new Map<string, number>();
  const startNodes = graph.nodesByPath(startRelativePath).map(node => node.id);
  const startNode = graph.nodesById.get(startRelativePath);
  if (startNode && !startNodes.includes(startNode.id)) startNodes.push(startNode.id);
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
