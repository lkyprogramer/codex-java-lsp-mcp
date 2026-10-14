import { appendFileSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertOwnerLock, ownerChildStdio } from "../dist/mac-platform/owner-lock.js";
import { BuilderSupervisor } from "../dist/java-index/builder-supervisor.js";
import { defaultJdtlsTransportFactory } from "../dist/jdtls-transport.js";
import { buildJdtlsEnv } from "../dist/jdtls-lsp-io.js";
import { GradleDomain } from "../dist/mac-platform/gradle-domain.js";
import { buildJavaSettings, buildInitializeParams, pickJavaConfigurationSection } from "../dist/jdtls-semantic-backend.js";
import { callMacNative } from "../dist/mac-platform/clonefile.js";

const root = process.argv[2];
const options = JSON.parse(readFileSync(path.join(root, "options.json"), "utf8"));
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const record = value => appendFileSync(path.join(root, "timeline.jsonl"), `${JSON.stringify({ ...value, pid: process.pid, pgid, at: performance.timeOrigin + performance.now() })}\n`);
assertOwnerLock();
record({ type: "ready", execPath: process.execPath, versions: { ...process.versions } });
let builder, jdt, lastCommand;
let importDomain;
if (options.jdtImport) {
  importDomain = new GradleDomain(buildJdtlsEnv(options.javaHome).GRADLE_USER_HOME, [options.jdtImport.distribution]);
  importDomain.ownerBindingRestored();
  record({ type: "import-admission", status: importDomain.status() });
}
async function startJdtImport() {
  try { importDomain.assertSemanticAdmission(); }
  catch (error) { record({ type: "import-blocked", code: error.code, status: importDomain.status() }); return; }
  if (jdt) throw new Error("JDT import already started");
  const env = buildJdtlsEnv(options.javaHome);
  const settings = buildJavaSettings({ repoRoot: path.join(root, "repo"), buildSystem: "gradle",
    projectJdk: { resolvedHome: options.javaHome, runtimeName: "JavaSE-25" },
    generatedCode: { annotationProcessing: { enabled: false } }, gradleHome: env.GRADLE_USER_HOME });
  // No gradle.version: JDT LS prefers it over gradle.home and the Tooling API
  // then downloads a fresh distribution instead of running the frozen one.
  Object.assign(settings.java.import.gradle, { home: options.jdtImport.gradleHome,
    wrapper: { enabled: false }, offline: { enabled: true }, java: { home: options.javaHome } });
  jdt = defaultJdtlsTransportFactory.spawn({ binary: options.jdtlsBin,
    args: ["-data", path.join(root, "jdt-data"), "-configuration", path.join(root, "jdt-configuration"),
      "--jvm-arg=-Xms128m", "--jvm-arg=-Xmx512m", `--jvm-arg=-Duser.home=${process.env.HOME}`],
    cwd: path.join(root, "repo"), env });
  const connection = jdt.connection;
  for (const method of ["client/registerCapability", "window/workDoneProgress/create", "window/showMessageRequest"])
    connection.onRequest(method, () => null);
  connection.onRequest("workspace/applyEdit", () => ({ applied: false }));
  connection.onRequest("workspace/configuration", params => {
    record({ type: "import-configuration-request", params });
    return (params.items ?? []).map(item => !item.section || item.section === "java" ? settings.java :
      item.section.startsWith("java.") ? pickJavaConfigurationSection(settings.java, item.section.slice(5)) : null);
  });
  for (const method of ["language/status", "language/progressReport", "window/logMessage", "window/showMessage", "$/progress"])
    connection.onNotification(method, params => record({ type: "import-notification", method, params }));
  connection.onError(error => record({ type: "import-connection-error", error: String(error) }));
  jdt.child.stderr.on("data", bytes => appendFileSync(path.join(root, "jdt-stderr.log"), bytes));
  connection.listen();
  const initialize = buildInitializeParams(path.join(root, "repo"), settings);
  record({ type: "import-jdt-spawned", childPid: jdt.child.pid, env: { GRADLE_USER_HOME: env.GRADLE_USER_HOME }, settings, initialize });
  void connection.sendRequest("initialize", initialize).then(result => {
    record({ type: "import-initialized", result });
    connection.sendNotification("initialized", {});
    connection.sendNotification("workspace/didChangeConfiguration", { settings });
  }, error => record({ type: "import-initialize-failed", error: String(error) }));
}
const children = new Set();
if (options.child) {
  const child = spawn(process.execPath, [path.join(options.sourceRoot, "scripts/ilv2-mac-owner-descendant.mjs"), root, String(options.depth ?? 1)],
    { env: process.env, stdio: ownerChildStdio(["ignore", "inherit", "inherit"]) });
  children.add(child);
}
if (options.builder) {
  writeFileSync(path.join(root, "repo", "Example.java"), "class Example { int value; int get() { return value; } }\n");
  builder = new BuilderSupervisor({ repoRoot: path.join(root, "repo"), dbPath: path.join(options.cacheRoot, "index.sqlite"), idleMs: 60000 });
  await builder.coldBuild();
  record({ type: "builder-parsed", status: builder.status() });
  await builder.submit({ kind: "reconcile", generation: 1 });
  record({ type: "builder-serving", status: builder.status() });
}
if (options.jdtlsBin && !options.jdtImport) {
  const env = buildJdtlsEnv(options.javaHome);
  jdt = defaultJdtlsTransportFactory.spawn({ binary: options.jdtlsBin, args: ["-data", path.join(root, "jdt-data"), "-configuration", path.join(root, "jdt-configuration"), "--jvm-arg=-Xms128m", "--jvm-arg=-Xmx512m", `--jvm-arg=-Duser.home=${process.env.HOME}`], cwd: path.join(root, "repo"), env });
  jdt.connection.listen();
  record({ type: "jdt-spawned", childPid: jdt.child.pid, gradleHome: env.GRADLE_USER_HOME });
}
if (options.tapi) {
  const home = buildJdtlsEnv(options.javaHome).GRADLE_USER_HOME;
  const child = spawn(path.join(options.javaHome, "bin/java"), ["-cp", options.tapi.classpath, "Ilv2TapiFixture", options.tapi.project, home, options.tapi.gradleHome, options.tapi.phaseFile, String(options.tapi.pauseMs ?? 0)],
    { env: buildJdtlsEnv(options.javaHome), stdio: ownerChildStdio(["ignore", "inherit", "inherit"]) });
  children.add(child);
  child.once("error", error => { record({ type: "tapi-error", error: error.message }); });
  child.once("close", (code, signal) => record({ type: "tapi-exit", childPid: child.pid, code, signal }));
  record({ type: "tapi-spawned", childPid: child.pid, gradleHome: home });
}
for (;;) {
  try {
    const command = JSON.parse(readFileSync(path.join(root, "command.json"), "utf8"));
    if (command.id !== lastCommand) {
      lastCommand = command.id;
      if (command.type === "recover-import") {
        if (!importDomain || jdt) throw new Error("recovery requires an import domain without JDT");
        await importDomain.recover(async () => {});
        record({ type: "import-recovered", status: importDomain.status() });
      }
      if (command.type === "start-import") await startJdtImport();
      if (command.type === "close-lock") { closeSync(4); record({ type: "lock-closed" }); }
      if (command.type === "check-lock") {
        try { assertOwnerLock(); record({ type: "lock-valid" }); }
        catch (error) { record({ type: "lock-invalid", code: error.code ?? error.message }); }
      }
      if (command.type === "check-child-binding") {
        try { ownerChildStdio(["ignore", "inherit", "inherit"], { ...process.env, ILV2_OWNER_CACHE_ROOT: undefined }); record({ type: "child-binding-accepted" }); }
        catch (error) { record({ type: "child-binding-rejected", error: error.message }); }
      }
      if (command.type === "check-native-call") {
        try { record({ type: "native-call", ok: true, result: await callMacNative(["verify-owner-lock", process.env.ILV2_OWNER_CACHE_ROOT]) }); }
        catch (error) { record({ type: "native-call", ok: false, error: error.message }); }
      }
      if (command.type === "stop") {
        await builder?.stop();
        if (jdt) { jdt.connection.dispose(); jdt.child.kill("SIGTERM"); }
        for (const child of children) child.kill("SIGTERM");
        record({ type: "normal-exit" }); process.exit(0);
      }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await delay(25);
}
