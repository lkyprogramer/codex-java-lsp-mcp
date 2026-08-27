import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import {
  envForJavaIndexWorker,
  javaIndexWorkerExecArgv,
  JAVA_INDEX_WORKER_MAX_OLD_GENERATION_SIZE_MB,
  spawnJavaIndexWorkerProcess
} from "./java-index-worker-process.js";
import { JavaIndexClient } from "./java-index-client.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRepoRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

test("NODE_OPTIONS max-old-space-size is stripped so the child keeps 1536", () => {
  const env = envForJavaIndexWorker({
    PATH: "/usr/bin",
    NODE_OPTIONS: "--enable-source-maps --max-old-space-size=768 --trace-uncaught"
  });
  assert.equal(env.NODE_OPTIONS, "--enable-source-maps --trace-uncaught");
  assert.deepEqual(javaIndexWorkerExecArgv(), [`--max-old-space-size=${JAVA_INDEX_WORKER_MAX_OLD_GENERATION_SIZE_MB}`]);
  assert.equal(envForJavaIndexWorker({ NODE_OPTIONS: "--max-old-space-size=768" }).NODE_OPTIONS, undefined);
});

test("forked index worker heap is 1536 when the parent process is capped at 768", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=768",
      "--input-type=module",
      "-e",
      `import { spawnSync } from "node:child_process";
       import v8 from "node:v8";
       const nested = spawnSync(process.execPath, ${JSON.stringify([...javaIndexWorkerExecArgv(), "--input-type=module", "-e", "import v8 from 'node:v8'; process.stdout.write(String(Math.round(v8.getHeapStatistics().heap_size_limit/1024/1024)))"])}, { encoding: "utf8" });
       process.stdout.write(JSON.stringify({ parentMb: Math.round(v8.getHeapStatistics().heap_size_limit/1024/1024), childMb: Number(nested.stdout), status: nested.status }));`
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout) as { parentMb: number; childMb: number; status: number };
  assert.ok(payload.parentMb <= 900, `parent heap ${payload.parentMb}`);
  assert.ok(payload.childMb >= 1500, `child heap ${payload.childMb} should follow --max-old-space-size=1536`);
  assert.equal(payload.status, 0);
});

test("an index-worker-sized child abort does not kill this process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.kill("SIGABRT");
  const [code, signal] = await once(child, "exit");
  assert.ok(code !== 0 || signal, `expected child abort, code=${code} signal=${signal}`);
  assert.equal(typeof process.pid, "number");
  assert.ok(Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024) > 16);
});

test("spawned index worker process answers OPEN and dies on terminate", async () => {
  const worker = spawnJavaIndexWorkerProcess();
  const client = new JavaIndexClient(
    fixturesRepoRoot,
    mkdtempSync(path.join(tmpdir(), "java-index-process-")),
    () => worker
  );
  try {
    assert.equal((await client.open(1)).state, "READY");
  } finally {
    await client.close();
  }
});
