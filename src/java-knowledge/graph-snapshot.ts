// input: KnowledgeGraphStore.
// output: Compact interned snapshot plus sha256 digest of the live node/edge set.
// pos: N1 snapshot. Typed-array-style packing is interned string tables + integer index rows.
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_GRAPH_SCHEMA_VERSION } from "./schema.js";
import type { KnowledgeGraphStore } from "./graph-store.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type PackedGraphSnapshot = {
  schemaVersion: typeof KNOWLEDGE_GRAPH_SCHEMA_VERSION;
  generation: number;
  digest: string;
  strings: string[];
  nodes: Array<[kind: number, id: number, path: number, name: number]>;
  edges: Array<[kind: number, from: number, to: number, source: number]>;
};

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

export function packGraphSnapshot(store: KnowledgeGraphStore): PackedGraphSnapshot {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const nodes: PackedGraphSnapshot["nodes"] = [];
  for (const node of store.nodesById.values()) {
    nodes.push([
      intern(strings, index, node.kind),
      intern(strings, index, node.id),
      intern(strings, index, node.relativePath ?? ""),
      intern(strings, index, node.simpleName ?? "")
    ]);
  }
  const edges: PackedGraphSnapshot["edges"] = [];
  for (const edge of store.edgesById.values()) {
    edges.push([
      intern(strings, index, edge.kind),
      intern(strings, index, edge.fromId),
      intern(strings, index, edge.toId),
      intern(strings, index, edge.sourceFile ?? "")
    ]);
  }
  return {
    schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    generation: store.generation,
    digest: store.digest(),
    strings,
    nodes,
    edges
  };
}

export function graphDigest(store: KnowledgeGraphStore): string {
  return store.digest();
}

export function unpackGraphSnapshot(snapshot: PackedGraphSnapshot, store: KnowledgeGraphStore): void {
  if (snapshot.schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION) {
    throw new Error(`unsupported knowledge graph schemaVersion ${String(snapshot.schemaVersion)}`);
  }
  store.clear();
  store.generation = snapshot.generation;
  for (const [kindIdx, idIdx, pathIdx, nameIdx] of snapshot.nodes) {
    const id = snapshot.strings[idIdx] ?? "";
    const kind = snapshot.strings[kindIdx];
    if (!id || !kind) continue;
    const relativePath = snapshot.strings[pathIdx] || undefined;
    store.upsertNode({
      id,
      kind: kind as never,
      relativePath,
      simpleName: snapshot.strings[nameIdx] || undefined,
      generation: snapshot.generation
    }, relativePath);
  }
  for (const [kindIdx, fromIdx, toIdx, sourceIdx] of snapshot.edges) {
    const kind = snapshot.strings[kindIdx];
    const fromId = snapshot.strings[fromIdx];
    const toId = snapshot.strings[toIdx];
    const sourceFile = snapshot.strings[sourceIdx] || undefined;
    if (!kind || !fromId || !toId) continue;
    store.addEdge({
      edgeId: `e:${kind}:${fromId}->${toId}:0`,
      kind: kind as never,
      fromId,
      toId,
      sourceFile,
      generation: snapshot.generation
    }, sourceFile);
  }
}

export async function writeGraphSnapshotAtomic(target: string, snapshot: PackedGraphSnapshot): Promise<number> {
  const directory = path.dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(snapshot)), { level: 6 });
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(compressed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    return compressed.length;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function loadGraphSnapshot(target: string): Promise<PackedGraphSnapshot | undefined> {
  let compressed: Buffer;
  try {
    compressed = await readFile(target);
  } catch {
    return undefined;
  }
  const json = await gunzipAsync(compressed);
  const parsed = JSON.parse(json.toString("utf8")) as PackedGraphSnapshot;
  if (parsed.schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION) return undefined;
  return parsed;
}
