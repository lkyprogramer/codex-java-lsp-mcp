import { parentPort, workerData } from "node:worker_threads";
import { decodeSnapshotV4View } from "./snapshot-v4.js";

const view = decodeSnapshotV4View(Buffer.from(workerData.bytes as Uint8Array));
if ("error" in view) throw new Error(view.error);
let count = 0;
for (const chunk of view.readSegmentChunks("methods")) {
  count += Array.isArray(chunk) ? chunk.length : 0;
  if (Array.isArray(chunk)) chunk.length = 0;
}
parentPort?.postMessage(count);
