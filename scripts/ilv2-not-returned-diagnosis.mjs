#!/usr/bin/env node
// D15 §12, model-free. Splits the W1 targets that no planned term returned (rank null at limit 20: NOT_RETURNED and
// FILE_ONLY) by the first layer that fails. Phase 1 replays W1 exactly (planQueries + diagnoseTask + classifyTarget of
// ilv2-ranking-diagnosis.mjs) before any gold is read; phase 2 probes each missed target with oracle calls:
//   NON_JAVA            the range is not in a .java file (java_symbol never returns it by design)
//   NO_PLAN_TERMS       the task's agent-visible plan has no term at all
//   OUTLINE_UNAVAILABLE java_symbol operation=outline of the target file is not READY or has no entries
//   WINDOW_UNREACHABLE  no declaration of the file has a name line whose runner window covers the range: even a
//                       rank-1 candidate could not deliver it (a read-window limit, not discovery)
//   ORACLE_MISS         an exact query for the covering declaration (Type#member or Type) does not return a covering
//                       candidate at limit 20: the index or the exact lookup loses it
//   NO_VOCAB_OVERLAP    the planned terms share no identifier/CJK token with the covering declaration's head, leading
//                       comments, enclosing type name or file stem: lexical discovery cannot reach it
//   RANKED_OUT          vocabulary overlaps but no planned term (default, text or with-terms) ranked it within 20
// Private rows stay under --out; summary.json carries counts only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { DIAGNOSIS_LIMIT, classifyTarget, diagnoseTask, openProductSession, rankOf, windowCovers } from "./ilv2-ranking-diagnosis.mjs";

export const NOT_RETURNED_SCHEMA = "post-ilv2/not-returned-diagnosis/v1";
export const LADDER = Object.freeze(["NON_JAVA", "NO_PLAN_TERMS", "OUTLINE_UNAVAILABLE", "WINDOW_UNREACHABLE", "ORACLE_MISS", "NO_VOCAB_OVERLAP", "RANKED_OUT"]);
export const OUTLINE_LIMIT = 20;
const MEMBER_KINDS = new Set(["method", "constructor"]);
const isType = entry => !MEMBER_KINDS.has(entry.kind) && entry.kind !== "field";
const span = entry => entry.endLine - entry.startLine;
const contains = (entry, line) => entry.startLine <= line && entry.endLine >= line;

// src/java-index/entity-scoring.ts tokenize, mirrored: whole lexeme and camel/snake parts lower-cased; CJK runs plus bigrams.
const GENERIC = new Set(["public", "private", "protected", "static", "final", "void", "return", "class", "interface", "new", "this", "the",
  "string", "int", "long", "boolean", "integer", "list", "map", "set", "get", "java", "util", "lang", "com", "cn", "org", "import", "package",
  "null", "true", "false", "throws", "extends", "implements", "override", "and", "for", "with"]);
export function lexicalTokens(text) {
  const out = new Set();
  for (const [lexeme] of String(text).normalize("NFKC").matchAll(/[A-Za-z][A-Za-z0-9_]*|\p{Script=Han}+/gu)) {
    if (/^\p{Script=Han}+$/u.test(lexeme)) {
      if (lexeme.length >= 2) out.add(lexeme);
      for (let i = 0; i + 1 < lexeme.length; i += 1) out.add(lexeme.slice(i, i + 2));
      continue;
    }
    const parts = [lexeme, ...lexeme.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_]+/)];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length >= 3 && !GENERIC.has(lower)) out.add(lower);
    }
  }
  return out;
}

/** The declaration text the index can match: head lines, leading comment/annotation block, enclosing type name, file stem. */
export function declarationVocabulary(lines, entry, typeName, relativePath) {
  const head = lines.slice(entry.startLine - 1, Math.min(entry.endLine, entry.startLine + 5));
  const leading = [];
  for (let line = entry.startLine - 1; line >= 1 && leading.length < 15; line -= 1) {
    const text = (lines[line - 1] ?? "").trim();
    if (!/^(\/\/|\/\*|\*|@)/.test(text)) break;
    leading.push(text);
  }
  return lexicalTokens([...head, ...leading, typeName ?? "", path.basename(relativePath, ".java")].join("\n"));
}

/** The innermost member (else type, else field) whose name line puts the target inside the runner's read window. */
export function coveringDeclaration(entries, target) {
  const covering = entries.filter(entry => windowCovers({ declaration: { relativePath: target.path, selection: entry.selection } }, target));
  const pick = group => group.sort((a, b) => span(a) - span(b))[0];
  return pick(covering.filter(entry => MEMBER_KINDS.has(entry.kind))) ?? pick(covering.filter(isType)) ?? pick(covering) ?? null;
}
export function enclosingType(entries, entry) {
  return entries.filter(isType).filter(type => type !== entry && contains(type, entry.selection.line)).sort((a, b) => span(a) - span(b))[0] ?? null;
}
export function oracleQuery(entry, type) {
  if (isType(entry)) return entry.name;
  return type ? `${type.name}#${entry.name}` : entry.name;
}

/** Ladder for one missed target. `call` is the product session; `lines` the target file's text lines (or null). */
export async function diagnoseMissedTarget({ target, plan, lines, call }) {
  const row = { label: null, coveringKind: null, oracleRank: null, oracleExact: null, vocabOverlap: null, outlineState: null };
  if (!target.path.endsWith(".java")) return { ...row, label: "NON_JAVA" };
  if (plan.terms.length === 0) return { ...row, label: "NO_PLAN_TERMS" };
  const outline = await call("java_symbol", { operation: "outline", file: target.path, nearLine: target.startLine, limit: OUTLINE_LIMIT });
  row.outlineState = outline.scopeState ?? null;
  const entries = (outline.entries ?? []).filter(entry => Number.isInteger(entry.selection?.line));
  if (outline.scopeState !== "READY" || entries.length === 0) return { ...row, label: "OUTLINE_UNAVAILABLE" };
  const entry = coveringDeclaration(entries, target);
  if (!entry) return { ...row, label: "WINDOW_UNREACHABLE" };
  row.coveringKind = entry.kind;
  const type = enclosingType(entries, entry);
  const oracle = await call("java_symbol", { operation: "query", query: oracleQuery(entry, type), searchMode: "exact", limit: DIAGNOSIS_LIMIT, preview: "none" });
  row.oracleExact = oracle.exact ?? null;
  row.oracleRank = rankOf(oracle.candidates ?? [], target);
  if (row.oracleRank === null) return { ...row, label: "ORACLE_MISS" };
  const vocabulary = declarationVocabulary(lines ?? [], entry, type?.name, target.path);
  row.vocabOverlap = plan.terms.some(term => [...lexicalTokens(term)].some(token => vocabulary.has(token)));
  if (!row.vocabOverlap) return { ...row, label: "NO_VOCAB_OVERLAP" };
  return { ...row, label: "RANKED_OUT" };
}

export function summarizeMissed(rows, mechanisms) {
  const count = (values, keys) => Object.fromEntries(keys.map(key => [key, values.filter(value => value === key).length]));
  const tally = values => values.reduce((acc, value) => ({ ...acc, [value ?? "none"]: (acc[value ?? "none"] ?? 0) + 1 }), {});
  return {
    targets: mechanisms.total,
    replayByMechanism: mechanisms.byMechanism,
    missedTargets: rows.length,
    byLabel: count(rows.map(row => row.label), LADDER),
    byLabelAndMechanism: Object.fromEntries(["NOT_RETURNED", "FILE_ONLY"].map(mechanism =>
      [mechanism, count(rows.filter(row => row.mechanism === mechanism).map(row => row.label), LADDER)])),
    byCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].sort().map(category =>
      [category, count(rows.filter(row => row.category === category).map(row => row.label), LADDER)])),
    coveringKind: tally(rows.filter(row => row.coveringKind).map(row => row.coveringKind)),
    oracleExact: tally(rows.filter(row => row.label === "ORACLE_MISS").map(row => row.oracleExact)),
    outlineState: tally(rows.filter(row => row.label === "OUTLINE_UNAVAILABLE").map(row => row.outlineState))
  };
}

export async function runNotReturned({ datasetFile, tasksFile, goldFile, inputsFile, serverJs, out, readyTimeoutMs = 900000, openSession = openProductSession, materialize = materializeCorpus }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split; §12 never runs on holdout");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const tasks = tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  await mkdir(out);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const rows = [];
  const mechanisms = { total: 0, byMechanism: {} };
  const sessions = {};
  for (const corpusId of [...new Set(tasks.map(task => task.corpusId))]) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(row => row.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    const workDir = path.join(out, "sessions", corpusId);
    await mkdir(workDir, { recursive: true });
    // Outline is an oracle here, so this owner registers the hidden operations; the W1 replay calls only operation=query.
    const session = await openSession({ serverJs, corpusRoot, workDir, readyTimeoutMs, extraEnv: { JAVA_LSP_EXPERIMENTAL_SYMBOL_OPS: "1" } });
    sessions[corpusId] = { readyMs: Math.round(session.readyMs) };
    try {
      const work = tasks.filter(task => task.corpusId === corpusId);
      // Phase 1: the W1 replay, agent-visible task only.
      const observed = new Map();
      for (const task of work) observed.set(task.taskId, await diagnoseTask({ task, call: session.call }));
      // Phase 2: gold, then oracle probes on this corpus's open session.
      const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row.requiredEvidence ?? []]));
      const fileCache = new Map();
      const lines = async relativePath => {
        if (!fileCache.has(relativePath)) fileCache.set(relativePath, await readFile(path.join(corpusRoot, relativePath), "utf8").then(text => text.split("\n"), () => null));
        return fileCache.get(relativePath);
      };
      for (const task of work) {
        const { plan, responses } = observed.get(task.taskId);
        for (const target of gold.get(task.taskId) ?? []) {
          // classifyTarget's co-anchor re-ordering only needs candidate files; it does not affect rank or mechanism.
          const classified = classifyTarget({ target, plan, responses, fileText: () => null });
          mechanisms.total += 1;
          mechanisms.byMechanism[classified.mechanism] = (mechanisms.byMechanism[classified.mechanism] ?? 0) + 1;
          if (classified.rank !== null) continue;
          const result = await diagnoseMissedTarget({ target, plan, lines: await lines(target.path), call: session.call });
          rows.push({ taskId: task.taskId, category: task.category, path: target.path, startLine: target.startLine, endLine: target.endLine, mechanism: classified.mechanism, ...result });
        }
      }
    } finally { await session.close(); }
  }
  await writeFile(path.join(out, "rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: NOT_RETURNED_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split: "dev", tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
      serverBuildStampSha256: sha256(await readFile(path.join(path.dirname(serverJs), "build-stamp.json"))), limit: DIAGNOSIS_LIMIT, outlineLimit: OUTLINE_LIMIT, planner: "planQueries" },
    sessions,
    ...summarizeMissed(rows, mechanisms),
    notClaimed: "First failing layer per missed target. Vocabulary overlap is a lexical approximation of the indexed text (declaration head, leading comments, type name, file stem), not the index itself. No reads, recall or task success are measured."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--inputs", "--server-js", "--out"]);
  for (const name of ["dataset", "tasks", "gold", "inputs", "server-js", "out"]) requireValue(options[name], `--${name} is required`);
  console.log(JSON.stringify(await runNotReturned({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), serverJs: path.resolve(options["server-js"]), out: path.resolve(options.out) }), null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
