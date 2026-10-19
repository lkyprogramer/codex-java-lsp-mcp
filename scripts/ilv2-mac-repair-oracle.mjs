// MAC-10 repair oracle: an evaluator-owned Java main compiled together with the one source file under
// repair, in a fresh directory with no classpath, no annotation processing and no repository build.
// The only dependency is the frozen JDK; javac and java each run under the oracle's time limit with
// bounded output, and the whole process group is killed on expiry.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { ORACLE_SCHEMA, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";

export const ORACLE_STATE = Object.freeze({
  PASS: "PASS", TEST_FAILED: "TEST_FAILED", COMPILE_FAILED: "COMPILE_FAILED", TIMEOUT: "TIMEOUT",
  OUTPUT_LIMIT: "OUTPUT_LIMIT", MISSING_FILE: "MISSING_FILE", JUDGE_ERROR: "JUDGE_ERROR"
});
export const PASS_MARKER = "ORACLE PASS";
export const MAX_OUTPUT_BYTES = 64 * 1024;
const JVM_FLAGS = ["-Xmx256m", "-Xss8m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8"];

function bounded(binary, args, { cwd, timeoutMs, signal }) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(binary, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "en_US.UTF-8" } });
    const chunks = [];
    let bytes = 0;
    let limited = false;
    let timedOut = false;
    // ESRCH: the group is gone; EPERM: only zombies of it remain (macOS). Neither can still run.
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH" && error.code !== "EPERM") throw error; } };
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { limited = true; kill(); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { clearTimeout(timer); resolve({ code: null, error: error.message, output: "", ms: performance.now() - started }); });
    child.once("close", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // The group outlives a killed parent only until the same SIGKILL reaches it; make sure it did.
      kill();
      resolve({ code, signal: killedBy, timedOut, limited, output: Buffer.concat(chunks).toString("utf8"), ms: performance.now() - started });
    });
  });
}

const firstLine = text => text.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 240) ?? null;

/** Judge one source text of `oracle.file` with the oracle's own test. */
export async function evaluateOracle({ oracle, testSource, sourceText, javaHome, workDir, signal }) {
  requireValue(oracle?.schema === ORACLE_SCHEMA, "repair oracle schema required");
  if (typeof sourceText !== "string") return { state: ORACLE_STATE.MISSING_FILE, compileMs: null, runMs: null, detail: oracle.file };
  const root = await mkdtemp(path.join(workDir, `oracle-${oracle.taskId}-`));
  try {
    const src = path.join(root, "src");
    await mkdir(src);
    await mkdir(path.join(root, "out"));
    await writeFile(path.join(src, path.basename(oracle.file)), sourceText);
    await writeFile(path.join(src, oracle.test), testSource);
    const compile = await bounded(path.join(javaHome, "bin/javac"), ["--release", String(oracle.release), "-proc:none", "-implicit:none", "-nowarn", "-encoding", "UTF-8",
      "-d", path.join(root, "out"), path.join(src, path.basename(oracle.file)), path.join(src, oracle.test)], { cwd: root, timeoutMs: oracle.timeoutMs, signal });
    const result = (state, run) => ({ state, compileMs: compile.ms, runMs: run?.ms ?? null, detail: firstLine((run ?? compile).output ?? (run ?? compile).error ?? "") });
    if (compile.timedOut) return result(ORACLE_STATE.TIMEOUT);
    if (compile.limited) return result(ORACLE_STATE.OUTPUT_LIMIT);
    if (compile.code !== 0) return result(compile.code === null ? ORACLE_STATE.JUDGE_ERROR : ORACLE_STATE.COMPILE_FAILED);
    const main = oracle.mainClass;
    const run = await bounded(path.join(javaHome, "bin/java"), [...JVM_FLAGS, "-cp", path.join(root, "out"), main], { cwd: root, timeoutMs: oracle.timeoutMs, signal });
    if (run.timedOut) return result(ORACLE_STATE.TIMEOUT, run);
    if (run.limited) return result(ORACLE_STATE.OUTPUT_LIMIT, run);
    if (run.code === null) return result(ORACLE_STATE.JUDGE_ERROR, run);
    const passed = run.code === 0 && run.output.split("\n").some(line => line.trim() === PASS_MARKER);
    return result(passed ? ORACLE_STATE.PASS : ORACLE_STATE.TEST_FAILED, run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The frozen JDK the oracle depends on, recorded by binary digest. */
export async function javaIdentity(javaHome) {
  const java = path.join(javaHome, "bin/java");
  const javac = path.join(javaHome, "bin/javac");
  const version = await bounded(java, ["-version"], { cwd: path.dirname(java), timeoutMs: 20000 });
  requireValue(version.code === 0, `java -version failed: ${firstLine(version.output ?? "")}`);
  return { javaHome, javaSha256: sha256(await readFile(java)), javacSha256: sha256(await readFile(javac)), version: firstLine(version.output) };
}

async function frozenSource(record, oracle) {
  const { execute } = await import("./ilv2-mac-contracts.mjs");
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", record.repoRoot, "show", `${oracle.head}:${oracle.file}`], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

/** Oracle stability: the broken pre-state fails by assertion and the known fix passes, on every repeat. */
export async function checkOracles({ datasetFile, inputsFile, split, repeats, javaHome, out, signal }) {
  requireValue(["dev", "holdout", "all"].includes(split) && Number.isInteger(repeats) && repeats >= 1, "split dev|holdout|all and repeats >= 1 required");
  const { root, manifest } = await verifyDataset(datasetFile);
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const rows = [];
  for (const name of split === "all" ? ["dev", "holdout"] : [split]) rows.push(...await readJsonl(path.join(root, manifest.parts[`gold-${name}`].file)));
  const java = await javaIdentity(javaHome);
  const tasks = [];
  await mkdir(out, { recursive: false });
  for (const row of rows.filter(item => item.kind === "repair")) {
    const oracleDir = path.join(root, path.dirname(row.repairOracle));
    const oracle = await readJson(path.join(root, row.repairOracle));
    const testSource = await readFile(path.join(oracleDir, oracle.test), "utf8");
    requireValue(sha256(testSource) === oracle.testSha256, `${row.taskId}: oracle test changed`);
    const broken = await readFile(path.join(oracleDir, oracle.preState), "utf8");
    requireValue(sha256(broken) === oracle.preStateSha256, `${row.taskId}: pre-state changed`);
    const record = inputs.get(oracle.corpusId);
    requireValue(record && record.head === oracle.head, `${row.taskId}: frozen input ${oracle.corpusId} does not match the oracle head`);
    const fixed = await frozenSource(record, oracle);
    requireValue(sha256(fixed) === oracle.fixSha256, `${row.taskId}: frozen fix bytes changed`);
    const runs = { broken: [], fixed: [] };
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const [variant, sourceText] of [["broken", broken], ["fixed", fixed]]) {
        signal?.throwIfAborted();
        runs[variant].push(await evaluateOracle({ oracle, testSource, sourceText, javaHome, workDir: out, signal }));
      }
    }
    const withinLimit = [...runs.broken, ...runs.fixed].every(run => (run.compileMs ?? 0) <= oracle.timeoutMs && (run.runMs ?? 0) <= oracle.timeoutMs);
    tasks.push({ taskId: row.taskId, split: row.split, corpusId: oracle.corpusId, timeoutMs: oracle.timeoutMs,
      broken: runs.broken.map(run => run.state), fixed: runs.fixed.map(run => run.state),
      brokenDetail: runs.broken[0].detail, maxCompileMs: Math.max(...[...runs.broken, ...runs.fixed].map(run => run.compileMs ?? 0)),
      maxRunMs: Math.max(...[...runs.broken, ...runs.fixed].map(run => run.runMs ?? 0)),
      stable: runs.broken.every(run => run.state === ORACLE_STATE.TEST_FAILED) && runs.fixed.every(run => run.state === ORACLE_STATE.PASS) && withinLimit });
  }
  const report = { schema: "ilv2-mac10-oracle-check/v1", datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split, repeats, java,
    status: tasks.length > 0 && tasks.every(task => task.stable) ? "PASS" : "FAIL", tasks };
  await writeJson(path.join(out, "oracle-check.json"), report);
  return report;
}

async function main(args, { signal }) {
  const [command, ...rest] = args;
  requireValue(command === "check", "usage: ilv2-mac-repair-oracle.mjs check --dataset MANIFEST --inputs F --split dev|holdout|all --repeats N --java-home DIR --out NEW_DIR");
  const options = cliOptions(rest, ["--dataset", "--inputs", "--split", "--repeats", "--java-home", "--out"]);
  const report = await checkOracles({ datasetFile: path.resolve(options.dataset), inputsFile: path.resolve(options.inputs), split: options.split,
    repeats: Number(options.repeats), javaHome: options["java-home"], out: path.resolve(options.out), signal });
  console.log(JSON.stringify({ status: report.status, tasks: report.tasks.map(task => ({ taskId: task.taskId, broken: task.broken, fixed: task.fixed, stable: task.stable })) }, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}

if (isMain(import.meta.url)) runCli(context => main(process.argv.slice(2), context));
