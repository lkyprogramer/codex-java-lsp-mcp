import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";
import { acquireFixtureSlot, fixtureQuotaFile, inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";
import { MAC_WORK_ROOT, execute, writeJson } from "./ilv2-mac-contracts.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

for (const phase of ["reserved-before-bootstrap", "bootstrapped-before-pid-registration"]) {
  test(`controller-sigkill-${phase}-pins-external-reservation`, { timeout: 30000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-owner-window-")));
    for (const name of ["cache", "home", "tmp"]) await mkdir(path.join(root, name));
    const label = `com.lky.ilv2-mac02b.window-${randomUUID()}`;
    const service = `gui/${process.getuid()}/${label}`;
    const entry = path.join(root, "owner.mjs");
    await writeFile(entry, `import {writeFileSync,fstatSync} from 'node:fs';import{execFileSync}from'node:child_process';writeFileSync(${JSON.stringify(path.join(root, "ready.json"))},JSON.stringify({pid:process.pid,pgid:Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim()),fd4:fstatSync(4).isFile()}));setInterval(()=>{},1000);\n`);
    const launch = await ownerLaunchArguments(path.join(root, "cache"), entry);
    const plist = path.join(root, "fixture.plist");
    await writeFile(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[launch.binary, ...launch.args].map(value => `<string>${xml(value)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${root}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${root}/home</string><key>TMPDIR</key><string>${root}/tmp</string><key>ILV2_RUNTIME_MANIFEST</key><string>${xml(process.env.ILV2_RUNTIME_MANIFEST)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>1</integer><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>${root}/stdout.log</string><key>StandardErrorPath</key><string>${root}/stderr.log</string></dict></plist>\n`);
    const controllerFile = path.join(root, "controller.mjs");
    await writeFile(controllerFile, `import{acquireLaunchdFixtureSlot}from${JSON.stringify(path.join(sourceRoot, "scripts/ilv2-mac-fixture-quota.mjs"))};const lease=await acquireLaunchdFixtureSlot(${JSON.stringify(MAC_WORK_ROOT)},{runRoot:${JSON.stringify(root)},label:${JSON.stringify(label)}});${phase === "bootstrapped-before-pid-registration" ? `await lease.bootstrap(${JSON.stringify(plist)});` : ""}process.send({phase:${JSON.stringify(phase)},pid:process.pid,slot:lease.slot});setInterval(()=>{},1000);\n`);
    const controllerEnv = { ...process.env };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_TEST_CONTEXT"]) delete controllerEnv[name];
    const controller = spawn(process.execPath, [controllerFile], { env: controllerEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const controllerClosed = new Promise((resolve, reject) => { controller.once("close", resolve); controller.once("error", reject); });
    let checkpoint, slot, token, owner, primaryError;
    let other;
    const evidence = { phase, root, label, actualLaunchd: phase === "bootstrapped-before-pid-registration" };
    try {
      checkpoint = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("controller checkpoint deadline exceeded")), 10000);
        controller.once("message", value => { clearTimeout(timeout); resolve(value); });
        controller.once("error", error => { clearTimeout(timeout); reject(error); });
      });
      assert.equal(checkpoint.pid, controller.pid); assert.equal(checkpoint.phase, phase);
      slot = inspectFixtureSlots(MAC_WORK_ROOT).find(row => row.slot === checkpoint.slot && row.pid === controller.pid);
      assert.ok(slot); assert.equal(slot.child_pid, null); token = slot.token;
      process.kill(controller.pid, "SIGKILL"); await controllerClosed;
      assert.equal(processAlive(controller.pid), false);
      other = await acquireFixtureSlot(MAC_WORK_ROOT);
      await assert.rejects(acquireFixtureSlot(MAC_WORK_ROOT, { timeoutMs: 150 }), /quota wait timed out/);
      const db = new DatabaseSync(fixtureQuotaFile(MAC_WORK_ROOT));
      try { assert.throws(() => db.prepare("DELETE FROM fixture_slots WHERE token=?").run(token), /external_fixture_requires_closeout/); }
      finally { db.close(); }
      assert.equal(inspectFixtureSlots(MAC_WORK_ROOT).find(row => row.token === token).child_pid, null);
      if (phase === "bootstrapped-before-pid-registration") {
        owner = await eventually(async () => JSON.parse(await readFile(path.join(root, "ready.json"), "utf8").catch(() => "null")));
        owner.groupOwned = Number.isInteger(owner.pid) && owner.pid > 1 && owner.pgid === owner.pid;
        assert.equal(owner.groupOwned, true); assert.equal(owner.fd4, true); assert.ok(processAlive(owner.pid));
      }
      Object.assign(evidence, { controllerPid: controller.pid, checkpoint, slot, owner, protectedAfterControllerDeath: true });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const failures = [];
      const attempt = async action => { try { await action(); } catch (error) { failures.push(error); } };
      await attempt(async () => {
        if (controller.exitCode === null && controller.signalCode === null) { controller.kill("SIGKILL"); await controllerClosed; }
      });
      await attempt(async () => other?.release());
      let shutdownObservation;
      try {
        const printed = (await execute("/bin/launchctl", ["print", service], { timeout: 1000 })).stdout;
        const pid = Number(printed.match(/\n\tpid = (\d+)/)?.[1]);
        if (pid) {
          shutdownObservation = { pid, groupOwned: false };
          const pgid = Number((await execute("/bin/ps", ["-o", "pgid=", "-p", String(pid)])).stdout.trim());
          const valid = Number.isInteger(pid) && pid > 1 && (pgid === pid || pgid === 1);
          if (!valid) failures.push(new Error(`invalid launchd publication ownership: pid=${pid} pgid=${pgid}`));
          shutdownObservation = { pid, pgid, groupOwned: valid && pid === pgid };
        }
      } catch (error) { evidence.shutdownObservationError = String(error); }
      await attempt(async () => {
        try { await execute("/bin/launchctl", ["bootout", service], { timeout: 5000, killSignal: "SIGKILL" }); }
        catch (error) { if (![3, 113].includes(error.code)) throw error; }
      });
      await attempt(async () => { await eventually(async () => {
        try { await execute("/bin/launchctl", ["print", service], { timeout: 1000 }); return false; }
        catch (error) { return error.code === 113 && error.stderr.includes(`Could not find service "${label}"`); }
      }, 5000); evidence.jobAbsent = true; });
      await attempt(async () => {
        if (owner) {
          assert.equal(owner.groupOwned, true, "invalid ready ownership must retain the reservation");
          await eventually(() => !processAlive(owner.pid) && !processAlive(-owner.pgid), 5000);
        }
        if (shutdownObservation) await eventually(() => !processAlive(shutdownObservation.pid) &&
          (!shutdownObservation.groupOwned || !processAlive(-shutdownObservation.pgid)), 5000);
        const matching = (await execute("/bin/ps", ["-axo", "pid=,command="])).stdout.split("\n").filter(line => line.includes(root) && Number(line.trim().split(/\s+/)[0]) !== process.pid);
        assert.deepEqual(matching, []);
        evidence.ownedProcessesAbsent = true;
      });
      // Recovery is explicit and token-scoped; the ordinary reclaim path must
      // never release a live externally managed job after controller death.
      if (!failures.length && evidence.jobAbsent && evidence.ownedProcessesAbsent) await attempt(async () => {
      const db = new DatabaseSync(fixtureQuotaFile(MAC_WORK_ROOT));
      try {
        db.exec("BEGIN IMMEDIATE");
        const rows = db.prepare("SELECT * FROM external_fixture_jobs WHERE label=? AND run_root=?").all(label, root);
        assert.equal(rows.length, 1); token ??= rows[0].token;
        assert.equal(rows[0].token, token);
        assert.equal(db.prepare("SELECT pid FROM fixture_slots WHERE token=?").get(token).pid, controller.pid);
        db.prepare("DELETE FROM external_fixture_jobs WHERE token=?").run(token);
        db.prepare("DELETE FROM fixture_slots WHERE token=?").run(token);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { db.close(); }
      evidence.slotReleased = !inspectFixtureSlots(MAC_WORK_ROOT).some(row => row.token === token);
      });
      for (const name of ["controller.mjs", "fixture.plist", "owner.mjs", "ready.json", "stdout.log", "stderr.log"])
        await attempt(async () => { try { evidence[name] = await readFile(path.join(root, name), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; } });
      evidence.shutdownObservation = shutdownObservation;
      Object.assign(evidence, { controllerPid: controller.pid, checkpoint, slot, owner,
        primaryError: primaryError ? String(primaryError) : null, cleanupErrors: failures.map(String) });
      await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), `controller-window-${phase}.json`), evidence);
      if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, "Controller window closeout failed; evidence retained");
    }
  });
}
