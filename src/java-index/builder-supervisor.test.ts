import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuilderSupervisor } from "./builder-supervisor.js";

const FAKE_BUILDER = `import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import readline from "node:readline";

const argv = process.argv;
const mode = argv[argv.indexOf("--mode") + 1] ?? "serve";
const logPath = process.env.IOD_FAKE_LOG;
const gateDir = process.env.IOD_FAKE_GATE;
const hangId = Number(process.env.IOD_FAKE_HANG_ID ?? "");
const delayMs = Number(process.env.IOD_FAKE_DELAY_MS ?? "30");

function log(line) {
  if (logPath) appendFileSync(logPath, line + "\\n");
}

log("spawn " + process.pid + " " + mode);

if (mode === "cold") {
  if (process.env.IOD_FAKE_COLD_HANG === "1") {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ ok: true, files: 0, indexedGeneration: 1 }) + "\\n");
    process.exit(0);
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const job = JSON.parse(trimmed);
    if (job.kind === "exit") process.exit(0);
    log("start " + job.id + " " + process.pid + " " + Date.now());
    if (gateDir) {
      const gate = gateDir + "/go-" + job.id;
      while (!existsSync(gate)) await delay(10);
    } else if (Number.isFinite(delayMs) && delayMs > 0) {
      await delay(delayMs);
    }
    if (job.id === hangId) {
      setInterval(() => {}, 1000);
      continue;
    }
    process.stdout.write(JSON.stringify({
      id: job.id,
      ok: true,
      indexedGeneration: job.generation ?? 1,
      files: 1
    }) + "\\n");
    log("end " + job.id + " " + process.pid + " " + Date.now());
  }
}
`;

async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-sup-"));
  const scriptPath = path.join(dir, "fake-builder.mjs");
  const logPath = path.join(dir, "events.log");
  const gateDir = path.join(dir, "gate");
  const dbPath = path.join(dir, "index.sqlite");
  await writeFile(scriptPath, FAKE_BUILDER);
  await mkdir(gateDir);
  await writeFile(logPath, "");
  const supervisor = new BuilderSupervisor({
    repoRoot: dir,
    dbPath,
    scriptPath,
    idleMs: extraEnv.IOD_IDLE_MS ? Number(extraEnv.IOD_IDLE_MS) : 200,
    watchdogIntervalMs: extraEnv.IOD_WATCHDOG_MS ? Number(extraEnv.IOD_WATCHDOG_MS) : 20,
    stallMs: extraEnv.IOD_STALL_MS ? Number(extraEnv.IOD_STALL_MS) : 2_000,
    maxRestarts: 2,
    env: {
      ...process.env,
      IOD_FAKE_LOG: logPath,
      IOD_FAKE_GATE: extraEnv.IOD_USE_GATE === "1" ? gateDir : "",
      IOD_FAKE_DELAY_MS: extraEnv.IOD_FAKE_DELAY_MS ?? "40",
      IOD_FAKE_HANG_ID: extraEnv.IOD_FAKE_HANG_ID ?? "",
      IOD_FAKE_COLD_HANG: extraEnv.IOD_FAKE_COLD_HANG ?? ""
    }
  });
  return { dir, supervisor, logPath, gateDir, dbPath };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function readLog(logPath: string): Promise<string[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").map(line => line.trim()).filter(Boolean);
}

test("submit runs jobs serially on one builder process", async () => {
  const { supervisor, logPath } = await setup({ IOD_FAKE_DELAY_MS: "50" });
  try {
    const first = supervisor.submit({ id: 1, kind: "refresh", generation: 2, changed: ["a.java"], deleted: [] });
    const second = supervisor.submit({ id: 2, kind: "refresh", generation: 3, changed: ["b.java"], deleted: [] });
    const results = await Promise.all([first, second]);
    assert.equal(results[0]?.ok, true, results[0]?.error);
    assert.equal(results[1]?.ok, true, results[1]?.error);
    const events = await readLog(logPath);
    const start1 = events.find(line => line.startsWith("start 1 "));
    const end1 = events.find(line => line.startsWith("end 1 "));
    const start2 = events.find(line => line.startsWith("start 2 "));
    assert.ok(start1 && end1 && start2);
    const end1At = Number(end1.split(" ").at(-1));
    const start2At = Number(start2.split(" ").at(-1));
    assert.ok(end1At <= start2At, `overlap: end1=${end1At} start2=${start2At}`);
    const pids = events.filter(line => line.startsWith("spawn ")).map(line => line.split(" ")[1]);
    assert.equal(new Set(pids).size, 1);
  } finally {
    await supervisor.stop();
  }
});

test("idle builder exits after JAVA_LSP_BUILDER_IDLE_MS", async () => {
  const { supervisor } = await setup({ IOD_IDLE_MS: "80", IOD_FAKE_DELAY_MS: "10" });
  try {
    const result = await supervisor.submit({ id: 1, kind: "refresh", generation: 1, changed: [], deleted: [] });
    assert.equal(result.ok, true);
    await waitUntil(() => supervisor.status().state === "idle" && supervisor.status().pid !== undefined);
    const pid = supervisor.status().pid;
    assert.ok(pid);
    await waitUntil(() => supervisor.status().state === "absent", 1000);
    assert.equal(supervisor.status().state, "absent");
    assert.equal(supervisor.status().pid, undefined);
  } finally {
    await supervisor.stop();
  }
});

test("watchdog SIGKILL restarts a stalled job at most twice then errors", async () => {
  const { supervisor, logPath } = await setup({
    IOD_FAKE_HANG_ID: "1",
    IOD_STALL_MS: "60",
    IOD_WATCHDOG_MS: "15",
    IOD_FAKE_DELAY_MS: "0"
  });
  try {
    const hung = supervisor.submit({ id: 1, kind: "refresh", generation: 1, changed: ["stall.java"], deleted: [] });
    const follow = supervisor.submit({ id: 2, kind: "refresh", generation: 1, changed: ["ok.java"], deleted: [] });
    const hungResult = await hung;
    assert.equal(hungResult.ok, false);
    assert.match(hungResult.error ?? "", /stall|exited/i);
    const followResult = await follow;
    assert.equal(followResult.ok, true, followResult.error);
    const events = await readLog(logPath);
    const spawnPids = events.filter(line => line.startsWith("spawn ") && line.endsWith(" serve")).map(line => line.split(" ")[1]);
    assert.ok(spawnPids.length >= 3, `expected ≥3 serve spawns, got ${spawnPids.join(",")}`);
    assert.ok(new Set(spawnPids.slice(0, 3)).size === 3, "restarts must fork new pids");
  } finally {
    await supervisor.stop();
  }
});

test("concurrent submit queues behind the in-flight job", async () => {
  const { supervisor, gateDir } = await setup({ IOD_USE_GATE: "1" });
  try {
    const jobs = [1, 2, 3].map(id => supervisor.submit({
      id,
      kind: "refresh",
      generation: id,
      changed: [`f${id}.java`],
      deleted: []
    }));
    await waitUntil(() => {
      const status = supervisor.status();
      return status.state === "busy" && status.queued === 2 && status.pid !== undefined;
    });
    const during = supervisor.status();
    assert.equal(during.state, "busy");
    assert.equal(during.queued, 2);
    assert.ok(during.pid);
    await writeFile(path.join(gateDir, "go-1"), "ok");
    await writeFile(path.join(gateDir, "go-2"), "ok");
    await writeFile(path.join(gateDir, "go-3"), "ok");
    const results = await Promise.all(jobs);
    assert.deepEqual(results.map(result => result.ok), [true, true, true]);
    await waitUntil(() => supervisor.status().queued === 0);
  } finally {
    await supervisor.stop();
  }
});

test("coldBuild uses a one-shot child and the same watchdog", async () => {
  const { supervisor, logPath } = await setup();
  try {
    await supervisor.coldBuild();
    const events = await readLog(logPath);
    assert.ok(events.some(line => line.startsWith("spawn ") && line.endsWith(" cold")));
    assert.equal(supervisor.status().state, "absent");
  } finally {
    await supervisor.stop();
  }
});

test("cold stall SIGKILLs the hung child before restarting", async () => {
  const { supervisor, logPath } = await setup({
    IOD_FAKE_COLD_HANG: "1",
    IOD_STALL_MS: "80",
    IOD_WATCHDOG_MS: "20"
  });
  try {
    await assert.rejects(() => supervisor.coldBuild(), /stall/i);
    const events = await readLog(logPath);
    const pids = events.filter(line => line.startsWith("spawn ") && line.endsWith(" cold")).map(line => Number(line.split(" ")[1]));
    assert.ok(pids.length >= 2, `expected restarts, got ${pids.join(",")}`);
    for (const pid of pids) {
      assert.equal(alive(pid), false, `stalled cold pid ${pid} still alive`);
    }
  } finally {
    await supervisor.stop();
  }
});

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
