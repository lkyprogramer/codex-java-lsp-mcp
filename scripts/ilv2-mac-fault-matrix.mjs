#!/usr/bin/env node
// A phase acknowledgement holds the real child until the controller acts.
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { CONTRACT_VERSION, readJson, writeJson, newOutput, requireValue, cliOptions, isMain, runCli, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { connectDriver, field } from "./ilv2-mac-driver.mjs";

export async function runFaultCase(driver, scenario, { signal } = {}) {
  requireValue(driver.ownedPid && driver.ownedPgid, "fault injection requires an owned start instance");
  requireValue(typeof scenario.phase === "string" && scenario.phase && ["SIGKILL", "SIGTERM", "release"].includes(scenario.action), "invalid fault scenario");
  requireValue(Number.isFinite(scenario.timeoutMs) && scenario.timeoutMs > 0 && scenario.timeoutMs <= 10000, "bounded fault timeout required");
  requireValue(Array.isArray(scenario.assertions) && scenario.assertions.length > 0, "fault assertions required");
  const started = process.hrtime.bigint();
  await driver.request("barrier-arm", { phase: scenario.phase }, { timeoutMs: scenario.timeoutMs, signal });
  let ack;
  while (Number(process.hrtime.bigint() - started) / 1e6 < scenario.timeoutMs) {
    signal?.throwIfAborted();
    ack = (await driver.request("barrier-wait", { phase: scenario.phase }, { timeoutMs: Math.min(500, Math.max(1, scenario.timeoutMs - Number(process.hrtime.bigint() - started) / 1e6)), signal })).value;
    if (ack.phase === scenario.phase && ack.blocked === true) break;
    await delay(25, undefined, { signal });
  }
  requireValue(ack?.phase === scenario.phase && ack.blocked === true && ack.pid === driver.ownedPid, "phase barrier not acknowledged by owned process");
  const injected = process.hrtime.bigint();
  let observed;
  if (scenario.action === "release") observed = (await driver.request("barrier-release", { phase: scenario.phase }, { timeoutMs: scenario.timeoutMs })).value;
  else {
    // Only the process group recorded by this start instance is a kill target.
    try { process.kill(-driver.ownedPgid, scenario.action); }
    catch (error) { throw new Error(`fault signal failed: ${error.code}`); }
    await driver.waitForOwnedExit(Math.max(1, scenario.timeoutMs - Number(process.hrtime.bigint() - injected) / 1e6));
    await driver.stop();
    observed = { exited: true, pid: driver.ownedPid, phase: scenario.phase };
  }
  const checks = scenario.assertions.map(assertion => ({ field: assertion.field, expected: assertion.equals, actual: field(observed, assertion.field),
    status: JSON.stringify(field(observed, assertion.field)) === JSON.stringify(assertion.equals) ? "PASS" : "FAIL" }));
  const end = process.hrtime.bigint();
  const recoveryMs = Number(end - injected) / 1e6;
  return { id: scenario.id, status: checks.every(check => check.status === "PASS") && recoveryMs <= scenario.timeoutMs ? "PASS" : "FAIL",
    phase: scenario.phase, action: scenario.action, startMonoNs: String(started), injectedMonoNs: String(injected), endMonoNs: String(end),
    recoveryMs, ack, checks };
}
if (isMain(import.meta.url)) runCli(async ({ signal }) => {
  const options = cliOptions(process.argv.slice(2), ["--driver", "--plan", "--out"]);
  const runtime = await verifyRuntime();
  const plan = await readJson(options.plan);
  requireValue(plan.contractVersion === CONTRACT_VERSION && Array.isArray(plan.cases) && plan.cases.length > 0 && new Set(plan.cases.map(item => item.id)).size === plan.cases.length, "invalid fault plan");
  const out = await newOutput(process.env.ILV2_RUN_ROOT, options.out);
  const config = await readJson(options.driver);
  const results = [];
  for (const scenario of plan.cases) {
    signal.throwIfAborted();
    requireValue(typeof scenario.id === "string" && /^[a-zA-Z0-9-]+$/.test(scenario.id), "invalid fault case ID");
    const driver = await connectDriver(config, { mode: "start", runtime, runtimeManifest: process.env.ILV2_RUNTIME_MANIFEST, signal,
      runRoot: process.env.ILV2_RUN_ROOT, workRoot: process.env.ILV2_WORK_ROOT, serviceWork: path.join(out, `service-${scenario.id}`), port: scenario.port });
    try { results.push(await runFaultCase(driver, scenario, { signal })); }
    finally { await driver.stop(); }
  }
  const result = { contractVersion: CONTRACT_VERSION, status: results.every(item => item.status === "PASS") ? "PASS" : "FAIL", cases: results };
  await writeJson(path.join(out, "fault-result.json"), result);
  process.exitCode = result.status === "PASS" ? 0 : 1;
});
