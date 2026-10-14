import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOwnerFixture, eventually, processAlive, processGroup } from "./ilv2-mac-owner-fixture.mjs";
import { execute, readJson, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { GradleDomain, defaultGradleCleanupIO } from "../dist/mac-platform/gradle-domain.js";

async function tools() {
  const frozen = await readJson(process.env.ILV2_MAC02B_TOOLCHAINS);
  for (const file of frozen.files) assert.equal(sha256(await readFile(file.path)), file.sha256, `toolchain drift: ${file.path}`);
  assert.equal(frozen.jdtVersion, "1.56.0"); assert.equal(frozen.gradleVersion, "9.3.1");
  return frozen;
}
async function record(fixture, type, pid) {
  return eventually(async () => (await fixture.records()).find(row => row.type === type && (!pid || row.pid === pid)), 90000);
}
async function daemon(home) {
  return eventually(async () => {
    const entries = await readdir(path.join(home, "daemon/9.3.1")).catch(() => []);
    return entries.flatMap(name => /^daemon-(\d+)\.out\.log$/.exec(name)?.slice(1).map(Number) ?? []).find(processAlive);
  }, 90000);
}

// Real initialize/settings-driven import, separate from the direct TAPI proof.
// The two launchd reservations remain held until both groups and daemon domains exit.
test("launchd-jdt-settings-import-and-fault-recovery", { timeout: 300000 }, async t => {
  const frozen = await tools();
  const owned = [];
  const evidence = { toolchainDigest: frozen.filesDigest, route: "launchd-direct-native-exec", domains: [] };
  async function start(name, pauseMs) {
    // This test owns teardown: the adapter's ordinary t.after hook would
    // release the launchd lease before this test proves external daemon exit.
    const fixture = await createOwnerFixture({ after() {} }, { javaHome: frozen.javaHome, jdtlsBin: frozen.jdtlsBin,
      jdtImport: { distribution: frozen.distribution, gradleHome: frozen.gradleHome } });
    const home = path.join(fixture.root, "service-state/jdt-gradle-home");
    const commands = [];
    const domain = new GradleDomain(home, [frozen.distribution], {
      alive: defaultGradleCleanupIO.alive,
      async execute(distribution, args, selectedHome, timeoutMs) {
        const row = { args: [...args, "--gradle-user-home", selectedHome], home: selectedHome, timeoutMs, at: performance.now() };
        commands.push(row);
        try { row.stdout = await defaultGradleCleanupIO.execute(distribution, args, selectedHome, timeoutMs); row.exitCode = 0; return row.stdout; }
        catch (error) { row.exitCode = error.code; throw error; }
      }
    });
    const item = { fixture, home, domain, commands, name }; owned.push(item);
    evidence.domains.push({ name, root: fixture.root, label: fixture.label, home, commands });
    const repo = path.join(fixture.root, "repo");
    await writeFile(path.join(repo, "settings.gradle"), `rootProject.name = 'synthetic-${name}'\n`);
    await writeFile(path.join(repo, "build.gradle"), `plugins { id 'java'; id 'eclipse' }\nnew File(projectDir, 'phase.txt').text = 'IMPORT_STARTED'\nThread.sleep(${pauseMs}L)\n`);
    await writeFile(path.join(repo, "gradle.properties"), "org.gradle.jvmargs=-Xms128m -Xmx512m\norg.gradle.daemon.idletimeout=300000\n");
    await mkdir(path.join(repo, "src/main/java"), { recursive: true });
    await writeFile(path.join(repo, "src/main/java/Example.java"), "public class Example { public int value() { return 1; } }\n");
    item.owner = await fixture.ready();
    const initial = await record(fixture, "import-admission", item.owner.pid);
    assert.deepEqual(initial.status, { staticAdmission: true, semanticState: "RECOVERING" });
    await fixture.command({ type: "start-import" });
    const blocked = await record(fixture, "import-blocked", item.owner.pid); assert.equal(blocked.code, "JDT_NOT_READY");
    assert.equal((await fixture.records()).some(row => row.type === "import-jdt-spawned"), false);
    await fixture.command({ type: "recover-import" });
    assert.equal((await record(fixture, "import-recovered", item.owner.pid)).status.semanticState, "READY");
    await fixture.command({ type: "start-import" });
    item.jdt = await record(fixture, "import-jdt-spawned", item.owner.pid);
    await record(fixture, "import-initialized", item.owner.pid);
    assert.equal(item.jdt.env.GRADLE_USER_HOME, home);
    assert.equal(item.jdt.settings.java.import.gradle.user.home, home);
    assert.equal(item.jdt.initialize.initializationOptions.settings.java.import.gradle.user.home, home);
    await eventually(async () => (await readFile(path.join(repo, "phase.txt"), "utf8").catch(() => "")) === "IMPORT_STARTED", 90000);
    item.pid = await daemon(home);
    item.jdtPgid = await processGroup(item.jdt.childPid);
    item.jdtFd = (await execute("/usr/sbin/lsof", ["-a", "-p", String(item.jdt.childPid), "-d", "4"])).stdout;
    assert.equal(item.jdtPgid, item.owner.pgid); assert.match(item.jdtFd, /4u.*\.owner\.lock/);
    item.daemonPgid = await processGroup(item.pid);
    item.daemonFd = (await execute("/usr/sbin/lsof", ["-a", "-p", String(item.pid), "-d", "4"])).stdout;
    item.daemonCommand = (await execute("/bin/ps", ["-o", "command=", "-p", String(item.pid)])).stdout;
    assert.match(item.daemonCommand, /GradleDaemon 9\.3\.1/);
    assert.notEqual(item.daemonPgid, item.owner.pgid); assert.equal(item.daemonFd.includes(".owner.lock"), false);
    Object.assign(evidence.domains.at(-1), { owner: item.owner, jdt: item.jdt, pid: item.pid,
      jdtPgid: item.jdtPgid, jdtFd: item.jdtFd, daemonPgid: item.daemonPgid, daemonFd: item.daemonFd, daemonCommand: item.daemonCommand });
    return item;
  }
  let primaryError;
  try {
    const control = await start("control", 0);
    await eventually(async () => {
      const out = await defaultGradleCleanupIO.execute(frozen.distribution, ["--status"], control.home, 5000);
      return new RegExp(`^\\s*${control.pid}\\s+IDLE\\b`, "m").test(out);
    }, 60000);
    const active = await start("active", 30000);
    const beforeFaultStatus = await defaultGradleCleanupIO.execute(frozen.distribution, ["--status"], active.home, 5000);
    assert.match(beforeFaultStatus, new RegExp(`^\\s*${active.pid}\\s+BUSY\\b`, "m"));
    evidence.beforeFaultStatus = beforeFaultStatus;
    const faultAt = performance.now();
    evidence.fault = { targetPid: active.owner.pid, targetPgid: active.owner.pgid, at: faultAt };
    process.kill(active.owner.pid, "SIGKILL"); evidence.fault.signalSent = true;
    await active.domain.recover(async () => { await eventually(() => !processAlive(-active.owner.pgid), 10000); }, faultAt);
    const faultToBothExitMs = performance.now() - faultAt;
    assert.ok(faultToBothExitMs <= 10000, `same-fault cleanup took ${faultToBothExitMs}ms`);
    assert.equal(processAlive(-active.owner.pgid), false); assert.equal(processAlive(active.pid), false);
    assert.ok(processAlive(control.pid), "another private daemon domain must survive active recovery");
    const restarted = await active.fixture.ready(active.owner.pid);
    const restored = await record(active.fixture, "import-admission", restarted.pid);
    assert.deepEqual(restored.status, { staticAdmission: true, semanticState: "RECOVERING" });
    await active.fixture.command({ type: "start-import" });
    await record(active.fixture, "import-blocked", restarted.pid);
    assert.equal((await active.fixture.records()).some(row => row.type === "import-jdt-spawned" && row.pid === restarted.pid), false);
    await active.fixture.command({ type: "recover-import" });
    assert.equal((await record(active.fixture, "import-recovered", restarted.pid)).status.semanticState, "READY");
    Object.assign(evidence, { faultToBothExitMs, restarted, restored, controlSurvived: true, oldOwnerGroupAbsent: true,
      activeDaemonAbsent: true, semanticRecovery: active.domain.status(), restartJdtBeforeRecovery: false });
  } catch (error) {
    primaryError = error;
    evidence.primaryError = { message: String(error), stack: error.stack, code: error.code };
    throw error;
  } finally {
    // Never let the fixture's automatic close release a slot while its external
    // Gradle domain is live. Bootout and both exit proofs precede fixture.close.
    const failures = [];
    for (const item of owned.toReversed()) {
      try {
        try { await execute("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${item.fixture.label}`]); }
        catch (error) { if (![3, 113].includes(error.code)) throw error; }
        const rows = await item.fixture.records();
        await item.domain.recover(async () => {
          await eventually(() => rows.filter(row => row.type === "ready").every(row => !processAlive(-row.pgid)), 5000);
        });
        if (item.pid) assert.equal(processAlive(item.pid), false);
        const target = path.join(process.env.ILV2_RUN_ROOT, "raw", `jdt-import-${item.name}-${path.basename(item.fixture.root)}`);
        await mkdir(target);
        for (const [from, to] of [["service-state/jdt-gradle-home/daemon/9.3.1", "daemon-9.3.1"], ["jdt-data/.metadata", "jdt-metadata"],
          ["jdt-stderr.log", "jdt-stderr.log"], ["repo", "synthetic-repo"]]) {
          try { await cp(path.join(item.fixture.root, from), path.join(target, to), { recursive: true }); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await writeJson(path.join(target, "commands.json"), item.commands);
        await item.fixture.close();
      } catch (error) {
        failures.push(error);
        // A failed closeout preserves its lease and the minimal primary logs.
        const target = path.join(process.env.ILV2_RUN_ROOT, "raw", `jdt-import-failure-${item.name}-${path.basename(item.fixture.root)}`);
        try {
          await mkdir(target);
          for (const name of ["options.json", "fixture.plist", "timeline.jsonl", "stdout.log", "stderr.log", "jdt-stderr.log"])
            await cp(path.join(item.fixture.root, name), path.join(target, name)).catch(copyError => { if (copyError.code !== "ENOENT") throw copyError; });
          await writeJson(path.join(target, "residual.json"), { commands: item.commands,
            daemonPid: item.pid ?? null, daemonAlive: item.pid ? processAlive(item.pid) : null,
            ownerGroups: (await item.fixture.records()).filter(row => row.type === "ready").map(row => ({ pgid: row.pgid, alive: processAlive(-row.pgid) })) });
        } catch (captureError) { failures.push(captureError); }
      }
    }
    evidence.closeoutFailures = failures.map(error => ({ message: String(error), stack: error.stack, code: error.code }));
    await writeJson(path.join(process.env.ILV2_RUN_ROOT, "raw", `${t.name}.json`), evidence);
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, "JDT import closeout failed; quota must remain held");
  }
});
