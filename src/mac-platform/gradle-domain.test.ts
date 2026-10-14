import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GradleDomain, defaultGradleCleanupIO, type GradleCleanupIO, type GradleDistribution } from "./gradle-domain.js";
import { JdtlsSession } from "../jdtls-session.js";
import { fakeTransportFactory } from "../test-support/fake-jdtls.test.js";

const distribution = (version: string): GradleDistribution => ({ version, launcher: `/private/gradle-${version}/bin/gradle`, launcherSha256: "a".repeat(64), javaHome: "/private/jdk" });
async function home(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gradle-domain-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("Gradle cleanup dispatches every frozen version once in a single-flight domain", async t => {
  const calls: string[] = [];
  const io: GradleCleanupIO = { alive: () => false, async execute(dist, args, selectedHome) {
    calls.push(`${dist.version}:${args[0]}:${selectedHome}`); return "No Gradle daemons are running.\n";
  } };
  const selectedHome = await home(t);
  const domain = new GradleDomain(selectedHome, [distribution("9.3.1"), distribution("8.9")], io);
  let closed = 0;
  const a = domain.recover(async () => { closed++; }); const b = domain.recover(async () => { closed++; });
  assert.equal(a, b); await a; assert.equal(closed, 1);
  assert.deepEqual(calls.filter(value => value.includes(":--stop:")), [`9.3.1:--stop:${selectedHome}`, `8.9:--stop:${selectedHome}`]);
  assert.equal(domain.status().semanticState, "READY");
});

test("gradle-failure-preserves-static-admission-state", async t => {
  const io: GradleCleanupIO = { alive: () => false, async execute(_dist, args) {
    if (args[0] === "--stop") throw new Error("injected stop failure"); return "No Gradle daemons are running.\n";
  } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  domain.ownerBindingRestored();
  await assert.rejects(domain.recover(async () => {}), /injected stop failure/);
  assert.equal(domain.status().staticAdmission, true); assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
  const factory = fakeTransportFactory();
  const session = new JdtlsSession(await home(t), [], { transportFactory: factory, gradleDomain: domain });
  await assert.rejects(session.ensureStarted(), /semanticState=RECOVERY_BLOCKED/);
  assert.equal(factory.spawnInputs.length, 0);
  await session.stop();
});

test("stop exit zero cannot stand in for actual daemon exit", async t => {
  const io: GradleCleanupIO = { alive: () => true, async execute() { return "   PID STATUS INFO\n   123 BUSY 9.3.1\n"; } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  domain.ownerBindingRestored();
  await assert.rejects(domain.recover(async () => {}, performance.now(), 100), /deadline exceeded/);
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED"); assert.equal(domain.status().staticAdmission, true);
});

test("unrecognized status cannot silently clear semantic recovery", async t => {
  const io: GradleCleanupIO = { alive: () => false, async execute() { return "unknown registry status"; } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  await assert.rejects(domain.recover(async () => {}), /unrecognized Gradle status/);
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
});
test("timed-out JDT close retains single-flight until its actual completion", async t => {
  let resolveClose!: () => void;
  const closing = new Promise<void>(resolve => { resolveClose = resolve; });
  let calls = 0;
  const io: GradleCleanupIO = { alive: () => false, async execute() { calls++; return "No Gradle daemons are running.\n"; } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  domain.ownerBindingRestored();
  const first = domain.recover(() => closing, performance.now(), 20);
  await assert.rejects(first, /JDT close deadline exceeded/);
  const second = domain.recover(async () => {});
  assert.equal(first, second); await assert.rejects(second, /JDT close deadline exceeded/);
  assert.equal(calls, 0); assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
  resolveClose(); await closing; await Promise.resolve();
  await domain.recover(async () => {}); assert.equal(domain.status().semanticState, "READY");
});
test("timed-out Gradle command retains single-flight until actual completion", async t => {
  let resolveStatus!: (value: string) => void;
  const waiting = new Promise<string>(resolve => { resolveStatus = resolve; });
  let calls = 0;
  const io: GradleCleanupIO = { alive: () => false, async execute() { calls++; return calls === 1 ? waiting : "No Gradle daemons are running.\n"; } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  const first = domain.recover(async () => {}, performance.now(), 20);
  await assert.rejects(first, /Gradle command deadline exceeded/);
  const second = domain.recover(async () => {});
  assert.equal(first, second); await assert.rejects(second); assert.equal(calls, 1);
  resolveStatus("No Gradle daemons are running.\n"); await waiting; await Promise.resolve();
});
test("frozen cleanup client ignoring SIGTERM is SIGKILLed and actually reaped", async t => {
  const root = await home(t);
  const launcher = path.join(root, "stubborn-client"), pidFile = path.join(root, "pid.txt");
  const source = `#include <stdio.h>\n#include <signal.h>\n#include <unistd.h>\n#include <string.h>\nint main(int argc,char**argv){if(argc>1&&strcmp(argv[1],"--ready-probe")==0){puts("ILV2_CLIENT_READY");return 0;}signal(SIGTERM,SIG_IGN);FILE*f=fopen(${JSON.stringify(pidFile)},"w");if(!f)return 2;fprintf(f,"%d",getpid());fclose(f);for(;;)pause();}\n`;
  const sourceFile = path.join(root, "client.c"); await writeFile(sourceFile, source);
  // A native fixture reaches its barrier without relying on Node module startup
  // fitting the command deadline. The 300ms deadline is unchanged.
  await promisify(execFile)("/usr/bin/clang", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", sourceFile, "-o", launcher]);
  const input = { ...distribution("9.3.1"), launcher, launcherSha256: createHash("sha256").update(await readFile(launcher)).digest("hex") };
  // Establish that this newly linked executable can reach main before injecting
  // the short deadline. A pre-main environment block is a separate precondition.
  assert.match(await defaultGradleCleanupIO.execute(input, ["--ready-probe"], root, 5000), /ILV2_CLIENT_READY/);
  const started = performance.now();
  await assert.rejects(defaultGradleCleanupIO.execute(input, ["--stop"], root, 300), error => (error as { signal?: string }).signal === "SIGKILL");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.equal(defaultGradleCleanupIO.alive(pid), false);
  assert.ok(performance.now() - started < 1500);
});
