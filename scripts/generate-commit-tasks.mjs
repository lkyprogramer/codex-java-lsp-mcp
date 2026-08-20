#!/usr/bin/env node
// input: A git repository of Java sources.
// output: Frozen commit-derived tasks (task=message, gold=changed Java files + method ranges).
// pos: JIN N3-00. Generic rules only; no per-repo filters. Isolated when writing freeze JSON.
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import Parser from "tree-sitter";

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
const Java = require("tree-sitter-java");

export const MIN_MESSAGE_CHARS = 20;
export const MIN_JAVA_FILES = 2;
export const MAX_JAVA_FILES = 15;
export const RENAME_SIMILARITY = 80;
const DEFAULT_MIN_TASKS = 30;
const FALLBACK_MIN_TASKS = 20;

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    repo: options.get("--repo"),
    project: options.get("--project"),
    output: options.get("--output"),
    minTasks: Number(options.get("--min-tasks") || DEFAULT_MIN_TASKS),
    holdoutRatio: Number(options.get("--holdout-ratio") || 0.3),
    maxCommits: options.get("--max-commits") ? Number(options.get("--max-commits")) : undefined
  };
}

async function git(repo, ...args) {
  const { stdout } = await execFile("git", ["-C", repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8"
  });
  return stdout;
}

function isJavaPath(file) {
  return file.replaceAll("\\", "/").endsWith(".java");
}

export function classifyDiffEntries(entries) {
  const java = [];
  for (const entry of entries) {
    if (!entry.status) continue;
    const code = entry.status[0];
    if (code === "R" || code === "C") {
      const similarity = Number(entry.status.slice(1) || "0");
      if (isJavaPath(entry.path) || isJavaPath(entry.from ?? "")) {
        java.push({
          path: entry.path,
          from: entry.from,
          status: code,
          similarity,
          renameOnly: code === "R" && similarity >= RENAME_SIMILARITY
        });
      }
      continue;
    }
    if (isJavaPath(entry.path)) java.push({ path: entry.path, status: code, similarity: 100, renameOnly: false });
  }
  return java;
}

export function isExcludedJavaSet(javaEntries) {
  if (javaEntries.length < MIN_JAVA_FILES || javaEntries.length > MAX_JAVA_FILES) return "java-count";
  if (javaEntries.every(entry => entry.renameOnly)) return "rename-only";
  return undefined;
}

export function parseNameStatus(stdout) {
  const entries = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      entries.push({ status, from: parts[1], path: parts[2] });
    } else {
      entries.push({ status, path: parts[1] });
    }
  }
  return entries;
}

function parser() {
  const instance = new Parser();
  instance.setLanguage(Java);
  return instance;
}

function walkMethods(node, source, methods) {
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const nameNode = node.childForFieldName("name");
    const params = node.childForFieldName("parameters");
    const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : node.type === "constructor_declaration" ? "<init>" : "";
    const arity = params ? params.namedChildren.filter(child => child.type === "formal_parameter" || child.type === "spread_parameter").length : 0;
    methods.push({
      name,
      arity,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column + 1,
      endColumn: node.endPosition.column + 1,
      compact: source.slice(node.startIndex, node.endIndex).replace(/\s+/g, "")
    });
  }
  for (const child of node.namedChildren) walkMethods(child, source, methods);
}

export function extractMethods(source) {
  if (!source) return [];
  const tree = parser().parse(source);
  try {
    const methods = [];
    walkMethods(tree.rootNode, source, methods);
    return methods;
  } finally {
    tree.delete?.();
  }
}

export function methodGold(parentSource, childSource) {
  const parent = extractMethods(parentSource ?? "");
  const child = extractMethods(childSource ?? "");
  const parentByKey = new Map();
  for (const method of parent) {
    const key = `${method.name}/${method.arity}`;
    const bucket = parentByKey.get(key) ?? [];
    bucket.push(method);
    parentByKey.set(key, bucket);
  }
  const gold = [];
  const seen = new Set();
  for (const method of child) {
    const key = `${method.name}/${method.arity}`;
    const bucket = parentByKey.get(key) ?? [];
    const match = bucket.shift();
    if (!match || match.compact !== method.compact) {
      gold.push({
        name: method.name,
        arity: method.arity,
        range: { start: { line: method.startLine, column: method.startColumn }, end: { line: method.endLine, column: method.endColumn } }
      });
      seen.add(key);
    }
  }
  for (const [key, leftover] of parentByKey) {
    if (seen.has(key)) continue;
    for (const method of leftover) {
      gold.push({
        name: method.name,
        arity: method.arity,
        deleted: true,
        range: { start: { line: method.startLine, column: method.startColumn }, end: { line: method.endLine, column: method.endColumn } }
      });
    }
  }
  return gold;
}

function whitespaceEqual(left, right) {
  return (left ?? "").replace(/\s+/g, "") === (right ?? "").replace(/\s+/g, "");
}

async function showFile(repo, revision, file) {
  try {
    return await git(repo, "show", `${revision}:${file}`);
  } catch {
    return "";
  }
}

export async function taskFromCommit(repo, commit) {
  const subject = (await git(repo, "log", "-1", "--format=%s", commit)).trim();
  if (subject.length < MIN_MESSAGE_CHARS) return { excluded: "short-message", commit, subject };
  const parents = (await git(repo, "rev-list", "--parents", "-n", "1", commit)).trim().split(" ");
  if (parents.length !== 2) return { excluded: "merge-or-root", commit, subject };
  const parent = parents[1];
  const statusOut = await git(repo, "diff-tree", "--no-commit-id", "--name-status", "-r", `-M${RENAME_SIMILARITY}%`, parent, commit);
  const java = classifyDiffEntries(parseNameStatus(statusOut));
  const countReason = isExcludedJavaSet(java);
  if (countReason) return { excluded: countReason, commit, subject, javaCount: java.length };
  const files = [];
  let anyMethodChange = false;
  for (const entry of java) {
    if (entry.renameOnly) {
      files.push({ path: entry.path, from: entry.from, status: "rename" });
      continue;
    }
    const parentText = entry.status === "A" ? "" : await showFile(repo, parent, entry.from ?? entry.path);
    const childText = entry.status === "D" ? "" : await showFile(repo, commit, entry.path);
    if (entry.status !== "A" && entry.status !== "D" && whitespaceEqual(parentText, childText)) {
      files.push({ path: entry.path, status: "format", methods: [] });
      continue;
    }
    const methods = methodGold(parentText, childText);
    if (methods.length > 0) anyMethodChange = true;
    files.push({ path: entry.path, status: entry.status === "A" ? "add" : entry.status === "D" ? "delete" : "modify", methods });
  }
  if (!anyMethodChange) return { excluded: "format-or-rename", commit, subject };
  const timestamp = Number((await git(repo, "log", "-1", "--format=%ct", commit)).trim());
  return {
    commit,
    parent,
    timestamp,
    task: subject,
    files: files.filter(file => file.status !== "format" && file.status !== "rename")
  };
}

export async function listCandidateCommits(repo) {
  const raw = await git(repo, "log", "--reverse", "--no-merges", "--format=%H");
  return raw.split("\n").map(line => line.trim()).filter(Boolean);
}

export function splitTrainHoldout(tasks, holdoutRatio = 0.3) {
  const ordered = [...tasks].sort((left, right) => left.timestamp - right.timestamp);
  const holdoutCount = Math.max(1, Math.round(ordered.length * holdoutRatio));
  const cut = Math.max(1, ordered.length - holdoutCount);
  return { train: ordered.slice(0, cut), holdout: ordered.slice(cut) };
}

export async function generateCommitTasks(repo, options = {}) {
  const minTasks = options.minTasks ?? DEFAULT_MIN_TASKS;
  const fallbackMin = options.fallbackMinTasks ?? FALLBACK_MIN_TASKS;
  let commits = await listCandidateCommits(repo);
  if (options.maxCommits && options.maxCommits > 0 && commits.length > options.maxCommits) {
    commits = commits.slice(-options.maxCommits);
  }
  const kept = [];
  const excluded = { mergeOrRoot: 0, shortMessage: 0, javaCount: 0, renameOnly: 0, format: 0 };
  for (const commit of commits) {
    const task = await taskFromCommit(repo, commit);
    if (task.excluded === "merge-or-root") { excluded.mergeOrRoot += 1; continue; }
    if (task.excluded === "short-message") { excluded.shortMessage += 1; continue; }
    if (task.excluded === "java-count") { excluded.javaCount += 1; continue; }
    if (task.excluded === "rename-only") { excluded.renameOnly += 1; continue; }
    if (task.excluded === "format-or-rename") { excluded.format += 1; continue; }
    kept.push(task);
  }
  const minApplied = kept.length >= minTasks ? minTasks : kept.length >= fallbackMin ? fallbackMin : kept.length;
  const split = splitTrainHoldout(kept, options.holdoutRatio ?? 0.3);
  return {
    schemaVersion: "jin-commit-tasks/v1",
    project: options.project,
    repo,
    head: (await git(repo, "rev-parse", "HEAD")).trim(),
    minRequested: minTasks,
    minApplied,
    counts: { scanned: commits.length, kept: kept.length, excluded },
    train: split.train,
    holdout: split.holdout
  };
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/generate-commit-tasks.mjs --repo <git> --project <id> --output <json>");
    return;
  }
  if (!cli.repo || !cli.project || !cli.output) throw new Error("--repo, --project, and --output are required");
  const payload = await generateCommitTasks(path.resolve(cli.repo), {
    project: cli.project,
    minTasks: cli.minTasks,
    holdoutRatio: cli.holdoutRatio,
    maxCommits: cli.maxCommits
  });
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(cli.output, text);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    sha256: sha256(text),
    kept: payload.counts.kept,
    train: payload.train.length,
    holdout: payload.holdout.length,
    minApplied: payload.minApplied,
    head: payload.head
  }));
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).endsWith("generate-commit-tasks.mjs");
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
