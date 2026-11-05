import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execute, sha256, writeJson, CONTRACT_VERSION, MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";
import { inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "input")); await mkdir(path.join(root, "run"));
  const input = path.join(root, "input");
  const git = args => execute("git", ["--no-optional-locks", "-C", input, ...args]);
  await git(["init", "-q"]); await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(input, "Fixture.java"), "class Fixture {}\n"); await git(["add", "."]); await git(["commit", "-qm", "fixture"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const source = await readFile(path.join(input, "Fixture.java"));
  const manifest = path.join(root, "input.json");
  await writeJson(manifest, { schema: "ilv2-mac-input/v1", repoRoot: input, head, files: [{ path: "Fixture.java", sha256: sha256(source), size: source.length }] });
  const runtime = path.join(root, "runtime.json");
  await writeJson(runtime, { schema: "ilv2-mac-runtime/v1", execPath: process.execPath, nodeRealpath: await realpath(process.execPath), nodeSha256: sha256(await readFile(process.execPath)), arch: process.arch, versions: { ...process.versions }, os: (await execute("/usr/bin/sw_vers", [])).stdout });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const driver = path.join(root, "driver.json");
  const config = { contractVersion: CONTRACT_VERSION, protocol: "http-json/v1", startTimeoutMs: 2000,
    argv: [process.execPath, fileURLToPath(new URL("../fixtures/ilv2-mac/fake-driver.mjs", import.meta.url)), "{port}"],
    expected: { sourceDigest: "fixture-source", buildDigest: "fixture-build", nativeDigest: "NOT_BUILT", runtimeManifestSha256: sha256(await readFile(runtime)) },
    operations: Object.fromEntries(["identity", "query", "status", "barrier-arm", "barrier-wait", "barrier-release"].map(operation => [operation, { method: "POST", path: `/${operation}`, readOnlyField: "start", body: { start: "{start}", phase: "{phase}" }, normalize: Object.fromEntries([
      "instanceId", "sourceDigest", "buildDigest", "nativeDigest", "runtimeManifestSha256", "cacheRoot", "ownerRoot", "contractVersion", "pid", "status", "workspaceId", "sourceHash", "snapshotId", "token", "phase", "blocked"
    ].map(key => [key, key])) }])) };
  await writeJson(driver, config);
  const plan = path.join(root, "plan.json");
  const workload = { contractVersion: CONTRACT_VERSION, concurrency: 1, inputs: [{ repoRoot: input, head, manifest, manifestSha256: sha256(await readFile(manifest)) }],
    slots: [{ id: "q1", operation: "query", workspaceId: "fixture-w1", window: "normal", atMs: 0, deadlineMs: 200, stopAfterMs: 500,
      expected: { workspaceId: "fixture-w1", sourceHash: "fixture-source-hash", match: { token: "fresh-token" } } }],
    slos: [{ id: "query", operation: "query", metric: "firstCorrectMs", window: "normal", percentile: 0.95, minSamples: 1, limitMs: 500 }] };
  await writeJson(plan, workload);
  const runRoot = path.join(root, "run");
  const env = { ...process.env, ILV2_WORK_ROOT: MAC_WORK_ROOT, ILV2_RUN_ROOT: runRoot, ILV2_RUNTIME_MANIFEST: runtime };
  const startArgs = ["--mode", "start", "--driver", driver, "--frozen", input, "--plan", plan, "--out", path.join(runRoot, "burst"), "--port", String(port), "--service-work", path.join(runRoot, "service")];
  return { root, runRoot, input, runtime, config, driver, workload, plan, env, port, startArgs };
}
async function cli(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { env }); const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk)); child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}
test("burst and report CLI produce verifiable PASS, and altered calls cannot be reported", async t => {
  const data = await setup(t);
  const result = await cli("./ilv2-mac-burst-replay.mjs", data.startArgs, data.env);
  assert.equal(result.code, 0, result.stderr);
  const identity = JSON.parse(await readFile(path.join(data.runRoot, "burst", "identity.json")));
  assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
  const reportArgs = ["--telemetry", path.join(data.runRoot, "burst"), "--calls", path.join(data.runRoot, "burst/calls.jsonl"), "--plan", data.plan,
    "--since", "2000-01-01T00:00:00Z", "--until", "2100-01-01T00:00:00Z", "--out", path.join(data.runRoot, "report")];
  assert.equal((await cli("./ilv2-mac-slo-report.mjs", reportArgs, data.env)).code, 0);
  await writeFile(path.join(data.runRoot, "burst/calls.jsonl"), "{}\n");
  reportArgs[reportArgs.length - 1] = path.join(data.runRoot, "tampered-report");
  const tampered = await cli("./ilv2-mac-slo-report.mjs", reportArgs, data.env);
  assert.equal(tampered.code, 2); assert.match(tampered.stderr, /calls digest/);
});
test("wrong oracle has exit 1, input preflight has exit 2", async t => {
  const data = await setup(t);
  data.config.argv.push("wrong-hash"); await writeJson(data.driver, data.config);
  assert.equal((await cli("./ilv2-mac-burst-replay.mjs", data.startArgs, data.env)).code, 1);
  await rm(path.join(data.input, "Fixture.java"));
  data.startArgs[data.startArgs.indexOf("--out") + 1] = path.join(data.runRoot, "bad-input");
  assert.equal((await cli("./ilv2-mac-burst-replay.mjs", data.startArgs, data.env)).code, 2);
});
test("fault CLI records a real acknowledged barrier and reap", async t => {
  const data = await setup(t);
  await writeJson(data.plan, { contractVersion: CONTRACT_VERSION, cases: [{ id: "kill-seal", port: data.port, phase: "before-seal", action: "SIGKILL", timeoutMs: 2000, assertions: [{ field: "exited", equals: true }] }] });
  const result = await cli("./ilv2-mac-fault-matrix.mjs", ["--driver", data.driver, "--plan", data.plan, "--out", path.join(data.runRoot, "fault")], data.env);
  assert.equal(result.code, 0, result.stderr);
  const evidence = JSON.parse(await readFile(path.join(data.runRoot, "fault/fault-result.json")));
  assert.equal(evidence.cases[0].ack.phase, "before-seal");
  assert.throws(() => process.kill(evidence.cases[0].ack.pid, 0), { code: "ESRCH" });
});
test("SIGTERM cancels the CLI, reaps its fixture and releases the shared slot", async t => {
  const data = await setup(t);
  data.config.argv.push("hang"); await writeJson(data.driver, data.config);
  data.workload.slots[0].deadlineMs = 10000; data.workload.slots[0].stopAfterMs = 10000; await writeJson(data.plan, data.workload);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./ilv2-mac-burst-replay.mjs", import.meta.url)), ...data.startArgs], { env: data.env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", resolve));
  let ready = false;
  const limit = performance.now() + 4000;
  while (performance.now() < limit) {
    try { ready = (await readFile(path.join(data.runRoot, "service/requests.jsonl"), "utf8")).includes('"operation":"query"'); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.equal(ready, true);
  const identity = JSON.parse(await readFile(path.join(data.runRoot, "burst/identity.json")));
  assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
  const processIdentity = JSON.parse(await readFile(path.join(data.runRoot, "service/process.json")));
  assert.equal(inspectFixtureSlots(MAC_WORK_ROOT).some(row => row.child_pid === processIdentity.supervisorPid), false);
});
test("identity write failure still reaps the process group and releases its quota", async t => {
  const data = await setup(t);
  const injection = fileURLToPath(new URL("../fixtures/ilv2-mac/fail-identity-write.mjs", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", injection, fileURLToPath(new URL("./ilv2-mac-burst-replay.mjs", import.meta.url)), ...data.startArgs], { env: data.env });
    const chunks = []; child.stderr.on("data", chunk => chunks.push(chunk)); child.stdout.resume(); child.once("error", reject);
    child.once("close", code => resolve({ code, stderr: Buffer.concat(chunks).toString() }));
  });
  assert.equal(result.code, 2); assert.match(result.stderr, /injected identity write failure/);
  const owned = JSON.parse(await readFile(path.join(data.runRoot, "service/process.json")));
  assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(-owned.pgid, 0), { code: "ESRCH" });
  assert.equal(inspectFixtureSlots(MAC_WORK_ROOT).some(row => row.child_pid === owned.supervisorPid), false);
});
