import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuilderHeartbeat } from "./build-process.js";

const liveness = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "builder-liveness.js")).href;

test("liveness keeps beating at about 1 Hz while the builder's main thread is blocked; work moves only with real progress", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ilv2-liveness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "blocked-builder.mjs");
  // The main thread blocks for 5 s (a long synchronous SQL step), then commits one batch and finishes a stage.
  // MAC-14 (§6.2): a real child of at least 5 s, judged by first arrival, adjacent arrival gaps and last
  // arrival rather than a beat count inside a fixed window; liveness (beats) and progress (work) are apart.
  await writeFile(script, `import { startBuilderLiveness, noteBuilderWork, noteBuilderStage } from ${JSON.stringify(liveness)};
const stop = startBuilderLiveness(5);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
noteBuilderWork();
noteBuilderStage("graph-search");
await new Promise(resolve => setTimeout(resolve, 1300));
await stop();
`);
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit", "ignore", "ignore", "pipe"] });
  const beats: Array<BuilderHeartbeat & { receivedAt: number }> = [];
  let partial = "";
  const pipe = (child.stdio as unknown as Array<import("node:stream").Readable>)[5]!;
  pipe.setEncoding("utf8");
  pipe.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) beats.push({ ...JSON.parse(line) as BuilderHeartbeat, receivedAt: Date.now() });
  });
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  const closedAt = Date.now();
  assert.equal(code, 0);
  assert.ok(closedAt - spawnedAt >= 5000, `the child ran ${closedAt - spawnedAt} ms`);
  assert.deepEqual(beats.map(beat => beat.seq), beats.map((_, index) => index + 1));
  // First arrival: liveness starts before the block, not after it (node start-up included).
  assert.ok(beats.length > 0 && beats[0]!.receivedAt - spawnedAt <= 2000, `first beat after ${beats[0]?.receivedAt - spawnedAt} ms`);
  // Adjacent arrivals while the main thread is blocked: never a gap the coordinator would read as dead.
  const arrivals = beats.slice(1).map((beat, index) => beat.receivedAt - beats[index]!.receivedAt);
  assert.ok(arrivals.every(gap => gap <= 2000), `arrival gaps ${arrivals.join(",")}`);
  const emitted = beats.slice(1).map((beat, index) => beat.at - beats[index]!.at);
  assert.ok(emitted.every(gap => gap >= 900 && gap <= 2000), `heartbeat gaps ${emitted.join(",")}`);
  // Last arrival: beats continue to the end, so a stalled tail would show as a late last beat.
  assert.ok(closedAt - beats.at(-1)!.receivedAt <= 2000, `last beat ${closedAt - beats.at(-1)!.receivedAt} ms before close`);
  // Alive is not progress: through the whole block the beats carry no work.
  const blocked = beats.filter(beat => beat.receivedAt - spawnedAt < 5000);
  assert.ok(blocked.length >= 3 && blocked.every(beat => beat.work === 0), `beats during the block: ${JSON.stringify(blocked.map(beat => beat.work))}`);
  const last = beats.at(-1)!;
  assert.deepEqual([last.work, last.stage], [2, "graph-search"], "one batch plus one stage transition");
});
