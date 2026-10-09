#!/usr/bin/env node
// input:  冻结 kit 根（baseline-kit）+ repair taskId + candidate 目录 + 隔离输出目录。
// output: evaluateRepair(...) -> {state, validatedSuccess, judgeArtifact}。
//         validatedSuccess 只可能来自原 Python frozen judge
//         （python -m harness repair -> run_repair）的 validated_success；
//         本文件不实现第二套“通过”判定，只做候选策略预检、进程边界和状态包装。
// pos:    R04：判定器复用（thin bridge，优先原 run_repair）+ 候选物化（allowed
//         文件被候选删除 = REJECTED_MISSING_ALLOWED_FILE，绝不恢复原文件假装候选）
//         + 可搬运路径（所有根目录来自显式 CLI/env，无个人绝对路径默认值）。
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** docs/03: 子进程总输出上限 128KiB；超过即杀进程树并记 OUTPUT_LIMIT。 */
export const MAX_OUTPUT_BYTES = 128 * 1024;
export const DEFAULT_TIMEOUT_MS = 180_000;
/** frozen judge 用 `--release`，因此 runner 自身要求 JDK9+（本套件基线 JDK17+）。 */
export const REQUIRED_JDK_MAJOR = 9;

export const REPAIR_STATE = Object.freeze({
  VALIDATED_SUCCESS: "VALIDATED_SUCCESS",
  TEST_FAILED: "TEST_FAILED",
  COMPILE_FAILED: "COMPILE_FAILED",
  REJECTED_MISSING_ALLOWED_FILE: "REJECTED_MISSING_ALLOWED_FILE",
  REJECTED_DISALLOWED_EDIT: "REJECTED_DISALLOWED_EDIT",
  REJECTED_UNSAFE_PATH: "REJECTED_UNSAFE_PATH",
  MISSING_RECEIPT: "MISSING_RECEIPT",
  TIMEOUT: "TIMEOUT",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  BLOCKED_ENV: "BLOCKED_ENV",
  BLOCKED_SETUP: "BLOCKED_SETUP",
  JUDGE_ERROR: "JUDGE_ERROR"
});

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** lstat-based tree walk: symlinks and special files are recorded, never followed. */
export function walkTree(root) {
  const abs = path.resolve(String(root));
  const out = new Map();
  if (!existsSync(abs)) return out;
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(abs, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) out.set(rel, { kind: "symlink" });
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(rel, { kind: "file", hash: hashFile(full) });
      else out.set(rel, { kind: "other" });
    }
  };
  walk(abs);
  return out;
}

/** Canonical containment: never a prefix string comparison. */
export function assertInside(root, target, label) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} resolves outside its root`);
  }
  return path.resolve(target);
}

/**
 * Candidate policy, evaluated once and reported verbatim.
 * - missingAllowed: an allowed_edits source file the candidate deleted. This v1
 *   dataset requires those files to exist, so deletion is an explicit rejection;
 *   the judge must NOT restore the pristine file to keep the run "passing".
 * - violations: any changed/added/removed path not covered by allowed_edits.
 * - symlinks: any non-regular entry in either tree (never followed).
 */
export function diffCandidateTrees({ fixtureRoot, candidateRoot, allowedEdits = [] }) {
  const before = walkTree(fixtureRoot);
  const after = walkTree(candidateRoot);
  const allowed = new Set(allowedEdits);
  const changed = [];
  const removed = [];
  const added = [];
  const missingAllowed = [];
  const symlinks = [];
  for (const [rel, meta] of after) {
    if (meta.kind !== "file") symlinks.push(`candidate:${rel}(${meta.kind})`);
  }
  for (const [rel, meta] of before) {
    if (meta.kind !== "file") symlinks.push(`fixture:${rel}(${meta.kind})`);
    const now = after.get(rel);
    if (!now) {
      if (allowed.has(rel)) missingAllowed.push(rel);
      else removed.push(rel);
    } else if (meta.kind === "file" && now.kind === "file" && meta.hash !== now.hash) {
      changed.push(rel);
    }
  }
  for (const rel of after.keys()) if (!before.has(rel)) added.push(rel);
  const violations = [...changed, ...added, ...removed].filter(rel => !allowed.has(rel)).sort();
  return {
    changed: changed.sort(),
    removed: removed.sort(),
    added: added.sort(),
    missingAllowed: missingAllowed.sort(),
    symlinks: symlinks.sort(),
    violations
  };
}

/**
 * Materialize the judge workspace: pristine fixture + ONLY the allowed_edits
 * taken from the candidate. A deleted allowed file is DELETED here too; the
 * pristine copy is never used to impersonate the candidate.
 */
export function stageCandidateTree({ fixtureRoot, candidateRoot, allowedEdits = [], dest }) {
  const fixture = path.resolve(fixtureRoot);
  const candidate = path.resolve(candidateRoot);
  const target = path.resolve(dest);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(fixture, target, { recursive: true });
  const applied = [];
  const deleted = [];
  for (const rel of allowedEdits) {
    const parts = rel.split("/");
    const src = assertInside(candidate, path.join(candidate, ...parts), `allowed edit ${rel}`);
    const dst = assertInside(target, path.join(target, ...parts), `staged path ${rel}`);
    if (existsSync(src) && lstatSync(src).isFile()) {
      mkdirSync(path.dirname(dst), { recursive: true });
      cpSync(src, dst);
      applied.push(rel);
    } else if (existsSync(dst)) {
      rmSync(dst, { force: true });
      deleted.push(rel);
    }
  }
  return { dest: target, applied: applied.sort(), deleted: deleted.sort(), files: [...walkTree(target).keys()].sort() };
}

/**
 * Bounded process runner: argv array (never a shell string), capped output,
 * absolute timeout, and process-tree kill (child is its own group leader).
 * It is a resource bound, not an OS security boundary.
 */
export function runBounded(argv, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimit = false;
    let timedOut = false;
    let settled = false;
    const killTree = () => {
      try {
        if (detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ argv, elapsedMs: Date.now() - started, stdout, stderr, outputLimit, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree();
    }, timeoutMs);
    const attach = (stream, which) => {
      stream.on("data", chunk => {
        const text = chunk.toString("utf8");
        if (which === "stdout") stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes > maxBytes || stderrBytes > maxBytes) {
          outputLimit = true;
          killTree();
          return;
        }
        if (which === "stdout") stdout += text;
        else stderr += text;
      });
    };
    attach(child.stdout, "stdout");
    attach(child.stderr, "stderr");
    child.on("error", error => finish({ exitCode: null, spawnError: String(error?.message ?? error) }));
    child.on("close", code => finish({ exitCode: code }));
  });
}

/** Missing/old compiler is BLOCKED_ENV, never a business RED. */
export async function probeJavaToolchain({ javaHome = null, release = null } = {}) {
  const javac = javaHome ? path.join(javaHome, "bin", "javac") : "javac";
  const probe = await runBounded([javac, "-version"], { timeoutMs: 15_000 });
  if (probe.spawnError) return { available: false, javac, reason: `javac is not runnable: ${probe.spawnError}` };
  const text = `${probe.stderr}\n${probe.stdout}`;
  const matched = /javac (\d+)(?:\.(\d+))?/.exec(text);
  if (probe.exitCode !== 0 || !matched) {
    return { available: false, javac, reason: `javac -version did not succeed: ${text.slice(0, 200)}` };
  }
  const version = matched[0].replace("javac ", "");
  const major = matched[1] === "1" ? Number(matched[2]) : Number(matched[1]);
  if (major < REQUIRED_JDK_MAJOR) {
    return { available: false, javac, version, reason: `frozen judge compiles with --release and needs JDK ${REQUIRED_JDK_MAJOR}+ (found javac ${version})` };
  }
  const java = javaHome ? path.join(javaHome, "bin", "java") : "java";
  const javaProbe = await runBounded([java, "-version"], { timeoutMs: 15_000 });
  if (javaProbe.spawnError || javaProbe.exitCode !== 0) {
    return { available: false, javac, version, reason: `java launcher is not runnable next to javac: ${javaProbe.spawnError ?? javaProbe.stderr.slice(0, 200)}` };
  }
  if (release != null) {
    const releaseProbe = await runBounded([javac, "--release", String(release), "-version"], { timeoutMs: 15_000 });
    const releaseText = `${releaseProbe.stderr}\n${releaseProbe.stdout}`;
    if (releaseProbe.spawnError || releaseProbe.exitCode !== 0 || /release version .*not supported/i.test(releaseText)) {
      return { available: false, javac, version, reason: `javac ${version} cannot compile --release ${release}: ${releaseText.slice(0, 200)}` };
    }
  }
  return { available: true, javac, version, major };
}

function readRepairSpec(dataset, taskId) {
  const manifest = JSON.parse(readFileSync(path.join(dataset, "repairs", "manifest.json"), "utf8"));
  return manifest.find(entry => entry.task_id === taskId) ?? null;
}

function trim(text, limit = 1200) {
  return String(text ?? "").slice(0, limit);
}

/**
 * Thin bridge to the frozen Python repair judge.
 * Returns {state, validatedSuccess, judgeArtifact, ...provenance}.
 */
export async function evaluateRepair({
  kitRoot,
  taskId,
  mode = "candidate",
  candidateRoot = null,
  outputRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  python = process.env.JSB_PYTHON ?? "python3",
  javaHome = process.env.JAVA_HOME ?? null
} = {}) {
  const kit = path.resolve(String(kitRoot ?? ""));
  const out = path.resolve(String(outputRoot ?? ""));
  const dataset = path.join(kit, "dataset");
  const blocked = (state, reason, extra = {}) => ({
    state,
    validatedSuccess: false,
    judgeArtifact: null,
    reason,
    kitRoot: kit,
    taskId: taskId ?? null,
    mode,
    ...extra
  });
  if (!taskId) return blocked(REPAIR_STATE.BLOCKED_SETUP, "taskId is required");
  if (!["baseline", "reference", "candidate"].includes(mode)) {
    return blocked(REPAIR_STATE.BLOCKED_SETUP, `unknown repair mode ${mode}`);
  }
  if (!existsSync(path.join(kit, "harness", "__main__.py"))) {
    return blocked(REPAIR_STATE.BLOCKED_SETUP, `frozen kit harness not found under ${kit}`);
  }
  if (!existsSync(path.join(dataset, "repairs", "manifest.json"))) {
    return blocked(REPAIR_STATE.BLOCKED_SETUP, `frozen repair manifest not found under ${dataset}`);
  }
  const relToKit = path.relative(kit, out);
  if (relToKit === "" || (!relToKit.startsWith(`..${path.sep}`) && relToKit !== ".." && !path.isAbsolute(relToKit))) {
    return blocked(REPAIR_STATE.BLOCKED_SETUP, "outputRoot must stay outside the frozen kit");
  }
  const spec = readRepairSpec(dataset, taskId);
  if (!spec) return blocked(REPAIR_STATE.BLOCKED_SETUP, `${taskId} is not a repair task in the frozen manifest`);
  mkdirSync(out, { recursive: true });

  const fixtureRoot = path.join(dataset, "corpora", spec.corpus);
  let policy = null;
  if (mode === "candidate") {
    if (!candidateRoot) return blocked(REPAIR_STATE.BLOCKED_SETUP, "candidate directory required for candidate mode");
    const candidate = path.resolve(candidateRoot);
    if (!existsSync(candidate)) return blocked(REPAIR_STATE.BLOCKED_SETUP, `candidate root does not exist: ${candidate}`);
    policy = diffCandidateTrees({ fixtureRoot, candidateRoot: candidate, allowedEdits: spec.allowed_edits });
    if (policy.symlinks.length > 0) {
      return blocked(REPAIR_STATE.REJECTED_UNSAFE_PATH, `non-regular entries in the trees: ${policy.symlinks.join(", ")}`, { policy });
    }
    if (policy.missingAllowed.length > 0) {
      return blocked(
        REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE,
        `candidate deleted allowed source file(s): ${policy.missingAllowed.join(", ")}; the judge never restores the pristine copy`,
        { policy, candidateRoot: candidate, fixtureRoot }
      );
    }
    if (policy.violations.length > 0) {
      return blocked(REPAIR_STATE.REJECTED_DISALLOWED_EDIT, `files outside allowed_edits: ${policy.violations.join(", ")}`, { policy, candidateRoot: candidate });
    }
  }

  const toolchain = await probeJavaToolchain({ javaHome, release: spec.java_release });
  if (!toolchain.available) {
    return blocked(REPAIR_STATE.BLOCKED_ENV, toolchain.reason, { policy, toolchain });
  }

  // Isolated, portable environment: no personal HOME/cache writes, and the
  // frozen kit stays byte-identical (no __pycache__ inside it).
  for (const dir of ["home", "tmp", "pycache"]) mkdirSync(path.join(out, dir), { recursive: true });
  // The frozen judge runs bare `javac`/`java`: put the probed toolchain first
  // on PATH so the JDK that was probed is the JDK that judges.
  const env = {
    PATH: javaHome ? [path.join(javaHome, "bin"), process.env.PATH ?? ""].join(path.delimiter) : (process.env.PATH ?? ""),
    HOME: path.join(out, "home"),
    TMPDIR: path.join(out, "tmp"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: path.join(out, "pycache"),
    LC_ALL: "C.UTF-8"
  };
  if (javaHome) env.JAVA_HOME = javaHome;
  const artifactPath = path.join(out, "frozen-judge.json");
  if (existsSync(artifactPath)) rmSync(artifactPath);
  const argv = [
    python,
    "-m",
    "harness",
    "--dataset",
    dataset,
    "repair",
    "--task",
    taskId,
    "--mode",
    mode,
    "--output",
    artifactPath
  ];
  if (mode === "candidate") argv.push("--candidate", path.resolve(candidateRoot));
  const proc = await runBounded(argv, { cwd: kit, env, timeoutMs });

  const base = {
    kitRoot: kit,
    taskId,
    mode,
    policy,
    toolchain,
    judgeArtifactPath: artifactPath,
    python: {
      argv,
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      outputLimit: proc.outputLimit,
      elapsedMs: proc.elapsedMs,
      stderr: trim(proc.stderr),
      stdout: trim(proc.stdout)
    }
  };
  if (proc.spawnError) {
    return { ...base, state: REPAIR_STATE.BLOCKED_ENV, validatedSuccess: false, judgeArtifact: null, reason: `python is not runnable: ${proc.spawnError}` };
  }
  if (proc.timedOut) {
    return { ...base, state: REPAIR_STATE.TIMEOUT, validatedSuccess: false, judgeArtifact: null, reason: `frozen judge exceeded ${timeoutMs}ms; the process tree was killed` };
  }
  if (proc.outputLimit) {
    return { ...base, state: REPAIR_STATE.OUTPUT_LIMIT, validatedSuccess: false, judgeArtifact: null, reason: `frozen judge exceeded the ${MAX_OUTPUT_BYTES} byte output bound; the process tree was killed` };
  }

  let artifact = null;
  if (existsSync(artifactPath)) {
    try {
      artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    } catch (error) {
      return { ...base, state: REPAIR_STATE.JUDGE_ERROR, validatedSuccess: false, judgeArtifact: null, reason: `frozen judge artifact unreadable: ${error.message}` };
    }
  }
  if (!artifact) {
    const missing = /No such file or directory: '([^']+)'/.exec(proc.stderr ?? "");
    if (missing && candidateRoot && path.resolve(missing[1]).startsWith(path.resolve(candidateRoot) + path.sep)) {
      return {
        ...base,
        state: REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE,
        reason: `frozen judge could not read an allowed source file from the candidate: ${missing[1]}`
      };
    }
    return { ...base, state: REPAIR_STATE.JUDGE_ERROR, validatedSuccess: false, reason: `frozen judge produced no artifact (exit ${proc.exitCode}): ${trim(proc.stderr)}` };
  }

  const compileText = `${artifact.compile?.stderr ?? ""}\n${artifact.compile?.stdout ?? ""}`;
  if (artifact.status === "COMPILE_FAILED" && /release version .*not supported|invalid source release|invalid target release/i.test(compileText)) {
    return { ...base, state: REPAIR_STATE.BLOCKED_ENV, validatedSuccess: false, judgeArtifact: artifact, reason: `toolchain cannot compile --release ${spec.java_release}` };
  }
  const stateByStatus = {
    PASS: REPAIR_STATE.VALIDATED_SUCCESS,
    TEST_FAILED: REPAIR_STATE.TEST_FAILED,
    COMPILE_FAILED: REPAIR_STATE.COMPILE_FAILED,
    DISALLOWED_EDIT: REPAIR_STATE.REJECTED_DISALLOWED_EDIT
  };
  const state = stateByStatus[artifact.status] ?? REPAIR_STATE.JUDGE_ERROR;
  const validatedSuccess = artifact.validated_success === true && artifact.status === "PASS";
  if (state === REPAIR_STATE.JUDGE_ERROR) {
    return { ...base, state, validatedSuccess: false, judgeArtifact: artifact, reason: `unmapped frozen judge status ${artifact.status}` };
  }
  return { ...base, state, validatedSuccess, judgeArtifact: artifact };
}

// ---------------------------------------------------------------- CLI
const USAGE = `Usage: node scripts/eval-repair-adapter.mjs --kit-root DIR --task ID --output DIR
          [--mode candidate|reference|baseline] [--candidate DIR] [--timeout-ms N]
          [--python python3] [--java-home DIR]
All roots are explicit: this tool has no personal absolute-path defaults.
Exit codes: 0 validated success, 1 judged failure, 2 blocked/error.`;

function parseArgs(argv) {
  const options = { mode: "candidate" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--help") return { help: true };
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--kit-root") options.kitRoot = value;
    else if (arg === "--task") options.taskId = value;
    else if (arg === "--mode") options.mode = value;
    else if (arg === "--candidate") options.candidateRoot = value;
    else if (arg === "--output") options.outputRoot = value;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value);
    else if (arg === "--python") options.python = value;
    else if (arg === "--java-home") options.javaHome = value;
    else throw new Error(`unknown argument ${arg}`);
    i += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await evaluateRepair(options);
  const summary = {
    state: result.state,
    validatedSuccess: result.validatedSuccess,
    reason: result.reason ?? null,
    judgeArtifactPath: result.judgeArtifactPath ?? null,
    policy: result.policy ?? null,
    toolchain: result.toolchain ?? null,
    frozenTestSha256: result.judgeArtifact?.frozen_test_sha256 ?? null,
    compileExit: result.judgeArtifact?.compile?.exit_code ?? null,
    runExit: result.judgeArtifact?.run?.exit_code ?? null,
    frozenTestCompleted: result.judgeArtifact?.frozen_test_completed ?? null
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.validatedSuccess) return 0;
  if ([REPAIR_STATE.BLOCKED_ENV, REPAIR_STATE.BLOCKED_SETUP, REPAIR_STATE.JUDGE_ERROR].includes(result.state)) return 2;
  return 1;}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`ERROR: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
}
