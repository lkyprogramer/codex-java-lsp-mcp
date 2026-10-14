import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnerFixture, eventually, processAlive, processGroup } from "./ilv2-mac-owner-fixture.mjs";
import { execute, readJson, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { GradleDomain, defaultGradleCleanupIO } from "../dist/mac-platform/gradle-domain.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function toolchains() {
  const tools = await readJson(process.env.ILV2_TOOLCHAINS ?? "ILV2_TOOLCHAINS is unset: name the frozen toolchain INPUT");
  for (const file of tools.files) assert.equal(sha256(await readFile(file.path)), file.sha256, `frozen toolchain drift: ${file.path}`);
  return tools;
}
async function evidence(name, data) { await writeJson(path.join(process.env.ILV2_RUN_ROOT, "raw", `${name}.json`), data); }
async function busy(fixture) { return eventually(async () => (await readFile(path.join(fixture.root, "stdout.log"), "utf8").catch(() => "")).includes('"code":"OWNER_BUSY"'), 6500); }
async function gradlePid(home) {
  return eventually(async () => {
    const names = await readdir(path.join(home, "daemon/9.3.1")).catch(() => []);
    const pids = names.flatMap(name => /^daemon-(\d+)\.out\.log$/.exec(name)?.slice(1).map(Number) ?? []);
    return pids.find(pid => processAlive(pid));
  }, 60000);
}

test("jdt-wrapper-preserves-lock-and-pgid", { timeout: 45000 }, async t => {
  const tools = await toolchains();
  const one = await createOwnerFixture(t, { route: "direct", jdtlsBin: tools.jdtlsBin, javaHome: tools.javaHome }); const owner = await one.ready();
  const jdt = await eventually(async () => (await one.records()).find(row => row.type === "jdt-spawned"));
  const command = await eventually(async () => {
    const out = (await execute("/bin/ps", ["-o", "command=", "-p", String(jdt.childPid)])).stdout;
    return out.includes("org.eclipse.jdt.ls.core.id1") ? out : false;
  });
  assert.equal(await processGroup(jdt.childPid), owner.pgid);
  const fd = (await execute("/usr/sbin/lsof", ["-a", "-p", String(jdt.childPid), "-d", "4"])).stdout;
  assert.match(fd, /4u.*\.owner\.lock/);
  assert.equal(jdt.gradleHome, path.join(one.root, "service-state/jdt-gradle-home"));
  await one.command({ type: "close-lock" }); await eventually(async () => (await one.records()).some(row => row.type === "lock-closed"));
  const two = await createOwnerFixture(t, { route: "direct", cacheRoot: one.cacheRoot }); await busy(two);
  assert.equal((await two.records()).length, 0);
  await evidence(t.name, { route: "G01-direct-fixture", launchd: "NOT_RUN", owner, jdt, command, fd, retainedOFD: true });
  await two.close(); await one.close();
});

test("gradle-private-home-and-bounded-recovery", { timeout: 180000 }, async t => {
  const tools = await toolchains();
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-tapi-"));
  const classes = path.join(root, "classes"); await mkdir(classes);
  const javaSource = path.join(root, "Ilv2TapiFixture.java");
  await writeFile(javaSource, `import java.io.File;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;
import org.gradle.tooling.model.eclipse.EclipseProject;
public final class Ilv2TapiFixture {
  public static void main(String[] args) {
    GradleConnector connector = GradleConnector.newConnector().forProjectDirectory(new File(args[0]))
      .useGradleUserHomeDir(new File(args[1])).useInstallation(new File(args[2]));
    try (ProjectConnection connection = connector.connect()) {
      EclipseProject model = connection.model(EclipseProject.class)
        .withArguments("--offline", "-Pilv2Phase=" + args[3], "-Pilv2Pause=" + args[4])
        .setStandardOutput(System.out).setStandardError(System.err).get();
      System.out.println("ILV2_TAPI_MODEL=" + model.getName());
    } finally { connector.disconnect(); }
  }
}\n`);
  await execute(path.join(tools.javaHome, "bin/javac"), ["-cp", tools.classpath, "-d", classes, javaSource]);
  async function start(name, pauseMs) {
    const project = path.join(root, name); await mkdir(project);
    await writeFile(path.join(project, "settings.gradle"), `rootProject.name = 'isolated-${name}'\n`);
    await writeFile(path.join(project, "build.gradle"), `plugins { id 'java'; id 'eclipse' }\nnew File(project.property('ilv2Phase')).text = 'IMPORT_STARTED'\nThread.sleep(Long.parseLong(project.property('ilv2Pause')))\n`);
    await writeFile(path.join(project, "gradle.properties"), "org.gradle.jvmargs=-Xms128m -Xmx512m\norg.gradle.daemon.idletimeout=60000\n");
    const phaseFile = path.join(project, "phase.txt");
    const fixture = await createOwnerFixture(t, { route: "direct", javaHome: tools.javaHome, tapi: { classpath: `${classes}:${tools.classpath}`, gradleHome: tools.gradleHome, project, phaseFile, pauseMs } });
    const home = path.join(fixture.root, "service-state/jdt-gradle-home");
    const commands = [];
    const domain = new GradleDomain(home, [tools.distribution], {
      alive: defaultGradleCleanupIO.alive,
      async execute(distribution, args, selectedHome, timeoutMs) {
        const row = { executable: distribution.launcher, args: [...args, "--gradle-user-home", selectedHome], home: selectedHome, timeoutMs, at: performance.now() };
        commands.push(row);
        try { const stdout = await defaultGradleCleanupIO.execute(distribution, args, selectedHome, timeoutMs); row.stdout = stdout; row.exitCode = 0; return stdout; }
        catch (error) { row.exitCode = error.code; throw error; }
      }
    });
    // Hold the reservation through external teardown, including failure hooks.
    fixture.beforeClose(async () => {
      if (domain.status().semanticState !== "READY") await domain.recover(() => fixture.stopOwned());
    });
    const owner = await fixture.ready();
    await eventually(async () => (await readFile(phaseFile, "utf8").catch(() => "")) === "IMPORT_STARTED", 60000);
    const pid = await gradlePid(home);
    return { fixture, owner, home, domain, pid, commands };
  }
  const control = await start("control", 0);
  await eventually(async () => (await control.fixture.records()).some(row => row.type === "tapi-exit" && row.code === 0), 60000);
  const active = await start("active", 30000);
  const command = (await execute("/bin/ps", ["-o", "command=", "-p", String(active.pid)])).stdout;
  assert.match(command, /GradleDaemon 9\.3\.1/);
  const pgid = await processGroup(active.pid);
  const fds = (await execute("/usr/sbin/lsof", ["-a", "-p", String(active.pid), "-d", "4"])).stdout;
  assert.equal(fds.includes(".owner.lock"), false);
  assert.notEqual(pgid, active.owner.pgid);
  const faultAt = performance.now(); process.kill(active.owner.pid, "SIGKILL");
  await active.domain.recover(() => active.fixture.stopOwned(), faultAt);
  const elapsedMs = performance.now() - faultAt;
  assert.ok(elapsedMs <= 10000); assert.equal(processAlive(active.pid), false); assert.ok(processAlive(control.pid));
  assert.equal(active.domain.status().semanticState, "READY");
  await active.fixture.close();
  await evidence(t.name, { route: "G01-direct-fixture", launchd: "NOT_RUN", jdtDrivenImport: "NOT_RUN", actualTapiImport: true,
    version: tools.gradleVersion, active: { home: active.home, pid: active.pid, owner: active.owner, pgid, command, fds },
    control: { home: control.home, pid: control.pid, survived: true }, faultToBothExitMs: elapsedMs, commands: active.commands });
  await control.domain.recover(() => control.fixture.stopOwned());
  assert.equal(processAlive(control.pid), false);
  await control.fixture.close();
  for (const [name, item] of [["active", active], ["control", control]]) {
    const target = path.join(process.env.ILV2_RUN_ROOT, "raw", `gradle-${name}-${path.basename(item.fixture.root)}`);
    await mkdir(target);
    await cp(path.join(item.home, "daemon/9.3.1"), path.join(target, "daemon-9.3.1"), { recursive: true });
    await writeJson(path.join(target, "commands.json"), item.commands);
    await writeJson(path.join(target, "effective-home.json"), { home: item.home, daemonPid: item.pid, exited: !processAlive(item.pid) });
  }
});
