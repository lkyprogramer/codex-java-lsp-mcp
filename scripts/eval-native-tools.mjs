#!/usr/bin/env node
// input:  fixture/corpus 根 + attemptKey（或已有 candidateRoot）+ 工具参数。
// output: 每次 attempt 的隔离 candidate 工作区，以及绑定该工作区的中性原语
//         工具（list/rg/read；repair 场景由调用方再叠 write_file）。
// pos:    R03 的对称性核心：control 与 product 两臂共享同一组原生工具与同一
//         root；唯一臂间差异是 product 的 java_symbol（待测 discovery）。
//         路径检查用 resolve/realpath + relative 包含判断（prefix 字符串
//         比较不算 containment）；rg 用参数数组 spawn，绝不拼 shell。
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { splitSourceLines } from "./eval-tool-wire.mjs";

export const EVAL_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read an exact file window from the working copy (repo-relative path).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        maxLines: { type: "integer" }
      },
      additionalProperties: false,
      required: ["path"]
    }
  }
};

export const RGP_BIN = process.env.EVAL_RG_BIN || "rg";
export const NATIVE_TOOL_LIMIT = 8_000;
/** docs/03 §1.1: an ordinary read returns at most 16000 source bytes. */
export const READ_MAX_SOURCE_BYTES = 16_000;
const MAX_READ_LINES = 400;
/** Eval protocol v1.2: a read without maxLines returns this window (was 200);
 *  longer windows stay available up to MAX_READ_LINES by asking for them. */
export const DEFAULT_READ_LINES = 80;
const LIST_MAX_ENTRIES = 500;

export const EVAL_LIST_TOOL = {
  type: "function",
  function: {
    name: "list",
    description: "List directory entries (file/dir names, repo-relative paths) under a repo-relative directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, maxEntries: { type: "integer" } },
      additionalProperties: false,
      required: ["path"]
    }
  }
};

export const EVAL_RG_TOOL = {
  type: "function",
  function: {
    name: "rg",
    description: "Locate a fixed-string pattern in the working copy; returns bounded repo-relative 'path:line:content' navigation output. These matches do not count as source evidence; read the relevant exact windows before submission.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "repo-relative file or directory to search (default: root)" },
        maxResults: { type: "integer" }
      },
      additionalProperties: false,
      required: ["pattern"]
    }
  }
};

const executeFile = promisify((command, args, options, callback) => {
  const child = spawn(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 20_000 });
  let stdout = "";
  let stderr = "";
  let outputLimited = false;
  const started = Date.now();
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > options.outputCapBytes) {
      outputLimited = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, "utf8") > options.outputCapBytes) {
      outputLimited = true;
      child.kill("SIGKILL");
    }
  });
  child.on("error", error => callback(error));
  child.on("close", (code, signal) => callback(null, {
    code,
    signal,
    stdout,
    stderr,
    outputLimited,
    // spawn's own timeout kills with SIGTERM; a kill we did not cause for the
    // output cap is a timeout, never a complete result.
    timedOut: signal !== null && !outputLimited && Date.now() - started >= (options.timeoutMs ?? 20_000) - 50
  }));
});

/** Repair-only compile check shared by both arms. */
export const EVAL_TEST_TOOL = {
  type: "function",
  function: {
    name: "test",
    description: "Compile production Java sources selected by the public Maven configuration (or standalone src tree). Unsupported builds are reported explicitly. Evaluator tests are not available.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
};

/** Shared declaration of the repair-only write_file tool. */
export const EVAL_WRITE_FILE_TOOL = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write the full corrected content of a repo-relative source file (repair tasks only).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      additionalProperties: false,
      required: ["path", "content"]
    }
  }
};

/** Exact replacement shared by both repair arms. */
export const EVAL_REPLACE_FILE_TOOL = {
  type: "function",
  function: {
    name: "replace_file",
    description: "Replace exactly one occurrence of before with after in an existing repo-relative file. Zero or multiple matches fail without writing.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, before: { type: "string", minLength: 1 }, after: { type: "string" } },
      required: ["path", "before", "after"],
      additionalProperties: false
    }
  }
};

export function validateArguments(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) return `unknown parameter: ${key}`;
    const spec = schema.properties[key];
    if (spec.type === "integer" ? !Number.isInteger(args[key]) : typeof args[key] !== spec.type) return `${key} must be ${spec.type}`;
    if (spec.minLength && args[key].length < spec.minLength) return `${key} must not be empty`;
  }
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) return `${key} is required`;
  return null;
}

/** True when `target` is `root` itself or strictly inside it. */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Canonical containment check: normalize separators, resolve against the
 * candidate root, require logical containment, then require the REAL path
 * of the target - or, for a not-yet-existing write target, of its nearest
 * existing ancestor - to stay inside the real root, so a symlinked
 * directory cannot carry a read or write outside the workspace. String
 * prefix comparison is not used. */
export function resolveInCandidate(candidateRoot, repoRelativePath) {
  const normalized = String(repoRelativePath ?? "").replaceAll("\\", "/");
  if (normalized.length === 0) return { error: "path is required" };
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return { error: "path must be repo-relative" };
  const candidate = path.resolve(candidateRoot);
  const target = path.resolve(candidate, normalized);
  if (!isInside(candidate, target)) {
    return { error: "path escapes the candidate workspace" };
  }
  const resolvedRoot = realpathSync(candidate);
  let probe = target;
  while (!existsSync(probe) && isInside(candidate, path.dirname(probe)) && probe !== candidate) {
    probe = path.dirname(probe);
  }
  let resolvedProbe;
  try {
    resolvedProbe = realpathSync(probe);
  } catch {
    return { error: "path cannot be resolved inside the candidate workspace" };
  }
  if (!isInside(resolvedRoot, resolvedProbe)) {
    return { error: "path resolves outside the candidate workspace (symlink escape)" };
  }
  const exists = probe === target;
  return {
    candidateRoot: resolvedRoot,
    target: exists ? resolvedProbe : path.join(resolvedProbe, path.relative(probe, target)),
    normalized,
    exists
  };
}

/** Create an isolated per-attempt candidate workspace: a full copy of
 * fixtureRoot (minus `.git` directories) under outputRoot/candidates. The
 * directory name embeds a hash of the full attempt key, so two attempts can
 * never share a root, and an existing root is refused rather than merged
 * (a re-run must use a fresh output directory; old candidates are evidence). */
export function createAttemptWorkspace(fixtureRoot, attemptKey, outputRoot) {
  if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
    throw new Error("fixtureRoot must be an absolute path");
  }
  const key = String(attemptKey ?? "");
  if (key.length === 0) throw new Error("attemptKey is required");
  const readable = key.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
  const output = path.resolve(outputRoot);
  const candidateRoot = path.join(output, "candidates", `${readable}-${digest}`);
  if (existsSync(candidateRoot)) {
    throw new Error(`attempt workspace already exists: ${candidateRoot} (use a fresh output directory)`);
  }
  const fixture = path.resolve(fixtureRoot);
  if (isInside(fixture, output)) {
    throw new Error("outputRoot must not be inside the fixture");
  }
  mkdirSync(path.dirname(candidateRoot), { recursive: true });
  cpSync(fixture, candidateRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: src => !path.relative(fixture, src).split(path.sep).includes(".git")
  });
  return candidateRoot;
}

/** Bounded navigation text: whole lines only (a lone oversized first line is
 * cut on a character boundary); truncation is reported by the flag. */
function boundedText(text, limit = NATIVE_TOOL_LIMIT) {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  const lines = splitSourceLines(text);
  let used = 0;
  let kept = 0;
  while (kept < lines.length && used + Buffer.byteLength(lines[kept], "utf8") <= limit) {
    used += Buffer.byteLength(lines[kept], "utf8");
    kept += 1;
  }
  if (kept > 0) return { text: lines.slice(0, kept).join(""), truncated: true };
  let head = "";
  for (const ch of lines[0] ?? "") {
    if (Buffer.byteLength(head + ch, "utf8") > limit) break;
    head += ch;
  }
  return { text: head, truncated: true };
}

/** Shared native tool executor bound to ONE candidate root. Returns the
 * tool declarations (matching the runLiveAgentTask tool shape) plus an
 * async invoke(name, args). Tool errors come back as {error} objects, never
 * as thrown exceptions, so the agent loop stays alive and receipts stay
 * honest. */
/** Shared native tool executor bound to ONE candidate root. `kind`
 * ("qa"|"repair") selects whether mutation and compile tools are exposed; both arms see the
 * identical native set. Returns the tool declarations (matching the
 * runLiveAgentTask tool shape) plus an async invoke(name, args). Tool
 * errors come back as {error} objects, never as thrown exceptions, so the
 * agent loop stays alive and receipts stay honest. */
export function buildToolSet(profile, kind, { candidateRoot, budget = {} } = {}) {
  if (!candidateRoot || !path.isAbsolute(candidateRoot)) {
    throw new Error("candidateRoot is required and must be absolute");
  }
  if (kind !== "qa" && kind !== "repair") {
    throw new Error(`unknown kind: ${kind}`);
  }
  const outputCapBytes = budget.outputCapBytes ?? NATIVE_TOOL_LIMIT;
  const rgTimeoutMs = budget.rgTimeoutMs ?? 20_000;
  const maxLines = budget.maxLines ?? DEFAULT_READ_LINES;
  const readMaxBytes = budget.readMaxBytes ?? READ_MAX_SOURCE_BYTES;
  const tools = [...(kind === "repair" ? [EVAL_WRITE_FILE_TOOL, EVAL_REPLACE_FILE_TOOL, EVAL_TEST_TOOL] : []), EVAL_LIST_TOOL, EVAL_RG_TOOL, EVAL_READ_TOOL];
  const invoke = async (name, args) => {
    const declaration = tools.find(tool => tool.function.name === name);
    if (!declaration) return { error: `tool ${name} is not provided in this session` };
    const invalid = validateArguments(declaration.function.parameters, args);
    if (invalid) return { error: invalid, errorClass: "INVALID_ARGUMENTS" };
    if (name === "replace_file") return invokeReplace(args, candidateRoot);
    if (name === "list") {
      return invokeList(args, candidateRoot, outputCapBytes);
    }
    if (name === "rg") {
      return invokeRg(args, candidateRoot, outputCapBytes, rgTimeoutMs);
    }
    if (name === "read") {
      return invokeRead(args, candidateRoot, maxLines, readMaxBytes);
    }
    if (name === "write_file" && kind === "repair") {
      return invokeWrite(args, candidateRoot);
    }
    if (name === "test" && kind === "repair") {
      return invokeCompileCheck(candidateRoot, { javaHome: budget.javaHome ?? process.env.JAVA_HOME ?? null, timeoutMs: budget.testTimeoutMs ?? 60_000, outputCapBytes });
    }
    return { error: `tool ${name} is not provided in this session` };
  };
  return { profile: profile ?? "native", kind, candidateRoot, tools, invoke };
}

async function invokeList(args, candidateRoot, outputCapBytes) {
  const check = resolveInCandidate(candidateRoot, args?.path ?? ".");
  if (check.error) return { error: check.error };
  const maxEntries = Math.max(1, Math.min(LIST_MAX_ENTRIES, Number.isFinite(args?.maxEntries) ? Math.trunc(args.maxEntries) : LIST_MAX_ENTRIES));
  const entries = [];
  try {
    const walk = async (dir, prefix) => {
      if (entries.length >= maxEntries) return;
      let items;
      try {
        items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const item of items) {
        if (entries.length >= maxEntries) return;
        const rel = prefix === "." ? item.name : `${prefix}/${item.name}`;
        if (item.isDirectory()) {
          entries.push(rel + "/");
          await walk(path.join(dir, item.name), rel);
        } else {
          entries.push(rel);
        }
      }
    };
    await walk(check.target, String(args?.path ?? ".").replaceAll("\\", "/").replace(/\/+$/, "") || ".");
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
  const bounded = boundedText(entries.join("\n"), outputCapBytes);
  return { path: String(args?.path ?? "."), entries: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) };
}

async function invokeRg(args, candidateRoot, outputCapBytes, timeoutMs) {
  const pattern = String(args?.pattern ?? "");
  if (pattern.length === 0) return { error: "pattern is required" };
  const check = resolveInCandidate(candidateRoot, args?.path ?? ".");
  if (check.error) return { error: check.error };
  if (!check.exists) return { error: `rg search path does not exist: ${check.normalized}`, errorClass: "PATH_NOT_FOUND" };
  const maxResults = Math.max(1, Math.min(1_000, Number.isFinite(args?.maxResults) ? Math.trunc(args.maxResults) : 200));
  // argv-array spawn: the pattern is a single argument, never shell-joined.
  const argv = [
    "--fixed-strings",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color", "never",
    "-g", "!*.min.js",
    "--max-count", String(maxResults),
    "--", pattern, path.relative(check.candidateRoot, check.target) || "."
  ];
  let result;
  try {
    result = await executeFile(RGP_BIN, argv, { cwd: check.candidateRoot, timeoutMs, outputCapBytes: outputCapBytes * 4 });
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") return { error: `rg binary not found at ${RGP_BIN} (BLOCKED_ENV)` };
    return { error: String(error.message ?? error) };
  }
  if (result.code !== null && result.code > 1) {
    return { error: `rg failed (code ${result.code}): ${String(result.stderr).slice(0, 300)}` };
  }
  // --max-count is per file; maxResults is the TOTAL line cap.
  const allLines = splitSourceLines(result.stdout);
  const kept = allLines.slice(0, maxResults);
  const bounded = boundedText(kept.join(""), outputCapBytes);
  const truncated = bounded.truncated || kept.length < allLines.length || result.outputLimited || result.timedOut;
  return {
    pattern,
    path: String(args?.path ?? "."),
    output: bounded.text,
    matches: kept.length,
    ...(truncated ? { truncated: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.code === 1 && allLines.length === 0 ? { noMatches: true } : {})
  };
}

/** Exact source window: lines keep their terminators (the text is the
 * literal bytes of lines startLine..endLine, as the frozen kit validates),
 * no phantom line after a trailing newline, a per-call source byte cap of
 * whole lines, and the whole-file sha256 for provenance. */
function invokeRead(args, candidateRoot, maxLines, maxBytes) {
  const check = resolveInCandidate(candidateRoot, args?.path);
  if (check.error) return { error: check.error };
  const startArg = args?.startLine ?? 1;
  const linesArg = args?.maxLines ?? maxLines;
  if (!Number.isInteger(startArg) || startArg < 1) return { error: "startLine must be a positive integer" };
  if (!Number.isInteger(linesArg) || linesArg < 1) return { error: "maxLines must be a positive integer" };
  let bytes;
  try {
    if (!lstatSync(check.target).isFile()) return { error: "read failed: not a regular file" };
    bytes = readFileSync(check.target);
  } catch (error) {
    return { error: `read failed: ${String(error.message ?? error)}` };
  }
  const full = bytes.toString("utf8");
  const lines = splitSourceLines(full);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  if (startArg > lines.length) {
    return { path: check.normalized, text: "", startLine: startArg, endLine: startArg - 1, totalLines: lines.length, contentHash };
  }
  const limit = Math.min(MAX_READ_LINES, linesArg);
  const window = lines.slice(startArg - 1, startArg - 1 + limit);
  let kept = 0;
  let used = 0;
  for (const line of window) {
    const size = Buffer.byteLength(line, "utf8");
    if (kept > 0 && used + size > maxBytes) break;
    if (kept === 0 && size > maxBytes) {
      return { error: `line ${startArg} alone exceeds the ${maxBytes}-byte read cap`, errorClass: "READ_BUDGET" };
    }
    used += size;
    kept += 1;
  }
  const endLine = startArg + kept - 1;
  const truncatedByBytes = kept < window.length;
  return {
    path: check.normalized,
    text: window.slice(0, kept).join(""),
    startLine: startArg,
    endLine,
    totalLines: lines.length,
    contentHash,
    ...(truncatedByBytes ? { truncated: true, nextStartLine: endLine + 1 } : {})
  };
}

async function invokeWrite(args, candidateRoot) {
  const check = resolveInCandidate(candidateRoot, args?.path);
  if (check.error) return { error: check.error };
  if (typeof args?.content !== "string") return { error: "content must be a string" };
  try {
    if (check.exists && !lstatSync(check.target).isFile()) return { error: "write failed: target is not a regular file" };
    mkdirSync(path.dirname(check.target), { recursive: true });
    // Re-check after directory creation: nothing on the path may have become
    // an escape in between.
    const recheck = resolveInCandidate(candidateRoot, args.path);
    if (recheck.error) return { error: recheck.error };
    await writeFile(recheck.target, args.content, "utf8");
    return { path: check.normalized, written: true, bytes: Buffer.byteLength(args.content, "utf8") };
  } catch (error) {
    return { error: `write failed: ${String(error.message ?? error)}` };
  }
}

async function invokeReplace(args, candidateRoot) {
  const check = resolveInCandidate(candidateRoot, args.path);
  if (check.error) return { error: check.error };
  try {
    if (!check.exists || !lstatSync(check.target).isFile()) return { error: "replace failed: target is not an existing regular file" };
    const bytes = readFileSync(check.target);
    const before = Buffer.from(args.before, "utf8");
    const offset = bytes.indexOf(before);
    if (offset < 0) return { error: "replace failed: before has no match" };
    if (bytes.indexOf(before, offset + 1) >= 0) return { error: "replace failed: before has multiple matches" };
    const updated = Buffer.concat([bytes.subarray(0, offset), Buffer.from(args.after, "utf8"), bytes.subarray(offset + before.length)]);
    const recheck = resolveInCandidate(candidateRoot, args.path);
    if (recheck.error) return { error: recheck.error };
    await writeFile(recheck.target, updated);
    return { path: check.normalized, written: true, bytes: updated.length, replacements: 1 };
  } catch (error) {
    return { error: `replace failed: ${String(error.message ?? error)}` };
  }
}

async function collectJavaSources(root) {
  const out = [];
  const walk = async dir => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === ".git" || item.isSymbolicLink()) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile() && item.name.endsWith(".java")) out.push(full);
    }
  };
  await walk(root);
  return out;
}

/** This deliberately small compile adapter supports dependency-free Maven
 * production roots and standalone src trees. It never guesses a classpath or
 * combines independent modules. Complex builds need their real build runner. */
async function compileUnits(candidateRoot) {
  candidateRoot = realpathSync(candidateRoot);
  const units = [];
  const visit = async (relativeRoot, seen = new Set()) => {
    const check = resolveInCandidate(candidateRoot, relativeRoot);
    if (check.error) throw new Error(check.error);
    if (seen.has(check.target)) throw new Error("cyclic Maven module configuration");
    seen.add(check.target);
    const pomPath = path.join(check.target, "pom.xml");
    if (!existsSync(pomPath)) {
      if (relativeRoot !== ".") throw new Error("declared module has no pom.xml");
      if (existsSync(path.join(check.target, "build.gradle")) || existsSync(path.join(check.target, "build.gradle.kts"))) throw new Error("Gradle compile configuration is unsupported");
      const sourceCheck = resolveInCandidate(candidateRoot, path.join(relativeRoot, "src"));
      if (sourceCheck.error) throw new Error(sourceCheck.error);
      units.push({ root: relativeRoot, sources: await collectJavaSources(sourceCheck.target), release: null });
      return;
    }
    const pomCheck = resolveInCandidate(candidateRoot, path.relative(candidateRoot, pomPath));
    if (pomCheck.error) throw new Error(pomCheck.error);
    const xml = readFileSync(pomCheck.target, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    if (/<(?:parent|dependencies|profiles|plugins|extensions)\b/.test(xml)) throw new Error("Maven inheritance, dependencies, profiles and plugins require the real build runner");
    const tag = name => xml.match(new RegExp(`<${name}\\s*>\\s*([^<]+?)\\s*</${name}>`))?.[1];
    const source = tag("sourceDirectory") ?? "src/main/java";
    const sourceCheck = resolveInCandidate(candidateRoot, path.join(relativeRoot, source));
    if (sourceCheck.error) throw new Error(sourceCheck.error);
    const configuredRelease = tag("maven\\.compiler\\.release");
    const sourceLevel = tag("maven\\.compiler\\.source");
    const targetLevel = tag("maven\\.compiler\\.target");
    if (!configuredRelease && (sourceLevel || targetLevel) && (!sourceLevel || sourceLevel !== targetLevel)) throw new Error("Maven source/target configuration requires matching explicit levels");
    const rawRelease = configuredRelease ?? sourceLevel;
    const release = rawRelease?.replace(/^1\./, "") ?? null;
    if (release !== null && !/^\d+$/.test(release)) throw new Error("unresolved Maven Java release");
    if (source.includes("${") || /<build\b/.test(xml) && !/<sourceDirectory\b/.test(xml)) throw new Error("unsupported Maven build configuration");
    units.push({ root: relativeRoot, sources: await collectJavaSources(sourceCheck.target), release });
    const modules = xml.match(/<modules\b[^>]*>([\s\S]*?)<\/modules>/)?.[1] ?? "";
    for (const match of modules.matchAll(/<module\b[^>]*>\s*([^<]+?)\s*<\/module>/g)) {
      if (match[1].includes("${")) throw new Error("unresolved Maven module path");
      await visit(path.join(relativeRoot, match[1]), seen);
    }
  };
  await visit(".");
  return units;
}

async function invokeCompileCheck(candidateRoot, { javaHome, timeoutMs, outputCapBytes }) {
  let units;
  try { units = await compileUnits(candidateRoot); }
  catch (error) { return { status: "UNSUPPORTED", exitCode: null, output: String(error.message ?? error) }; }
  if (units.every(unit => unit.sources.length === 0)) return { status: "NO_SOURCES", exitCode: null, output: "" };
  const javac = javaHome ? path.join(javaHome, "bin", "javac") : "javac";
  const classes = mkdtempSync(path.join(os.tmpdir(), "eval-compile-check-"));
  const results = [];
  const started = Date.now();
  try {
    for (const [index, unit] of units.entries()) {
      if (unit.sources.length === 0) continue;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return { status: "TIMEOUT", exitCode: null, output: "compile deadline exhausted", timedOut: true, units: results };
      const destination = path.join(classes, String(index));
      mkdirSync(destination);
      let result;
      try {
        result = await executeFile(javac, ["-encoding", "UTF-8", "-proc:none", ...(unit.release ? ["--release", unit.release] : []), "-d", destination, ...unit.sources], { cwd: candidateRoot, timeoutMs: remaining, outputCapBytes: outputCapBytes * 4 });
      } catch (error) {
        if (error?.code === "ENOENT") return { error: `javac not found at ${javac} (BLOCKED_ENV)`, errorClass: "BLOCKED_ENV" };
        return { error: String(error.message ?? error) };
      }
      const bounded = boundedText(`${result.stdout}${result.stderr}`.replaceAll(`${candidateRoot}${path.sep}`, "").replaceAll(`${realpathSync(candidateRoot)}${path.sep}`, ""), outputCapBytes);
      const status = result.timedOut ? "TIMEOUT" : result.code === 0 && !result.outputLimited ? "COMPILED" : "COMPILE_FAILED";
      results.push({ root: unit.root, release: unit.release, status, exitCode: result.code, compiledFiles: unit.sources.length, output: bounded.text, ...(result.timedOut ? { timedOut: true } : {}), ...(bounded.truncated || result.outputLimited ? { truncated: true } : {}) });
      if (status !== "COMPILED") return { ...results.at(-1), units: results };
    }
    return { status: "COMPILED", exitCode: 0, compiledFiles: results.reduce((sum, unit) => sum + unit.compiledFiles, 0), output: results.map(unit => unit.output).join(""), units: results };
  } finally {
    rmSync(classes, { recursive: true, force: true });
  }
}

/** Native tool names shared by BOTH arms (control and product). The only
 * arm difference is java_symbol on the product arm. */
export function nativeToolNames() {
  return ["list", "rg", "read"];
}
