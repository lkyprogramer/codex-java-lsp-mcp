#!/usr/bin/env node
// input:  fixture/corpus 根 + attemptKey（或已有 candidateRoot）+ 工具参数。
// output: 每次 attempt 的隔离 candidate 工作区，以及绑定该工作区的中性原语
//         工具（list/rg/read；repair 场景由调用方再叠 write_file）。
// pos:    R03 的对称性核心：control 与 product 两臂共享同一组原生工具与同一
//         root；唯一臂间差异是 product 的 java_symbol（待测 discovery）。
//         路径检查用 resolve/realpath + relative 包含判断（prefix 字符串
//         比较不算 containment）；rg 用参数数组 spawn，绝不拼 shell。
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

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
      required: ["path"]
    }
  }
};

export const RGP_BIN = process.env.EVAL_RG_BIN || "rg";
export const NATIVE_TOOL_LIMIT = 8_000;
const LIST_MAX_ENTRIES = 500;

export const EVAL_LIST_TOOL = {
  type: "function",
  function: {
    name: "list",
    description: "List directory entries (file/dir names, repo-relative paths) under a repo-relative directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, maxEntries: { type: "integer" } },
      required: ["path"]
    }
  }
};

export const EVAL_RG_TOOL = {
  type: "function",
  function: {
    name: "rg",
    description: "Grep a fixed-string pattern in the working copy; returns bounded 'path:line:content' output.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "repo-relative directory to search (default: root)" },
        maxResults: { type: "integer" }
      },
      required: ["pattern"]
    }
  }
};

const executeFile = promisify((command, args, options, callback) => {
  const child = spawn(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 20_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > options.outputCapBytes) child.kill("SIGKILL");
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, "utf8") > options.outputCapBytes) child.kill("SIGKILL");
  });
  child.on("error", error => callback(error));
  child.on("close", (code, signal) => callback(null, { code, signal, stdout, stderr }));
});

/** Shared declaration of the repair-only write_file tool. */
export const EVAL_WRITE_FILE_TOOL = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write the full corrected content of a repo-relative source file (repair tasks only).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  }
};

/** Canonical containment check: normalize separators, resolve against the
 * candidate root, then require the resolved target's relative position
 * inside the resolved root to be a real path ("" for the root itself, never
 * "../..."). Existing targets are additionally checked through realpath so
 * a symlink inside the workspace cannot reach a file outside it. String
 * startsWith is NOT used anywhere. */
export function resolveInCandidate(candidateRoot, repoRelativePath) {
  const normalized = String(repoRelativePath ?? "").replaceAll("\\", "/");
  if (normalized.length === 0) return { error: "path is required" };
  if (path.isAbsolute(normalized)) return { error: "path must be repo-relative" };
  const candidate = path.resolve(candidateRoot);
  const target = path.resolve(candidate, normalized);
  // Logical containment (applies to all targets, including non-existent
  // write targets).
  if (path.relative(candidate, target).startsWith("..")) {
    return { error: "path escapes the candidate workspace" };
  }
  let exists = false;
  try {
    statSync(target);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    return { candidateRoot: candidate, target, normalized };
  }
  // Symlink escape: the RESOLVED target must stay inside the resolved root.
  const resolvedRoot = realpathSync(candidate);
  const resolvedTarget = realpathSync(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === "" || (rel.startsWith("..") === false && !path.isAbsolute(rel))) {
    return { candidateRoot: resolvedRoot, target: resolvedTarget, normalized };
  }
  return { error: "path resolves outside the candidate workspace (symlink escape)" };
}

/** Create an isolated per-attempt candidate workspace: a full copy of
 * fixtureRoot under outputRoot, keyed by attemptKey. Each attempt (arm x
 * repeat) gets its own root; the root NEVER aliases the fixture or another
 * attempt's copy. */
export function createAttemptWorkspace(fixtureRoot, attemptKey, outputRoot) {
  if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
    throw new Error("fixtureRoot must be an absolute path");
  }
  const attemptId = String(attemptKey ?? "").replace(/[^\w.\-]+/g, "_").slice(0, 120) || "attempt";
  const output = path.resolve(outputRoot);
  const candidateRoot = path.join(output, "candidates", attemptId);
  mkdirSync(path.dirname(candidateRoot), { recursive: true });
  cpSync(fixtureRoot, candidateRoot, { recursive: true, filter: src => !src.includes(".git") });
  return candidateRoot;
}

function boundedText(text, limit = NATIVE_TOOL_LIMIT) {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= limit) return { text, truncated: false };
  let kept = buf.slice(0, limit).toString("utf8");
  const lastNewline = kept.lastIndexOf("\n");
  if (lastNewline > kept.length - 256) kept = kept.slice(0, lastNewline);
  return { text: `${kept}\n...[truncated]`, truncated: true };
}

/** Shared native tool executor bound to ONE candidate root. Returns the
 * tool declarations (matching the runLiveAgentTask tool shape) plus an
 * async invoke(name, args). Tool errors come back as {error} objects, never
 * as thrown exceptions, so the agent loop stays alive and receipts stay
 * honest. */
/** Shared native tool executor bound to ONE candidate root. `kind`
 * ("qa"|"repair") selects whether write_file is exposed; both arms see the
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
  const maxLines = budget.maxLines ?? 200;
  const tools = [...(kind === "repair" ? [EVAL_WRITE_FILE_TOOL] : []), EVAL_LIST_TOOL, EVAL_RG_TOOL, EVAL_READ_TOOL];
  const invoke = async (name, args) => {
    if (name === "list") {
      return invokeList(args, candidateRoot, outputCapBytes);
    }
    if (name === "rg") {
      return invokeRg(args, candidateRoot, outputCapBytes, rgTimeoutMs);
    }
    if (name === "read") {
      return invokeRead(args, candidateRoot, maxLines);
    }
    if (name === "write_file" && kind === "repair") {
      return invokeWrite(args, candidateRoot);
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
  const maxResults = Math.max(1, Math.min(1_000, Number.isFinite(args?.maxResults) ? Math.trunc(args.maxResults) : 200));
  // argv-array spawn: the pattern is a single argument, never shell-joined.
  const argv = [
    "--fixed-strings",
    "--line-number",
    "--no-heading",
    "--color", "never",
    "-g", "!*.min.js",
    "--max-count", String(maxResults),
    "--", pattern, "."
  ];
  let result;
  try {
    result = await executeFile(RGP_BIN, argv, { cwd: check.target, timeoutMs, outputCapBytes: outputCapBytes * 4 });
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") return { error: `rg binary not found at ${RGP_BIN} (BLOCKED_ENV)` };
    return { error: String(error.message ?? error) };
  }
  if (result.code > 1) {
    return { error: `rg failed (code ${result.code}): ${String(result.stderr).slice(0, 300)}` };
  }
  const bounded = boundedText(result.stdout, outputCapBytes);
  return {
    pattern,
    path: String(args?.path ?? "."),
    output: bounded.text,
    matches: result.stdout === "" ? 0 : result.stdout.split("\n").length - (result.stdout.endsWith("\n") ? 1 : 0),
    ...(bounded.truncated ? { truncated: true } : {}),
    ...(result.code === 1 ? { noMatches: true } : {})
  };
}

function invokeRead(args, candidateRoot, maxLines) {
  const check = resolveInCandidate(candidateRoot, args?.path);
  if (check.error) return { error: check.error };
  let full;
  try {
    full = readFileSync(check.target, "utf8");
  } catch (error) {
    return { error: `read failed: ${String(error.message ?? error)}` };
  }
  const lines = full.split("\n");
  const startLine = Math.max(1, Math.max(1, Math.trunc(args?.startLine ?? 1)));
  const limit = Math.max(1, Math.min(400, Math.trunc(args?.maxLines ?? maxLines)));
  const endLine = Math.min(lines.length, startLine - 1 + limit);
  const text = lines.slice(startLine - 1, endLine).join("\n");
  return { path: check.normalized, text, startLine, endLine };
}

async function invokeWrite(args, candidateRoot) {
  const check = resolveInCandidate(candidateRoot, args?.path);
  if (check.error) return { error: check.error };
  const content = String(args?.content ?? "");
  try {
    if (!path.isAbsolute(check.target)) throw new Error("internal: unresolved target");
    const parent = path.dirname(check.target);
    mkdirSync(parent, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(check.target, content, "utf8");
    return { path: check.normalized, written: true, bytes: Buffer.byteLength(content, "utf8") };
  } catch (error) {
    return { error: `write failed: ${String(error.message ?? error)}` };
  }
}

/** Native tool names shared by BOTH arms (control and product). The only
 * arm difference is java_symbol on the product arm. */
export function nativeToolNames() {
  return ["list", "rg", "read"];
}