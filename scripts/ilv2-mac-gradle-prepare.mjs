#!/usr/bin/env node
// Installer dependency preparation. This phase never starts JDT or the service.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFixtureSlot, ISOLATED_LAUNCHD_LABEL } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, cliOptions, execute, isMain, managedPath, readJson, requireUnprotectedRoot, requireValue, sha256, verifyRuntime, writeJson } from "./ilv2-mac-contracts.mjs";
import { jdtIndexPlugins, prepareJarIndexes } from "./ilv2-mac-jar-indexes.mjs";
import { formalTarget, requireFormalPath } from "./ilv2-mac-formal-target.mjs";
import { prepareLishueduMavenLocal } from "./ilv2-mac-lishuedu-preparation.mjs";

export async function validatePreparation(plan, planFile, formal = false) {
  requireValue(formal ? !process.env.JAVA_LSP_ISOLATED_VALIDATION : process.env.JAVA_LSP_ISOLATED_VALIDATION === "1",
    "wrong mode for Gradle installation preparation");
  const root = process.env.ILV2_RUN_ROOT;
  requireValue(root && path.isAbsolute(root) && await realpath(root) === root && plan.runRoot === root,
    "canonical registered run root required");
  requireValue((await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "run registration mismatch");
  requireUnprotectedRoot(root, "dependency preparation");
  requireValue(plan.schema === "ilv2-gradle-install-prepare/v1", "unsupported preparation plan");
  for (const key of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "GRADLE_OPTS", "JAVA_OPTS"]) {
    requireValue(!process.env[key], "host JVM options must be absent");
  }
  const files = [planFile, plan.workDirectory, plan.outputDirectory];
  const isolatedLishuedu = !formal && plan.projectId === "lishuedu";
  if (formal) {
    const target = formalTarget();
    await requireFormalPath(target.gradleHome, plan.gradleHome);
    await requireFormalPath(target.projects, process.env.JAVA_LSP_PROJECTS_JSON);
    const projects = await readJson(target.projects);
    const alias = projects.aliases?.find(row => row.lspEnabled === true && row.root === plan.repoRoot
      && (!plan.projectId || row.id === plan.projectId));
    requireValue(plan.ownerHome === target.home && plan.repoRoot === process.env.JAVA_LSP_PREPARED_GRADLE_REPO && alias
      && await realpath(plan.repoRoot) === plan.repoRoot, "formal preparation requires the enabled configured repository");
  } else files.push(plan.repoRoot, plan.gradleHome, plan.ownerHome);
  if (plan.reuseGradleModules) {
    requireValue(formal, "Gradle module cache reuse requires formal installation");
    files.push(plan.reuseGradleModules);
  }
  for (const file of files) {
    requireValue(await managedPath(root, file) === file, "preparation paths must belong to this run");
  }
  requireValue(plan.gradleHome === process.env.GRADLE_USER_HOME && plan.ownerHome === process.env.HOME,
    "installer and future JDT must share private HOME and Gradle home");
  requireValue(isolatedLishuedu ? typeof plan.lishueduMavenLocal === "string" : plan.lishueduMavenLocal === undefined,
    "lishuedu Maven input manifest is required for isolated preparation only");
  if (isolatedLishuedu) await prepareLishueduMavenLocal(plan, root);
  requireValue(Number.isFinite(plan.timeoutMs) && plan.timeoutMs > 0 && plan.timeoutMs <= 1800000,
    "installation dependency phase is bounded to 30 minutes");
  requireValue(Date.parse(plan.deadline) > Date.now(), "preparation deadline elapsed");
  const proxyPort = /^-Dhttps\.proxyPort=([1-9]\d{0,4})$/.exec(plan.jvmArguments?.[3] ?? "")?.[1];
  requireValue(plan.jvmArguments?.length === 4 && plan.jvmArguments[0] === "-Djdk.tls.client.protocols=TLSv1.2"
    && plan.jvmArguments[1] === "-Dhttps.protocols=TLSv1.2"
    && plan.jvmArguments[2] === "-Dhttps.proxyHost=127.0.0.1"
    && proxyPort && Number(proxyPort) <= 65535, "approved TLS/proxy profile required");
  return root;
}

async function validateInstallation([planFile, runtime, plist, logs, cache, ownership, label, port, canaryPort], sealed, formal) {
  const plan = await readJson(planFile);
  const root = await validatePreparation(plan, planFile, formal);
  const paths = [process.env.TMPDIR];
  if (formal) {
    const target = formalTarget();
    requireValue(label === target.label && port === target.port && Number(canaryPort) !== 38457, "formal label or port mismatch");
    for (const [name, value] of Object.entries({ runtime, plist, logs, cache, ownership })) await requireFormalPath(target[name], value);
  } else {
    requireValue(ISOLATED_LAUNCHD_LABEL.test(label), "isolated LaunchAgent label required");
    requireValue(![port, canaryPort].some(value => [38456, 38457].includes(Number(value))), "reserved HTTP port rejected");
    paths.push(runtime, plist, logs, cache, ownership);
  }
  for (const key of ["CODEX_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "JAVA_LSP_PROJECTS_JSON"]) {
    if (process.env[key] && !(formal && key === "JAVA_LSP_PROJECTS_JSON")) paths.push(process.env[key]);
  }
  for (const target of paths) {
    requireValue(target && await managedPath(root, target) === target, "installer paths must belong to this run");
  }
  jdtIndexPlugins(plan);
  const launcher = process.env.JDTLS_BIN;
  const plugins = path.dirname(plan.jdtCoreJar);
  requireValue(launcher && plan.runtimeFiles.some(file => file.path === launcher)
    && [path.resolve(plugins, "../bin/jdtls"), path.resolve(plugins, "../../bin/jdtls")].includes(await realpath(launcher)),
  "installed JDT launcher must use the frozen indexer plugins");
  if (sealed) {
    await verifyGradleInputs(plan);
    const projectsFile = process.env.JAVA_LSP_PROJECTS_JSON;
    const distributionsFile = process.env.JAVA_LSP_GRADLE_DISTRIBUTIONS;
    requireValue(projectsFile && distributionsFile && await managedPath(root, distributionsFile) === distributionsFile,
      "sealed installation requires projects and frozen Gradle distributions");
    if (!formal) {
      const projects = await readJson(projectsFile);
      requireValue(Array.isArray(projects.aliases) && projects.aliases.some(alias => alias.lspEnabled === true)
        && projects.aliases.every(alias => alias.root === plan.repoRoot
          && (alias.id === "lishuedu") === (plan.projectId === "lishuedu")), "sealed installation must target the prepared repository");
    }
    const distributions = await readJson(distributionsFile);
    const [distribution] = distributions.distributions ?? [];
    requireValue(distributions.distributions?.length === 1 && distributions.import === plan.distribution.version
      && distribution.version === plan.distribution.version && distribution.launcher === plan.distribution.launcher
      && distribution.launcherSha256 === plan.distribution.launcherSha256 && distribution.javaHome === plan.javaHome
      && distribution.gradleHome === plan.gradleInstallation, "sealed installation Gradle import differs from the preparation plan");
    const runtimeFiles = new Set(plan.runtimeFiles.map(file => file.path));
    requireValue(process.env.JAVA_HOME === plan.javaHome && process.env.JDTLS_JAVA_HOME === plan.javaHome
      && runtimeFiles.has(process.env.JDTLS_BIN) && runtimeFiles.has(path.join(plan.javaHome, "bin/java"))
      && runtimeFiles.has(path.join(plan.javaHome, "bin/javac"))
      && runtimeFiles.has(plan.distribution.launcher)
      && plan.classpath.split(path.delimiter).every(file => runtimeFiles.has(file)), "sealed installation toolchain differs from the preparation plan");
  }
  console.log(plan.jvmArguments[3].slice("-Dhttps.proxyPort=".length));
}

async function verifyGradleInputs(plan) {
  for (const file of plan.runtimeFiles) requireValue(sha256(await readFile(file.path)) === file.sha256, "consumed runtime drift");
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "Ilv2GradlePrepare.java");
  requireValue(sha256(await readFile(source)) === plan.javaSourceSha256, "preparation Java source drift");
  requireValue(sha256(await readFile(plan.jdtCoreJar)) === plan.jdtCoreJarSha256, "frozen JDT core changed");
  return source;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

export async function requireFormalModelFile(plan, file) {
  const maven = plan.ownerHome && path.join(plan.ownerHome, ".m2/repository");
  const anchor = [plan.gradleHome, plan.repoRoot, maven].filter(Boolean).find(root => {
    const relative = path.relative(root, file);
    return path.isAbsolute(file) && relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  });
  requireValue(anchor && (anchor !== maven || await managedPath(plan.ownerHome, maven) === maven)
    && await managedPath(anchor, file) === file && (await lstat(file)).isFile(),
    "formal model artifact outside canonical Gradle home, configured repository or owner Maven repository: " + file);
}

export async function prepareGradle(planFile, formal = false) {
  const plan = await readJson(planFile), root = await validatePreparation(plan, planFile, formal);
  await verifyRuntime();
  const { GradleDomain, prepareIsolatedGradleHome } = await import("../dist/mac-platform/gradle-domain.js");
  const { GRADLE_IMPORT_INIT_SCRIPT } = await import("../dist/jdtls-semantic-backend.js");
  const source = await verifyGradleInputs(plan);
  requireValue((await readdir(plan.gradleHome)).length === 0, "installation restore requires a physically empty Gradle home");
  await mkdir(plan.outputDirectory, { recursive: false });
  await mkdir(plan.workDirectory, { recursive: false });
  const out = { schema: "ilv2-gradle-install-prepare-result/v1", status: "IN_PROGRESS", startedAt: new Date().toISOString(), preparationPid: process.pid,
    planSha256: sha256(await readFile(planFile)), emptyBefore: { fileCount: 0, directoryCount: 0, allocatedFileBytes: 0 },
    projectModel: "NOT_RUN", aptModel: "NOT_RUN", resources: [] };
  const save = () => writeJson(path.join(plan.outputDirectory, "result.json"), out);
  await save();
  const abort = new AbortController(), stopAt = Math.min(Date.now() + plan.timeoutMs, Date.parse(plan.deadline));
  const requestStop = () => abort.abort(new Error("installation dependency phase stopped"));
  process.on("SIGTERM", requestStop); process.on("SIGINT", requestStop);
  const timer = setTimeout(() => abort.abort(new Error("installation dependency phase deadline")), stopAt - Date.now());
  let lease, java, javaClosed, killTimer, failure;
  const observer = path.join(plan.gradleHome, "init.d/ilv2-install-observe.gradle");
  const killJava = () => {
    if (!java?.pid) return;
    try { process.kill(-java.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    killTimer ??= setTimeout(() => { try { process.kill(-java.pid, "SIGKILL"); } catch {} }, 3000);
  };
  try {
    if (plan.lishueduMavenLocal) out.mavenLocal = await prepareLishueduMavenLocal(plan, root, { stage: true });
    if (plan.reuseGradleModules) {
      const start = performance.now();
      const caches = path.join(plan.gradleHome, "caches");
      await mkdir(caches);
      await execute("/usr/bin/rsync", ["-a", "--exclude=*.lock", "--exclude=gc.properties",
        plan.reuseGradleModules + "/", path.join(caches, "modules-2") + "/"],
      { signal: abort.signal, timeout: 90000, maxBuffer: 1024 * 1024 });
      out.reusedGradleModules = { status: "PASS", path: plan.reuseGradleModules, elapsedMs: performance.now() - start };
    }
    await prepareIsolatedGradleHome(plan.gradleHome, plan.ownerHome);
    await mkdir(path.dirname(observer));
    const observationPath = Buffer.from(path.join(plan.outputDirectory, "build-properties.jsonl")).toString("base64");
    await writeFile(observer, `gradle.beforeSettings { settings ->
 def props=[:]
 ['user.home','org.gradle.parallel','jdk.tls.client.protocols','https.protocols','https.proxyHost','https.proxyPort'].each { key -> props[key]=System.getProperty(key) }
 def row=[pid:ProcessHandle.current().pid(),gradleUserHome:gradle.gradleUserHomeDir.absolutePath,properties:props]
 new File(new String('${observationPath}'.decodeBase64(),'UTF-8')).append(groovy.json.JsonOutput.toJson(row)+'\\n','UTF-8')
}
`, { flag: "wx" });
    const mainInit = path.join(plan.workDirectory, "jdt-init.gradle"), aptInit = path.join(plan.workDirectory, "jdt-apt.init.gradle"), policy = path.join(plan.workDirectory, "source-policy.init.gradle");
    for (const [entry, destination] of [["gradle/init/init.gradle", mainInit], ["gradle/apt/init.gradle", aptInit]]) {
      await writeFile(destination, (await execute("/usr/bin/unzip", ["-p", plan.jdtCoreJar, entry], { maxBuffer: 4 * 1024 * 1024 })).stdout);
    }
    await writeFile(policy, GRADLE_IMPORT_INIT_SCRIPT);
    const classes = path.join(plan.workDirectory, "classes"); await mkdir(classes);
    const compile = execute(path.join(plan.javaHome, "bin/javac"), ["-cp", plan.classpath, "-d", classes, source],
      { timeout: 30000, signal: abort.signal, maxBuffer: 1024 * 1024 });
    if (compile.child?.pid) out.resources.push({ pid: compile.child.pid });
    const compiler = await compile;
    await writeFile(path.join(plan.outputDirectory, "javac.stderr.log"), compiler.stderr);
    lease = await acquireFixtureSlot(MAC_WORK_ROOT, { signal: abort.signal });
    const stdout = path.join(plan.outputDirectory, "model-records.log"), stderr = path.join(plan.outputDirectory, "model-errors.log");
    const outFd = openSync(stdout, "wx"), errFd = openSync(stderr, "wx");
    const args = ["-cp", `${classes}:${plan.classpath}`, "Ilv2GradlePrepare", plan.repoRoot, plan.gradleHome, plan.gradleInstallation,
      plan.javaHome, mainInit, policy, aptInit, path.join(plan.outputDirectory, "gradle.stdout.log"), path.join(plan.outputDirectory, "gradle.stderr.log"),
      "-Dorg.gradle.parallel=false", ...plan.jvmArguments];
    java = spawn(path.join(plan.javaHome, "bin/java"), args, { cwd: plan.repoRoot, env: process.env, detached: true, stdio: ["ignore", outFd, errFd] });
    javaClosed = new Promise(resolve => { java.once("error", error => resolve({ error: error.message })); java.once("close", (code, signal) => resolve({ code, signal })); });
    let result;
    try {
      requireValue(java.pid > 1, "preparation JVM could not start");
      out.resources.push({ pid: java.pid, pgid: java.pid, ownedGroup: true });
      await lease.registerChild(java.pid, java.pid); await save();
      abort.signal.addEventListener("abort", killJava, { once: true });
      if (abort.signal.aborted) killJava();
      result = await javaClosed;
    } finally { closeSync(outFd); closeSync(errFd); clearTimeout(killTimer); }
    out.clientExit = result; abort.signal.throwIfAborted(); requireValue(result.code === 0, "Gradle dependency models failed");
    const rows = (await readFile(stdout, "utf8")).split("\n").filter(line => line.startsWith("ILV2_PREPARE\t")).map(line => line.split("\t"));
    out.projectModel = rows.some(row => row[1] === "PHASE" && row[2] === "ECLIPSE_MODEL_COMPLETE") ? "PASS" : "FAIL";
    out.aptModel = rows.some(row => row[1] === "PHASE" && row[2] === "APT_MODEL_COMPLETE") ? "PASS" : "FAIL";
    const files = type => [...new Set(rows.filter(row => row[1] === type).map(row => Buffer.from(row[2], "base64").toString("utf8")))];
    out.projectDirectories = files("PROJECT"); out.processorFiles = files("PROCESSOR"); out.binaryFiles = files("BINARY"); out.sourceAttachments = files("SOURCE_ATTACHMENT");
    out.sourceDirectories = files("SOURCE_DIRECTORY"); out.projectDependencies = files("PROJECT_DEPENDENCY");
    out.classpathDirectories = files("CLASSPATH_DIRECTORY"); out.classpathContainers = files("CLASSPATH_CONTAINER");
    if (out.mavenLocal) {
      const app = path.join(plan.repoRoot, "apps/lishu-edu-app");
      const appLombok = new Set();
      let project;
      for (const [, kind, value] of rows) {
        if (kind === "APT_PROJECT") project = Buffer.from(value, "base64").toString("utf8");
        if (kind === "PROCESSOR" && project === app) {
          const file = Buffer.from(value, "base64").toString("utf8");
          if (/\/org\.projectlombok\/lombok\/[^/]+\/[^/]+\/lombok-[^/]+\.jar$/.test(file)) appLombok.add(file);
        }
      }
      requireValue(appLombok.size === 1, "lishuedu application APT model must select one Lombok JAR");
      [out.appLombok] = appLombok;
    }
    requireValue(out.projectDirectories.includes(plan.repoRoot) && out.binaryFiles.length > 0 && out.processorFiles.length > 0
      && out.projectModel === "PASS" && out.aptModel === "PASS", "real project/binary/APT model proof missing");
    out.status = "PASS";
  } catch (error) { failure = error; out.status = "FAIL"; out.failure = error.message; }
  finally {
    abort.signal.removeEventListener("abort", killJava);
    if (java?.pid && alive(java.pid)) { killJava(); await javaClosed; }
    clearTimeout(killTimer);
    try {
      const daemonDirectory = path.join(plan.gradleHome, "daemon");
      const versions = await readdir(daemonDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const version of versions.filter(value => /^\d+\.\d+(?:\.\d+)?$/.test(value))) {
        for (const name of await readdir(path.join(daemonDirectory, version))) {
          const match = /^daemon-(\d+)\.out\.log$/.exec(name); if (match) out.resources.push({ pid: Number(match[1]) });
        }
      }
      const domain = new GradleDomain(plan.gradleHome, [plan.distribution]);
      await domain.recover(async () => {});
      out.gradleRecovery = domain.status();
      const exitAt = Date.now() + 5000;
      while (out.resources.some(row => alive(row.pid) || row.ownedGroup && alive(-row.pgid)) && Date.now() < exitAt) await delay(50);
      requireValue(out.resources.every(row => !alive(row.pid) && (!row.ownedGroup || !alive(-row.pgid))), "preparation JVM resources remain");
      out.resourceExit = "PASS";
      await unlink(observer).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (lease) await lease.release();
      if (out.status === "PASS") {
        abort.signal.throwIfAborted();
        const observations = (await readFile(path.join(plan.outputDirectory, "build-properties.jsonl"), "utf8"))
          .trim().split("\n").filter(Boolean).map(JSON.parse);
        const expected = Object.fromEntries(plan.jvmArguments.map(value => value.slice(2).split("=")));
        requireValue(observations.length >= 2 && observations.every(row => row.gradleUserHome === plan.gradleHome
          && row.properties?.["user.home"] === plan.ownerHome && row.properties?.["org.gradle.parallel"] === "false"
          && Object.entries(expected).every(([key, value]) => row.properties?.[key] === value)),
        "actual preparation build properties differ from the approved profile");
        out.buildProperties = { status: "PASS", observation: "ACTUAL_BUILD_SYSTEM_PROPERTIES", rows: observations };
        const required = [...new Set([...out.binaryFiles, ...out.processorFiles])];
        out.requiredFiles = [];
        const frozen = new Map(plan.runtimeFiles.map(file => [file.path, file.sha256]));
        const starter = out.mavenLocal?.files.find(row => row.path.endsWith(".jar"));
        const starterFile = starter && path.join(out.mavenLocal.repository, starter.path);
        if (starterFile) requireValue(out.binaryFiles.includes(starterFile), "Eclipse model did not use the pinned local Starter JAR");
        for (const file of required) {
          abort.signal.throwIfAborted();
          if (formal) await requireFormalModelFile(plan, file);
          const bytes = await readFile(file), digest = sha256(bytes);
          if (file === starterFile) requireValue(await managedPath(out.mavenLocal.repository, file) === file && (await lstat(file)).isFile()
            && bytes.length === starter.bytes && digest === starter.sha256, "Maven Starter drift in Eclipse model");
          if (!formal) requireValue(frozen.get(file) === digest || await managedPath(root, file) === file, "model artifact outside frozen/private inputs");
          out.requiredFiles.push({ path: file, sha256: digest, bytes: bytes.length });
        }
        const artifacts = [];
        const artifactRoot = path.join(plan.gradleHome, "caches/modules-2/files-2.1");
        async function visit(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            abort.signal.throwIfAborted();
            const file = path.join(directory, entry.name);
            requireValue(!entry.isSymbolicLink(), "restored artifact symlink rejected");
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) { const bytes = await readFile(file); artifacts.push({ path: path.relative(plan.gradleHome, file), sha256: sha256(bytes), bytes: bytes.length }); }
          }
        }
        await visit(artifactRoot); artifacts.sort((a, b) => a.path.localeCompare(b.path));
        const indexPreparationStart = performance.now();
        try {
          out.jdtJarIndexes = await prepareJarIndexes(plan, out.requiredFiles, { signal: abort.signal, resources: out.resources });
        } catch (error) {
          out.jdtJarIndexes = { status: "FAIL", elapsedMs: performance.now() - indexPreparationStart, failure: error.message };
          throw error;
        }
        if (out.mavenLocal) requireValue(out.jdtJarIndexes.status === "PASS", "lishuedu requires prepared JAR indexes");
        const manifest = { schema: "ilv2-prepared-gradle-artifacts/v1", status: "PASS", gradleHome: plan.gradleHome,
          ownerHome: plan.ownerHome, repoRoot: plan.repoRoot, artifacts, requiredFiles: out.requiredFiles, jdtJarIndexes: out.jdtJarIndexes,
          ...(out.mavenLocal ? { projectId: "lishuedu", mavenLocal: out.mavenLocal, appLombok: out.appLombok,
            gradleProxyPort: expected["https.proxyPort"] } : {}) };
        const manifestFile = path.join(plan.outputDirectory, "artifact-manifest.json"); await writeJson(manifestFile, manifest);
        out.artifactManifest = { path: manifestFile, sha256: sha256(await readFile(manifestFile)), count: artifacts.length,
          logicalBytes: artifacts.reduce((sum, file) => sum + file.bytes, 0) };
      }
    } catch (error) { failure ??= error; out.status = "FAIL"; out.cleanupFailure = error.message; }
    clearTimeout(timer); process.off("SIGTERM", requestStop); process.off("SIGINT", requestStop);
    out.endedAt = new Date().toISOString(); await save();
  }
  if (failure) throw failure;
  return out;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const validation = ["--validate-install", "--validate-sealed-install", "--validate-formal-install"];
  const formalPrepare = args[0] === "--prepare-formal";
  const run = validation.includes(args[0]) && args.length === 10
    ? validateInstallation(args.slice(1), args[0] !== "--validate-install", args[0] === "--validate-formal-install")
    : prepareGradle(cliOptions(formalPrepare ? args.slice(1) : args, ["--plan"]).plan, formalPrepare)
      .then(result => console.log(JSON.stringify({ status: result.status, projectModel: result.projectModel, aptModel: result.aptModel,
        jdtJarIndexes: result.jdtJarIndexes })));
  run
    .catch(error => { console.error("[gradle-prepare]", error.message); process.exitCode = 1; });
}
