import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execute, requireValue, sha256, writeJson } from "./ilv2-mac-contracts.mjs";

const source = fileURLToPath(new URL("./Ilv2JarIndex.java", import.meta.url));
const indexDirectory = "jdt-shared-index";

export function jdtIndexPlugins(plan) {
  const directory = path.dirname(plan.jdtCoreJar);
  const plugins = plan.runtimeFiles.filter(file => path.dirname(file.path) === directory && file.path.endsWith(".jar"));
  for (const bundle of ["org.eclipse.jdt.core_", "org.eclipse.jdt.core.compiler.batch_"]) {
    requireValue(plugins.filter(file => path.basename(file.path).startsWith(bundle)).length === 1,
      "one frozen JDT indexer bundle required: " + bundle);
  }
  return plugins;
}

export async function prepareJarIndexes(plan, requiredFiles, { signal, resources }) {
  const started = performance.now();
  const artifactRoot = path.join(plan.gradleHome, "caches/modules-2/files-2.1");
  // Only publish for content-addressed Gradle artifacts. Workspace JARs can
  // change at the same path and must go through JDT's ordinary indexing path.
  const jars = requiredFiles.filter(file => file.path.startsWith(artifactRoot + path.sep) && file.path.endsWith(".jar"));
  if (jars.length === 0) return { status: "SKIP", count: 0, elapsedMs: performance.now() - started };
  const plugins = jdtIndexPlugins(plan);
  const classpath = plugins.map(file => file.path).join(path.delimiter);
  const destination = path.join(plan.gradleHome, indexDirectory);
  const existing = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
  requireValue(!existing, "prepared JAR index directory already exists");
  const staging = await mkdtemp(path.join(plan.gradleHome, ".jdt-shared-index-"));
  const classes = path.join(plan.workDirectory, "jar-index-classes");
  const list = path.join(plan.workDirectory, "jar-index-inputs.txt");
  const run = async (name, args, timeout) => {
    const operation = execute(path.join(plan.javaHome, "bin", name), args,
      { cwd: plan.workDirectory, signal, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    if (operation.child?.pid) resources.push({ pid: operation.child.pid });
    return operation;
  };
  try {
    await mkdir(classes);
    await writeFile(list, jars.map(file => Buffer.from(file.path).toString("base64")).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    const readJar = async file => {
      signal.throwIfAborted();
      requireValue(await realpath(file.path) === file.path, "noncanonical JAR index input: " + file.path);
      const bytes = await readFile(file.path);
      requireValue(bytes.length === file.bytes && sha256(bytes) === file.sha256, "JAR index input changed: " + file.path);
      return (await lstat(file.path, { bigint: true })).mtimeNs;
    };
    const timestamps = [];
    for (const file of jars) timestamps.push(await readJar(file));
    await run("javac", ["-cp", classpath, "-d", classes, source], 30000);
    const generationStart = performance.now();
    const { stdout } = await run("java", ["-cp", classes + path.delimiter + classpath, "Ilv2JarIndex", list, staging]);
    const generationMs = performance.now() - generationStart;
    const [version, ...names] = stdout.trim().split("\n");
    requireValue(/^\d+\.\d+$/.test(version) && names.length === jars.length && new Set(names).size === names.length
      && names.every(name => /^\d+\.index$/.test(name)), "invalid generated JDT index inventory");
    const versionDir = path.join(staging, version);
    requireValue((await readdir(versionDir)).length === names.length, "unexpected generated JDT index files");
    const signature = Buffer.from("INDEX VERSION " + version);
    const indexes = [];
    for (const [i, jar] of jars.entries()) {
      const name = names[i], file = path.join(versionDir, name);
      const bytes = await readFile(file), info = await lstat(file, { bigint: true });
      const header = 2 + signature.length;
      requireValue(info.isFile() && info.mtimeNs === timestamps[i] && await readJar(jar) === timestamps[i]
        && bytes.length > header + 4 && bytes.readUInt16BE(0) === signature.length
        && bytes.subarray(2, header).equals(signature)
        && bytes.readInt32BE(header) > 0 && bytes.readInt32BE(header) < bytes.length, "invalid generated JDT index: " + name);
      indexes.push({ jar, jarMtimeNs: String(timestamps[i]), file: version + "/" + name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = path.join(staging, "manifest.json");
    await writeJson(manifest, { schema: "ilv2-prepared-jdt-jar-indexes/v1", version,
      javaHome: plan.javaHome, generatorSha256: sha256(await readFile(source)), plugins, indexes });
    const manifestSha256 = sha256(await readFile(manifest));
    signal.throwIfAborted();
    await rename(staging, destination);
    return { status: "PASS", directory: destination, manifest: path.join(destination, "manifest.json"), manifestSha256,
      count: indexes.length, bytes: indexes.reduce((sum, index) => sum + index.bytes, 0),
      generationMs, elapsedMs: performance.now() - started };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
