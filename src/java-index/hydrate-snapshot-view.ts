// input: Files-only store plus a v4/v5 snapshot view that can yield rest chunks.
// output: Types/fields/methods/edges/myBatis ingested one chunk at a time, with a turn between parts.
// pos: Shared hydrate unit for the JavaIndex worker and the 256-cap isolate regression.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import v8 from "node:v8";
import type {
  JavaFieldFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  StaticEdge
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import { JavaIndexStore } from "./index-store.js";
import { decodeSnapshotV4View, type SnapshotV4View } from "./snapshot-v4.js";

export function yieldHydrateTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export async function hydrateSnapshotView(
  store: JavaIndexStore,
  view: Pick<SnapshotV4View, "readSegment" | "readSegmentChunks">,
  options: { yieldTurn?: () => Promise<void> } = {}
): Promise<void> {
  const yieldTurn = options.yieldTurn ?? yieldHydrateTurn;
  const restKinds = ["types", "fields", "methods", "edges"] as const;
  for (const kind of restKinds) {
    const chunks = typeof view.readSegmentChunks === "function"
      ? view.readSegmentChunks(kind)
      : [view.readSegment(kind)];
    for (const chunk of chunks) {
      const items = Array.isArray(chunk) ? chunk : [];
      store.ingestSnapshotFacts({
        types: kind === "types" ? items as JavaTypeFacts[] : [],
        fields: kind === "fields" ? items as JavaFieldFacts[] : [],
        methods: kind === "methods" ? items as JavaMethodFacts[] : [],
        edges: kind === "edges" ? items as StaticEdge[] : []
      }, { onDuplicate: "skip" });
      if (Array.isArray(chunk)) chunk.length = 0;
      await yieldTurn();
    }
  }
  const myBatisResources = view.readSegment("mybatis") as MyBatisMapperResourceFacts[];
  store.ingestSnapshotFacts({ types: [], fields: [], methods: [], edges: [], myBatisResources }, { onDuplicate: "skip" });
  myBatisResources.length = 0;
}

async function runHydrateProbe(): Promise<void> {
  if (!parentPort || typeof workerData?.snapshotPath !== "string") {
    throw new Error("hydrate probe requires workerData.snapshotPath");
  }
  const bytes = readFileSync(workerData.snapshotPath);
  const view = decodeSnapshotV4View(bytes, workerData.snapshotPath);
  if ("error" in view) throw new Error(view.error);
  const store = new JavaIndexStore();
  store.loadSnapshotData({
    files: view.files,
    types: [],
    fields: [],
    methods: [],
    edges: [],
    myBatisResources: []
  });
  await hydrateSnapshotView(store, view);
  const relativePath = view.files[0]?.relativePath;
  const methods = relativePath ? store.files([relativePath])[0]?.methods.length ?? 0 : 0;
  parentPort.postMessage({
    methods,
    heapSizeLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024))
  });
}

if (!isMainThread && parentPort && typeof workerData?.snapshotPath === "string") {
  await runHydrateProbe();
}
