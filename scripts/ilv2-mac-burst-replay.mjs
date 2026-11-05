#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writeJson, newOutput, managedPath, requireValue, cliOptions, isMain, runCli, verifyRuntime, verifyFrozenInput, sha256 } from "./ilv2-mac-contracts.mjs";
import { connectDriver } from "./ilv2-mac-driver.mjs";
import { evaluateOracle, summarize, validatePlan } from "./ilv2-mac-slo-report.mjs";

export async function replay(plan, driver, { out, runRoot, signal } = {}) {
  validatePlan(plan);
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const samples = [];
  await writeFile(path.join(out, "calls.jsonl"), "", { flag: "wx" });
  let writes = Promise.resolve();
  const origin = performance.now();
  let next = 0;
  async function record(sample) {
    samples.push(sample);
    writes = writes.then(() => appendFile(path.join(out, "calls.jsonl"), `${JSON.stringify(sample)}\n`));
    await writes;
  }
  async function runSlot(slot) {
    await delay(Math.max(0, origin + slot.atMs - performance.now()), undefined, { signal });
    const start = process.hrtime.bigint();
    const startedAt = new Date().toISOString();
    if (slot.edit) {
      const file = await managedPath(runRoot, slot.edit.path);
      requireValue(typeof slot.edit.beforeHash === "string" && sha256(await readFile(file)) === slot.edit.beforeHash, "edit input hash mismatch");
      requireValue(typeof slot.edit.utf8 === "string", "edit bytes required");
      await writeFile(file, slot.edit.utf8);
    }
    const common = { slotId: slot.id, operation: slot.operation, workspaceId: slot.workspaceId, window: slot.window, startedAt, deadlineMs: slot.deadlineMs };
    let response;
    let maxAttemptMs = 0;
    let payloadBytes = 0;
    let status = "FAIL";
    let attempt = 0;
    let firstCorrectMs = null;
    let publishMs = null;
    do {
      signal?.throwIfAborted();
      const attemptStart = process.hrtime.bigint();
      let errorCode;
      try {
        const result = await driver.request(slot.operation, { ...(slot.parameters ?? {}), workspaceId: slot.workspaceId, start: false, deadlineMs: slot.deadlineMs }, { timeoutMs: Math.min(slot.deadlineMs, Math.max(1, slot.stopAfterMs - Number(attemptStart - start) / 1e6)), signal });
        response = result.value;
        payloadBytes += result.payloadBytes;
        if (slot.operation === "query" ? evaluateOracle(response, slot.expected) : response.status === "OK") {
          status = "PASS";
          if (slot.operation === "query") firstCorrectMs = Number(process.hrtime.bigint() - start) / 1e6;
        }
        if (response.publishedMonoNs !== undefined && publishMs === null) {
          const elapsed = Number(BigInt(response.publishedMonoNs) - start) / 1e6;
          requireValue(Number.isFinite(elapsed) && elapsed >= 0, "invalid publish timestamp");
          publishMs = elapsed;
        }
      } catch (error) { errorCode = error.name === "TimeoutError" ? "TIMEOUT" : error.name === "AbortError" ? "CANCELLED" : "DRIVER_ERROR"; }
      const attemptEnd = process.hrtime.bigint();
      const elapsedMs = Number(attemptEnd - attemptStart) / 1e6;
      maxAttemptMs = Math.max(maxAttemptMs, elapsedMs);
      await record({ ...common, kind: "attempt", sampleId: randomUUID(), attempt: attempt++, startMonoNs: String(attemptStart), endMonoNs: String(attemptEnd), elapsedMs, errorCode, response, payloadBytes });
      if (status === "PASS" || !slot.pollMs || Number(attemptEnd - start) / 1e6 >= slot.stopAfterMs) break;
      await delay(Math.min(slot.pollMs, Math.max(0, slot.stopAfterMs - Number(attemptEnd - start) / 1e6)), undefined, { signal });
    } while (Number(process.hrtime.bigint() - start) / 1e6 < slot.stopAfterMs);
    const end = process.hrtime.bigint();
    await record({ ...common, kind: "slot", sampleId: randomUUID(), startMonoNs: String(start), endMonoNs: String(end), elapsedMs: Number(end - start) / 1e6,
      maxAttemptMs, payloadBytes, status, response, firstCorrectMs, publishMs, readOnly: slot.operation === "status" });
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(plan.concurrency, plan.slots.length) }, async () => {
    try { while (next < plan.slots.length) { const slot = plan.slots[next++]; await runSlot(slot); } }
    catch (error) { controller.abort(); throw error; }
  }));
  const result = summarize(plan, samples);
  await writeJson(path.join(out, "slo-result.json"), result);
  await writeJson(path.join(out, "calls-manifest.json"), { callsSha256: sha256(await readFile(path.join(out, "calls.jsonl"))), planDigest: sha256(JSON.stringify(plan)), driverDigest: driver.driverDigest });
  const failure = workers.find(worker => worker.status === "rejected");
  if (failure) throw failure.reason;
  return result;
}
if (isMain(import.meta.url)) runCli(async ({ signal }) => {
  const options = cliOptions(process.argv.slice(2), ["--mode", "--driver", "--frozen", "--plan", "--out", "--port", "--service-work", "--url", "--expected-instance", "--expected-source"]);
  const runtime = await verifyRuntime();
  const plan = validatePlan(await readJson(options.plan));
  requireValue(Array.isArray(plan.inputs) && plan.inputs.length > 0, "frozen input records required");
  requireValue(plan.inputs.some(input => input.repoRoot === options.frozen), "frozen root is not in plan");
  for (const input of plan.inputs) await verifyFrozenInput(input, { signal });
  const out = await newOutput(process.env.ILV2_RUN_ROOT, options.out);
  const driver = await connectDriver(await readJson(options.driver), {
    mode: options.mode, runtime, runtimeManifest: process.env.ILV2_RUNTIME_MANIFEST, signal,
    runRoot: process.env.ILV2_RUN_ROOT, workRoot: process.env.ILV2_WORK_ROOT, serviceWork: options["service-work"],
    port: Number(options.port), url: options.url, expectedInstance: options["expected-instance"], expectedSource: options["expected-source"]
  });
  try {
    await writeJson(path.join(out, "identity.json"), { ...driver.identity, driverDigest: driver.driverDigest, planDigest: sha256(JSON.stringify(plan)) });
    const result = await replay(plan, driver, { out, runRoot: process.env.ILV2_RUN_ROOT, signal });
    process.exitCode = result.status === "PASS" ? 0 : 1;
  }
  finally { await driver.stop(); }
});
