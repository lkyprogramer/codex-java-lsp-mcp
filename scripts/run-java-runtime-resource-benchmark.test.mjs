import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { combinedObservations } from "./run-java-runtime-resource-benchmark.mjs";

test("resource manifest combines external and in-process observations without inventing missing values", () => {
  const combined = combinedObservations(
    { observations: { rss: { status: "MEASURED" }, cpu: { status: "MEASURED" }, fd: { status: "UNMEASURED", missingReason: "denied" } } },
    { observations: { eventLoopDelay: { status: "MEASURED" }, gc: { status: "MEASURED" }, queueDepth: { status: "MEASURED" } } },
    "present"
  );
  assert.equal(combined.fd.status, "UNMEASURED");
  assert.equal(combined.fd.reason, "denied");
  assert.equal(combined.queueDepth.status, "MEASURED");
});

test("formal resource runner binds sidecars and truthfully reports optional fd sampling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-runner-test-"));
  const output = path.join(root, "manifest.json");
  const script = fileURLToPath(new URL("./run-java-runtime-resource-benchmark.mjs", import.meta.url));
  try {
    const result = await run(process.execPath, [
      script,
      "--output", output,
      "--profile", "runner-test",
      "--interval-ms", "10",
      "--warmup-ms", "0",
      "--java-index", "present",
      "--",
      process.execPath,
      "scripts/resource-target-fixture.mjs",
      "observer"
    ], { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "1" });
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.isolation.activeRuntimeAttached, false);
    assert.equal(manifest.observations.rss.status, "MEASURED");
    assert.equal(manifest.observations.cpu.status, "MEASURED");
    assert.equal(manifest.observations.eventLoopDelay.status, "MEASURED");
    assert.equal(manifest.observations.gc.status, "MEASURED");
    assert.equal(manifest.observations.queueDepth.status, "MEASURED");
    if (manifest.observations.fd.status === "MEASURED") {
      assert.equal(manifest.status, "PASS");
    } else {
      assert.equal(manifest.observations.fd.status, "UNMEASURED");
      assert.match(manifest.observations.fd.reason, /fd|lsof|sampling/i);
      assert.equal(manifest.status, "PARTIAL");
    }
    assert.equal(manifest.artifacts.processTree.status, "PRESENT");
    assert.equal(manifest.artifacts.inProcess.status, "PRESENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}
