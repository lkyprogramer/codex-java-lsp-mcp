import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GradleDomain, defaultGradleCleanupIO, discoveredGradleDistributions, loadGradleDistributionConfig, serviceGradleDomain,
  type GradleCleanupIO, type GradleDistribution } from "./gradle-domain.js";
import { buildJavaSettings } from "../jdtls-semantic-backend.js";
import { javaSymbol } from "../tools/symbol.js";
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

test("a position request reports a blocked semantic domain instead of an empty answer", async t => {
  const io: GradleCleanupIO = { alive: () => false, async execute(_dist, args) {
    if (args[0] === "--stop") throw new Error("injected stop failure"); return "No Gradle daemons are running.\n";
  } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  await assert.rejects(domain.recover(async () => {}), /injected stop failure/);
  const repo = await home(t);
  await writeFile(path.join(repo, "A.java"), "class A { int a() { return 1; } }\n");
  const factory = fakeTransportFactory();
  const session = new JdtlsSession(repo, [], { transportFactory: factory, gradleDomain: domain });
  t.after(() => session.stop());
  await assert.rejects(javaSymbol({ repoRoot: repo, session } as never, { file: path.join(repo, "A.java"), line: 1, column: 15 } as never),
    (error: { code?: string; message?: string }) => error.code === "JDT_NOT_READY" && /semanticState=RECOVERY_BLOCKED: injected stop failure/.test(error.message ?? ""));
  assert.equal(factory.spawnInputs.length, 0);
});

test("stop exit zero cannot stand in for actual daemon exit", async t => {
  const io: GradleCleanupIO = { alive: () => true, async execute() { return "   PID STATUS INFO\n   123 BUSY 9.3.1\n"; } };
  const domain = new GradleDomain(await home(t), [distribution("9.3.1")], io);
  domain.ownerBindingRestored();
  await assert.rejects(domain.recover(async () => {}, performance.now(), 100), /deadline exceeded/);
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED"); assert.equal(domain.status().staticAdmission, true);
});

test("a daemon still registering when its client died is stopped once it registers; one that never does blocks semantic", async t => {
  const DAEMON = "/jdk/bin/java -cp gradle-daemon-main-9.3.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.3.1";
  const scenario = async (registersAfterStops: number, budgetMs = 10000) => {
    const selectedHome = await home(t);
    await mkdir(path.join(selectedHome, "daemon", "9.3.1"), { recursive: true });
    // Fresh logs: 4242 is still registering; 4343 is a live non-Gradle process that reused an old pid.
    for (const pid of [4242, 4343]) await writeFile(path.join(selectedHome, "daemon", "9.3.1", `daemon-${pid}.out.log`), "");
    let stops = 0;
    const io: GradleCleanupIO = {
      alive: pid => pid === 4343 || (pid === 4242 && stops < registersAfterStops),
      async command(pid) { return pid === 4242 ? DAEMON : "/usr/bin/vim notes.txt"; },
      async execute(_dist, args) { if (args[0] === "--stop") stops += 1; return "No Gradle daemons are running.\n"; }
    };
    const domain = new GradleDomain(selectedHome, [distribution("9.3.1")], io);
    const outcome = await domain.recover(async () => {}, performance.now(), budgetMs).then(() => "READY", (error: Error) => error.message);
    return { outcome, stops, state: domain.status().semanticState };
  };
  assert.deepEqual(await scenario(2), { outcome: "READY", stops: 2, state: "READY" });
  const never = await scenario(Infinity, 700);
  assert.match(never.outcome, /deadline exceeded/);
  assert.equal(never.state, "RECOVERY_BLOCKED");
  assert.ok(never.stops >= 2, "--stop was retried while the daemon was registering");
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

const quietIO = (calls: string[]): GradleCleanupIO => ({ alive: () => false, async execute(dist, args) {
  calls.push(`${dist.version}:${args[0]}:${dist.launcher}`); return "No Gradle daemons are running.\n";
} });

test("a discovered domain that never ran a daemon is READY without any Gradle command", async t => {
  const calls: string[] = [];
  const domain = new GradleDomain(await home(t), discoveredGradleDistributions({ distributions: [] }, "/private/jdk"), quietIO(calls));
  await domain.recover(async () => {});
  assert.deepEqual(calls, []); assert.equal(domain.status().semanticState, "READY");
});

test("discovery cleans each used version with its configured or completed wrapper launcher, and blocks on one it cannot stop", async t => {
  const root = await home(t);
  for (const version of ["9.3.1", "8.9", "7.6", "not-a-version"]) await mkdir(path.join(root, "daemon", version), { recursive: true });
  // 8.9: a wrapper distribution this home completed; 7.6: unpacked but never completed (no .zip.ok).
  const wrapper = (version: string) => path.join(root, "wrapper/dists", `gradle-${version}-bin`, "h1", `gradle-${version}`, "bin", "gradle");
  for (const version of ["8.9", "7.6"]) { await mkdir(path.dirname(wrapper(version)), { recursive: true }); await writeFile(wrapper(version), `launcher ${version}`); }
  await writeFile(path.join(root, "wrapper/dists/gradle-8.9-bin/h1/gradle-8.9-bin.zip.ok"), "");
  const calls: string[] = [];
  const domain = new GradleDomain(root, discoveredGradleDistributions({ distributions: [distribution("9.3.1")] }), quietIO(calls));
  await assert.rejects(domain.recover(async () => {}), /Gradle 7\.6 ran in this domain but has no verified local distribution/);
  assert.deepEqual(calls.filter(call => call.includes(":--stop:")), ["8.9:--stop:" + wrapper("8.9"), "9.3.1:--stop:/private/gradle-9.3.1/bin/gradle"]);
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
  const { distributions } = await discoveredGradleDistributions({ distributions: [distribution("9.3.1")] })(root);
  assert.equal(distributions.find(item => item.version === "8.9")?.launcherSha256, createHash("sha256").update("launcher 8.9").digest("hex"));
  assert.equal(distributions.find(item => item.version === "8.9")?.javaHome, "/private/jdk", "a wrapper version runs on the configured JDK");
});

test("the service domain reads its configuration at each cleanup: a bad one blocks semantic admission instead of disabling the gate", async t => {
  const root = await home(t);
  const state = path.join(root, "state");
  const file = path.join(root, "gradle.json");
  const env = (extra: NodeJS.ProcessEnv) => ({ JAVA_LSP_SERVICE_STATE_ROOT: state, JAVA_LSP_GRADLE_DISTRIBUTIONS: file, ...extra });
  await writeFile(file, JSON.stringify({ import: "9.3.1", distributions: [{ ...distribution("9.3.1"), gradleHome: "/private/gradle-9.3.1" }] }));
  await mkdir(state);
  const good = JSON.stringify({ import: "9.3.1", distributions: [{ ...distribution("9.3.1"), gradleHome: "/private/gradle-9.3.1" }] });
  const domain = serviceGradleDomain(env({}), quietIO([]));
  assert.equal(domain.home, path.join(state, "jdt-gradle-home"));
  await domain.recover(async () => {});
  assert.deepEqual(domain.gradleImport, { gradleHome: "/private/gradle-9.3.1", javaHome: "/private/jdk" });
  await writeFile(file, JSON.stringify({ import: "9.3.1", distributions: [distribution("9.3.1")] }));
  assert.throws(() => loadGradleDistributionConfig(env({})), /no configured gradleHome/);
  assert.throws(() => loadGradleDistributionConfig(env({ JAVA_LSP_GRADLE_DISTRIBUTIONS: "gradle.json" })), /absolute path/);
  // The file is read by each cleanup: a broken one blocks, a corrected one recovers.
  await assert.rejects(domain.recover(async () => {}), /no configured gradleHome/);
  assert.equal(domain.gradleImport, undefined);
  assert.equal(domain.status().semanticState, "RECOVERY_BLOCKED");
  assert.throws(() => domain.assertSemanticAdmission(), /semanticState=RECOVERY_BLOCKED/);
  await writeFile(file, good);
  await domain.recover(async () => {});
  assert.equal(domain.status().semanticState, "READY");
});

test("a configured import installation replaces the wrapper and never names a Gradle version", () => {
  const input = { repoRoot: "/repo", buildSystem: "gradle" as const, projectJdk: {} as never,
    generatedCode: { annotationProcessing: { enabled: false } } as never, gradleHome: "/private/home" };
  const gradle = (settings: Record<string, unknown>) => (settings as { java: { import: { gradle: Record<string, unknown> } } }).java.import.gradle;
  const imported = gradle(buildJavaSettings({ ...input, gradleImport: { gradleHome: "/private/gradle-9.3.1", javaHome: "/private/jdk" } }));
  assert.deepEqual([imported.home, imported.wrapper, imported.java, imported.version, (imported.user as { home: string }).home],
    ["/private/gradle-9.3.1", { enabled: false }, { home: "/private/jdk" }, undefined, "/private/home"]);
  const wrapper = gradle(buildJavaSettings(input));
  assert.deepEqual([wrapper.home, wrapper.wrapper, wrapper.java], [undefined, undefined, undefined]);
});
