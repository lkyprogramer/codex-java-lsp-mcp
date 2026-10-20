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
  // The main thread blocks for 3.5 s (a long synchronous SQL step), then commits one batch and finishes a stage.
  await writeFile(script, `import { startBuilderLiveness, noteBuilderWork, noteBuilderStage } from ${JSON.stringify(liveness)};
const stop = startBuilderLiveness(5);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
noteBuilderWork();
noteBuilderStage("graph-search");
await new Promise(resolve => setTimeout(resolve, 1300));
await stop();
`);
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
  assert.equal(code, 0);
  const blocked = beats.filter(beat => beat.work === 0);
  assert.ok(blocked.length >= 3, `beats during the 3.5 s block: ${blocked.length}`);
  assert.deepEqual(beats.map(beat => beat.seq), beats.map((_, index) => index + 1));
  const gaps = beats.slice(1).map((beat, index) => beat.at - beats[index]!.at);
  assert.ok(gaps.every(gap => gap >= 900 && gap <= 2000), `heartbeat gaps ${gaps.join(",")}`);
  const last = beats.at(-1)!;
  assert.deepEqual([last.work, last.stage], [2, "graph-search"], "one batch plus one stage transition");
});
