import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, realpath, readdir, rm, stat, symlink, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireFormalModelFile, validatePreparation } from "./ilv2-mac-gradle-prepare.mjs";
import { prepareJarIndexes } from "./ilv2-mac-jar-indexes.mjs";
import { prepareLishueduMavenLocal, verifyPreparedLishuedu } from "./ilv2-mac-lishuedu-preparation.mjs";
import { sha256 } from "./ilv2-mac-contracts.mjs";

const exec = promisify(execFile);
const prepareScript = fileURLToPath(new URL("./ilv2-mac-gradle-prepare.mjs", import.meta.url));

test("formal model artifacts may use the canonical owner Maven repository", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "formal-gradle-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = { gradleHome: path.join(root, "gradle"), repoRoot: path.join(root, "repo"), ownerHome: path.join(root, "home") };
  const outside = path.join(root, "repo-other", "dependency.jar");
  await mkdir(path.dirname(outside));
  await writeFile(outside, "other");
  for (const anchor of [plan.gradleHome, plan.repoRoot, path.join(plan.ownerHome, ".m2/repository")]) {
    await mkdir(anchor, { recursive: true });
    const dependency = path.join(anchor, "dependency.jar");
    await writeFile(dependency, "valid");
    await requireFormalModelFile(plan, dependency);
    await symlink(outside, path.join(anchor, "escape.jar"));
    await assert.rejects(requireFormalModelFile(plan, path.join(anchor, "escape.jar")), /outside managed root/);
  }
  await assert.rejects(requireFormalModelFile(plan, outside), /formal model artifact outside canonical/);
  await assert.rejects(requireFormalModelFile(plan, plan.gradleHome), /formal model artifact outside canonical/);
  const otherHome = path.join(root, "other-home");
  await mkdir(path.join(otherHome, ".m2"), { recursive: true });
  await symlink(path.dirname(outside), path.join(otherHome, ".m2/repository"));
  await assert.rejects(requireFormalModelFile({ ...plan, ownerHome: otherHome }, path.join(otherHome, ".m2/repository/dependency.jar")), /outside managed root/);
});

test("installation preparation confines inputs and preserves its bounded profile", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "gradle-prepare-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "run-root.txt"), root + "\n");
  for (const name of ["repo", "gradle", "home"]) await mkdir(path.join(root, name));
  const previous = { root: process.env.ILV2_RUN_ROOT, marker: process.env.JAVA_LSP_ISOLATED_VALIDATION,
    home: process.env.HOME, gradle: process.env.GRADLE_USER_HOME };
  process.env.ILV2_RUN_ROOT = root; process.env.JAVA_LSP_ISOLATED_VALIDATION = "1";
  process.env.HOME = path.join(root, "home"); process.env.GRADLE_USER_HOME = path.join(root, "gradle");
  try {
    const launcher = path.join(root, "jdt/bin/jdtls");
    const plugins = path.join(root, "jdt/libexec/plugins");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "");
    const plan = { schema: "ilv2-gradle-install-prepare/v1", runRoot: root, repoRoot: path.join(root, "repo"),
      gradleHome: process.env.GRADLE_USER_HOME, ownerHome: process.env.HOME, workDirectory: path.join(root, "work"),
      outputDirectory: path.join(root, "raw"), timeoutMs: 1800000, deadline: new Date(Date.now() + 60000).toISOString(),
      jdtCoreJar: path.join(plugins, "org.eclipse.jdt.ls.core_test.jar"),
      runtimeFiles: [launcher, path.join(plugins, "org.eclipse.jdt.core_test.jar"),
        path.join(plugins, "org.eclipse.jdt.core.compiler.batch_test.jar")].map(path => ({ path })),
      jvmArguments: ["-Djdk.tls.client.protocols=TLSv1.2", "-Dhttps.protocols=TLSv1.2", "-Dhttps.proxyHost=127.0.0.1", "-Dhttps.proxyPort=8888"] };
    const planFile = path.join(root, "plan.json"); await writeFile(planFile, JSON.stringify(plan));
    assert.equal(await validatePreparation(plan, planFile), root);
    await assert.rejects(validatePreparation({ ...plan, projectId: "lishuedu" }, planFile), /required for isolated preparation only/);
    await assert.rejects(validatePreparation({ ...plan, repoRoot: path.join(root, "..", "not-owned") }, planFile), /outside managed root/);
    await assert.rejects(validatePreparation({ ...plan, timeoutMs: 1800001 }, planFile), /bounded to 30 minutes/);
    await assert.rejects(validatePreparation({ ...plan, jvmArguments: ["-Djavax.net.ssl.trustStore=untrusted"] }, planFile), /approved TLS\/proxy profile/);
    await assert.rejects(validatePreparation({ ...plan, jvmArguments: [...plan.jvmArguments.slice(0, 3), "-Dhttps.proxyPort=65536"] }, planFile), /approved TLS\/proxy profile/);
    const args = [prepareScript, "--validate-install", planFile, path.join(root, "runtime"), path.join(root, "agents/test.plist"),
      path.join(root, "logs"), path.join(root, "cache"), path.join(root, "ownership"), "com.lky.ilv2-mac18.test", "53101", "53102"];
    const env = {
      HOME: plan.ownerHome,
      ILV2_RUN_ROOT: root,
      JAVA_LSP_ISOLATED_VALIDATION: "1",
      GRADLE_USER_HOME: plan.gradleHome,
      JDTLS_BIN: launcher,
      TMPDIR: path.join(root, "tmp")
    };
    assert.equal((await exec(process.execPath, args, { env })).stdout.trim(), "8888");
    await assert.rejects(exec(process.execPath, args, { env: { ...env, JDTLS_BIN: "/unbound/bin/jdtls" } }),
      /launcher must use the frozen indexer plugins/);
    await assert.rejects(exec(process.execPath, [...args.slice(0, -1), "38457"], { env }), /reserved HTTP port/);
    await assert.rejects(exec(process.execPath, [...args.slice(0, -3), "com.lky.codex-java-lsp-mcp", ...args.slice(-2)], { env }), /isolated LaunchAgent label/);
    await assert.rejects(exec(process.execPath, args, { env: { ...env, TMPDIR: path.dirname(root) } }), /outside managed root/);
    await assert.rejects(exec(process.execPath, args, { env: { ...env, CODEX_HOME: path.dirname(root) } }), /outside managed root/);
  } finally {
    for (const [name, value] of Object.entries({ ILV2_RUN_ROOT: previous.root, JAVA_LSP_ISOLATED_VALIDATION: previous.marker,
      HOME: previous.home, GRADLE_USER_HOME: previous.gradle })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("lishuedu preparation pins the local Maven files, Gradle artifacts and JAR indexes", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lishuedu-preparation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = { repoRoot: path.join(root, "repo"), ownerHome: path.join(root, "home"), gradleHome: path.join(root, "gradle"),
    lishueduMavenLocal: path.join(root, "seed/manifest.json") };
  await mkdir(plan.ownerHome);
  await mkdir(plan.repoRoot);
  async function write(base, relative, text) {
    const file = path.join(base, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return { path: relative, bytes: Buffer.byteLength(text), sha256: sha256(text) };
  }
  const seed = path.join(root, "seed/repository");
  const files = [];
  for (const [artifact, extensions] of [["lishu-common-dependencies", ["pom"]], ["lishu-boot-starter", ["pom", "jar"]]]) {
    const version = `com/lishu/common/${artifact}/1.0.0-SNAPSHOT`;
    for (const name of [...extensions.map(ext => `${artifact}-1.0.0-SNAPSHOT.${ext}`), "maven-metadata-local.xml"]) {
      files.push(await write(seed, `${version}/${name}`, name));
    }
  }
  const mavenInput = { schema: "ilv2-lishuedu-maven-local/v1", files };
  await writeFile(plan.lishueduMavenLocal, JSON.stringify({ ...mavenInput, files: files.slice(1) }));
  await assert.rejects(prepareLishueduMavenLocal(plan, root, { stage: true }), /exactly the BOM and Starter/);
  await writeFile(plan.lishueduMavenLocal, JSON.stringify(mavenInput));
  const mavenLocal = await prepareLishueduMavenLocal(plan, root, { stage: true });
  const lombok = await write(plan.gradleHome, "caches/modules-2/files-2.1/org.projectlombok/lombok/1.18.42/hash/lombok-1.18.42.jar", "processor");
  const jar = { ...lombok, path: path.join(plan.gradleHome, lombok.path) };
  const indexRoot = path.join(plan.gradleHome, "jdt-shared-index");
  const indexFile = await write(indexRoot, "1.134/42.index", "index");
  const { mtimeNs } = await stat(jar.path, { bigint: true });
  const indexManifest = JSON.stringify({ schema: "ilv2-prepared-jdt-jar-indexes/v1",
    indexes: [{ jar, jarMtimeNs: String(mtimeNs), file: indexFile.path, bytes: indexFile.bytes, sha256: indexFile.sha256 }] });
  await write(indexRoot, "manifest.json", indexManifest);
  const jdtJarIndexes = { status: "PASS", directory: indexRoot, manifest: path.join(indexRoot, "manifest.json"), manifestSha256: sha256(indexManifest), count: 1 };
  const starter = files.find(row => row.path.endsWith(".jar"));
  const artifactManifest = JSON.stringify({ schema: "ilv2-prepared-gradle-artifacts/v1", status: "PASS", projectId: "lishuedu",
    repoRoot: plan.repoRoot, ownerHome: plan.ownerHome, gradleHome: plan.gradleHome, mavenLocal, appLombok: jar.path, gradleProxyPort: "8888", jdtJarIndexes,
    artifacts: [lombok], requiredFiles: [jar, { ...starter, path: path.join(mavenLocal.repository, starter.path) }] });
  const output = path.join(root, "output");
  await write(output, "artifact-manifest.json", artifactManifest);
  await write(output, "result.json", JSON.stringify({ schema: "ilv2-gradle-install-prepare-result/v1", status: "PASS", projectModel: "PASS", aptModel: "PASS",
    resourceExit: "PASS", jdtJarIndexes, processorFiles: [jar.path], artifactManifest: { path: path.join(output, "artifact-manifest.json"), sha256: sha256(artifactManifest), count: 1 } }));
  const result = path.join(output, "result.json");
  assert.equal((await verifyPreparedLishuedu(result, plan)).jdtJarIndexes, 1);
  await write(indexRoot, indexFile.path, "drift");
  await assert.rejects(verifyPreparedLishuedu(result, plan), /prepared JAR index digest mismatch/);
  await write(mavenLocal.repository, starter.path, "drift");
  await assert.rejects(verifyPreparedLishuedu(result, plan), /prepared Maven input digest mismatch/);
});

test("JAR preparation rejects drift and does not publish partial indexes", async t => {
  const gradleHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "gradle-index-preparation-")));
  t.after(() => rm(gradleHome, { recursive: true, force: true }));
  const workDirectory = path.join(gradleHome, "work");
  const artifacts = path.join(gradleHome, "caches/modules-2/files-2.1");
  const jar = path.join(artifacts, "dependency.jar");
  const plan = { gradleHome, workDirectory, jdtCoreJar: "/plugins/org.eclipse.jdt.ls.core_test.jar",
    runtimeFiles: ["/plugins/org.eclipse.jdt.core_test.jar", "/plugins/org.eclipse.jdt.core.compiler.batch_test.jar"].map(path => ({ path })) };
  const options = { signal: new AbortController().signal, resources: [] };
  await mkdir(workDirectory);
  await mkdir(artifacts, { recursive: true });
  await writeFile(jar, "changed");
  await assert.rejects(prepareJarIndexes(plan, [{ path: jar, bytes: 7, sha256: "0".repeat(64) }], options), /JAR index input changed/);
  assert.deepEqual((await readdir(gradleHome)).sort(), ["caches", "work"]);
  assert.deepEqual(options.resources, []);
});

test("installer rejects non-isolated preparation before runtime writes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gradle-prepare-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  const installer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../install-runtime.sh");
  for (const flag of ["--prepare-gradle", "--install-with-gradle"]) {
    await assert.rejects(exec("/bin/bash", [installer, flag, path.join(root, "unused.json")], {
      env: { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "", HOME: root, CODEX_JAVA_LSP_RUNTIME_DIR: runtime }, timeout: 5000
    }), error => error.code === 2 && /isolated installation phase/.test(error.stderr));
  }
  await assert.rejects(exec("/bin/bash", [installer, "--formal", "--install-with-gradle", path.join(root, "unused.json")], {
    env: { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "", HOME: root, CODEX_JAVA_LSP_RUNTIME_DIR: runtime }, timeout: 5000
  }), error => error.code === 2 && /requires a sealed release/.test(error.stderr));
  await assert.rejects(access(runtime), { code: "ENOENT" });
});
