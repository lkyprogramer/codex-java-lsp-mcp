#!/usr/bin/env node
// D17, offline and model-free. For the D16 focus misses the static path did not prove (WEAK_RELATION and
// RELATION_MISSING in implementations/callers, C0), read the frozen corpus source and classify the textual link
// between each target and its task's exact anchors (docs/post-ilv2/d17-relation-text-check.md). No product call.
// Private rows (paths, names) stay under --out; summary.json carries counts only.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { FOCUS, breakdown } from "./ilv2-impact-miss-breakdown.mjs";

export const RELATION_TEXT_SCHEMA = "post-ilv2/relation-text-check/v1";
export const UNPROVEN = Object.freeze(["WEAK_RELATION", "RELATION_MISSING"]);
// Best class first; a target takes the best class over its task's anchors (d17 §2).
export const CLASSES = Object.freeze(["SAME_FILE", "DIRECT", "INDIRECT", "MENTION_ONLY", "NO_TEXT_LINK"]);
// Not determinable, kept out of every rule denominator (d17 §2): no exact anchor at all, or a callers target whose
// exact anchors are all types (no member to look for).
export const UNDETERMINED = Object.freeze(["NO_ANCHOR", "TYPE_ANCHOR_ONLY"]);
export const MAX_DEPTH = 4;
export const GATE = 5;

/** Drop comments and string/char literals, keeping line breaks so line numbers survive. */
export function stripJava(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, match => match.replace(/[^\n]/g, " "));
}

const simple = name => name.replace(/<[\s\S]*$/, "").trim().split(/[.$]/).pop();
/** Split a comma list at generic depth 0 and keep each entry's simple type name. */
function typeList(text) {
  const out = [];
  let depth = 0, current = "";
  for (const char of text) {
    if (char === "<") depth += 1;
    if (char === ">") depth -= 1;
    if (char === "," && depth === 0) { out.push(current); current = ""; continue; }
    current += char;
  }
  out.push(current);
  return out.map(entry => simple(entry.replace(/@\w+(\([^)]*\))?/g, ""))).filter(Boolean);
}

/** Type headers in one stripped Java source: [{ name, supers, line }]. */
export function typeHeaders(stripped) {
  const headers = [];
  const pattern = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/g;
  for (const match of stripped.matchAll(pattern)) {
    let tail = match[3];
    // Drop the type's own parameters and a record's component list.
    if (tail.trimStart().startsWith("<")) {
      let depth = 0, index = tail.indexOf("<");
      for (; index < tail.length; index += 1) { if (tail[index] === "<") depth += 1; if (tail[index] === ">" && --depth === 0) break; }
      tail = tail.slice(index + 1);
    }
    if (match[1] === "record") tail = tail.replace(/^\s*\([^)]*\)/, "");
    const supers = [];
    // relations keep the clause keyword and whether the supertype carries type arguments (D18 shape features).
    const relations = [];
    const tokens = tail.split(/\b(extends|implements|permits)\b/);
    tokens.forEach((token, i) => {
      if ((token !== "extends" && token !== "implements") || i + 1 >= tokens.length) return;
      const names = typeList(tokens[i + 1]);
      supers.push(...names);
      const raw = tokens[i + 1];
      for (const name of names) relations.push({ keyword: token, name, generic: new RegExp(`${name.replace(/[$]/g, "\\$")}\\s*<`).test(raw) });
    });
    const before = stripped.slice(0, match.index);
    const statementStart = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"));
    headers.push({ name: match[2], keyword: match[1], abstract: /\babstract\b/.test(before.slice(statementStart + 1)), supers, relations,
      line: before.split("\n").length });
  }
  return headers;
}

/** simple type name -> set of simple supertype names, merged over the corpus (simple-name collisions merge). */
export function hierarchyOf(sources) {
  const graph = new Map();
  for (const text of sources) for (const header of typeHeaders(stripJava(text))) {
    if (!graph.has(header.name)) graph.set(header.name, new Set());
    for (const name of header.supers) graph.get(header.name).add(name);
  }
  return graph;
}

/** Shortest supertype distance from any of `from` to `to`, up to MAX_DEPTH; null when unreachable. */
export function superDepth(graph, from, to) {
  let frontier = [...new Set(from)];
  const seen = new Set(frontier);
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth += 1) {
    const next = [];
    for (const name of frontier) for (const parent of graph.get(name) ?? []) {
      if (parent === to) return depth;
      if (!seen.has(parent)) { seen.add(parent); next.push(parent); }
    }
    frontier = next;
  }
  return null;
}

/** The anchor's owner type and member: method fqn is `owner.Fqn#name`. */
export function anchorNames(declaration) {
  if (declaration.kind === "method") {
    const owner = String(declaration.fqn ?? "").split("#")[0];
    return { type: simple(owner) || null, member: declaration.name ?? null };
  }
  return { type: declaration.name ?? simple(String(declaration.fqn ?? "")), member: null };
}

const word = name => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
const call = name => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}\\s*\\(`);

/** One target against one anchor. `lines`: stripped target file split by line. */
export function classifyLink({ category, item, anchor, lines, graph }) {
  if (anchor.relativePath === item.path) return { linkClass: "SAME_FILE" };
  const { type, member } = anchorNames(anchor);
  const file = lines.join("\n");
  const range = lines.slice(Math.max(0, item.startLine - 1), item.endLine).join("\n");
  if (category === "implementations") {
    // The target's own headers are read from its file, so its first hop never depends on the corpus graph.
    const supers = typeHeaders(file).flatMap(header => header.supers);
    const above = type && !supers.includes(type) ? superDepth(graph, supers, type) : null;
    const depth = !type ? null : supers.includes(type) ? 1 : above === null || above + 1 > MAX_DEPTH ? null : above + 1;
    if (depth === 1) return { linkClass: "DIRECT", depth };
    if (depth !== null) return { linkClass: "INDIRECT", depth };
  } else if (member) {
    // Name-only call matching: ownerMentioned says whether the owner type also appears in the file.
    const ownerMentioned = Boolean(type && word(type).test(file));
    if (call(member).test(range)) return { linkClass: "DIRECT", ownerMentioned };
    // A call elsewhere in the file: the gold range is a caller of a caller, or the call sits outside it.
    if (call(member).test(file)) return { linkClass: "INDIRECT", ownerMentioned };
  }
  const mentioned = (type && word(type).test(file)) || (member && word(member).test(file));
  return { linkClass: mentioned ? "MENTION_ONLY" : "NO_TEXT_LINK" };
}

/** The task's exact-anchor declarations under C0 (the ones its impact calls used). */
export function exactAnchors(observation) {
  return observation.terms.filter(row => row.exact === "match" && row.impacts?.C0)
    .map(row => row.symbol?.candidates?.[0]?.declaration).filter(Boolean);
}

/** A target over its task's exact anchors: undetermined classes first, else the best class. */
export function linkForTarget({ category, item, anchors, lines, graph }) {
  const hasMethodAnchor = anchors.some(anchor => anchor.kind === "method");
  const base = { anchors: anchors.length, hasMethodAnchor };
  if (anchors.length === 0) return { ...base, linkClass: "NO_ANCHOR" };
  const same = anchors.find(anchor => anchor.relativePath === item.path);
  if (same) return { ...base, linkClass: "SAME_FILE" };
  if (category === "callers" && !hasMethodAnchor) return { ...base, linkClass: "TYPE_ANCHOR_ONLY" };
  const usable = category === "callers" ? anchors.filter(anchor => anchor.kind === "method") : anchors;
  return { ...base, ...bestLink(usable.map(anchor => ({ ...classifyLink({ category, item, anchor, lines, graph }), anchorKind: anchor.kind, anchorIndex: anchors.indexOf(anchor) }))) };
}

const rank = linkClass => CLASSES.indexOf(linkClass);
export function bestLink(results) {
  return results.reduce((best, result) => (best === null || rank(result.linkClass) < rank(best.linkClass) ? result : best), null);
}

const zeroed = () => Object.fromEntries([...CLASSES, ...UNDETERMINED].map(name => [name, 0]));
/** A DIRECT row with type evidence: implementations always; callers only when the owner type appears in the file. */
export const typedDirect = row => row.linkClass === "DIRECT" && (row.category === "implementations" || row.ownerMentioned === true);
export function summarize(rows) {
  const byClass = zeroed();
  const byCategory = {};
  const byCause = {};
  const anchorKinds = {};
  for (const row of rows) {
    byClass[row.linkClass] += 1;
    (byCategory[row.category] ??= zeroed())[row.linkClass] += 1;
    (byCause[row.cause] ??= zeroed())[row.linkClass] += 1;
    const kinds = anchorKinds[row.category] ??= { methodAnchor: 0, typeAnchorOnly: 0, noAnchor: 0 };
    kinds[row.anchors === 0 ? "noAnchor" : row.hasMethodAnchor ? "methodAnchor" : "typeAnchorOnly"] += 1;
  }
  const determinable = rows.filter(row => CLASSES.includes(row.linkClass));
  const groups = cls => [...new Set(rows.filter(row => row.linkClass === cls).map(row => row.taskGroup))].length;
  const typed = rows.filter(typedDirect).length;
  const indirect = byClass.INDIRECT;
  const rules = {
    targets: rows.length,
    determinable: determinable.length,
    R_defect: { typedDirect: typed, allDirect: byClass.DIRECT, gate: 3, triggered: typed >= 3 },
    R_q05: { value: indirect, taskGroups: groups("INDIRECT"), half: determinable.length / 2, triggered: indirect * 2 > determinable.length && groups("INDIRECT") >= 2 },
    R_gold: { value: byClass.NO_TEXT_LINK, half: determinable.length / 2, triggered: determinable.length > 0 && byClass.NO_TEXT_LINK * 2 > determinable.length },
    sameFile: byClass.SAME_FILE
  };
  return { byClass, byCategory, byCause, anchorKinds, rules, depthOfIndirect: rows.filter(row => row.linkClass === "INDIRECT" && row.depth).reduce((acc, row) => ({ ...acc, [row.depth]: (acc[row.depth] ?? 0) + 1 }), {}) };
}

async function javaFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await javaFiles(root, full, out);
    else if (entry.isFile() && entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}

const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function runRelationTextCheck({ datasetFile, tasksFile, goldFile, inputsFile, responsesFile, rowsFile, expect, out, verify = verifyDataset, materialize = materializeCorpus }) {
  const { root, manifest } = await verify(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const responsesBytes = await readFile(responsesFile);
  const rowsBytes = await readFile(rowsFile);
  requireValue(sha256(responsesBytes) === expect.responses, "responses.jsonl is not the recorded D15-F artifact");
  requireValue(sha256(rowsBytes) === expect.rows, "rows.jsonl is not the recorded D15-F artifact");
  const tasks = new Map(jsonl(tasksBytes).map(task => [task.taskId, task]));
  const gold = new Map(jsonl(goldBytes).map(row => [row.taskId, row]));
  const observations = jsonl(responsesBytes);
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const misses = breakdown({ rows: jsonl(rowsBytes), observations, gold })
    .filter(row => row.config === "C0" && FOCUS.includes(row.category) && UNPROVEN.includes(row.cause));
  await mkdir(out, { recursive: true });
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const rows = [];
  for (const corpusId of [...new Set(misses.map(row => tasks.get(row.taskId).corpusId))].sort()) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(entry => entry.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    // Sequential reads: a large corpus read all at once can exhaust file descriptors on macOS.
    const sources = [];
    for (const file of await javaFiles(corpusRoot)) sources.push(await readFile(file, "utf8"));
    const graph = hierarchyOf(sources);
    for (const miss of misses.filter(row => tasks.get(row.taskId).corpusId === corpusId)) {
      const task = tasks.get(miss.taskId);
      const item = gold.get(miss.taskId).requiredEvidence[miss.index];
      const lines = stripJava(await readFile(path.join(corpusRoot, item.path), "utf8")).split("\n");
      const anchors = exactAnchors(byTask.get(miss.taskId));
      rows.push({ taskId: miss.taskId, taskGroup: task.taskGroup ?? miss.taskId, category: miss.category, cause: miss.cause, path: item.path,
        ...linkForTarget({ category: miss.category, item, anchors, lines, graph }) });
    }
  }
  await writeFile(path.join(out, "link-rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: RELATION_TEXT_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes), responsesSha256: expect.responses, rowsSha256: expect.rows,
      taskGroupField: [...tasks.values()].some(task => task.taskGroup !== undefined) ? "taskGroup" : "taskId" },
    ...summarize(rows),
    notClaimed: "Text heuristics over the frozen source: comments and literals stripped, simple-name type hierarchy (collisions merged), member calls by name. No compiler binding; overloads, imports and same-name types are not resolved."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const names = ["--dataset", "--tasks", "--gold", "--inputs", "--responses", "--rows", "--expect-responses-sha256", "--expect-rows-sha256", "--out"];
  const options = cliOptions(args, names);
  for (const name of names) requireValue(options[name.slice(2)], `${name} is required`);
  const summary = await runRelationTextCheck({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), responsesFile: path.resolve(options.responses), rowsFile: path.resolve(options.rows),
    expect: { responses: options["expect-responses-sha256"], rows: options["expect-rows-sha256"] }, out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
